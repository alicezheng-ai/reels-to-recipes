/**
 * Reels to Recipes — backend
 *
 * Watches a Drive folder for reel videos and a Google Doc for pasted text and
 * YouTube links, extracts a bilingual recipe with Gemini, and files it as JSON.
 * Serves the web interface.
 *
 * One-time setup: set the Gemini key in Script Properties, then run setup().
 */

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  ROOT: 'Recipe Box',          // Drive folder created by setup()
  DOC: 'Inbox',                // the paste-here Doc, created by setup()
  MODEL: 'gemini-3.7-flash',   // gemini-3.5-flash-lite is cheaper if you want it
  FALLBACK_MODEL: 'gemini-3.5-flash-lite',  // tried when the primary stays busy
  DAILY_CAP: 40,               // extractions per day, guards the key
  MAX_MB: 200,                 // larger videos are parked, not extracted
  CHUNK_MB: 8,                 // upload slice size; keeps memory and each request small
  BUDGET_MS: 4.5 * 60 * 1000,  // stop before the 6-minute execution limit

  // Videos move to /done instead of the trash while this is true. Leave it on
  // until you have read a few extractions and trust them; flip it to false and
  // deletion becomes permanent-ish (Drive trash, 30 days).
  KEEP_VIDEOS: true
};

const FOLDERS = ['inbox', 'recipes', 'done', 'failed', 'too-large'];

/** Closed tag vocabulary. Add a line and it is live everywhere. */
const VOCAB = {
  ingredient: ['chicken','beef','salmon','eggs','tofu','chickpeas','lentils','peanut',
               'rice','noodles','oats','mushroom','tomato','broccoli','greens',
               'sweet potato','carrot'],
  dish:       ['soup','noodles','stir-fry','rice bowl','congee','steamed','salad',
               'bake','stew','breakfast','purée'],
  time:       ['≤15 min','≤30 min','one pot','no-cook','no-cook sauce','make-ahead'],
  nutrition:  ['high-protein','iron-rich','high-fiber','calcium-rich','low-sodium',
               'low-carb','omega-3'],
  diet:       ['vegetarian','vegan','gluten-free','dairy-free'],
  baby:       ['6m purée','8m finger food','12m+','no added salt'],
  cuisine:    ['Cantonese','Sichuan','Yunnan','Taiwanese','Japanese','Korean','Thai',
               'Mediterranean','Italian','Indian','American']
};

/** Where each ingredient lives in a store. Drives the grocery list grouping. */
const AISLES = ['produce', 'protein', 'dairy & eggs', 'grains & noodles',
                'pantry', 'seasoning', 'frozen', 'other'];

const YOUTUBE_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+/i;
/* Separator between entries. Use +++ — Google Docs autocorrects "---" into an
   em dash as you type, which is why dashes are only accepted, never suggested. */
const BLOCK_SPLIT = /^\s*(\+{2,}|-{2,}|[–—]+)\s*$/;
const DONE_MARK = '✓';
const FAIL_MARK = '✗';

// ─────────────────────────────────────────────────────────────
// SETUP — run once from the editor
// ─────────────────────────────────────────────────────────────
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GEMINI_KEY')) {
    throw new Error('Add GEMINI_KEY in Project Settings → Script Properties first.');
  }
  const root = folderByName(DriveApp.getRootFolder(), CONFIG.ROOT) ||
               DriveApp.createFolder(CONFIG.ROOT);
  props.setProperty('ROOT_ID', root.getId());
  FOLDERS.forEach(function (name) {
    const f = folderByName(root, name) || root.createFolder(name);
    props.setProperty(name.toUpperCase().replace('-', '_') + '_ID', f.getId());
  });

  // The paste inbox. One Doc, forever — never replaced, only appended to.
  let docFile = null;
  const existing = root.getFilesByName(CONFIG.DOC);
  if (existing.hasNext()) docFile = existing.next();
  if (!docFile) {
    const doc = DocumentApp.create(CONFIG.DOC);
    doc.getBody().appendParagraph(
      DONE_MARK + ' Paste recipe text or a YouTube link below, with a line of ' +
      '+++ between entries. Processed entries get a ✓ and are skipped after ' +
      'that. This line is marked done so it is never treated as a recipe.');
    doc.getBody().appendParagraph('+++');
    doc.saveAndClose();
    docFile = DriveApp.getFileById(doc.getId());
    docFile.moveTo(root);
  }
  props.setProperty('DOC_ID', docFile.getId());

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();

  rebuildIndex();
  Logger.log('Ready.');
  Logger.log('Videos → https://drive.google.com/drive/folders/' + props.getProperty('INBOX_ID'));
  Logger.log('Paste  → https://docs.google.com/document/d/' + docFile.getId() + '/edit');
}

