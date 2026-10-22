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

## The four things that can silently corrupt a sheet

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

### 4. A sheet that no longer came from its pack

The three failures above happen *while* a sheet is being built. The
fourth happens afterwards: someone edits the pack, re-renders one
variant, or regenerates the manifest from a different run — and the
shipped artifact quietly stops being the output of the pipeline.

**The fix is a guard on the artifact, not on the code.** A test on
synthetic input proves the builder behaves; it does not prove the
shipped sheet is what the builder produced. The gap between the two is
where drift lives.

`lib/mj-contact-sheet.test.js` (section 5) therefore walks every
directory under `assets/mj-sheets/` and pins the whole chain of
custody, **data-driven** — a second pack is covered with no edit to the
test. It asserts:

- the pack still exists and still parses with the submitter's own
  `extractPrompts`;
- the pack yields exactly the manifest's variant count;
- every prompt is `16:9`;
- it is **one brief with twelve variants** — proved by
  longest-common-prefix and longest-common-suffix, not by hardcoding
  marker strings;
- every caption is the clause that produced its tile, and every caption
  is a prefix of its own clause;
- the twelve task ids are distinct, and every tile's URL embeds its own
  task id;
- every tile's URL names the **same cell of the 4-up** the manifest
  records as its `slot` — the manifest and the URL are written by
  different parts of the builder, so they can drift apart, and a
  manifest claiming "slot 2" over a slot-1 tile misreports the
  comparison the sheet exists to make;
- every tile ships as a **local real webp with real pixels**, and **no
  two tiles are the same image**;
- the sheet PNG is a real PNG, large enough for its grid.

**It reads tracked files only.** `mj-output/` is gitignored, so a guard
that needed the metas would be skipped in CI — which is exactly where a
broken sheet would be published.

**The guard was proven by making it fail.** Eight mutations (mangled
caption, mangled task id, duplicated task id, duplicated tile, mangled
pack clause, mangled count, missing tile, stubbed PNG) were each caught
by the guard that should catch them. A guard that never fails is
decoration.

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

### The third case: a caption that lies about the camera

Variant 09 was the shipped sheet's worst lie, and it survived two
audits before anyone looked. Its caption read *overhead mirror
reflection, red coat doubled in glass*; the tile was a frontal shot
with the reflection in a mirrored ceiling. The camera was never
overhead.

The pack's own check is the first step, and it is worth doing exactly
as written — render **every** cell of the suspect job and pick the
closest one:

- the job behind tile 09 (`8fd1fb8d`) has four cells;
- put all four next to a **known-overhead** tile and ask which one is
  shot from above;
- the answer was *none of them*.

Measured geometry is not a substitute for that look. A red-mass
profile (the share of red pixels in each third of the frame) called
one cell "top-weighted, like the known overhead" — it was the
wrong cell. The red mass in a wet-floor scene is a reflection, and a
reflection moves the number without moving the camera. CLIP
image-to-image similarity is no better: ranked against the known
overhead tile it put an eye-level cell first. Two instruments, two
wrong answers, one lesson — **the sheet's audit is a look, not a
measurement.**

So: reword, re-render. `looking down from a high angle, red coat
doubled in the wet floor` delivered high-angle cells (verified by
looking, one cell at a time).

### The condition the tiles were rendered under

The re-render came back **three times darker** than the other eleven
tiles, and the reason was not the angle. The twelve original jobs
carried the account's profile **plus four moodboards**
(`--profile brvazka mhw6dpq xr39csb det21e6 67lkfw3`); a job
submitted the next day carried `--profile brvazka` only. The
moodboards are still on the account — the composer's Personalize
panel just no longer expands the profile into them, so a new job
inherits the profile and nothing else.

A controlled A/B settles it: the same reworded prompt, the same
flags, the profile codes typed into the prompt text instead of
injected by the composer.

| job | profile in the command | mean luminance | red pixels |
|---|---|---|---|
| original set (11 tiles) | profile + 4 moodboards | 0.23 – 0.39 | 28k – 265k |
| re-render, composer only | profile | 0.08 – 0.13 | 6k – 14k |
| re-render, codes in the prompt | profile + 4 moodboards | 0.26 – 0.36 | 28k – 265k |

Two things follow.

**A typed `--profile` wins cleanly.** The composer still injects its
own `--profile brvazka` when the prompt carries one, and the command
that reached Midjourney had **exactly one** `--profile` — the typed
one, with all five codes. No duplicate flag, no need to touch the
account's toggle. (The account's style codes are deliberately **not**
written into the pack: they are the account's own identifiers, and
the pack is tracked. Read them off any older job's `full_command`
instead — the feed keeps them.)

**A comparison sheet needs one rendering condition.** The shipped
tiles were all rendered under the profile and its moodboards; the
re-render was matched to them. A tile that is dark because it came
from a different account setting is not a comparison, it is a
different picture.

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

Eleven tiles are cell 0 of their job. **Variant 09 is cell 3 of
`1f583a22`** — the re-render described above; the manifest records the
slot, and the tile's own URL names the same cell.

---

## Tests

```bash
npm run test:mj-contact-sheet   # 49 checks, no browser, no network
```

Covers the caption derivation (including the word-boundary truncation),
the grid-cell picker, the per-variant slot map, the HTML builder, and
the **shipped artifact's chain of custody** (section 4 above).

The reconcile tool has its own suite:

```bash
npm run test:mj-feed-reconcile   # 43 checks, no browser, no network
```

It covers the half of `lib/mj-feed-reconcile.js` that **writes** the
pack's metas — the repair path for the pipeline, and therefore the path
that most needs a test. Among other things it pins the `taskIdChanged`
contract: two ids are the same job when one is a prefix of the other.
That tolerance is deliberate — the comparison it replaced truncated the
old id to 8 characters and compared it against a full uuid, so the
"changed" flag was **always** true, and every line of the output said
`CHANGED` even when nothing had changed.

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
  live feed and rewrite the metas. Importable (`require.main === module`
  guards the CLI), so the file-IO half is unit-testable without a
  browser; `npm run test:mj-feed-reconcile` covers it.
- `lib/mj-web.js` — the web backend that submits prompts
- `docs/MJ-WATCHER.md` — the drop-a-file watcher around all of it
