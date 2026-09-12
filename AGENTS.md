# AGENTS.md — digital_twin

> Project context for any agent (Mavis, future-Coder, future-Reviewer,
> human collaborator) working in this repo. Read this before
> proposing changes, opening PRs, or running the e2e tests.

---

## What this project is

**digital_twin** is a personal AI twin that knows your stack, your
taste, your schedule, your weird preferences. It runs locally, learns
from patterns, and turns ten open tabs into one calm surface. It is
the seventh spoke of the **kai-systems** series — the meta-layer
that makes all the other kai-systems stacks run themselves.

The full positioning lives in the landing page
(`pages/landing.html`) and the deep-dive on the kai-systems hub
(`https://kajica2.github.io/kai-systems/twin/`). Read both before
changing copy.

The kai-systems design tokens live at
`https://kajica2.github.io/kai-systems/assets/shared.css` and **must
be matched** by this project — the visual language is shared. Do not
introduce new colors or fonts without first checking the kai-systems
hub.

## Current state (sprint 0)

Shipped:

- **`pages/landing.html`** — single self-contained HTML file. Three
  A/B-testable variants (`?v=1|2|3`) sharing a common architecture
  section, running-processes flow, and 4 domain twins. The landing
  is the public face of the project.
- **`docs/DESIGN-RATIONALE.md`** — why the page looks the way it does.
- **`docs/COMPONENT-CATALOGUE.md`** — what each Web Component does.
- **`e2e/landing.spec.mjs`** — Puppeteer smoke test (see "E2E" below).
- **`README.md`** — how to run the page and the test.

Not yet built (queued for sprint 1+):

- **`pages/twin-os/`** — the actual Twin OS PWA shell. Three panels:
  Today / Songs / Twin. This is the thing the landing page's CTA
  points to. Installable PWA, runs locally, IndexedDB-backed.
- **`lib/songs-indexer.js`** + **`data/songs/catalog.json`** — the
  song indexer. Walks `~/Documents/{jazz solos, meditations,
  music_to_mp4}`, reads ID3/WAV metadata, builds a searchable
  catalog.
- **`agents/*.md`** — twin agent definitions (one per domain: music,
  trumpet, web, research, ...). These describe the work the orchestrator
  can dispatch to.