function folderByName(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function folder(key) {
  return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(key + '_ID'));
}
function root() {
  return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ROOT_ID'));
}
function apiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
}
function inboxDoc() {
  return DocumentApp.openById(PropertiesService.getScriptProperties().getProperty('DOC_ID'));
}
function docUrl() {
  return 'https://docs.google.com/document/d/' +
    PropertiesService.getScriptProperties().getProperty('DOC_ID') + '/edit';
}

// ─────────────────────────────────────────────────────────────
// WEB APP
// ─────────────────────────────────────────────────────────────
function doGet() {
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.bootstrap = JSON.stringify(bootstrap());
  return tpl.evaluate()
    .setTitle('Reels to Recipes')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Everything the interface needs in one payload — no second round trip. */
function bootstrap() {
  return {
    recipes: readIndex().recipes,
    state: readState(),
    vocab: VOCAB,
    aisles: AISLES,
    docUrl: docUrl(),
    pending: countPending()
  };
}

/** Videos waiting plus unprocessed blocks in the Doc. */
function countPending() {
  let n = 0;
  const it = folder('INBOX').getFiles();
  while (it.hasNext()) { if (isVideo(it.next())) n++; }
  try { n += readBlocks().filter(function (b) { return !b.done; }).length; }
  catch (e) { /* doc not set up yet */ }
  return n;
}

/** Called from the page. Shared across everyone using the link. */
function saveState(patch) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const state = readState();
    ['clicks', 'seeds', 'favs', 'notes', 'tried', 'confirmed', 'basket', 'checked', 'pantry']
      .forEach(function (k) {
        if (patch[k]) state[k] = Object.assign(state[k] || {}, patch[k]);
      });
    if (patch.pantryText !== undefined) state.pantryText = patch.pantryText;
    writeJson(root(), 'state.json', state);
    return state;
  } finally {
    lock.releaseLock();
  }
}

/** "Import now" button. Returns what changed so the page can refresh itself. */
function importNow() {
  const n = processInbox();
  return { imported: n, recipes: readIndex().recipes, pending: countPending() };
}

// ─────────────────────────────────────────────────────────────
// THE PIPELINE — one dispatcher, three sources
// ─────────────────────────────────────────────────────────────
function processInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 0;   // a run is already going
  const deadline = Date.now() + CONFIG.BUDGET_MS;
  let done = 0;

  try {
    done += processVideos(deadline);
    done += processDoc(deadline);
    if (done) rebuildIndex();
  } finally {
    lock.releaseLock();
  }
  return done;
}

/** Source 1: video files dropped in Drive. */
function processVideos(deadline) {
  const files = [];
  const it = folder('INBOX').getFiles();
  while (it.hasNext()) { const f = it.next(); if (isVideo(f)) files.push(f); }

  let done = 0;
  for (let i = 0; i < files.length; i++) {
    if (Date.now() > deadline || !underDailyCap()) break;
    try {
      if (extractVideo(files[i])) { bumpDailyCount(); done++; }
    } catch (err) {
      Logger.log('Failed on ' + files[i].getName() + ': ' + err);
      if (!isTransient(err)) park(files[i], 'FAILED', String(err));
    }
  }
  return done;
}

