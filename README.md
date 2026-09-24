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
  cognitive-twin page. Regenerate with `python3
  agents/persistent-agent-loop.py dashboard --out pages/agent-dashboard.html`.
- **`pages/how-to.html`** — the operator's manual: quickstart, Twin OS,
  CLIP Interrogator, Refael, chart pipeline, song indexer, testing,
  LaunchAgents, troubleshooting. Linked from the cognitive-twin footer.
- **`lib/songs-indexer.js`** — walks audio dirs, builds
  `data/songs/catalog.json`.
- **`docs/DESIGN-RATIONALE.md`** — why the page looks the way it does.
- **`docs/COMPONENT-CATALOGUE.md`** — what each Web Component does.
- **`e2e/*.mjs`** — Puppeteer smoke tests (landing, twin-os, songs,
  cognitive-twin, clip-interrogator, refael).

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
```

Details, CLI verbs, exit codes and e2e: [`docs/CLIP-INTERROGATOR.md`](docs/CLIP-INTERROGATOR.md).

## Run the Refael MP4 Maker

No setup — it's one static HTML file. Serve it or open it from disk:

```bash
# Option A: open directly (fully offline, file:// works)
open pages/refael-mp4-maker.html

# Option B: serve it with the rest of the pages
python3 -m http.server 5173 --directory .
# then visit http://127.0.0.1:5173/pages/refael-mp4-maker.html
```

Drop an MP3, pick a track name (or hit 🎲 random), choose a render
mode, and get a 1920×1080 MP4 with a mood-keyword auto-cover. Fast
mode is WebCodecs (offline, zero network); FFmpeg.wasm lazy-loads
from unpkg on first use; Real-time uses MediaRecorder. Open with
`?selftest=1` for a built-in end-to-end render self-test.

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

The CLIP test runs against a repo-root server (no Python deps):

```bash
python3 -m http.server 5180 --directory . &
npm run e2e:clip
```

The Refael test uses the same convention:

```bash
python3 -m http.server 5180 --directory . &
npm run e2e:refael
```

The how-to page test uses the same convention (`npm run e2e:howto`),
as does the Loopable Video Segmenter test (`npm run e2e:lvs`), and
`npm run test:all` covers the watcher unit tests (chart / songs / MJ).

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
│   └── twin-os/              # the Twin OS PWA shell (Today / Songs / Twin)
├── lib/                      # pure-Node tooling + browser components
│   ├── serve.js              # zero-dep static server (also the LaunchAgent program)
│   ├── songs-indexer.js      # walks audio roots → data/songs/catalog.json
│   ├── jazz-solos-indexer.js # reads the WJazzD manifest → catalog-jazz-solos.json
│   ├── chart-export.js       # MusicXML → per-part PDFs / muted parts / MP3
│   ├── midi-export.js        # MusicXML → multi-track MIDI
│   ├── *-watcher.js          # chart / songs / reel / mj inbox watchers
│   ├── mj-prompt-generator.js# lyrics/idea → 5-10 Midjourney prompts
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
│   └── REFAEL-MP4-MAKER.md
├── assets/                   # brand assets, mural prompts, clip example images
├── bin/                      # shell wrappers for the LaunchAgents
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
