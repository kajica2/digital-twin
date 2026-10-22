# digital_twin

**→ Live at [kajica2.github.io/digital-twin/](https://kajica2.github.io/digital-twin/)**

A personal AI twin that knows your stack, your taste, your schedule,
your weird preferences. Built to run locally, learn from patterns, and
turn ten open tabs into one calm surface.

Part of [kai-systems](https://kajica2.github.io/kai-systems/) — the
meta-layer that makes all the other kai-systems stacks run
themselves.

> **Sprint 2 status:** Landing page live, Twin OS shell live, song
> indexer live, chart pipeline live, CLIP Interrogator port live,
> Refael MP4 Maker port live, Loopable Video Segmenter port live.
> The landing's CTA opens the Twin OS; the Twin OS's Songs panel
> surfaces the audio catalog plus pairing tools.
>
> **The whole family now shares one skin contract** — 39 pages themed
> from a single stylesheet, re-themed with `?skin=`. See
> [`DESIGN.md`](DESIGN.md).

## What this is

A long-running project. The landing page is the public face; the Twin
OS shell is the thing you'll actually use every day.

For now, what's here:

- **`pages/landing.html`** — the landing page. Three swappable pitches
  (Control / Persona / Architecture) via `?v=1|2|3` or the nav
  switcher. kai-systems house style (DM Serif Display + Outfit +
  JetBrains Mono, warm copper), paired light + dark, WCAG AA in both
  themes.
- **`pages/twin-os/`** — the Twin OS PWA shell (Today / Songs / Twin
  panels) with the song catalog surfaced in Songs.
- **`pages/clip-interrogator.html`** — the CLIP Interrogator port
  (image→prompt + image analysis), docs and sibling link from the
  Twin OS Songs panel.
- **`lib/clip-interrogator/`** — Python package (uv-managed venv) that
  powers the CLIP Interrogator. Gradio UI + CLI + self-check.
- **`pages/refael-mp4-maker.html`** — the Refael MP4 Maker port
  (offline MP3→MP4 with mood-keyword auto-covers; single/custom/batch),
  docs and sibling link from the Twin OS Songs panel.
- **`pages/loopable-video-segmenter.html`** — the Loopable Video
  Segmenter port (MP4→N beat-aligned mirror-loopable clips), docs and
  sibling link from the Twin OS Songs panel.
- **`lib/loopable-video-segmenter/`** — Python package (uv-managed
  venv) that powers the Loopable Video Segmenter. Gradio UI + CLI +
  self-check.
- **`pages/agent-dashboard.html`** — live view of the persistent agent
  loop (`agents/persistent-agent-loop.py`), embedded in the
  cognitive-twin page. The loop rewrites it itself on pause/exit and
  every 10 iterations; regenerate by hand with `python3
  agents/persistent-agent-loop.py dashboard --out pages/agent-dashboard.html`.
- **`pages/how-to.html`** — the operator's manual: quickstart, Twin OS,
  CLIP Interrogator, Refael, chart pipeline, song indexer, testing,
  LaunchAgents, troubleshooting. Linked from the cognitive-twin footer.
- **`pages/floating-toolset.html`** — the floating toolset: a draggable
  panel with TODAY / NOW PLAYING / CODE / PATTERNS that can be parked in
  the corner of any page. The component (`lib/floating-toolset.js`) is
  drop-in.
- **`pages/persona-social-pack.html`** — the Persona Social Pack: give it
  a URL that carries creative-persona descriptions and it returns, per
  persona, three hashtag tiers (primary / secondary / niche), YouTube
  metadata and four social posts (Instagram, TikTok, X, Facebook). The
  Gemini call is made from the browser with a key you paste; the key
  lives in `sessionStorage` and never leaves the tab. Logic in
  `lib/persona-social-pack.js`, reference in
  `docs/PERSONA-SOCIAL-PACK.md`.
- **`lib/suno-*.js`** — the Suno style-variant pipeline: ten covers of
  one song, each with a different reference-lock protocol and Audio
  Influence value. Browser-driven (the studio API needs the SPA's own
  Bearer token and a Turnstile token). `npm run suno:styles` /
  `npm run suno:run`.
- **`pages/mj-sheets.html`** — the Midjourney comparison sheet: one
  brief rendered at twelve camera angles, each tile labelled with the
  clause that produced it. Built by `lib/mj-contact-sheet.js`.
- **`lib/songs-indexer.js`** — walks audio dirs, builds
  `data/songs/catalog.json`.
- **`lib/social-engine.js`** — the social worker: it discovers the
  catalogue and the reels, tags them, writes the per-platform copy
  (reusing `lib/persona-social-pack.js`), prices them and stages a
  POST.md the poster can publish. Deterministic, no model call.
  Reference in `docs/SOCIAL-ENGINE.md`.
- **`assets/mural-prompts/STYLE-PRESETS.md`** — the 23-entry MJ style
  registry, with its generated style-study pack
  (`prompts-inbox/style-presets-vol-1.md`, dry-run validated through
  the MJ watcher).
- **`docs/DESIGN-RATIONALE.md`** — why the page looks the way it does.
- **`docs/COMPONENT-CATALOGUE.md`** — what each Web Component does.
- **`DESIGN.md`** — the skin contract, in prose. What a token is, how a
  skin is written, how to adopt the contract in a sibling repo.
- **`lib/skin-contract.js`** — the contract as code: 81 themed tokens,
  46 static, 17 page-local. The source of truth; the validator and the
  lint both read it, so the prose cannot drift from the skins.
- **`assets/skins/`** — the skins. `house.css` is the kai-systems
  house style (cream + copper + forest); `studio.css` is Suno Studio
  2.0, with the palette taken from Suno's own production CSS.
- **`lib/skin.js`** — the runtime. `?skin=studio` re-themes a page;
  the choice is remembered per browser. **`lib/theme.js`** is the
  theme half (the no-flash bootstrap 23 pages used to each carry).
- **`e2e/*.mjs`** — Puppeteer smoke tests (landing, twin-os, songs,
  cognitive-twin, clip-interrogator, refael, skin).

## Install from GitHub

Requires **macOS** (the boot core and LaunchAgents are macOS-only), **git**, and **Node 18+**. The pages are static — no build step, no bundler, no runtime dependencies.

```bash
# 1. Clone (repo path matters: boot.sh and the LaunchAgents resolve ~/digital-twin)
git clone https://github.com/kajica2/digital-twin.git ~/Documents/digital_twin
ln -s ~/Documents/digital_twin ~/digital-twin   # launchd resolves the repo through this
cd ~/digital-twin

# 2. (optional) e2e test runner — only needed to run the Puppeteer specs
cd e2e && npm install && cd ..

# 3. Run the site locally
node lib/serve.js --port 5173
#   → http://localhost:5173/pages/landing.html
#   → http://localhost:5173/pages/twin-os/        (Twin OS PWA)
#   → http://localhost:5173/pages/cognitive-twin.html
```

> **Why Node and not `python3 -m http.server`?** macOS grants filesystem
> access per-binary. Under launchd, `node` may read `~/Documents` while
> `/usr/bin/python3` is denied (`Operation not permitted`), which makes a
> python-based server return 404 for every path. `lib/serve.js` is a
> zero-dependency static server so local and LaunchAgent runs use the
> same program.

### Self-update on launch

The repo ships with **auto-update on launch** (`bin/auto-update.sh`, wired into `bin/boot.sh`):

- At every login, `boot.sh` runs `auto-update.sh` which fetches `origin/main`, **detects new commits**, and fast-forwards the repo only if there are any.
- After a clean pull it **reloads any running LaunchAgents whose code changed** (chart / songs / reel / MJ watchers + the static server) so new code goes live without a logout/login cycle.
- It **refuses to overwrite uncommitted local changes** (exit 1, logs to `logs/auto-update.log`) and tolerates being offline (exit 3, boot continues).
- Manual run: `bin/auto-update.sh` from the repo root.

### Optional: LaunchAgent boot core

The full login-boot experience (auto-update → server → open Twin OS → terminal log → Apple Notes status) runs via two LaunchAgents that already ship on this machine:

```bash
# Verify the boot core agents are loaded
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.boot   2>/dev/null | grep -E "state|program"
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.server 2>/dev/null | grep -E "state|program"

# Force the boot core to run right now
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.boot
#   → watch logs/boot-$(date +%Y%m%d).log for the auto-update + server-up lines

# (GUI-visible) open the Twin OS now
open http://127.0.0.1:5173/pages/twin-os/
```

The plist files themselves are per-machine artifacts (they hardcode `$HOME` paths), so on a fresh install recreate them from the workflow scripts in `bin/` — the schemas are documented in `docs/CHART-WATCHER.md`, `docs/SONGS-WATCHER.md`, `docs/MJ-WATCHER.md` and the `macos-launchd-automation` skill.

## Run the landing page

The page is a single self-contained HTML file. No build step.

```bash
# Option A: open directly
open pages/landing.html

# Option B: serve it (recommended — Puppeteer + mobile testing work better)
node lib/serve.js --port 5173
# then visit http://localhost:5173/pages/landing.html
```

To switch variants, either click the `v1 v2 v3` switcher in the hub
nav, or go directly:

- `?v=1` — **Control** (pragmatic tool pitch — "One screen. Everything
  that matters.")
- `?v=2` — **Persona** (emotional partner pitch — "A version of you.
  That never sleeps.")
- `?v=3` — **Architecture** (technical platform pitch — "Four layers.
  One philosophy.")

The hero, lede, features grid, and CTA wording all swap. The
architecture section, the running processes, the domain twins, the
integrations, and the footer stay the same — the *product* is
constant, the *pitch* is the A/B test.

## Run the CLIP Interrogator

The tool is a Python package under `lib/clip-interrogator/` with its own
uv-managed venv (CPython 3.12). First run downloads ~1 GB of models
into `~/.cache/huggingface` (ViT-L + BLIP; vocab embeddings come from
the clip-interrogator CDN).

```bash
# one-time setup: venv + resolved deps (commits uv.lock)
npm run clip:setup

# self-check — import + device + registry, downloads NO weights
npm run clip:check

# gradio UI on http://127.0.0.1:7860
npm run clip:ui

# real interrogation — image → prompt (best mode, ViT-L, example01.jpg)
npm run clip:interrogate

# regenerate data/clip/samples.json — the page's sample strip
# renders this catalog live when present (falls back to the baked-in
# sample on deploys, where the gitignored file doesn't exist)
npm run clip:samples
```

Details, CLI verbs, exit codes and e2e: [`docs/CLIP-INTERROGATOR.md`](docs/CLIP-INTERROGATOR.md).

## Run the Refael MP4 Maker

No setup — it's one static HTML file. Serve it or open it from disk:

```bash
# Option A: open directly (fully offline, file:// works)
open pages/refael-mp4-maker.html

# Option B: serve it with the rest of the pages
node lib/serve.js --port 5173
# then visit http://127.0.0.1:5173/pages/refael-mp4-maker.html
```

Drop an MP3, pick a track name (or hit 🎲 random), choose a render
mode + a resolution (HD · 1920×1080 default, or Regular · 1280×720
from the Resolution dropdown), and get an MP4 with a mood-keyword
auto-cover. Fast mode is WebCodecs (offline, zero network); FFmpeg.wasm
lazy-loads from unpkg on first use; Real-time uses MediaRecorder. Open
with `?selftest=1` for a built-in end-to-end render self-test.

Details and offline caveats: [`docs/REFAEL-MP4-MAKER.md`](docs/REFAEL-MP4-MAKER.md).

## Run the Loopable Video Segmenter

A Python package under `lib/loopable-video-segmenter/` with its own
uv-managed venv (CPython 3.12). **ffmpeg must be on PATH** (MoviePy
uses it for encode/decode — `brew install ffmpeg`).

```bash
# one-time setup: venv + resolved deps (commits uv.lock)
npm run lvs:setup

# self-check — imports + deps + ffmpeg presence, no model downloads
npm run lvs:check

# gradio UI on http://127.0.0.1:7861  (7860 is the CLIP Interrogator's port)
npm run lvs:ui

# headless split — beat-aligned, mirror-loopable, ZIP out
npm run lvs:segment -- video.mp4 --segments 4
```

Details, CLI flags, exit codes and e2e: [`docs/LOOPABLE-VIDEO-SEGMENTER.md`](docs/LOOPABLE-VIDEO-SEGMENTER.md).

## Run the Temple of Control

Pure client-side — no server, no Python, no build step. Two files:
`lib/meditate-temperature.js` (the visual) and `lib/midi-automap.js`
(hardware knobs). Open the page:

```bash
node lib/serve.js --port 5173
# → http://127.0.0.1:5173/pages/temple-of-control.html
```

Three temperature sliders drive a meditation visual — **heat** (colour
temperature), **breath** (motion temperature), **glow** (light
temperature). Drop a `.mid` on it and the score becomes the meditation:
note-ons ripple out, velocity drives their weight, pitch class shifts
their hue, the tempo map sets the breath rate.

To put it on any page:

```html
<script src="/lib/meditate-temperature.js"></script>
<meditate-temperature heat="0.38" breath="0.5" glow="0.58"></meditate-temperature>
```

Hardware (Maschine Mikro profiled, generic fallback) on top of it via
`lib/midi-automap.js` — three automap modes cycle from the controller's
mode button. Reference: [`docs/COMPONENT-CATALOGUE.md`](docs/COMPONENT-CATALOGUE.md).

## Run the Floating Toolset

A draggable panel with **today**, **now playing**, **code** and
**patterns** — the one-glance version of what the twin is doing. Pure
client-side, one file, no build step:

```bash
node lib/serve.js --port 5173
# → http://127.0.0.1:5173/pages/floating-toolset.html
```

To park it in the corner of any page:

```html
<script src="/lib/floating-toolset.js"></script>
<floating-toolset src="/data/twin/toolset.json"></floating-toolset>
```

The chrome bar is the drag handle, the three window lights are
functional (close / collapse / widen), and the position is remembered.
It renders in a shadow root, so it cannot fight the host page's CSS, and
it picks up the skin tokens for free. Reference:
[`docs/FLOATING-TOOLSET.md`](docs/FLOATING-TOOLSET.md).

## Run the social worker

The twin's social worker: it discovers the catalogue (`assets/marketplace/`)
and the produced reels (`reel-inbox/processed/`), tags them, writes the
per-platform copy, prices them and stages a `POST.md` the poster can
publish. Deterministic — no model call, so the same asset always yields
the same post.

```bash
npm run social:once     # one pass, then exit
npm run social:worker   # poll forever (this is what the LaunchAgent runs)
npm run social:dry      # compute and print, write nothing
npm run test:social     # the unit suite
```

It also runs as a launchd service:

```bash
launchctl print gui/$UID/com.kaidjuric.digital-twin.social-worker
pgrep -fl social-engine.js
tail -f logs/social-worker.out.log
```

**Nothing is published by default.** `posting.autoPublish` is `false`
and each item has to say `publish: true`; `posting.dryRunPoster: true`
runs the whole path — worker → `lib/ig-poster.js --dry-run` — without
reaching Instagram. The price plan (`data/social/pricing.json`) is a
document: Gumroad has no API wired here, so a human applies it.

Reference: [`docs/SOCIAL-ENGINE.md`](docs/SOCIAL-ENGINE.md).

## Post to X (Twitter)

The twin can post to X on your behalf. It needs your logged-in X
session, captured out of Chrome into a cookie jar that lives **outside**
the repo:

```bash
npm run x:capture    # read Chrome's cookie DB → ~/.x-cookies.txt (mode 0600)
npm run x:check      # validate the jar: is there a live session?
npm run x:post -- --text "hello world"
npm run x:post -- data/social/neon-pulse-cover --dry-run   # stops before the browser
```

X's API rejects this session with a 401 even when the cookie is
perfectly valid, so the poster drives the **web composer in a headed
browser** — the same shape as the Instagram poster. The session check
is therefore a page check (composer present, login wall down), not an
API call.

The 280-character limit is enforced by **weighted** counting, and the
weights were measured against X's own composer counter, not taken from
documentation: a URL counts as 23 however long it is, CJK and emoji
count as 2. The body of the caption always wins; the hashtags fill
what is left in tier order, and every tag that got cut is reported by
name.

**Nothing is published by default.** `posting.twitter.enabled` is
`false`, so X is never posted to even when an item opts in — arming it
is a deliberate edit, and it needs a valid cookie. The per-item opt-in
(`publish: true`) still applies on top of that.

Reference: [`docs/X-COOKIES.md`](docs/X-COOKIES.md).

## Run the Persona Social Pack

Point it at a page that describes creative personas and it gives every
persona on that page three hashtag tiers, YouTube metadata and four
social posts. Pure client-side — the browser calls Gemini directly, so
there is no server and no key in the repo:

```bash
node lib/serve.js --port 5173
# → http://127.0.0.1:5173/pages/persona-social-pack.html
```

Paste a Gemini API key into the page and hit **Generate pack**. The key
is kept in `sessionStorage` — it is gone when the tab closes, and it is
never written to the repo, to `localStorage`, or to any file. The model
defaults to `gemini-2.5-pro` and is overridable in the page.

Per persona you get **POST.md** (the file `lib/ig-poster.js` reads to
post a reel) and **metadata JSON** (title, description, tags and the
`--tags "a,b,c"` string `lib/youtube-poster.js` wants), plus a
pack-level **copy all hashtags** and a single JSON file for the whole
pack. The unit suite is offline — it stubs the Gemini endpoint:

```bash
npm run test:persona-social-pack   # unit suite, no network, no key
npm run e2e:persona-social-pack    # Puppeteer, Gemini intercepted
```

Reference: [`docs/PERSONA-SOCIAL-PACK.md`](docs/PERSONA-SOCIAL-PACK.md).

## Run the Suno style variants

Ten **style variants** of one song — the same source audio covered with
a different style directive and a different Audio Influence value. The
protocols live in `pages/suno-prompts.html`; the scripts read them from
there rather than keeping a second copy.

```bash
# inspect a song's settings (the reference clip's task, model, duration, tags)
npm run suno:web -- clip --id <clip_id>

# build the 10 variants and save them as Suno styles
npm run suno:styles -- --song <clip_id> --apply

# generate one song per variant
npm run suno:run -- --song <clip_id> --apply --pace 9000
```

Driven through a real browser (the studio API demands the Bearer token
the Suno SPA attaches, and generation is gated behind a Cloudflare
Turnstile that does not solve in headless Chrome). The cookie jar lives
**outside the repo** at `~/.suno-cookies.txt`.

Every run is recorded in `data/suno/style-variants.json` — titles,
protocols, influence values, clip ids. A re-run skips what is already
`ok`, so it only submits what is missing. Reference:
[`docs/SUNO-STYLES.md`](docs/SUNO-STYLES.md).

## Re-skin the family

Every page in the family is themed from one stylesheet. To see it
work, open any page with `?skin=studio`:

```bash
node lib/serve.js --port 5173
# → http://localhost:5173/pages/landing.html?skin=studio
```

The choice sticks (`localStorage['dt-skin']`); `?skin=` beats it. An
unknown skin falls back to the default **without** requesting it, so a
typo never turns into a 404 in the console.

To add a skin, write a stylesheet that defines the contract's tokens in
both scopes and drop it in `assets/skins/`:

```bash
# 1. what a skin must define
node lib/skin-tokens.js assets/skins/house.css assets/skins/studio.css

# 2. every page against every skin (the permanent guard)
node lib/skin-lint.js

# 3. the browser contract
npm run e2e:skin
```

`lib/skin-lint.js` fails the build when a page defines a contract
token of its own (which would fight the skin), when a page consumes a
token without loading a skin, or when the runtime's skin list and the
`assets/skins/` directory disagree. The eight pages that keep their own
palettes are named in the lint, with a reason each — growing that list
means re-arguing the claim.

The rules in short: **themed** tokens (colour) are declared in *both*
the light and the dark scope; **static** tokens (type, space, radius,
shadow, motion) are declared once in the base scope and are never
repeated in the dark scope — a static token may *reference* a themed
one and then resolves per theme, which is how one shadow rule serves a
cream ground and a near-black one; **local** tokens belong to a page
and a skin must never define them. Full rationale:
[`DESIGN.md`](DESIGN.md).

## Run the e2e test

```bash
cd e2e
npm install
node landing.spec.mjs
```

The landing test:
1. Spawns a local static file server on port 5173.
2. Loads the landing page in headless Chrome.
3. Switches through all three variants and screenshots each.
4. Asserts the variant switcher round-trips (`?v=1` → `?v=2` → `?v=3`
   → `?v=1`).
5. Asserts 0 console errors on each variant.
6. Saves screenshots to `e2e/artifacts/`.

The tool-page tests (clip, refael, how-to, marketplace, LVS, temple,
skin, mj-sheets) run against a repo-root server on port 5180 — the same
root the deploy serves, so a `../assets/` or `../lib/` reference that works
on the deploy also works locally:

```bash
node lib/serve.js --port 5180 &
npm run e2e:clip
npm run e2e:refael
npm run e2e:howto
npm run e2e:lvs
npm run e2e:temple
npm run e2e:skin
npm run e2e:tools-instagram
npm run e2e:mj-sheets
```

> **Why the same root locally and on the deploy?** A local harness
> that serves a *different* tree than production is a harness that
> cannot catch a broken path. The repo-root convention is the rule
> every spec now follows.

`npm run test:all` covers the watcher unit tests (chart / songs / reel
/ MJ), the skin contract + lint, the prompt lint, the agent loop, and
the python suites.

> **Prompt lint.** `npm run prompt:check` fails if any prompt pack
> names the subject's race or ethnicity. These prompts exist so a
> reference photo can be attached and the model returns what the photo
> shows — a prompt that says "a Black man" overrides the photo. See
> `assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md` § "The subject's
> identity".

## Architecture (sprint 0 + planned)

```
digital_twin/
├── pages/
│   ├── landing.html          # the public landing page
│   ├── cognitive-twin.html   # the 4-layer architecture narrative
│   ├── clip-interrogator.html # tool page for the CLIP Interrogator port
│   ├── refael-mp4-maker.html  # offline MP3→MP4 maker (single-file app)
│   ├── loopable-video-segmenter.html # tool page for the LVS port
│   ├── agent-dashboard.html   # agent-loop live view (regenerated by the loop)
│   ├── how-to.html            # operator's manual for the whole repo
│   ├── mj-sheets.html         # the Midjourney comparison sheet (12-up)
│   └── twin-os/              # the Twin OS PWA shell (Today / Songs / Twin)
├── lib/                      # pure-Node tooling + browser components
│   ├── serve.js              # zero-dep static server (also the LaunchAgent program)
│   ├── skin-contract.js      # the token contract (source of truth)
│   ├── skin-tokens.js        # skin validator
│   ├── skin-lint.js          # the permanent per-page guard
│   ├── prompt-lint.js        # no prompt may name the subject's race
│   ├── skin.js               # the browser runtime (?skin=)
│   ├── theme.js              # the shared no-flash theme bootstrap
│   ├── songs-indexer.js      # walks audio roots → data/songs/catalog.json
│   ├── jazz-solos-indexer.js # reads the WJazzD manifest → catalog-jazz-solos.json
│   ├── chart-export.js       # MusicXML → per-part PDFs / muted parts / MP3
│   ├── midi-export.js        # MusicXML → multi-track MIDI
│   ├── *-watcher.js          # chart / songs / reel / mj inbox watchers
│   ├── mj-prompt-generator.js# lyrics/idea → 5-10 Midjourney prompts
│   ├── mj-feed.js            # the Midjourney feed gate (attribution ground truth)
│   ├── mj-feed-reconcile.js  # re-derive every slot's task id from the live feed
│   ├── mj-contact-sheet.js   # a rendered pack → a captioned comparison sheet
│   ├── clip-interrogator/    # Python package (uv-managed venv)
│   └── loopable-video-segmenter/ # Python package (uv-managed venv)
├── data/                     # generated catalogs (gitignored)
│   └── songs/
│       ├── catalog.json              # audio, from `npm run index-songs`
│       └── catalog-jazz-solos.json   # MIDI corpus, from `npm run index-jazz-solos`
├── e2e/                      # Puppeteer specs (landing, twin-os, ct-*, clip, refael, how-to, lvs, watchers)
├── agents/                   # twin agent definitions
├── docs/                     # design + engraving, watcher, export, and tool references
│   ├── DESIGN-RATIONALE.md
│   ├── COMPONENT-CATALOGUE.md
│   ├── ARCHITECTURE.md
│   ├── CLIP-INTERROGATOR.md
│   ├── LOOPABLE-VIDEO-SEGMENTER.md
│   ├── MJ-CONTACT-SHEET.md
│   └── REFAEL-MP4-MAKER.md
├── assets/                   # brand assets, mural prompts, clip example images
│   ├── skins/                # the skins: house.css (kai-systems) + studio.css (Suno)
│   ├── mural-prompts/        # MJ prompt packs (one top-level bullet per prompt)
│   └── mj-sheets/            # rendered comparison sheets + tiles + manifests
├── bin/                      # shell wrappers for the LaunchAgents
├── DESIGN.md                 # the skin contract, in prose
└── README.md                 # this file
```

### The Song indexers

Two independent catalogs feed the Songs panel:

| Catalog | Built by | Source | Content |
|---------|----------|--------|---------|
| `catalog.json` | `npm run index-songs` | `lib/sources.config.json` roots | your own audio (mp3 / wav / aiff), ID3 + RIFF metadata |
| `catalog-jazz-solos.json` | `npm run index-jazz-solos` | `~/Documents/jazz solos/manifest.csv` | the [Weimar Jazz Database](https://jazzomat.hfm-weimar.de/dbformat/dbcontent.html) solo archive — 456 transcribed solos with MIDI + engraved PDF |

Both are generated artifacts and are `.gitignore`d. The `catalog-jazz-solos.json`
indexer also cross-checks every manifest row against the files actually on disk,
so a stale manifest surfaces as a reported discrepancy rather than a broken row.

### MusicXML → PDF

```bash
npm run musicxml-pdf -- score.musicxml                 # one file → ./pdf-out/score.pdf
npm run musicxml-pdf -- ./scores --out ./pdf           # a directory, walked recursively
npm run musicxml-pdf -- ./scores --out ./pdf --jobs 4  # parallel
npm run musicxml-pdf -- ./scores --out ./pdf --dry-run # list without rendering
```

Handles plain `.musicxml` / `.xml` and compressed `.mxl` (the ZIP container
MuseScore and most engravers ship). Requires `mscore` on PATH
(`brew install --cask musescore`).

This is the single-purpose path — one PDF per score. The full chart pipeline
(`npm run export-all`) additionally splits parts, builds muted backing
variants, writes a manifest, and exports MIDI + MP3.

Two behaviours worth knowing:

- **It reads the file, not the exit code.** MuseScore's Qt shutdown routinely
  exits 134 (SIGABRT) *after* writing a complete PDF, so success is judged by
  the output file existing and being non-empty.
- **Malformed input is rejected before MuseScore is invoked.** MuseScore does
  not fail on truncated or crossed-tag MusicXML — it hangs. A tag-stack check
  (`lib/xml-guard.js`) turns a multi-minute stall into an instant, named error.
  Compressed `.mxl` files skip that check (they're ZIPs) and rely on a
  `--timeout` instead.

### MJ contact sheet

```bash
node lib/mj-contact-sheet.js --pack red_coat_underpass_12 \
  --out assets/mj-sheets/red-coat-underpass-12/contact-sheet.png \
  --tiles assets/mj-sheets/red-coat-underpass-12/tiles \
  --manifest assets/mj-sheets/red-coat-underpass-12/sheet-manifest.json \
  --title "Red Coat Underpass"
```

Turns a rendered pack into a comparison sheet: one tile per prompt, in a
grid, each captioned with the clause that produced it. `--slots "2=1,5=3"`
picks a specific cell of a prompt's 4-up grid per variant, because
Midjourney's four cells are four different takes on the brief, not four
copies of one framing.

Two things are worth knowing before trusting a sheet:

- **Attribution comes from the feed, not the page.** The imagine feed is a
  shared timeline — the account owner's own concurrent jobs sit in it. A
  matcher that reads a card's text and looks for the prompt inside it
  attributed 6 of 12 tiles to the wrong job. Task ids are re-derived from
  the feed's own command string (`lib/mj-feed.js`), and only plain `16:9`
  `v8.2` jobs are accepted.
- **A successful job is not evidence that the angle landed.** Midjourney
  quietly ignored the overhead-crane and dutch-tilt instructions on the
  first pass. Both were reworded, re-rendered, and re-checked against the
  image before acceptance.

The shipped example is `assets/mj-sheets/red-coat-underpass-12/`
(sheet + 12 tiles + a provenance manifest) and the page that presents it
is `pages/mj-sheets.html`. Full reference:
[`docs/MJ-CONTACT-SHEET.md`](docs/MJ-CONTACT-SHEET.md).

## Design system

Intentionally matches the [kai-systems](https://kajica2.github.io/kai-systems/)
house style. Same color tokens, same type stack, same hex mark, same
section kicker style, same "design once · runs forever" closing.

- **Light:** warm cream `#f7f5f0` background, copper `#c97b3f` primary,
  forest `#2f6f5e` accent, ink `#14171e`.
- **Dark:** warm near-black `#1a1812` background, lifted copper
  `#d9925a` primary, lifted forest `#6ab098` accent, warm cream ink.
- **Type:** `DM Serif Display` (display) + `Outfit` (body) +
  `JetBrains Mono` (kickers, labels, demo).
- **Theme:** light + dark shipped together, with a system default and
  an explicit toggle. Both themes clear WCAG AA.

## Why three variants?

The pitch for "autonomous digital twin" is genuinely unclear. We don't
know yet whether the user (me) wants this framed as:

1. **Control** — a tool, a dashboard, a cockpit
2. **Persona** — a partner, a counterpart, a presence
3. **Architecture** — a platform, a stack, a system

The landing page makes all three pitches concrete and clickable. We
spend a week or two with each variant "on" (via `?v=N`) and see which
one makes us want to actually use the thing. That's the A/B test.

## Why the kai-systems house style?

Because the digital_twin is already a *spoke* of kai-systems (the 7th
card on the hub), not a separate product. Using the same visual
language makes the page read as a true extension of the hub — same
color story, same hex mark in the same position, same editorial
rhythm, same closing line. The director-mode reference the user also
pointed at (the `browser-use` landing) was the *craft* reference
(production polish, paired themes, Web Components, animations,
accessibility) — and that craft is preserved here, just wearing the
kai-systems visual clothes.

## What's next

- **Sprint 1** — Twin OS shell. The Today / Songs / Twin panel layout
  the landing page's CTA points to. A real PWA, installable on the
  Mac.
- **Sprint 2** — Song indexer. Walk `~/Documents/{jazz solos,
  meditations, music_to_mp4}`, extract metadata, build a searchable
  catalog.
- **Sprint 3+** — The actual twin. Pattern memory, persistent
  identity, agent fleet. TBD based on what sprint 0-2 reveal.