/** Sources 2 and 3: text blocks and YouTube links in the paste Doc. */
function processDoc(deadline) {
  let blocks;
  try { blocks = readBlocks(); }
  catch (e) { Logger.log('No paste Doc yet — run setup(). ' + e); return 0; }

  let done = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.done || !b.text.trim()) continue;
    if (Date.now() > deadline || !underDailyCap()) break;
    try {
      const lines = b.text.split('\n').map(function (x) { return x.trim(); })
                     .filter(function (x) { return x; });
      const recipe = (lines.length === 1 && YOUTUBE_RE.test(lines[0]))
        ? extractYouTube(lines[0])
        : extractText(b.text);
      mark(b, DONE_MARK + ' ' + recipe.title.en);
      bumpDailyCount();
      done++;
    } catch (err) {
      Logger.log('Failed on doc block ' + i + ': ' + err);
      /* Leave transient failures unmarked so the next run picks them up. */
      if (!isTransient(err)) mark(b, FAIL_MARK + ' ' + String(err).slice(0, 180));
    }
  }
  return done;
}

/**
 * The Doc as a list of entries. Blocks are separated by a line of dashes; the
 * first paragraph of each carries the ✓ or ✗ marker, so re-runs skip finished
 * work and nothing is ever deleted.
 */
function readBlocks() {
  const paras = inboxDoc().getBody().getParagraphs();
  const blocks = [];
  let current = null;

  for (let i = 0; i < paras.length; i++) {
    const text = paras[i].getText();
    if (BLOCK_SPLIT.test(text.trim())) { current = null; continue; }
    if (!current) {
      current = { head: paras[i], lines: [] };
      blocks.push(current);
    }
    current.lines.push(text);
  }

  return blocks.map(function (b) {
    const first = b.lines[0] || '';
    return {
      head: b.head,
      text: b.lines.join('\n'),
      done: first.indexOf(DONE_MARK) === 0 || first.indexOf(FAIL_MARK) === 0
    };
  });
}

/** Stamp a block's first line so the next run leaves it alone. */
function mark(block, note) {
  block.head.setText(note + ' — ' + block.head.getText());
}

function isVideo(file) {
  return /^video\//.test(file.getMimeType()) ||
         /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.getName());
}

function park(file, folderKey, note) {
  const dest = folder(folderKey === 'FAILED' ? 'FAILED' : 'TOO_LARGE');
  file.moveTo(dest);
  dest.createFile(file.getName() + '.why.txt', note);
}

function retire(file) {
  if (CONFIG.KEEP_VIDEOS) file.moveTo(folder('DONE'));
  else file.setTrashed(true);
}

// ─────────────────────────────────────────────────────────────
// EXTRACTION — one per source, all landing in the same place
// ─────────────────────────────────────────────────────────────
function extractVideo(file) {
  const mb = file.getSize() / 1048576;
  if (mb > CONFIG.MAX_MB) {
    park(file, 'TOO_LARGE', 'Video is ' + mb.toFixed(0) + 'MB, over the ' +
      CONFIG.MAX_MB + 'MB limit. Trim it, or raise MAX_MB in CONFIG.');
    return null;
  }

  const caption = readCaption(file.getName());
  const uploaded = uploadToGemini(file);
  try {
    waitForActive(uploaded.name);
    const parts = [
      { file_data: { mime_type: file.getMimeType(), file_uri: uploaded.uri } },
      { text: prompt(caption) }
    ];
    const recipe = finish(generate(parts), {
      id: idFor(file.getName()),
      sourceFile: file.getName(),
      source: 'video',
      hadCaption: !!caption
    });
    retire(file);
    return recipe;
  } finally {
    deleteGeminiFile(uploaded.name);   // never leave the video on Google's side
  }
}

function extractYouTube(url) {
  const parts = [{ file_data: { file_uri: url } }, { text: prompt('') }];
  return finish(generate(parts), {
    id: idFor(url),
    sourceFile: url,
    source: 'youtube',
    hadCaption: false
  });
}

