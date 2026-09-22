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
> Refael MP4 Maker port live.
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
- **`lib/songs-indexer.js`** — walks audio dirs, builds
  `data/songs/catalog.json`.
- **`docs/DESIGN-RATIONALE.md`** — why the page looks the way it does.
- **`docs/COMPONENT-CATALOGUE.md`** — what each Web Component does.
- **`e2e/*.mjs`** — Puppeteer smoke tests (landing, twin-os, songs,
  cognitive-twin, clip-interrogator, refael).

## Run the landing page

The page is a single self-contained HTML file. No build step.

```bash
# Option A: open directly
open pages/landing.html

# Option B: serve it (recommended — Puppeteer + mobile testing work better)
cd pages && python3 -m http.server 5173
# then visit http://localhost:5173/landing.html
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
python3 -m http.server 5173 --directory pages
# then visit http://127.0.0.1:5173/refael-mp4-maker.html
```

Drop an MP3, pick a track name (or hit 🎲 random), choose a render
mode, and get a 1920×1080 MP4 with a mood-keyword auto-cover. Fast
mode is WebCodecs (offline, zero network); FFmpeg.wasm lazy-loads
from unpkg on first use; Real-time uses MediaRecorder. Open with
`?selftest=1` for a built-in end-to-end render self-test.

Details and offline caveats: [`docs/REFAEL-MP4-MAKER.md`](docs/REFAEL-MP4-MAKER.md).

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

The CLIP test runs against a pages-rooted server (no Python deps):

```bash
python3 -m http.server 5180 --directory pages &
npm run e2e:clip
```

The Refael test uses the same convention:

```bash
python3 -m http.server 5180 --directory pages &
npm run e2e:refael
```

## Architecture (sprint 0 + planned)

```
digital_twin/
├── pages/
│   ├── landing.html          # the public landing page (sprint 0)
│   ├── cognitive-twin.html   # the 4-layer architecture narrative
│   ├── clip-interrogator.html # tool page for the CLIP Interrogator port
│   ├── refael-mp4-maker.html  # offline MP3→MP4 maker (single-file app)
│   └── twin-os/              # the actual twin PWA shell (sprint 1)
├── lib/
│   ├── songs-indexer.js      # audio metadata → catalog.json
│   ├── chart-export.js       # MusicXML → parts / PDF / MP3 / MIDI
│   └── clip-interrogator/    # Python package (uv-managed venv)
├── data/                     # generated catalogs
├── e2e/                      # Puppeteer specs (landing, twin-os, ct-*, clip, refael)
├── agents/                   # twin agent definitions (sprint 2+)
├── docs/
│   ├── DESIGN-RATIONALE.md
│   ├── COMPONENT-CATALOGUE.md
│   ├── ARCHITECTURE.md
│   ├── CLIP-INTERROGATOR.md
│   └── REFAEL-MP4-MAKER.md
├── assets/                   # brand assets + clip example images
└── README.md                 # this file
```

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
