# MJ Contact Sheet — one brief, many angles, proven attribution

A comparison sheet for the Midjourney pipeline: one brief rendered at N
different camera angles, laid out as a single contact sheet with one tile
per variant, each tile labelled with the clause that produced it.

The tool is `lib/mj-contact-sheet.js`. The shipped example is
`assets/mj-sheets/red-coat-underpass-12/` and the page that presents it is
`pages/mj-sheets.html`.

---

## What it does

```bash
node lib/mj-contact-sheet.js --pack red_coat_underpass_12 \
  --out assets/mj-sheets/red-coat-underpass-12/contact-sheet.png \
  --tiles assets/mj-sheets/red-coat-underpass-12/tiles \
  --manifest assets/mj-sheets/red-coat-underpass-12/sheet-manifest.json \
  --title "Red Coat Underpass"
```

| Flag | Meaning |
|---|---|
| `--pack <slug>` | directory under `mj-output/` (required) |
| `--out <file>` | the sheet PNG (default `mj-output/<pack>/contact-sheet.png`) |
| `--tiles <dir>` | also save each tile as its own file (`prompt-NN.webp`) |
| `--manifest <file>` | write the provenance manifest |
| `--title <text>` | heading text (default: derived from the pack slug) |
| `--cols` / `--rows` | grid shape (default 4 × 3 = 12 up) |
| `--thumb <px>` | tile width in CSS px (default 480) |
| `--slot <n>` | which grid cell of the 4-up to use by default (default 0) |
| `--slots "2=1,5=3"` | per-variant cell override, keyed by prompt number |

Exit 0 sheet written · 2 bad input · 3 render failure.

---

## Why a browser and not `curl`

The Midjourney CDN (`cdn.midjourney.com`) answers curl and headless
clients with a Cloudflare bot challenge — HTTP 403. A real browser gets the
pixels. The builder therefore drives Chrome **headed** (the same constraint
the web backend honours), renders the sheet as HTML, and screenshots it.

The same reason the tiles are exported through the page (`fetch` +
`FileReader` in-browser) rather than by a separate download step: the
browser is the only client the CDN serves.

---

## The three things that can silently corrupt a sheet

### 1. Wrong-job attribution

The imagine feed is a **shared timeline**. The account owner's own
concurrent jobs sit in it, with their own prompts and their own images. A
matcher that reads a rendered card's text and looks for the prompt inside
it will happily match the owner's job.

That is not hypothetical: it happened on 2026-10-21, and 6 of 12 tiles in
the first sheet were the owner's portrait rather than the brief.

**The fix** is `lib/mj-feed.js`: the sheet's task ids are re-derived from
the feed's own `full_command`, and only plain `16:9` `v8.2` jobs are
accepted. The DOM matcher was deleted, not demoted — keeping an unsound
matcher as a "fallback" is how it came back. `lib/mj-web.test.js` asserts
it is not exported.

**What this means for you:** a task id on a sheet is only as good as the
gate that produced it. If you swap the gate, re-check the tiles by eye.

### 2. Flags that drifted

A job enqueued as `--ar 4:3 --stylize 0` instead of `--ar 16:9 --s 100`
is a *successful* job with the wrong parameters — no error, just a
different picture. The drift came from the account's ambient UI state
(`localStorage.settings_v30`), not from the prompt.

The feed gate therefore checks the **enqueued command**, not just the
prose: the requested `--ar` must be present with the requested value, and
`--edit` / `--cref` / `--oref` must be absent.

`--stylize` is deliberately **not** strict — Midjourney omits it when it
equals its default, so demanding it would reject good jobs.

### 3. A caption that does not match its tile

The caption is not a description of the result; it is the clause from the
prompt that produced the tile. It has to be *derived*, not written by
hand, or it drifts.

`variantLabel()` reads the clause back out of the prompt — the text
between the shared head (`…underpass at night,`) and the shared tail
(`one overhead sodium streetlight…`) — so the caption and the image are
provably in sync.

**A bug worth knowing about:** the caption cap used to truncate at the
*first* separator, so `overhead mirror reflection, red coat doubled in
glass, muted 35mm documentary` collapsed to `overhead…`. It now cuts at
the *last* separator in the kept span. `lib/mj-contact-sheet.test.js`
pins this.

---

## Per-variant slot selection

Midjourney returns a **4-up grid** per prompt, and the four cells are not
four renditions of one framing — they are four different takes on the
brief. A prompt that says "overhead crane shot straight down" often
yields one genuinely top-down cell and three eye-level ones.

`--slots "2=1,5=3"` picks a specific cell per variant (the key is the
prompt's 1-based number). Unlisted variants use `--slot`.

The chosen cell is recorded in the manifest as `slot`, so the sheet says
which of the four it is showing.

---

## When Midjourney ignores the angle

It happens. Two of the twelve prompts came back as eye-level and level
respectively — the crane and the dutch tilt were both ignored, silently,
in a job that reported success.

Rewording helped both, and the rewrites are what shipped:

- `high overhead crane angle looking straight down` → `overhead crane shot
  straight down, bird's eye view`
- `dutch tilt three-quarter view` → `dutch tilt, camera rolled 30
  degrees, tilted horizon`

**Verify by looking.** The pack's own check is to render every cell of a
suspect job and pick the closest one; if no cell is close, reword and
re-render. A job that "succeeded" is not evidence that the angle landed.

---

## The shipped example

`assets/mj-sheets/red-coat-underpass-12/`

```
contact-sheet.png      1990 × 996 — the 12-up
tiles/prompt-01..12.webp   1143 × 640 — the individual tiles
sheet-manifest.json    provenance: label, task id, slot, CDN url per variant
```

The brief: *a lone figure in a saturated red coat standing three-quarter
turned in an empty concrete underpass at night, hip-height 35mm film
still, one overhead sodium streetlight as the only key, wet floor catching
thin reflections, deep unlit tunnel falling away behind, 35mm lens wide
open, fine natural film grain, muted palette, no text* — `--ar 16:9`.

Twelve bullets share the head and tail byte-for-byte and vary only the
clause between them. That is what makes the sheet a comparison rather
than twelve unrelated pictures.

The pack lives at `assets/mural-prompts/red-coat-underpass-12.md`
(12 prompts — an exception to the 5–10-per-file convention, noted in the
pack header).

---

## Tests

```bash
npm run test:mj-contact-sheet   # 27 checks, no browser, no network
```

Covers the caption derivation (including the word-boundary truncation),
the grid-cell picker, the per-variant slot map, and the HTML builder.

`e2e/mj-sheets.spec.mjs` covers the shipped page: the sheet image, the
twelve tiles, each caption tied back to its manifest entry, no truncated
caption stubs, the lightbox, the theme toggle, and zero console errors.

```bash
cd e2e && PORT=5180 node mj-sheets.spec.mjs
```

---

## Related

- `lib/mj-feed.js` — the feed gate (parsers + the in-page expressions)
- `lib/mj-feed-reconcile.js` — re-derive every slot's task id from the
  live feed and rewrite the metas
- `lib/mj-web.js` — the web backend that submits prompts
- `docs/MJ-WATCHER.md` — the drop-a-file watcher around all of it