function extractText(text) {
  const parts = [{ text: prompt('') + '\n\nRECIPE TEXT:\n"""\n' + text + '\n"""' }];
  return finish(generate(parts), {
    id: idFor(text.slice(0, 400)),
    sourceFile: text.trim().split('\n')[0].slice(0, 80),
    source: 'text',
    hadCaption: true          // pasted text IS the caption
  });
}

/** Normalize, write, return. Shared tail of every source. */
function finish(raw, meta) {
  const recipe = normalize(raw, meta);
  writeJson(folder('RECIPES'), recipe.id + '.json', recipe);
  return recipe;
}

function readCaption(videoName) {
  const base = videoName.replace(/\.[^.]+$/, '');
  const it = folder('INBOX').getFilesByName(base + '.txt');
  if (!it.hasNext()) return '';
  const f = it.next();
  const text = f.getBlob().getDataAsString();
  f.setTrashed(true);
  return text;
}

// ─────────────────────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────────────────────

/**
 * Uploads in slices. Apps Script caps a single request body around 50MB and a
 * whole reel will not fit in memory either, so the file is streamed: read a
 * byte range straight from Drive, push it to Gemini's resumable session, drop it.
 */
function uploadToGemini(file) {
  const size = file.getSize();

  const start = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + apiKey(), {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': file.getMimeType()
      },
      payload: JSON.stringify({ file: { display_name: file.getName() } }),
      muteHttpExceptions: true
    });
  if (start.getResponseCode() >= 300) throw new Error('Upload start failed: ' + start.getContentText());

  const uploadUrl = header(start, 'x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL returned.');

  const CHUNK = CONFIG.CHUNK_MB * 1048576;
  let offset = 0;
  let last = null;

  while (offset < size) {
    const end = Math.min(offset + CHUNK, size) - 1;
    const isLast = (end === size - 1);

    // UrlFetchApp sets Content-Length itself and rejects any attempt to set it.
    last = UrlFetchApp.fetch(uploadUrl, {
      method: 'post',
      headers: {
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload'
      },
      payload: readRange(file.getId(), offset, end),
      muteHttpExceptions: true
    });

    const code = last.getResponseCode();
    const ok = isLast ? code < 300 : (code === 200 || code === 308);
    if (!ok) throw new Error('Upload failed at byte ' + offset + ': ' + last.getContentText());
    offset = end + 1;
  }

  const f = JSON.parse(last.getContentText()).file;
  return { name: f.name, uri: f.uri };
}

/** One slice of a Drive file, without loading the whole thing. */
function readRange(fileId, start, end) {
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        Range: 'bytes=' + start + '-' + end
      },
      muteHttpExceptions: true
    });
  if (res.getResponseCode() >= 300) throw new Error('Drive read failed: ' + res.getContentText());
  return res.getBlob().getBytes();
}

function header(res, wanted) {
  const all = res.getAllHeaders();
  for (const k in all) if (k.toLowerCase() === wanted) return all[k];
  return null;
}

/** Video files are processed asynchronously; generation fails until ACTIVE. */
function waitForActive(name) {
  for (let i = 0; i < 18; i++) {                    // ~90 seconds
    const res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/' + name + '?key=' + apiKey(),
      { muteHttpExceptions: true });
    const state = JSON.parse(res.getContentText()).state;
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') throw new Error('Gemini could not process the video.');
    Utilities.sleep(5000);
  }
  throw new Error('Video still processing after 90s.');
}

function deleteGeminiFile(name) {
  try {
    UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/' + name + '?key=' + apiKey(),
      { method: 'delete', muteHttpExceptions: true });
  } catch (e) { /* it expires on its own in 48h anyway */ }
}

/** 503 and 429 mean "busy", not "broken" — wait and ask again before giving up. */
const TRANSIENT = [429, 500, 502, 503, 504];