- **`docs/ARCHITECTURE.md`** — codebase-level architecture (the
  "how" the codebase is organized, distinct from the "how the twin
  works" documented in the landing page).

## Architecture of the *product* (the twin system)

The twin is composed of **four layers**, each doing one job:

1. **Scanner** — traverses the filesystem, reads `package.json` /
   `requirements.txt` / installed packages / agent skills / GitHub
   repos / Obsidian vault. Outputs a structured inventory of "what
   do I have right now?"
2. **Model** — persists that inventory as memory. Three layers:
   `memory/user.md` (cross-project), `memory/agent.md` (agent
   behavior), `AGENTS.md` (per-repo). The model is the durable twin.
3. **Reasoner** — routes work to tools. Reads the model, picks the
   right combination. Constrained routing, not freeform LLM
   reasoning.
4. **Orchestrator** — sets up and runs the process. Subagent prompts,
   cron schedules, webhooks, Puppeteer gates. Handles failure:
   retry, rollback, escalate to the human digest with a diff.

This 4-layer architecture is documented on the landing page's
"Architecture" section and is canonical — do not break it without
consulting the kai-systems twin deep-dive.

## Architecture of the *codebase*

```
digital_twin/
├── pages/
│   ├── landing.html          # the public landing page (sprint 0)
│   └── twin-os/              # the actual twin PWA shell (sprint 1)
├── lib/                      # shared components (sprint 1+)
│   ├── shell.html
│   ├── today.js
│   ├── songs.js
│   └── twin.js
├── data/                     # generated catalogs
│   └── songs/catalog.json    # built by lib/songs-indexer.js (sprint 1)
├── e2e/
│   ├── landing.spec.mjs      # Puppeteer test (sprint 0)
│   └── twin-os.spec.mjs      # Puppeteer test (sprint 1)
├── agents/                   # twin agent definitions (sprint 2+)
├── docs/
│   ├── DESIGN-RATIONALE.md   # why the page looks the way it does
│   ├── COMPONENT-CATALOGUE.md# what each Web Component does
│   └── ARCHITECTURE.md       # codebase architecture (sprint 1)
├── assets/                   # brand assets
├── AGENTS.md                 # this file
└── README.md
```

Conventions:

- **Vanilla HTML + CSS + JS.** No bundler, no framework, no
  TypeScript. The pattern is proven (see RESONA, kai-systems). Every
  file is openable in a text editor and runs from a `python3 -m
  http.server` with zero install.
- **Web Components for distinct UI pieces.** `customElements.define`
  in inline scripts. No React, no Vue, no Lit.
- **CSS custom properties as design tokens.** All colors, spacing,
  radii, shadows, motion live under `:root`. No magic numbers in
  component styles.
- **Paired light + dark theming, shipped together.** System default
  via `prefers-color-scheme`, explicit override via `<theme-toggle>`,
  persisted to `localStorage.dt-theme-pref`, no-flash bootstrap
  script in `<head>` before first paint. Both themes must clear WCAG
  AA contrast.
- **MIT license** (matches the kai-systems series).
- **No Web3.0 hooks.** This is a personal local-first project, not a
  dApp. Don't add wallet connect, IPFS refs, or chain reads.
- **Puppeteer is the test runner.** See "E2E" below.

## E2E (Puppeteer)

**Every sprint that produces user-visible output runs the e2e
before reporting done.** The test must pass. If it fails, the
sprint isn't done — fix and re-run.

The current e2e (`e2e/landing.spec.mjs`) covers the landing page:

- Spawns a local static file server on port 5173.
- Loads the landing page in headless Chrome (prefers system Chrome at
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; falls
  back to puppeteer's bundled Chrome).
- Switches through all three variants (`?v=1|2/3`) and screenshots
  each, in both light and dark themes.
- Asserts the variant switcher round-trips, the features grid
  populates with 6 cards per variant, the demo mockup renders 4
  panes, the architecture has 4 levels, the flow has 4 nodes, the
  domain twins have 4 cards, the hub-nav is present, and 0 console
  errors fire.
- Saves screenshots to `e2e/artifacts/`.

```bash
cd e2e
npm install
node landing.spec.mjs
```

If a new test fails, **fix the page, not the test**, unless the test
itself is wrong. The test encodes the user-visible contract; the page
is what's allowed to change.

## Puppeteer deploy-test loop (memory rule)

This rule comes from the agent memory (see `~/.minimax/agents/mavis/memory/MEMORY.md`):

> Any web/PWA deploy is NOT done until a Puppeteer test visits the
> deployed URL and verifies concrete requirements; loop
> fix/redeploy/retest until green.

The pattern: when this project is deployed to GitHub Pages or
Vercel, the deploy is not done until `e2e/landing.spec.mjs` (or the
sprint-1 equivalent for the Twin OS) is updated to hit the deployed
URL and assert the same checks pass. The deploy is in a loop until
green.

## Sprint plan

- **Sprint 0 (shipped):** landing page + variant switcher + e2e.
- **Sprint 1 (next):** Twin OS shell (PWA, Today/Songs/Twin panels) +
  song indexer (walks `~/Documents/{jazz solos, meditations,
  music_to_mp4}`, extracts metadata, writes `data/songs/catalog.json`)
  + a `docs/ARCHITECTURE.md` documenting the codebase.
- **Sprint 2+:** the actual twin runtime. Pattern memory, persistent
  identity, agent fleet, cron self-reminders per the running
  processes the landing already advertises. Scope TBD based on what
  sprint 1 reveals.

## Things to remember

- **The twin is local-first.** Sync is opt-in, not default. Never
  store user data in a service without an explicit opt-in.
- **The twin is calm, not chatty.** Every feature should default to
  "silent unless something matters." No eager notifications, no
  pings, no "by the way did you know..." nudges.
- **The architecture is the system, the tools are the binding.**
  When a tool changes (and they will, every quarter), the structure
  holds. Don't hardcode tool assumptions into the architecture.
- **Mavis is the orchestrator runtime.** Use its memory and cron
  layers for cross-project context and scheduled self-reminders. See
  `~/.minimax/agents/mavis/memory/MEMORY.md` for the agent memory
  pattern.
- **The user is Kajica.** See `~/.minimax/memory/user.md` (read-only
  for agents) for cross-project preferences. Local repo git config
  may override global — use the `Kajica Djuric <kai.djuric@gmail.com>`
  author flags on commits (see user memory entry dated 2026-07-06).

## When you finish a sprint

1. Run the e2e. If it fails, fix and re-run.
2. Update `README.md` if the run instructions changed.
3. Update `docs/COMPONENT-CATALOGUE.md` if you added/changed Web
   Components.
4. Update `docs/DESIGN-RATIONALE.md` if the design system shifted.
5. Append a sprint note to the bottom of this file (see "Sprint log"
   below).

## Sprint log

### 2026-08-03 — sprint 0

- **Shipped:** `pages/landing.html` + design system + variant switcher
  + e2e + design rationale + component catalogue + README.
- **Decisions:** Adopted the kai-systems house style (DM Serif Display
  + Outfit + JetBrains Mono, warm cream + copper + forest). Built the
  landing as one HTML file with three swappable variants
  (`?v=1|2/3`) for A/B testing positioning. Dropped the
  "Solo/Studio/Collective" SaaS pricing tier and replaced it with the
  4-layer architecture story (Scanner/Model/Reasoner/Orchestrator)
  because that's the actual product, not a commercial offering.
- **Open:** the architecture table on the landing should eventually
  link to deeper docs. Right now it links to the kai-systems twin
  deep-dive.
- **Next:** sprint 1 — Twin OS shell + song indexer.

### 2026-08-03 — sprint 1 (kickoff)

- **Shipped:** `pages/twin-os/` — the Twin OS PWA shell.
  - `index.html` — single-file shell, 3-panel nav (Today / Songs /
    Twin), kai-systems house style, paired light + dark theme,
    Web Components for `<theme-toggle>`, URL-hash routing, responsive
    collapse to bottom-tabs on narrow viewports.
  - `manifest.webmanifest` — installable PWA (macOS, iPadOS, iOS).
    Two SVG icons (180×180 + 512×512 maskable), inline data URIs,
    no asset files.
  - `sw.js` — service worker stub. Caches the shell on install,
    pass-through fetch in `activate`. Sprint 2 will add cache-first
    for static + network-first for the catalog.
  - `e2e/twin-os.spec.mjs` — Puppeteer smoke test (mirrors
    `landing.spec.mjs`). Asserts 3 panels, default=Today, panel
    switcher roundtrips, 4 agenda items, 3 pattern cards, 3 stat
    cards, theme toggle (3 buttons), 0 console errors, screenshots
    in light + dark + mobile.
- **Decisions:** Started with 3-panel nav (Today / Songs / Twin) per
  the AGENTS.md contract. The landing's `<twin-demo>` shows 4 panes
  (today / now playing / code / patterns) — folded the patterns pane
  into Today as a sub-section (it's "your daily patterns", not its own
  panel) and kept Songs/Twin as their own panels. Songs panel is an
  explicit empty-state ("Indexer not wired yet — sprint 1 is the
  shell; sprint 2 surfaces the catalog here") so the contract is
  clear from the UI itself.
- **Open:** The landing's CTA still points at `#architecture` (same-
  page anchor). Sprint 1's release should wire it to
  `/pages/twin-os/index.html` once the songs indexer is real. Doing
  it now would ship a CTA that 404s on the songs panel until sprint 2
  lands.
- **Next:** sprint 1 part 2 — `lib/songs-indexer.js` +
  `data/songs/catalog.json`. Walk the audio dirs, read ID3 + WAV
  metadata, surface the catalog in the Songs panel.

### 2026-08-03 — sprint 2

- **Shipped:**
  - `lib/songs-indexer.js` — pure-Node, no-deps audio metadata
    extractor. Walks a configurable list of root dirs (from
    `lib/sources.config.json`), reads MP3 ID3v2 (TIT2 / TPE1 / TALB /
    TYER / TDRC / TCON / TBPM / TRCK / TKEY) and WAV RIFF/fmt + LIST/INFO
    chunks, writes `data/songs/catalog.json`. Defaults to
    `--apply --yes` so it composes with cron + npm. Strips absolute
    filesystem paths from the shipped output (per §11 hygiene) — use
    `--keep-abspath` for local debugging only.
  - `lib/sources.config.json` — declares the roots. Defaults to the
    AGENTS.md-named dirs (`~/Documents/jazz solos`,
    `~/Documents/meditations`, `~/Documents/music_to_mp4`). Update
    this file to point at wherever audio actually lives. The indexer
    treats missing roots as a logged warning, not an error.
  - `data/songs/catalog.json` — generated. Schema: `{ generatedAt,
    durationMs, roots: [{label, found, missing, pathHint}], items:
    [{id, label, relPath, format, size, mtime, tags, durationSec,
    sampleRate, channels}] }`.
  - Songs panel UI — replaced the sprint-1 empty-state with three
    real states: loading, configured-empty (shows the configured
    roots + how to point them at real audio), and catalog (grouped
    by label, with format chip + title + tech meta + size +
    duration). Search input filters by title / artist / path /
    genre with a debounced match counter.
  - Service worker promoted from sprint-1 pass-through stub to a
    real fetch handler. Cache-first for the shell (offline-capable),
    network-first with cache fallback for the catalog (so updates
    land fast but the PWA still opens offline).
  - Landing CTA "Open the twin" now points at `./twin-os/`. The
    closing CTA at the bottom still points at GitHub (source repo).
  - `e2e/twin-os-songs.spec.mjs` — third e2e spec, 18 assertions.
    Detects whether the catalog is empty (configured-empty-state) or
    populated (catalog view) and asserts accordingly. Tests search
    filtering, search count, format chip, row count, 0 console
    errors, light + dark screenshots.
  - `npm run index-songs` — wires the indexer into npm.
  - CI updated: pages-test workflow now runs all three e2e
    specs in sequence on push (against the live URL) and on PR
    (locally). Workflow keeps the absolute-path cd fix from
    sprint-1's commit `19b84c2`.
- **Decisions:**
  - **AGENTS.md drift surfaced, not silently worked around.** The
    AGENTS.md sprint plan says the indexer walks three specific
    dirs. As shipped, those three dirs contain zero audio files:
    one is the WJAZD corpus (scholarly MIDI transcriptions, not
    audio), one is empty, one is an `isf_studio` web app + a
    handful of shader-demo WAVs. The actual audio lives elsewhere
    in the personal corpus. Built the indexer to walk the named
    dirs as AGENTS.md specifies, accept an empty result gracefully,
    and surface the configured paths in the empty-state UI so the
    next agent knows where to point it. Did NOT silently enumerate
    the actual audio locations — that would violate §11 hygiene
    and ship the author's filesystem shape into a public repo.
  - **Path redaction is on by default.** The shipped catalog
    strips `absPath` from every item and replaces the root `path`
    with `pathHint = label`. The Twin OS panel never used
    `absPath` anyway, so this is a no-op for the UI but a real
    safety for the public repo. `--keep-abspath` for local debug.
  - **3-panel structure preserved.** The Songs panel stays one of
    the 3 panels (not a sub-section of Today), because the
    catalog is its own dataset with its own UX (filter / search /
    grouped list). Patterns-on-Today is the "your daily rhythms"
    surface; Songs is the "what audio do you have" surface.
- **Open:**
  - Sources config still points at the AGENTS.md-named dirs, which
    return empty. To populate the Songs panel with real audio,
    edit `lib/sources.config.json` to point at where audio
    actually lives, then `npm run index-songs`. The empty-state UI
    tells the user this without leaking the real paths.
  - `jazz solos/manifest.csv` has 456 entries with rich metadata
    (performer, title, instrument, style, year, tempo, tones) but
    is CSV, not audio. A future sprint could add a CSV catalog
    alongside the audio catalog (`catalog-jazz-solos.json`) so
    the MIDI corpus is searchable too. Defer until asked.
  - FLAC / M4A / AAC / OGG parsing deferred. The indexer is
    structured so adding a new format is one parseX() function +
    one SUPPORTED_EXTS entry.
- **Next:** sprint 3 candidates — (a) wire the songs indexer into
  a daily cron that auto-rebuilds the catalog on push; (b) add
  the jazz-solos CSV catalog so MIDI metadata is searchable; (c)
  start the actual twin runtime (pattern memory + cron self-
  reminders). Scope TBD based on what the populated Songs panel
  reveals about the audio corpus shape.

### 2026-09-09 — sprint 0.1 (boot-core)

- **Shipped:** launchd-driven boot for the Twin OS. Two LaunchAgents:
  - `com.kaidjuric.digital-twin.server` (`KeepAlive=true`) — serves the
    repo on `:5173` via `python3 -m http.server 0.0.0.0`, owned by
    launchd so its lifecycle survives boot.sh exit.
  - `com.kaidjuric.digital-twin.boot` (`RunAtLoad=true`) — orchestrator:
    `git pull --ff-only`, ensure server, wait for health, open a
    visible Terminal tailing the server log, open the Twin OS in the
    default browser, post a one-line status to Apple Notes under a
    `twin OS` folder.
- **Scripts:** `bin/boot.sh`, `bin/notes.applescript`,
  `bin/terminal-log.applescript`. Stickies AppleScript explored and
  abandoned — modern macOS does not expose the Stickies document model
  to AppleScript (`sticky` / `stickies` classes return `not defined`).
  Apple Notes is the scriptable alternative; same desktop-visible +
  iCloud-synced behavior.

### 2026-09-09 — sprint 0.2 (agenda-input + muScriptor)

- **Shipped:**
  - **Today panel textfield** — `form[data-agenda-add]` below the
    seeded agenda. Submit (Enter / Add button) appends a
    `.agenda-item[data-user="true"]` row with a × remove control.
    Persists in `localStorage["dt-agenda-items"]` as
    `{id, text, addedAt, done}`. Survives reload. Seeded items stay
    static; user items render after, with a subtle copper highlight.
  - **Songs panel Tools section** — `.tool-grid` with a MuScriptor
    card linking to `https://muscriptor.kyutai.org/`. Card describes
    the output (MIDI, per-instrument sheet-music PDFs, full score,
    MusicXML) and the local-only command (`uvx muscriptor serve`).
    Grid layout so future tools slot in next to it.
- **Decisions:**
  - Form follows the existing `.song-search` visual pattern (warm
    cream input, copper focus ring). The Add button uses the copper
    primary so it reads as a primary action without competing with
    the rail.
  - Seeded items kept as static markup instead of merging them into
    the storage list. This avoids "do I show seeds or user's items?"
    drift and keeps the first-load visual contract stable.
  - Text is HTML-escaped before insertion; matches the pattern used
    in the songs panel.

### 2026-09-09 — sprint 0.3 (engraving reference)

- **Shipped:** `docs/COLTRANE-SHAW-ENGRAVING.md` — 275-line reference
  encoding the conventions for engraving post-bop / modal jazz scores
  in the styles of John Coltrane and Woody Shaw. Covers: full-band
  and jazz-band staff order, part-prep rules (page turns, cue notes,
  multi-measure rests), section-specific engraving, Coltrane sax
  conventions (Trane slurs, ghost notes, sheets of sound, altissimo,
  multiphonics), Shaw trumpet conventions (no 8va, popped highs,
  acciaccatura grace notes, scoops, half-valve, Harmon mute), full-
  band implications for rhythm section + horn backgrounds, rhythmic
  feel notation (metric modulation, double-time feel, laying back),
  per-section checklist.
- **Decisions:** The twin's domain is jazz. Standard classical
  engraving rules do not apply. This doc gives future agents a
  shared reference so transcriptions / original charts stay
  consistent regardless of which agent produced them.

### 2026-09-09 — open + next

- **Open:**
  - Original chart composition in the style of Woody Shaw: not yet
    started. The reference doc is in place; next sprint will scaffold
    a chart (trumpet + rhythm) once the head's melody/chords/tempo
    land.
  - Branch `feat/agenda-input` has the 0.1/0.2/0.3 commits ready to
    push + PR.
- **Next:** push `feat/agenda-input`, open PR. Then start the Woody
  Shaw chart sprint (0.4) — head + harmony + rhythm-section voicings
  following the conventions in §6/§9 of the new doc.

### 2026-09-09 — sprint 0.4 (chart export pipeline)

- **Shipped:**
  - `lib/chart-export.js` — pure-Node, no deps. Splits a MusicXML
    score into per-instrument MusicXML parts (named per the convention
    from `docs/COLTRANE-SHAW-ENGRAVING.md` §2), writes a JSON manifest,
    and produces two muted variants (`No_Trumpet`, `No_Sax`) by removing
    both the `<part>` elements AND their `<score-part>` declarations
    from the part-list (orphan declarations would break strict
    consumers like MuseScore).
  - `lib/midi-export.js` — pure-Node, no deps. Reads MusicXML, emits
    a valid SMF 1.0 multi-track MIDI (conductor track + one per part,
    program-change per channel, note-on/note-off events). The MIDI is
    the input for Soundslice sync, Synthesia-style highlight videos,
    DAW re-import, and notation software round-trip.
  - `docs/CHART-EXPORT-WORKFLOW.md` — canonical reference for the
    pipeline, including the MuseScore one-click render steps and the
    Soundslice sync workflow.
  - `package.json` exposes `npm run export-parts` and
    `npm run export-midi` matching the existing `--apply --yes` convention
    from `npm run index-songs`.
- **Decisions:**
  - **No PDF / WAV generation inside the scripts.** This machine has
    no MuseScore / Sibelius / Dorico and no MIDI soundfont synth
    (no `timidity`, `fluidsynth`, or `mido`). The scripts produce
    MusicXML inputs + a manifest; the user runs MuseScore (or their
    DAW) once for the final render. The pipeline's value is in the
    **automated part-splitting + selective muting**, which is the
    slow tedious bit when done by hand.
  - **Staff order matches the engraving doc, not the input order.**
    The user's MuseScore may have entered the parts in any order;
    `chart-export.js` reorders them per §2 so the per-instrument
    filenames (`01_…`, `02_…`) match the band-staff layout.
  - **Transposition labels are inferred from part-name patterns** —
    Trumpet → Bb, Alto Sax → Eb, etc. No hard-coded instrument list;
    unknowns (custom part-names) fall through with C label.
- **Verified end-to-end:**
  - `node lib/chart-export.js /tmp/mini-score.musicxml --apply --yes`
    produces 4 output dirs (PDF, No_Trumpet, No_Sax, Whole) with
    per-instrument MusicXML parts + manifest + READMEs.
  - music21 round-trip parse of every output (`parts/*.musicxml`,
    `score.musicxml` in both muted variants) returns the expected
    part list.
  - `node lib/midi-export.js /tmp/mini-score.musicxml --apply --yes`
    produces a 4-track, 88-byte MIDI that music21 parses back to 4
    valid tracks.
- **Open:**
  - Percussion-channel mapping (channel 9 / GM percussion keys) is
    not yet applied — drum parts come through as literal MIDI note
    numbers when the source MusicXML doesn't tag them as channel 9.
    Sprint 0.5 candidate.
  - Chord symbol extraction / lyric / rehearsal mark handling —
    present in MusicXML, not yet parsed. Add when a real chart in
    the wild shows what's worth deepening.
- **Next:**
  - sprint 0.5 — first real chart (Woody Shaw-style). User provides
    the head + chord changes + form; the agent produces the
    trumpet-feature part + rhythm-section voicings following the
    conventions in `docs/COLTRANE-SHAW-ENGRAVING.md` §6/§9, then
    runs the export pipeline against the produced MusicXML.

### 2026-09-09 — sprint 0.4.b (tooling + automation)

- **Installed via Homebrew:**
  - `musescore` (cask, 4.7.5) — `/Applications/MuseScore 4.app` +
    `/opt/homebrew/bin/mscore`. The CLI wrapper exports PDFs and MP3s
    directly from MusicXML: `mscore -f input.musicxml -o output.pdf`
    and `mscore -f input.musicxml -o output.mp3`. Bundles `MS Basic.sf3`
    — no separate SoundFont install needed for the chart pipeline.
  - `fluid-synth` (2.6.0) — installed as a fallback for headless
    MIDI→audio rendering on hosts without MuseScore's bundled sounds.
- **`lib/chart-export.js` gains `--render`:** invokes `mscore` to
  produce the full score PDF, per-part PDFs, and the two muted
  backing tracks. Detection uses **file existence** rather than exit
  code (MuseScore's Qt shutdown can complete the export and then
  exit non-zero on macOS — the file IS the source of truth).
- **`package.json` gains `npm run export-all`:** one command runs
  the whole pipeline (MusicXML splits → PDFs → MP3s → MIDI). Six-
  second end-to-end test on a 3-part fixture.
- **Verified:** `npm run export-all -- /tmp/mini-score.musicxml`
  produces: 1 × Full_Score.pdf, 3 × per-part PDFs, 2 × muted MP3s,
  1 × .mid of the whole arrangement, plus the MusicXML inputs
  preserved. All files validated as real PDFs / MP3s / MIDI via
  `file` and music21 round-trip.
- **Open:** None blocking. The pipeline is fully self-sufficient.
- **Next:** sprint 0.5 — first real Woody Shaw-style chart. The
  tooling is in place; user supplies the head + changes.

### 2026-09-12 — sprint 0.5 (cognitive-twin page)

- **Shipped:**
  - **`pages/cognitive-twin.html`** — single-file narrative page
    documenting the 4-layer cognitive twin architecture (Scanner /
    Model / Reasoner / Orchestrator). Sections: hero, click-to-
    expand layer architecture diagram, 4 running processes, 6
    domain twins (music, transcription, web, research, …), 12-item
    toolchain, and the canonical memory model
    (`memory/user.md` / `memory/agent.md` / `AGENTS.md`).
    Paired light/dark via CSS custom properties + `prefers-color-
    scheme` + manual `<theme-toggle>` persisted to
    `localStorage.ct-theme`. Scroll-spy nav, reading progress bar,
    copy-to-clipboard on code blocks, click-to-run scanner demo.
    No frameworks, no build step. Same vanilla-HTML convention as
    the landing page.
  - **Six ct-* e2e specs** (`e2e/ct-default.mjs`,
    `ct-icon.mjs`, `ct-nav.mjs`, `ct-progress.mjs`, `ct-theme.mjs`,
    `ct-verify.mjs`). Mirror the `landing.spec.mjs` pattern, hit
    `http://127.0.0.1:5180/cognitive-twin.html` (different port so
    they can run alongside the launchd `:5173` server).
    `ct-verify` is the contract spec: 4 layers / 4 twins / 4 arch
    nodes / 4 processes / 6 domains / 12 tools, plus exercises for
    layer toggle, twin tab, scanner demo, theme toggle, and 0
    console errors.
  - **`lib/songs-indexer.js --add <file>`** — repeatable flag that
    adds individual audio files to the catalog without walking a
    configured root. Files land under a synthetic `manual` root
    (override with `--label <name>`). Reusable for ad-hoc catalog
    additions; used here to inject a test fixture.
  - **`assets/mural-prompts/south-america-street-graffiti.md`** —
    8 Midjourney prompts cataloging the three coherent style
    groups already in `~/Downloads/midjourney_session (8)/`: B&W
    asymmetric graphic, mixed-media stencil + blueprint + notation,
    and cinematic dawn medium-shot.
- **Decisions:**
  - **Different port (`:5180` not `:5173`) for ct-* specs** so the
    launchd Twin OS server keeps its port. Static `python3 -m
    http.server 5180 --directory pages` works for ad-hoc test
    runs; production deploy lives on GitHub Pages.
  - **6 domain twins instead of the 4 originally in the AGENTS.md
    contract** because the public page wants to surface the full
    fleet (music + transcription + web + research + 2 reserved).
    The Twin OS app shell keeps its 3 panels (Today / Songs / Twin)
    — the 6 are a presentation layer for the page, not a UI
    commitment.
- **Verified end-to-end:**
  - All six ct-* specs pass green on a fresh
    `python3 -m http.server 5180 --directory pages` server.
  - `ct-verify` confirms 0 console errors across light + dark, all
    4 layer-details elements toggle correctly, scanner demo
    toggles, theme toggle persists across reloads.
- **Open:**
  - Sprint 0.6 (the actual Woody Shaw chart per 0.4.b's "Next")
    is still parked.
- **Next:** wire ct-* specs into CI, then resume the chart work.

### 2026-09-12 — sprint 0.5.b (CI wiring)

- **Shipped:** the six ct-* specs now run in `.github/workflows/
  pages-test.yml` alongside the existing landing / twin-os /
  twin-os-songs specs, both on push (against the deployed GitHub
  Pages URL) and on PR (locally with a dedicated `python3 -m
  http.server 5180 --directory pages` started in-step and killed
  after). The specs honor the existing `E2E_URL` / `PORT`
  convention from `landing.spec.mjs` so deployed vs local paths
  (`/pages/cognitive-twin.html` vs `/cognitive-twin.html`) are
  picked up automatically. `executablePath` no longer hardcoded
  to macOS Chrome — reads `CHROME_PATH` env, otherwise puppeteer's
  bundled Chromium is used (what CI Linux runners want).
- **Pushed:** 5 commits on `main`, ahead of origin, now at
  `3691aa9` on origin. CI will run on push.
- **Open:** none for this sprint.
- **Next:** sprint 0.6 — the Woody Shaw chart per the 0.4.b
  parked item. User supplies the head + chord changes + form;
  agent produces the trumpet-feature part + rhythm-section
  voicings following `docs/COLTRANE-SHAW-ENGRAVING.md` §6/§9.
