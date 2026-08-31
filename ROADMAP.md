# Roadmap

Four phases, ordered so each one makes the next cheaper. The ordering matters more than the individual designs: phase 2 is trivial now and expensive to retrofit, and phase 1 unlocks YouTube as a side effect rather than as its own feature. Recipe modification is in the backlog below rather than the sequence — it is the most complex of the four and the least load-bearing.

---

## 1. One paste-inbox Google Doc — text and YouTube URLs

**The change.** A single Google Doc, `Recipe Box/Inbox`, that never gets replaced. Paste recipe text or a YouTube link into it, separated by a line containing `---`. `processInbox()` reads the doc with `DocumentApp`, splits on the delimiter, and handles each block that isn't already marked done. Processed blocks get a `✓` prefixed to their first line, so nothing is deleted and re-runs skip what's finished.

**Why YouTube comes free.** Gemini takes a YouTube URL directly as a `file_data` part — no download, no upload, no chunking, no size ceiling. A block that matches a YouTube URL and nothing else routes to that path; everything else is treated as recipe text. One inbox, three sources, one dispatcher.

```js
// in the parts array, instead of an uploaded file_uri
{ file_data: { file_uri: "https://www.youtube.com/watch?v=..." } }
```

**Refactor this forces.** `processInbox()` becomes a dispatcher over sources rather than a loop over video files. Extract a shared `extract(parts, context)` that the three sources feed: `sourceVideos()` (the current path), `sourceDoc()` (text blocks), `sourceYouTube()` (URL blocks). `normalize()`, `writeJson()` and `rebuildIndex()` are unchanged — they already take a raw record and don't care where it came from.

**Constraints to design around.** YouTube URLs must be public — not private, not unlisted. The free tier allows 8 hours of YouTube content per day, which is generous for recipe videos but not unlimited, and the feature is still in preview so the pricing may move. A 20-minute YouTube cooking video is also far more tokens than a 60-second reel; consider passing `videoMetadata` start/end offsets if you find yourself importing long-form content.

**Failure handling.** Videos have `/failed` to move to; a text block has nowhere to go. Mark the block `✗` with the reason appended in a comment line so the doc stays the record.

---

## 2. Normalized ingredient fields

**Do this before either grocery feature, and ideally before importing much more.** Ingredients are currently display strings — `{en: "2 cloves garlic", zh: "蒜 2 瓣"}`. Nothing can aggregate that.

**The change.** Each ingredient gains structured siblings alongside the display text:

```json
{
  "en": "~2 cloves garlic", "zh": "约 2 瓣蒜",
  "item": "garlic", "qty": 2, "unit": "clove", "estimated": true
}
```

`item` should snap to a controlled list where one fits and stay free-text otherwise, so "spring onion", "scallion" and "葱" don't become three shopping-list entries. Add it to `SCHEMA` and one paragraph to the prompt; extraction cost is unchanged.

**Why the timing matters.** Retrofitting means re-extracting everything. That's replayable today because the videos are sitting in `/done` and ids are derived from filenames, so a re-run overwrites cleanly — but only while `KEEP_VIDEOS` is `true`. Once you flip that, the old records can never be enriched.

---

## 3. Grocery list → recipes

**Cheapest feature here, and no backend work.** Matching pantry items against `tags.ingredient` is the filter that already exists, entered from the other end.

**The change.** A "What can I make?" panel: pick or paste what you have, then rank recipes by coverage rather than filtering to exact matches. Show the gap — "5 of 6 — missing 蚝油" — because a recipe you can *almost* make is the useful answer, and a hard filter hides it. Sort by fewest missing, then by fewest total ingredients.

Once phase 2 lands this can match on `item` instead of the coarse tag vocabulary, which is the difference between "chicken" and "chicken thighs".

---

## 4. Recipes → grocery list

**The change.** Select recipes, aggregate their ingredients by `item`, sum `qty` where units agree, and list amounts side by side where they don't. Group by aisle — produce, protein, pantry, 调料 — which is a static map from `item`, not something to ask a model about.

**Where honesty matters.** Quantities are estimates, so a summed total is an estimate of estimates. Carry the `estimated` flag through: an aggregated line built from any estimated input shows `~`. A grocery list that silently presents "437g chicken" as fact is worse than one that says "~400g".

Output as a Doc or a checklist in the app. A checklist you tick in the store wants shared state, which `state.json` already handles.

---

## Backlog

### Recipe modification — swap an ingredient

**Backlogged, not dropped.** The most complex of the expansions and the only one without a clear forcing need: swapping beef for chicken is something you can also just do at the stove. Revisit if you find yourself wanting the variant written down rather than improvised.

**The change.** A "swap" control on a recipe: send the existing record plus an instruction ("beef → chicken") to Gemini, get back a modified record.

**The trap.** This is not find-and-replace. Chicken thigh cooks in a third the time of beef shank, wants different aromatics, and may change the dish's identity — 红烧牛肉面 with chicken is a different noodle soup, not the same one. The prompt has to adjust times, quantities and technique, and say what it changed and why. A swap that only rewrites the noun produces recipes that fail.

**Storage.** Variants belong inside the parent record, not as new library entries:

```json
"variants": [{ "from": "beef", "to": "chicken", "createdAt": "...", "steps": [...], "minutes": 25 }]
```

Shown as a toggle on the recipe rather than a second card, so the library doesn't fill with near-duplicates that all match the same searches.

**New operational surface.** This is the first Gemini call triggered from the web app rather than the scheduled job. That means a visible 5–10 second wait, a spinner that has to handle failure, and `DAILY_CAP` covering interactive use as well as imports — worth splitting into separate counters so a burst of swapping can't block the evening's imports.

---

## Not planned

**Instagram URLs as input.** Instagram has no API for this and scraping breaks constantly. Saving the video and dropping it in a folder is uglier but it keeps working.

**Per-person accounts.** Shared state is a feature for a family recipe box. Adding auth would cost the no-login property that makes the link usable by anyone in the kitchen.