function generate(parts) {
  const body = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA
    }
  };
  const url = function (model) {
    return 'https://generativelanguage.googleapis.com/v1beta/models/' +
           model + ':generateContent?key=' + apiKey();
  };

  const models = [CONFIG.MODEL, CONFIG.FALLBACK_MODEL].filter(Boolean);
  let last = '';

  for (let m = 0; m < models.length; m++) {
    const attempts = m === 0 ? 3 : 2;
    for (let a = 0; a < attempts; a++) {
      if (a) Utilities.sleep(a === 1 ? 6000 : 18000);
      const res = UrlFetchApp.fetch(url(models[m]), {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(body), muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code < 300) {
        if (m > 0) Logger.log('Extracted with the fallback model, ' + models[m]);
        const out = JSON.parse(res.getContentText());
        return JSON.parse(out.candidates[0].content.parts[0].text);
      }
      last = res.getContentText();
      /* A permanent error on the primary is a bad request, not bad luck — the
         fallback would fail the same way, so stop. */
      if (TRANSIENT.indexOf(code) === -1) throw new Error('Gemini: ' + last);
      Logger.log(models[m] + ' returned ' + code + ', retry ' + (a + 1) + '/' + attempts);
    }
    if (m + 1 < models.length) Logger.log('Still busy — falling back to ' + models[m + 1]);
  }
  throw new Error('BUSY every model is overloaded — leaving this one for the next run. ' +
                  last.slice(0, 200));
}

/** Worth trying again later rather than filing as a failure. */
function isTransient(err) {
  return String(err).indexOf('BUSY') !== -1;
}

function prompt(caption) {
  return [
    'You are reading a recipe — from a video, or from text pasted below. Watch and',
    'listen to whatever media is attached, read every word of on-screen text, and',
    'produce one recipe record.',
    '',
    caption ? 'The creator\'s caption, which usually holds the ingredient list:\n"""\n' + caption + '\n"""\n' : '',
    'Quantities — the cook wants a usable recipe, not a transcript:',
    '- Give every ingredient an amount. Use what is stated or visibly shown.',
    '- When no amount is given, infer a sensible one for the stated servings and',
    '  mark it as your estimate: "~2 tbsp" in English, "约2汤匙" in Chinese, and set',
    '  estimated to true. Savoury home cooking is forgiving, and a reasonable',
    '  estimate beats a blank line.',
    '- Leave an amount out only when you cannot even estimate it sensibly.',
    '',
    'The one exception is BAKING — anything with flour, leavening, a batter, a dough,',
    'a cake, bread, pastry or custard set by ratio. There the proportions decide',
    'whether it works at all, so do NOT invent them. Leave those amounts out, set',
    'needsReview to true, and write a flag naming the ratio to look up, e.g.',
    '"Flour-to-butter ratio was never stated — check a standard shortcrust ratio."',
    '',
    'needsReview is ONLY for that baking case, or when the source was too unclear to',
    'read at all. A savoury recipe with estimated amounts is finished, not flagged.',
    '',
    'Every ingredient also carries structured fields used to build shopping lists:',
    '- item: the shopping name, lowercase English, singular, no amount and no',
    '  preparation. "2 cloves garlic, minced" gives item "garlic"; "葱花" gives',
    '  "scallion". Pick the same word every time so the same thing from twenty',
    '  recipes collapses into one line — prefer "scallion" over "spring onion",',
    '  "soy sauce" over "light soy", "chicken thigh" over "boneless chicken thigh".',
    '- qty and unit: the number and its unit ("clove", "tbsp", "g", "piece"). Omit',
    '  both for things measured to taste.',
    '- aisle: exactly one of ' + AISLES.join(', ') + '.',
    '',
    'Write both languages natively. The English should read like a competent home',
    'cook wrote it: imperative, specific, no filler. The Chinese should read like a',
    '中文菜谱 written by a Chinese cook, in whatever variant the creator uses — not a',
    'translation of the English. Keep both versions the same length and content.',
    '',
    'Tags: use ONLY these values. Anything you think is missing goes in suggestedTags.',
    JSON.stringify(VOCAB, null, 0),
    '',
    'Tag guidance:',
    '- ingredient: one or two things the dish is actually built from. Not aromatics,',
    '  not seasonings, not garnishes. Garlic and ginger are never tags.',
    '- baby: only if the dish can plausibly be adapted for a baby. Attach babyNote',
    '  explaining the adaptation (what to hold back, what texture, what age).',
    '  Flag choking risks and added salt honestly.',
    '- nutrition: only what the ingredients clearly support.',
    '',
    'protein and kcal are per serving and are your estimate from the ingredients —',
    'always approximate, so never flag them as uncertain.'
  ].join('\n');
}

