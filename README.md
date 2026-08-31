# Reels to Recipes

Turns saved recipe videos, YouTube links and pasted text into a searchable bilingual recipe library, using Google Drive as the backend and Gemini for extraction. Runs entirely inside your own Google account — one Apps Script project, one Drive folder, one API call out.

You drop a video into a Drive folder, or paste a link or some text into a Doc. Fifteen minutes later it's a recipe card with tags, ingredients, steps, and a note about whether it can be adapted for a baby, in English and Chinese. From there you can ask what you can cook with what's in the fridge, or turn a few recipes into an aisle-grouped shopping list.

## How it works

```
Drive/inbox   (video files)  ─┐
Inbox doc     (pasted text)  ─┼─→ processInbox() ──parts+prompt──> Gemini
Inbox doc     (YouTube URLs) ─┘         │                             │
                                        │      <──JSON+flags──────────┘
                                        ├─ recipes/<id>.json  (EN + 中文)
                                        ├─ index.json         (what the app reads)
                                        └─ video → /done      (or /failed, never deleted)
```

A time-driven trigger runs `processInbox()` every fifteen minutes; the web app's **Import** button runs the same function on demand. It dispatches over three sources into one extraction path, so `normalize()`, `writeJson()` and `rebuildIndex()` never learn where a recipe came from.

Videos are uploaded to Gemini in 8MB slices read straight out of Drive — Apps Script rejects request bodies over ~50MB and a whole reel will not fit in memory either. YouTube links skip all of that: Gemini takes the URL directly.

## Files

| File | What it is |
|---|---|
| `Code.gs` | The whole backend: Drive watching, chunked upload to Gemini, extraction, storage, and the web app entry point. |
| `Index.html` | The interface — library, what-can-I-make, and the shopping list. Served by `HtmlService`; the recipe library is injected at render time, so there's no second round trip. |
| `ROADMAP.md` | What's built, what's next, and what was deliberately left out. |

## Setup