const BILINGUAL = {
  type: 'OBJECT',
  properties: { en: { type: 'STRING' }, zh: { type: 'STRING' } },
  required: ['en', 'zh']
};

const INGREDIENT = {
  type: 'OBJECT',
  properties: {
    en: { type: 'STRING' },
    zh: { type: 'STRING' },
    item: { type: 'STRING', description: 'lowercase English shopping name, singular' },
    qty: { type: 'NUMBER' },
    unit: { type: 'STRING' },
    aisle: { type: 'STRING', enum: AISLES },
    estimated: { type: 'BOOLEAN' }
  },
  required: ['en', 'zh', 'item', 'aisle']
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: BILINGUAL,
    creator: { type: 'STRING', description: 'handle or source name if visible, else empty' },
    minutes: { type: 'INTEGER' },
    servings: { type: 'INTEGER' },
    kcal: { type: 'INTEGER' },
    protein: { type: 'INTEGER' },
    ingredients: { type: 'ARRAY', items: INGREDIENT },
    steps: { type: 'ARRAY', items: BILINGUAL },
    babyNote: BILINGUAL,
    tags: {
      type: 'OBJECT',
      properties: {
        ingredient: { type: 'ARRAY', items: { type: 'STRING' } },
        dish:       { type: 'ARRAY', items: { type: 'STRING' } },
        time:       { type: 'ARRAY', items: { type: 'STRING' } },
        nutrition:  { type: 'ARRAY', items: { type: 'STRING' } },
        diet:       { type: 'ARRAY', items: { type: 'STRING' } },
        baby:       { type: 'ARRAY', items: { type: 'STRING' } },
        cuisine:    { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['ingredient','dish','time','nutrition','diet','baby','cuisine']
    },
    suggestedTags: { type: 'ARRAY', items: { type: 'STRING' } },
    needsReview: { type: 'BOOLEAN' },
    reviewFlags: {
      type: 'OBJECT',
      properties: {
        en: { type: 'ARRAY', items: { type: 'STRING' } },
        zh: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['en', 'zh']
    }
  },
  required: ['title','minutes','servings','ingredients','steps','tags','needsReview','reviewFlags']
};

// ─────────────────────────────────────────────────────────────
// NORMALIZE — the model's output is a proposal, not the record
// ─────────────────────────────────────────────────────────────
function normalize(raw, meta) {
  const dropped = [];
  const tags = {};
  Object.keys(VOCAB).forEach(function (fam) {
    const allowed = VOCAB[fam];
    tags[fam] = ((raw.tags && raw.tags[fam]) || []).filter(function (t) {
      if (allowed.indexOf(t) !== -1) return true;
      dropped.push(fam + ':' + t);
      return false;
    });
  });

  const ingredients = (raw.ingredients || []).map(function (i) {
    return {
      en: i.en || '',
      zh: i.zh || '',
      item: (i.item || '').toLowerCase().trim(),
      qty: (typeof i.qty === 'number' && isFinite(i.qty)) ? i.qty : null,
      unit: (i.unit || '').toLowerCase().trim(),
      aisle: AISLES.indexOf(i.aisle) !== -1 ? i.aisle : 'other',
      estimated: !!i.estimated
    };
  });

  return {
    id: meta.id,
    sourceFile: meta.sourceFile,
    source: meta.source,
    hadCaption: meta.hadCaption,
    importedAt: new Date().toISOString(),
    creator: raw.creator || '',
    title: raw.title,
    minutes: raw.minutes || 0,
    servings: raw.servings || 0,
    kcal: raw.kcal || 0,
    protein: raw.protein || 0,
    ingredients: ingredients,
    steps: raw.steps || [],
    babyNote: (raw.babyNote && raw.babyNote.en) ? raw.babyNote : null,
    tags: tags,
    suggestedTags: (raw.suggestedTags || []).concat(dropped),
    needsReview: !!raw.needsReview,
    reviewFlags: {
      en: (raw.reviewFlags && raw.reviewFlags.en) || [],
      zh: (raw.reviewFlags && raw.reviewFlags.zh) || []
    }
  };
}

/**
 * The id is a hash of the source, not a random uuid. Extracting the same video,
 * link or text twice then overwrites one record instead of making a second one.
 */
function idFor(seed) {
  const base = String(seed).replace(/\.[^.]+$/, '').toLowerCase().trim();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, base, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += ('0' + (digest[i] & 0xFF).toString(16)).slice(-2);
  return 'r' + hex;
}

// ─────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────

/** Called from the page's delete button. Trashes one recipe, keeps the source. */
function deleteRecipe(id) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) throw new Error('Bad recipe id.');
  const it = folder('RECIPES').getFilesByName(id + '.json');
  if (!it.hasNext()) throw new Error('No recipe named ' + id);
  it.next().setTrashed(true);
  rebuildIndex();
  return readIndex().recipes;
}

/**
 * Maintenance: collapse recipes that came from the same source. Keeps the most
 * recently imported one and trashes the rest. Run it from the editor.
 */
function dedupe() {
  const seen = {};
  const all = [];
  const it = folder('RECIPES').getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    try {
      const r = JSON.parse(f.getBlob().getDataAsString());
      all.push({ file: f, key: (r.sourceFile || f.getName()).toLowerCase(), at: r.importedAt || '' });
    } catch (e) { Logger.log('Unreadable, skipped: ' + f.getName()); }
  }
  all.sort(function (a, b) { return b.at.localeCompare(a.at); });   // newest first

  let removed = 0;
  all.forEach(function (r) {
    if (seen[r.key]) { r.file.setTrashed(true); removed++; Logger.log('Trashed duplicate: ' + r.file.getName()); }
    else seen[r.key] = true;
  });
  rebuildIndex();
  Logger.log(removed ? 'Removed ' + removed + ' duplicate(s).' : 'No duplicates found.');
  return removed;
}

function rebuildIndex() {
  const recipes = [];
  const it = folder('RECIPES').getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    try { recipes.push(JSON.parse(f.getBlob().getDataAsString())); }
    catch (e) { Logger.log('Unreadable: ' + f.getName()); }
  }
  recipes.sort(function (a, b) { return (b.importedAt || '').localeCompare(a.importedAt || ''); });
  writeJson(root(), 'index.json', { updated: new Date().toISOString(), recipes: recipes });
  return recipes.length;
}

function readIndex() {
  const it = root().getFilesByName('index.json');
  if (!it.hasNext()) return { recipes: [] };
  return JSON.parse(it.next().getBlob().getDataAsString());
}

function readState() {
  const blank = { clicks: {}, seeds: {}, favs: {}, notes: {}, tried: {},
                  confirmed: {}, basket: {}, checked: {}, pantryText: '' };
  const it = root().getFilesByName('state.json');
  if (!it.hasNext()) return blank;
  return Object.assign(blank, JSON.parse(it.next().getBlob().getDataAsString()));
}

function writeJson(parent, name, obj) {
  const body = JSON.stringify(obj, null, 2);
  const it = parent.getFilesByName(name);
  if (it.hasNext()) { it.next().setContent(body); return; }
  parent.createFile(name, body, MimeType.PLAIN_TEXT);
}