1. Get a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Make sure the project it belongs to either has no billing attached (free tier) or has credits — a project with billing and a zero balance fails with a 429.
2. New project at [script.google.com](https://script.google.com). Paste `Code.gs` over the default file. Add an HTML file named exactly `Index` and paste `Index.html` into it.
3. Project Settings → Script Properties → add `GEMINI_KEY`.
4. In the Cloud project the script is bound to (Project Settings → GCP Project), enable the **Google Drive API**, and under Google Auth Platform → Audience add yourself as a test user.
5. Run `setup()` once. It creates the Drive folders and the paste-inbox Doc, installs the trigger, and logs both links.
6. Deploy → New deployment → Web app, execute as **Me**, access **Anyone**. After this, only ever update via Manage deployments → New version, or the URL changes.

## Configuration

Everything tunable is in `CONFIG` at the top of `Code.gs`.

| Key | Default | Notes |
|---|---|---|
| `ROOT` | `Recipe Box` | Drive folder name. Must match the folder on disk. |
| `DOC` | `Inbox` | The paste-here Doc, created inside `ROOT`. |
| `MODEL` | `gemini-3.7-flash` | `gemini-3.5-flash-lite` is cheaper. |
| `DAILY_CAP` | `40` | Extractions per day. The deployment is open to anyone with the link, so the expensive path is capped. |
| `MAX_MB` | `200` | Larger videos park in `/too-large` rather than failing. |
| `CHUNK_MB` | `8` | Upload slice size. Apps Script rejects request bodies over ~50MB, so the video is streamed in ranges. |
| `KEEP_VIDEOS` | `true` | Videos move to `/done` instead of the trash. |

The tag vocabulary is the `VOCAB` object below `CONFIG`. It's closed on purpose: anything the model invents is dropped and recorded in `suggestedTags`, so the tag list stays a usable filter instead of growing a long tail of one-offs. Adding a tag is one line, plus one line in `TAG_ZH` in `Index.html` for its Chinese label.

## The three ways in

**Video files.** Drop a reel into `Recipe Box/inbox`. Optionally leave a `.txt` of the caption beside it with the same name; it gets read as context and deleted with the video.

**Pasted text and YouTube links.** Open the `Inbox` Doc and paste, with a line of `+++` between entries. A block that is only a YouTube URL is sent to Gemini as a URL; anything else is treated as recipe text. Processed blocks get a `✓` and the recipe title prepended, failed ones a `✗` and the reason — nothing is ever deleted from the Doc, and re-runs skip what's finished.

Use `+++` rather than `---`: Google Docs autocorrects three hyphens into an em dash as you type. Dashes are still accepted as separators so an autocorrected one doesn't break anything, but `+++` survives typing.

YouTube links must be public; private and unlisted are rejected by the API. The free tier allows 8 hours of YouTube content per day.

## Both grocery directions

**What can I make** ranks the whole library by what you're *missing* rather than filtering to perfect matches, because a recipe you can almost make is the useful answer. Matching is loose in both directions, so "chicken" in the fridge covers "chicken thigh" in a recipe. Salt, oil, sugar, pepper and water are assumed present.

**The list** aggregates the recipes you've added into one line per ingredient, grouped by aisle, summed where units agree and listed side by side where they don't. Any line built from an estimated amount carries `~`. Ticking items is shared state, so two phones in the same store stay in sync.

## Design decisions worth knowing

**Ingredients carry structured fields.** Alongside the bilingual display string, each one has `item` (a canonical lowercase shopping name), `qty`, `unit`, `aisle` and `estimated`. That's what makes both grocery directions possible, and it costs nothing at extraction time.

**Quantities are estimated, and marked.** Reels routinely say "full recipe in the caption" and never speak the amounts. Rather than leaving blanks, the extractor infers a sensible amount for the stated servings and marks it — `~2 tbsp`, `约2汤匙`. Savoury cooking absorbs that.

**Baking is the exception.** Anything set by ratio — pastry, cake, bread, custard — gets no invented numbers. Those amounts are left out and the recipe carries a flag naming the ratio to look up. It's the only thing that gets flagged.

**Ids are derived from the source filename.** Re-extracting the same video overwrites its record instead of creating a second one. `dedupe()` cleans up anything doubled from before that.

**State is shared.** Favorites, tasting notes and the tag ranking live in one `state.json` in Drive, so they're identical on every device that opens the link. Language preference is the one per-person setting and stays in the browser.

**Tag ranking learns.** Tags start in a shuffled order that persists, then move to the front of their group as you pick them. On a phone the twelve highest-ranked tags sit in a swipeable rail above the results.

## Maintenance functions

Run these from the Apps Script editor.

| Function | What it does |
|---|---|
| `dryRun(input?)` | Extracts one item and logs the full record. Pass nothing for the first inbox video, a filename, a YouTube URL, or a block of recipe text. Always keeps the source. |
| `whatsPending()` | Lists what the script sees in both inboxes — files with mime type and size, and the waiting blocks in the Doc. |
| `showFailures()` | Prints the reason file for everything in `/failed`. Failed Doc entries are marked `✗` in the Doc itself. |
| `dedupe()` | Collapses recipes extracted from the same video, keeping the newest. |
| `rebuildIndex()` | Regenerates `index.json` from the recipe files. Safe to run any time. |

## Troubleshooting

**403 access_denied on first run** — the consent screen belongs to a Cloud project where you aren't a test user. Google Auth Platform → Audience → Test users, in the project the script is bound to.

**"Permission denied while enabling APIs: drive"** — a script bound to a standard Cloud project doesn't get APIs enabled automatically. Turn on the Google Drive API in that project.

**Blank page at `/exec`** — the deployment is pinned to a version that predates your `Index` file. Manage deployments → New version. The `/dev` test URL always serves the latest saved code.

**429 "prepayment credits are depleted"** — the AI Studio project has billing attached and a zero balance, which also takes it off the free tier. Disable billing on that project, or buy credits.

**Videos land in `/too-large`** — they exceed `MAX_MB`. iPhone `.mov` files run 80–150MB per minute of footage.

**Nothing imports and the run says Completed** — failures are caught per file and the video is moved to `/failed`. Run `showFailures()`.

## Limits

Apps Script caps a single execution at six minutes, so a batch of large videos spreads across trigger runs rather than completing in one. Gemini's free tier varies by model. The web app is deployed with no login, so anyone with the URL can browse the library and trigger imports against your key — `DAILY_CAP` is the guard.