// ─────────────────────────────────────────────────────────────
// DIAGNOSTICS — run these from the editor
// ─────────────────────────────────────────────────────────────

/**
 * Extracts one item, logs the whole record, and always keeps the source.
 * Pass nothing for the first inbox video, or a filename, or a YouTube URL,
 * or a block of recipe text.
 */
function dryRun(input) {
  const t0 = Date.now();
  let recipe;

  if (input && YOUTUBE_RE.test(String(input).trim())) {
    recipe = extractYouTube(String(input).trim());
  } else if (input && String(input).indexOf('\n') !== -1) {
    recipe = extractText(String(input));
  } else {
    const it = input ? folder('INBOX').getFilesByName(String(input)) : folder('INBOX').getFiles();
    let target = null;
    while (it.hasNext()) { const f = it.next(); if (isVideo(f)) { target = f; break; } }
    if (!target) throw new Error('No video found in the inbox' + (input ? ' named ' + input : '') + '.');
    const keep = CONFIG.KEEP_VIDEOS;
    CONFIG.KEEP_VIDEOS = true;
    try { recipe = extractVideo(target); } finally { CONFIG.KEEP_VIDEOS = keep; }
    if (!recipe) throw new Error('Video was parked, not extracted — check /too-large.');
  }

  rebuildIndex();
  Logger.log('Extracted in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  Logger.log(JSON.stringify(recipe, null, 2));
  if (recipe.needsReview) Logger.log('FLAGGED:\n- ' + recipe.reviewFlags.en.join('\n- '));
  if (recipe.suggestedTags.length) Logger.log('Wanted tags you do not have: ' + recipe.suggestedTags.join(', '));
  return recipe;
}

/** What does the script actually see, in both inboxes? */
function whatsPending() {
  let n = 0;
  const it = folder('INBOX').getFiles();
  while (it.hasNext()) {
    const f = it.next();
    n++;
    Logger.log([n + '.', f.getName(), '|', f.getMimeType(), '|',
                (f.getSize() / 1048576).toFixed(1) + 'MB', '|',
                isVideo(f) ? 'WILL EXTRACT' : 'ignored'].join(' '));
  }
  if (!n) Logger.log('No files in the video inbox.');

  const blocks = readBlocks();
  const waiting = blocks.filter(function (b) { return !b.done && b.text.trim(); });
  Logger.log('Doc: ' + blocks.length + ' block(s), ' + waiting.length + ' waiting.');
  waiting.forEach(function (b, i) {
    Logger.log('  ' + (i + 1) + '. ' + b.text.slice(0, 90).replace(/\n/g, ' ⏎ '));
  });
  Logger.log('Paste here: ' + docUrl());
  return n + waiting.length;
}

/** Why did videos disappear? Reads every .why.txt in /failed. */
function showFailures() {
  const it = folder('FAILED').getFiles();
  let n = 0;
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.why\.txt$/.test(f.getName())) continue;
    n++;
    Logger.log(f.getName().replace('.why.txt', '') + '\n    → ' + f.getBlob().getDataAsString() + '\n');
  }
  if (!n) Logger.log('Nothing in /failed. Failed doc entries are marked ✗ in the Doc itself.');
  return n;
}

// ─────────────────────────────────────────────────────────────
// GUARD RAILS
// ─────────────────────────────────────────────────────────────
function todayKey() {
  return 'COUNT_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
}
function underDailyCap() {
  const n = Number(PropertiesService.getScriptProperties().getProperty(todayKey()) || 0);
  if (n >= CONFIG.DAILY_CAP) Logger.log('Daily cap reached.');
  return n < CONFIG.DAILY_CAP;
}
function bumpDailyCount() {
  const props = PropertiesService.getScriptProperties();
  const k = todayKey();
  props.setProperty(k, String(Number(props.getProperty(k) || 0) + 1));
}
