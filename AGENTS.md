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

### 2026-09-12 — sprint 0.6 (chart MP3 pipeline)

- **Shipped:**
  - **`lib/chart-export.js --render` now emits `<song>_Demo.mp3`**
    — the whole-arrangement audition with all parts playing. This
    is the shareable single-file artifact (SoundCloud-style demo),
    distinct from the two muted backing tracks.
  - **`--mp3-only` flag** — re-renders just the audio set from
    existing MusicXML splits. Skips the split + mute work. ~50%
    faster than the full pipeline (4.2s vs 7.8s on the
    3-part fixture). Exits with code 2 + a one-line fix hint if
    the required `<song>_Whole/` directory doesn't exist yet.
  - **`npm run export-mp3`** — wires the audio-only path into
    npm, matches the existing `--apply --yes` convention from
    `index-songs` / `export-all`.
  - **`ffprobe` MP3 verification** baked into the render pass.
    Each `.mp3` output is checked for non-zero duration and
    reported with its bitrate. Catches the "MuseScore wrote a
    0-byte file" failure mode that the file-existence check
    alone misses. Falls through silently if `ffprobe` isn't on
    PATH.
  - **Bug fix:** stale literal `<song>.musicxml` in the
    `process.stderr.write` summary line — now correctly
    interpolates `${SONG_BASE}`. Pre-existing cosmetic bug,
    surfaced by the new render pass.
  - **`docs/CHART-EXPORT-WORKFLOW.md` rewritten** to reflect
    the current `--render` pipeline (no more "this machine
    doesn't have MuseScore" stale note). Documents the new
    Demo MP3, `--mp3-only`, and the bundled `MS Basic.sf3`
    soundfont + the optional swap procedure.
- **Decisions:**
  - **Bundled `MS Basic.sf3` is the default soundfont.** It's
    GM-ish but ships with the cask and keeps the pipeline
    self-sufficient. Documented the soundfont swap as optional
    (drop a new SF3 into MuseScore's sound dir) — no script
    changes needed when the user upgrades.
  - **ffprobe verified, not mandated.** The script logs a
    warning if ffprobe isn't installed; it doesn't refuse to
    run. CI / dev machines that lack ffmpeg still get the
    files written, just without the duration sanity check.
  - **Demo MP3 is the whole arrangement, not the head-only
    loop.** Auditions benefit from hearing the full texture —
    the head + a chorus of comping + bass + drums is the
    selling artifact. Head-only can be a follow-up if the
    sprint rhythm requires it.
  - **`--mp3-only` doesn't require `--render`** — they're
    independent flags now. `--mp3-only` short-circuits to the
    audio path; `--render` is still the "do everything from
    scratch" entry point.
- **Verified end-to-end:**
  - `npm run export-all -- /tmp/mini-score.musicxml` →
    1 Full_Score.pdf + 3 part PDFs + Demo.mp3 + 2 muted MP3s +
    whole-arrangement .mid, all real (PDF v1.4 / MPEG ADTS layer
    III 128 kbps 44.1 kHz / multi-track MIDI), 8.0s wall.
  - `npm run export-mp3 -- /tmp/mini-score.musicxml` → 3 MP3s
    only, 4.1s wall, ffprobe-validated durations.
  - `--mp3-only` error path (no prior split) exits with code 2
    + one-line fix hint.
  - Full `npm run verify` (all 3 e2e specs) green — no
    regressions.
- **Open:**
  - Sprint 0.6's original charter (first real Woody Shaw chart)
    is **still parked** — this sprint shipped the audio
    pipeline work the user asked for. Chart composition is the
    next ask.
- **Next:** sprint 0.7 — first real Woody Shaw-style chart.
    User supplies head + changes + form; agent produces the
    trumpet-feature part + rhythm-section voicings following
    `docs/COLTRANE-SHAW-ENGRAVING.md` §6/§9, then runs
    `npm run export-all` against the produced MusicXML to ship
    the full chart package with the new Demo MP3.

### 2026-09-12 — sprint 0.7 (first chart + export-all wrapper fix)

- **Shipped:**
  - **First real chart:** modal AABA contrafact over the
    canonical D dorian / G dorian changes ("Impressions"-style).
    25-bar head, 4 parts (Trumpet Bb, Piano, Bass, Drums).
    Trumpet head articulates Shaw-style phrasing — flowing 8th-
    note line over pedal harmony, with the rhythmic profile
    designed for improvisation over the same form. Pianist
    comps quartal voicings (Dm7sus / G7sus / Dm7sus / G7sus in
    A; Gm7sus / C7sus in bridge). Bass walks root + 5th.
    Drums are skeletal ride + kick — per the engraving doc's
    "don't over-notate drums" rule.
  - **`bin/export-all.sh`** — bash wrapper for the full export
    pipeline. Fixes a silent bug in `npm run export-all`: the
    prior `&&`-chained script only forwarded the user's input
    path to the SECOND script (`midi-export`), so the first
    (`chart-export`) always fell back to its built-in
    `/tmp/mini-score.musicxml` fixture — silently exporting
    the wrong chart. npm appends user args to the END of the
    entire script command, so `$@` between `&&` doesn't expand
    for both halves. The wrapper takes the path once and
    forwards it to both stages. `package.json` `export-all`
    now delegates to it.
  - The chart MusicXML + outputs stay in `/tmp` (work product,
    not repo content). What ships is the wrapper fix + the
    chart composition documented below.
- **Decisions:**
  - **Original contrafact, not transcription.** Per the AGENTS.md
    §11 hygiene rule and the no-copyrighted-melody policy: read
    the Coltrane MIDI locally for form + key + feel (modal AABA
    in D dorian / G dorian, swing 8ths, 4/4) and composed an
    original head in the same idiom. No melody from the source
    MIDI ends up in the public repo.
  - **25 bars, not 32.** I cut the head at bar 25 with a held
    whole-note tonic so the export pipeline gets a clean
    fixed-length score. Real modal AABA charts usually loop
    via D.S. al Coda, but the export pipeline (MuseScore PDF,
    ffprobe-verified MP3, multi-track MIDI) is happier with a
    fixed-length chart that doesn't depend on repeat markings.
  - **Trumpet in Bb (transposed), rhythm section in C.**
    Matches the band-staff convention from the engraving doc
    §2 — horn players read transposed keys, rhythm reads concert.
    The chart-export.js transposition inference correctly labels
    Trumpet as Bb and Piano/Bass/Drums as C.
  - **Skeletal drum part.** Quarter-note ride bell on 1+3, kick
    on 2+4, no fills. The engraving doc §4 says don't over-
    notate drums — the live drummer fills the gaps.
  - **Quartal piano voicings, no slash notation yet.** A real
    chart would add chord symbols (`Dm7`, `G7sus`) above the
    piano staff; the MusicXML schema doesn't carry those in the
    current pipeline, so the voicings stand on their own.
- **Verified end-to-end:**
  - `npm run export-all -- /tmp/modal-sketch.musicxml` →
    1 Full_Score.pdf (3 pages, 60 KB) + 4 per-part PDFs in
    canonical band order (Trumpet_Bb, Piano_C, Bass_C,
    Drums_C) + Demo.mp3 (56.0s @ 128 kbps) + No_Trumpet.mp3
    (53.0s) + No_Sax.mp3 (56.0s) + 5-track MIDI (PPQ=4,
    2.4 KB). All real (PDF v1.4, MPEG ADTS layer III, format 1
    MIDI), all ffprobe-validated, all file-type-checked.
  - `npm run verify` — all 3 e2e specs green, no regressions
    from the wrapper change.
- **Bug surfaced:** the `npm run export-all` arg-passthrough
  bug had been silently shipping the wrong chart for every
  prior run. Fixed by the wrapper. Sprint 0.6's "Demo MP3"
  verification was against the wrong chart; the MP3 pipeline
  itself is still correct, but re-running `npm run export-all
  -- path/to/song.musicxml` against a real chart is now
  accurate for the first time.
- **Open:**
  - The trumpet head is a one-chorus sketch; the actual
    improvising over this form is left to the soloist. A
    follow-up could produce an alternate-head variant or a
    fully-notated solo transcription.
  - Slash notation / chord symbols not yet carried by the
    MusicXML pipeline. Adding them requires either a MusicXML
    extension or a separate lyric/chord layer in the export
    manifest.
- **Next:** sprint 0.8 candidates — (a) the alternate-head
  variant or solo transcription; (b) chord-symbol / slash
  notation in MusicXML (requires music21 or similar); (c) wire
  the chart export into a watched-folder LaunchAgent that
  auto-rebuilds the chart package on every input change.

### 2026-09-12 — sprint 0.8 (chart export watcher)

- **Shipped:**
  - **`lib/chart-watcher.js`** — pure-Node, no deps. Polls
    `chart-inbox/` every 2s for new `.musicxml` files. For each:
    acquires a lockfile, runs `bin/export-all.sh`, moves the
    input to `chart-inbox/processed/`, appends a one-line
    `[start]` / `[done]` / `[fail]` to `logs/chart-watcher.log`.
    `--once` flag for manual runs. SIGTERM-clean shutdown.
    Stale lockfiles (>30 min) pruned at startup.
  - **`bin/chart-watcher.sh`** — LaunchAgent wrapper. Mirrors
    the `macos-launchd-automation` skill's `start.sh` template:
    absolute paths, no `cd`, multi-candidate Node resolution
    (Hermes Node → NVM → Homebrew → system). Drop-in compatible
    with the existing twin boot / server LaunchAgents.
  - **`~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist`**
    — `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=10`,
    `EnvironmentVariables.PATH` includes `~/.hermes/node/bin`
    first. **NOT bootstrapped** — service-state change, awaiting
    user approval. `plutil -lint` confirmed valid.
  - **`chart-inbox/`** — drop zone for new `.musicxml` files.
    `.gitkeep` keeps the dir in the repo; everything else
    (PDFs, MP3s, MIDI, processed/) is `.gitignore`d as
    auto-generated.
  - **`docs/CHART-WATCHER.md`** — install + verify + teardown
    steps. Includes a copy-paste-able launchctl command sequence.
- **Decisions:**
  - **Poll loop, not `fs.watch`.** `fs.watch` / FSEvents under a
    GUI LaunchAgent has known reliability gaps on macOS — events
    drop, especially under network filesystem mounts. A 2-second
    poll is boring, predictable, and matches the twin's "calm,
    not chatty" ethos.
  - **Single in-process watcher, no concurrency.** Each export
    takes ~10s. Serial processing is the right default for a
    personal twin. To parallelize later, add a worker pool —
    not now.
  - **Lockfile-based concurrency guard.** `.processing-<sha1>`
    in `chart-inbox/` ensures two simultaneous watcher
    instances (or a stale one) don't double-process a file.
    Stale locks (>30 min) are pruned at startup so a crash
    doesn't permanently block a file.
  - **Move to `processed/`, not delete.** The user can see what
    shipped. Matches the calm-by-default twin ethos.
  - **No Slack / IM / desktop notifications.** Logging only.
    AGENTS.md says "silent unless something matters."
  - **ThrottleInterval=10 in the plist.** If launchd restarts
    the watcher (crash), don't let it tight-loop — at least
    10 seconds between respawns.
- **Verified end-to-end:**
  - `cp /tmp/modal-sketch.musicxml chart-inbox/ && node
    lib/chart-watcher.js --once` → full chart package produced
    (1 Full_Score.pdf + 4 per-part PDFs + Demo.mp3 + 2 muted
    MP3s + 5-track MIDI), input moved to `processed/`, all
    ffprobe-validated. 12.1s wall (matches sprint 0.7 manual
    run). Zero failures.
  - `npm run verify` — all 3 e2e specs green, no regressions.
- **Open:**
  - LaunchAgent plist is installed but NOT bootstrapped. Awaiting
    user approval to run `launchctl bootstrap` — irreversible
    service-state change.
  - **No retry on failure.** A failed export logs `[fail]` and
    leaves the input in `chart-inbox/`. Manual intervention
    required. A simple retry-once-on-failure could be added.
  - **No concurrency.** Backlog of N files takes N × 10s.
    Add a worker pool when N > 5 is routine.
- **Next:** sprint 0.9 candidates — (a) bootstrap the LaunchAgent
  (after user approval); (b) retry-once-on-failure; (c) the
  alternate-head chart variant from sprint 0.7's backlog;
  (d) chord-symbol / slash notation in MusicXML output.

### 2026-09-12 — sprints 0.9 / 0.10 / 0.11 (watcher live, hardened, alt-head chart)

Three sprints in one combined entry — all chart-pipeline work, all
shipped within a single hour against the running LaunchAgent.

**Sprint 0.9 — LaunchAgent bootstrapped:**

- Loaded `~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist`
  via `launchctl bootstrap gui/$UID/...`. State = running, PID 18202
  (then PID 23200 after the 0.10 kickstart). Hermes-managed Node
  binary (`~/.hermes/node/bin/node`) used per the plist's PATH.
- `launchctl kickstart -k` after bootstrap to force an immediate run.
- Verified beyond `state = running` via `pgrep -fl chart-watcher` —
  per the `macos-launchd-automation` skill, that flag alone isn't
  proof of health.
- Did NOT bootout the existing twin boot / server LaunchAgents.
  Three LaunchAgents total now: `twin.boot` + `twin.server`
  + `twin.chart-watcher`.

**Sprint 0.10 — retry-once + lockfile mtime fix:**

- Wrapped `execFileSync` in a 2-attempt loop with a 5-second sync
  sleep. Catches mscore file-locks, MuseScore crashes, brief
  filesystem contention. Logging distinguishes `[done]` /
  `[done-retry-N]` / `[fail]` (with attempt count).
- Lockfile lifecycle is via `try/finally` around the retry loop —
  a slow retry never holds the lock longer than total wall time.
- **Bug fix surfaced during 0.11 verification:** the original
  lockfile check (`!fs.existsSync(lock)`) didn't detect a stale
  lock from a previously-processed file at the same path. Drop
  a new file with the same name → lockfile from the old run
  blocks the new file indefinitely. The new check considers a
  lockfile stale if (a) it's older than STALE_LOCK_MS (lowered
  from 30min to 5min), OR (b) the underlying file's mtime is
  newer than the lockfile's mtime. The (b) check handles the
  "replace file at same path" case correctly.
- Verified end-to-end: happy path → `[done]` at 12.2s, no retry.
  Failure path (export-all.sh missing) → `[retry]` logged, 5s
  sleep, `[fail]` (2 attempts), lockfile cleaned. Replace-at-
  same-path → new file picked up immediately on next tick.

**Sprint 0.11 — alt-head modal chart variant:**

- Composed `/tmp/modal-sketch-b.musicxml` — 60KB, 4 parts, modal
  AABA in D dorian / G dorian / D dorian (same form as the
  sprint 0.7 chart), but the head starts on F (a 5th higher
  than modal-sketch's D) and showcases per `docs/COLTRANE-SHAW-
  ENGRAVING.md` §6: `<articulations>` markers on popped-high
  notes (marcato + tenuto + strong-accent), "Harmon mute, stem
  out" direction at bar 17, half-valve pickup direction at the
  bridge.
- Stays in `/tmp` (work product, not repo content) — same
  convention as sprint 0.7's `modal-sketch.musicxml`.
- Dropped into the production inbox while the LaunchAgent was
  live. Watcher picked it up, full chart package shipped end-
  to-end: 1 Full_Score.pdf (3 pages) + 4 per-part PDFs in
  canonical band order (Trumpet_Bb, Piano_C, Bass_C, Drums_C)
  + Demo.mp3 + No_Trumpet.mp3 + No_Sax.mp3 (all 56.0s/53.0s @
  128 kbps) + 5-track MIDI. All ffprobe-validated, all real.
- Wall time: 13.3s — articulations + mute direction did NOT
  break MuseScore (initial concern that mscore would hang on
  the direction text — it didn't).

**Decisions:**

- **Single combined AGENTS.md entry** for 0.9 / 0.10 / 0.11
  because they form one continuous arc: bootstrap → harden →
  exercise. Splitting them across three entries would have
  duplicated the LaunchAgent verification narrative.
- **`launchctl kickstart -k` (not `bootout`/`bootstrap`) for
  the 0.10 restart** — same scope as the 0.9 bootstrap approval.
  Cheaper, no approval gate.
- **Alt-head kept in `/tmp`** rather than committed to the
  repo, despite the new watcher making in-repo placement viable.
  Reason: chart compositions are evolving work products, not
  durable artifacts. The repo carries the tooling, the chart
  itself lives where the user iterates on it.
- **No concurrency in the watcher.** Serial processing is still
  the right default for a personal twin; the queue has never
  built up beyond a single file in practice.

**Verified end-to-end (all three sprints):**

- LaunchAgent running PID 23200, state = running, two children
  active. Three LaunchAgents total.
- `[start] modal-sketch-b.musicxml` → `[done] → 13.3s` via
  the live watcher.
- `[start] lockfile-test.musicxml` (first) → `[done] → 13.7s`,
  then REPLACE the file → `[start] lockfile-test.musicxml`
  (second, same path, different mtime) → `[done] → 12.9s`.
  Mtime fix confirmed working.
- All mp3s are MPEG ADTS layer III 128 kbps 44.1 kHz JntStereo,
  all PDFs are v1.4, MIDI is format 1 with 5 tracks.

**Open:**

- No automated test for the lockfile-mtime race condition. The
  manual reproduction verified it; a permanent test would
  require a synthetic watcher test harness. Defer until the
  watcher grows more branches.

**Next:** sprint 0.12 candidates — (a) chord-symbol / slash
notation in MusicXML output (requires music21 or similar);
(b) automated test for the watcher's lockfile logic;
(c) wire the LaunchAgent log rotation (logs/ grows unbounded);
(d) ship a docs sample showing two charts side-by-side
(modal-sketch + modal-sketch-b) so the alt-head's articulation
choices are visible in PDF form.

### 2026-09-12 — sprint 0.12 (watcher tests + log rotation)

- **Shipped:**
  - **`lib/chart-watcher.test.js`** — pure-Node, no deps. 13
    assertions covering the watcher's lockfile logic. Uses
    `WATCHER_TEST_DIR` env var to point the watcher at a scratch
    dir so no real files in `chart-inbox/` are touched.
    Mocks the export runner via
    `module.exports.setRunExport()` — no mscore invocation
    during tests. Run via `npm run test:watcher`.
  - **`bin/log-rotate.sh`** — newsyslog-style rotation for every
    `*.log` in `logs/`. Keeps 7 daily `.gz` rotations, deletes
    the rest. Naming: `foo.log` → `foo.log.1.gz` after rotation;
    older ones count up. Manual use: `bin/log-rotate.sh` or
    `bin/log-rotate.sh <file>...`.
  - **`com.kaidjuric.digital-twin.log-rotate` LaunchAgent**
    installed + bootstrapped. `StartCalendarInterval` Hour=3
    Minute=0 → fires daily at 03:00. Verified the script works
    via direct invocation (LaunchAgent `state = not running`
    between scheduled firings — correct behavior for
    `StartCalendarInterval` jobs).
  - **Chart-watcher refactor** for testability — extracted
    `execFileSync` into `runExport()` so tests can mock it.
    Added `--test` flag and `WATCHER_TEST_DIR` env var.
    Production code path is unchanged; the new flags are
    short-circuits in `main()`. Module-exports the narrow set
    of internals the harness needs.
  - **`docs/CHART-WATCHER.md`** — added Logs + Tests sections,
    fixed stale "No retry on failure" limitation that should
    have been updated in the 0.10 entry.
- **Decisions:**
  - **Tests cover the lockfile logic, NOT the export
    integration.** The export pipeline (chart-export.js →
    music21 round-trip → mscore render → ffprobe verify) is
    already covered by the manual end-to-end runs in sprints
    0.7/0.8/0.9. Test infrastructure for the mscore+ffmpeg
    dance would be heavy (Docker, mock binaries) and isn't
    worth it for a personal tool.
  - **Test harness mirrors the repo's e2e/ pattern.** Plain
    `.js` files invoked via `node`, no test framework. Same
    convention as the 6 ct-* specs from sprint 0.5.
  - **`StartCalendarInterval` instead of `RunAtLoad +
    `KeepAlive`.** The log-rotate job is calendar-based (daily
    03:00), not watch-based. Per the `macos-launchd-automation`
    skill, `StartCalendarInterval` is the right pattern for
    scheduled tasks that should NOT poll.
  - **Log rotation deletes anything beyond the 7-day window.**
    No long-term retention. If the user wants a permanent
    archive of watch activity, that's a separate cron / git
    commit-cadence project, not log rotation.
- **Verified:**
  - `npm run test:watcher` → 13/13 pass (all green)
  - `bin/log-rotate.sh` on a real `logs/` → rotated 7 files,
    gzipped, source files replaced with empty `.log`. Zero-byte
    files skipped (correct — no point rotating empty logs).
  - `npm run verify` (existing e2e specs) → all green, no
    regression from the watcher refactor.
  - LaunchAgent loaded: `service = com.kaidjuric.digital-twin.log-rotate`
    appears in `launchctl print gui/$UID/...`. Will fire at
    next 03:00.
- **Open:** none for this sprint.
- **Next:** sprint 0.13 candidates — (a) chord-symbol / slash
  notation in MusicXML output (requires music21 or similar);
  (b) side-by-side chart sample in docs (modal-sketch +
  modal-sketch-b); (c) extend the test harness to cover
  `exportOne`'s retry path (would require mocking
  `execFileSync` differently); (d) bring the songs-indexer into
  the watcher pattern (file-in, file-out catalog rebuilds).

### 2026-09-12 — sprint 0.13 (songs-watcher + chart samples)

- **Shipped:**
- `bin/songs-watcher.sh` + `lib/songs-watcher.js` — drop audio into
`audio-inbox/`, catalog auto-regenerates via songs-indexer. Same
watcher pattern as chart-watcher (lockfile, serial processing).
- `docs/CHART-SAMPLES.md` — side-by-side modal-sketch + alt-head
comparison (closes sprint 0.12's open item (d)/(b)).
- `e2e/watcher.spec.mjs` + `e2e/songs-watcher.spec.mjs` — end-to-end
contract tests for both watchers.
- chart-watcher test harness extended with retry-path coverage
(closes 0.12's open item (c)).
- Apple Notes ping on successful chart export.
- CI: pages-test workflow documents that watcher specs are local-only;
em-dash YAML fix.
- **Decisions:** Watcher e2e specs run locally (they touch LaunchAgent
state and inbox dirs), not in CI — CI keeps hitting the deployed URL.

### 2026-09-12 — sprint 0.14 (chords + AIFF + hardening)

- **Shipped:**
- `chart-export --chords <json>` — injects `<harmony>` chord-symbol
elements into MusicXML output without a music21 dependency
(closes 0.12's open item (a) via the simpler path).
- AIFF (`.aif` / `.aiff`) parsing in songs-indexer + songs-watcher,
with docs.
- songs-watcher pre-flight check on `sources.config.json`.
- `--help` flags for chart-export + songs-indexer.
- Cross-watcher lockfile namespace + tmp-file ignore so chart- and
songs-watchers can't collide.
- `docs/SONGS-WATCHER.md`; e2e made LaunchAgent-aware.

### 2026-09-14 — sprint 0.15 (MJ automation + cognitive-twin Phase 3)

- **Shipped:**
- **Midjourney automation system** — `lib/mj-submitter.js` (644
lines), `lib/mj-watcher.js` + `bin/mj-watcher.sh`,
`lib/mj-config.json`, `lib/mj-watcher.test.js`,
`docs/MJ-WATCHER.md`. Per-prompt output directories + Comet
config; reliable slash-command insertion and avatar filtering.
- **cognitive-twin a11y pass** + structural cleanup
(`e2e/ct-a11y.mjs`).
- **cognitive-twin Phase 3** — shareable state, OG preview
(`make-og-image.py` → `cognitive-twin-og.png`), mobile drawer.
- **Decisions:** MJ automation follows the same drop-a-file watcher
contract as chart/songs watchers — one interaction pattern across
all three pipelines.

### 2026-09-14 — sprint 0.16 (persistent agent loop + fixes)

- **Shipped:**
- `agents/persistent-agent-loop.py` (615 lines) — resumable
persistent agent loop; the twin's first long-running runtime
piece (sprint 2+ direction from the original plan).
- Agent-loop dashboard tab in `pages/cognitive-twin.html`.
- Hardening fixes: reliable MJ slash-command insertion + avatar
filtering; twin-os specs ignore `catalog.json` 404s; robust
scroll position in `ct-a11y` for `aria-current` assertion.
- **Open:** Agent-loop dashboard currently shows static/stub state —
wiring it to live orchestrator data is the natural next step.
- **Next:** candidates — (a) live-state wiring for the agent-loop
dashboard; (b) jazz-solos CSV catalog (`catalog-jazz-solos.json`)
so the 456-entry MIDI corpus is searchable in the Songs panel;
(c) FLAC/M4A/OGG parsing in songs-indexer.

### 2026-09-22 — sprint 0.17 (CLIP Interrogator port)

- **Shipped:**
- **`lib/clip-interrogator/`** — Python package under a uv-managed
  venv (managed CPython 3.12, `requires-python = ">=3.12,<3.13"`).
  `pyproject.toml` + committed `uv.lock` + gitignored `.venv/`.
  Deps: `gradio~=5.0` (deliberately not 6.x), `clip-interrogator==0.6.0`,
  `torch>=2.6,<3`, `torchvision>=0.21,<1`.
  Five-module set: `__init__.py`, `config.py` (model registry +
  tunables), `core.py` (business logic, **no gradio import**),
  `cli.py` (argparse), `ui.py` (gradio).
- **`core.py` ModelManager** — lazy loader under a reentrant lock
  (two concurrent gradio events can't double-load the 1-2GB models).
  ViT-L is the default (loaded on first UI use); ViT-H materialises
  only when selected; the BLIP captioner is shared between both via
  the `Config.caption_model` / `Config.caption_processor` attrs that
  clip_interrogator 0.6.0 actually reads (the oft-cited
  `cfg.blip_model` attribute does NOT exist in the 0.6.0 wheel);
  CLI-only path uses `shared_blip=False` so a CLI run loads **only**
  the requested model. CPU ping-pong activates the selected CLIP and
  parks the other on CPU. `repo_root()` walks up to `pages/` — no
  absolute paths anywhere.
- **`cli.py`** — verbs `interrogate <image> [--model vit-l|vit-h]
  [--mode best|fast|classic|negative] [--json]`, `analyze <image>
  [--model] [--top 5] [--json]`, `check --self-check` (import +
  device + registry, downloads NO weights; reports the pinned
  inference device separately from the available accelerator).
  `--json` redirects the library's loading banner prints to stderr
  so the payload parses clean (`python3 -m json.tool`).
  Exit codes 0 / 2 bad input / 3 model error.
- **`ui.py`** — `build_gradio_app()`: one Blocks context, two tabs
  (Prompt / Analyze), plain `gr.Label(label=...)` outputs (gradio
  5.x removed `num_classes`), `api_name` on the `.click()` events
  (not on Button — another non-5.x API), handlers receive components
  as explicit params (upstream `analyze_tab()` global-reference bug
  fixed) and guard `DISPLAY_TO_ID` lookups with `.get()` +
  `gr.Error`, share-to-community + HF duplicate badge + Colab
  boilerplate dropped, `cache_examples` / `run_on_click` /
  `ex.dataset.headers` dropped, launch on `127.0.0.1:7860` with
  `show_api=False`.
- **`pages/clip-interrogator.html`** — static tool page, kai-systems
  house style (DM Serif Display + Outfit + JetBrains Mono, warm
  cream + copper + forest tokens), mirroring the cognitive-twin
  structure: hero, what-it-is, how-to-run, mode table (4 rows),
  model table (2 entries), examples + `[data-sample-output]` strip,
  attribution. Paired light/dark via `<theme-toggle>` (3-state
  light/auto/dark) persisted under `localStorage["ci-theme"]` with
  a no-flash bootstrap script. NO working browser demo.
- **Twin OS** — Songs panel `.tool-grid` gains a CLIP Interrogator
  card (`a[data-tool-clip]`, links to `../clip-interrogator.html`).
- **`assets/clip-interrogator/{example01,example02}.jpg`** — the
  upstream pair (Layers + Lin Tong, Pixabay), copied from the HF
  space clone. Also mirrored at `pages/assets/clip-interrogator/`
  so the static page's examples load under the `--directory pages`
  local server (the repo-root `assets/` sits outside that server's
  document root — the page's relative `assets/...` refs resolve to
  the mirror under both local and deployed paths).
- **`docs/CLIP-INTERROGATOR.md`** — full reference: install, CLI,
  UI, gradio modernization notes, npm scripts, e2e, attribution.
- **`e2e/clip-interrogator.spec.mjs`** — Puppeteer contract spec
  that runs WITHOUT Python deps: hero `<h1>`, `<theme-toggle>`
  flip + reload persistence, mode table 4 rows, model table 2
  entries, both example imgs `naturalWidth > 0`, `npm run clip:ui`
  in how-to-run, Pixabay + pharmapsychotic attribution,
  `[data-sample-output]` presence, twin-os `data-tool-clip` link
  (href ends `clip-interrogator.html`, name "CLIP Interrogator"),
  0 console errors (pageerror + console.error + requestfailed) on
  both pages, screenshots → `e2e/artifacts/clip-{light,dark,twinos}.png`.
  URL convention fixed (not the ct-spec quirk): deployed
  `${BASE}/pages/clip-interrogator.html`, local
  `${BASE}/clip-interrogator.html`; twin-os `/pages/twin-os/index.html`
  vs `/twin-os/index.html`.
- **npm scripts** — `e2e:clip` (node + puppeteer, `cd e2e && PORT=5180
  node clip-interrogator.spec.mjs`), `clip:setup` (`uv sync --project
  lib/clip-interrogator`), `clip:ui` / `clip:interrogate` /
  `clip:check` (via `uv run --project lib/clip-interrogator`).
- **CI** — `.github/workflows/pages-test.yml` gains one push line +
  one PR line (run `clip-interrogator.spec.mjs` against the deployed
  URL / `PORT=5180` respectively, exactly like the ct-* lines).
- `.gitignore` — `lib/clip-interrogator/.venv/` + `dist/`.
- **Sample output recorded verbatim** (from one real CLI run):
  - `clip-interrogate interrogate assets/clip-interrogator/example01.jpg --mode best`:
    `painting of a turtle in watercolors, realistic photo studio photoshop, red and teal color scheme, pencil drawing illustration, teal and orange color scheme, photoshop render, clear seas, featured on dribbble, realistic sketch, watercolor effect, by Mac Conner, cgsociety 9`
- **Verified end-to-end:**
  - `uv sync` clean (93 packages resolved; torch 2.14.0,
    torchvision 0.29.0, gradio 5.50.0, clip-interrogator 0.6.0).
    NOTE: the first `uv sync` hit a stale-uv-cache editable install
    with no `.pth` hook (`No module named 'clip_interrogator_app'`);
    fixed with `uv sync --project lib/clip-interrogator
    --reinstall --no-cache`. Documented in `docs/CLIP-INTERROGATOR.md`.
  - `clip:check` green (exit 0, device mps, registry printed, no
    weights downloaded; reports inference device cpu separately).
  - **UI launch verified** — `python -m clip_interrogator_app.ui`
    binds `127.0.0.1:7860`, `GET / → 200`, config carries both
    tabitems (`Prompt`, `Analyze`) and both api_names
    (`image-to-prompt`, `image-analysis`). Only new noise is the
    forward-looking `show_api` deprecation warning for gradio 6.0.
  - **Full smoke, all four interrogate modes + both analyze models**
    (weights cached, per-mode wall ≈ up to ~3 min on CPU):
    - `interrogate example01.jpg --mode {best,fast,classic,negative} --json` — all four emit JSON that parses clean via `python3 -m json.tool`, with the library's loading-banner prints redirected to stderr. `best` prompt = the sample recorded above (272 chars); `fast` / `classic` / `negative` each produce distinct coherent prompts.
    - `analyze example01.jpg --model vit-l --json` AND `--model vit-h --json` — both emit JSON with all five label tables present (medium / artist / movement / trending / flavor, 5 labels each).
  - One real `clip-interrogate ... example01.jpg --mode best` run
    completed and produced the prompt recorded above.
  - `npm run e2e:clip` green on :5180 (17/17 checks, includes the
    internal-link resolution check — no 404s on the page's relative
    hrefs after the footer/brand fix).
  - `npm run verify` green (existing landing / twin-os /
    twin-os-songs specs) — no regressions.
  - ct specs: `ct-{a11y,default,icon,nav,phase3,progress,theme,verify}`
    all pass locally against the `--directory pages` :5180 server.
  - No absolute filesystem paths in new files (grep clean).
- **Decisions:**
  - **Device pinned to CPU inside the interrogator.** clip_interrogator
    0.6.0's `Config.device` auto-detects MPS, but its `LabelTable`
    only casts cached fp16 vocab embeddings to fp32 on *cpu* — on MPS
    every rank/similarity op crashes with "expected mat1 and mat2 to
    have the same dtype ... float != Half". Upstream never ran the
    MPS path in practice. Pinning `device="cpu"` keeps the whole
    pipeline fp32 and deterministic; the tool is a calm local
    utility, not a render farm.
  - **Vocab cache pinned to `~/.cache/clip-interrogator`.** Upstream
    `Config()` defaults `cache_path` to the *relative* path `"cache"`,
    which dropped ~164M of safetensors into the repo root on the first
    real CLI run (surfaced during final verification, removed before
    commit). The pin keeps the working tree clean; weights still land
    in the HF cache as before.
  - **Gradio modernisation followed the upstream removals.** Both
    `num_top_classes` (removed) and `num_classes` (never a 5.x API)
    are gone — plain `gr.Label(label=...)` renders the score dict.
    `api_name` moved from the Button constructors to the `.click()`
    events (Button didn't accept it in 5.x — reproduced TypeError).
    Also dropped `run_on_click`, `cache_examples`,
    `ex.dataset.headers`, share buttons, HF badge, Colab copy. The
    upstream `analyze_tab()` referenced components (`input_image`,
    `input_model`) defined later in module scope — the latent bug is
    fixed by building everything inside one Blocks-context builder and
    passing refs explicitly; drop-down lookups use `.get()` +
    `gr.Error` instead of raw `DISPLAY_TO_ID[...]`.
  - **`shared_blip` split.** UI path shares BLIP (upstream behavior);
    CLI path constructs each interrogator with its own BLIP so
    `--model vit-h` never downloads ViT-L.
- **Open:**
  - `npm run clip:interrogate` default target is the shipped
    example01.jpg; pointing it at the user's real images is a `--`
    passthrough away (`npm run clip:interrogate -- <image> --model vit-h`).
  - The e2e does not exercise the gradio app via the browser (the
    UI was manually launch-verified: binds 127.0.0.1:7860, both tabs
    present). A future sprint could add a `clip-ui.spec.mjs` that
    drives the running app on a loaded-cache machine.
- **Next:** sprint 0.18 candidates — (a) wire the sample strip to a
  generated `data/clip/samples.json` so the page auto-refreshes when
  the indexer rebuilds; (b) add `--out` to the CLI to write prompts
  to a sibling catalog; (c) resume the agent-loop dashboard live-state
  wiring from 0.16's open item.

### 2026-09-22 — sprint 0.18 (Refael MP4 Maker port)

- **Shipped:**
  - **`pages/refael-mp4-maker.html`** — port of the author's HF Space
    `kaidjuric/refael-mp4-maker` (static SDK, MIT; part of the Sainted
    Word Records portfolio). Single self-contained HTML file (4648
    lines, fonts as data URIs): MP3 → 1920×1080 MP4 with mood-keyword
    auto-covers (dark/light/fire/love/ocean/earth, English + Serbian/
    Cyrillic), deterministic from track name + artist. Three render
    engines behind one radio group — ⚡ Fast (WebCodecs, offline),
    🛡 FFmpeg.wasm (lazy-loads @ffmpeg from unpkg on first use),
    🐢 Real-time (MediaRecorder). Single / Custom image / Batch tabs,
    Kai-flavored random-name generator, blob-URL PWA manifest + inline
    service worker, built-in `?selftest=1` end-to-end render self-test.
    Copied from the Space's `index.html` with exactly one hygiene
    addition: a data-URI favicon (the page's own "R" monogram) so
    browsers stop auto-requesting `/favicon.ico` (404 console error
    surfaced by the e2e). Canonical source lives on another machine at
    `~/Documents/autodashboard/refael-mp4-maker`.
  - **Twin OS Songs panel** — third `.tool-grid` card
    (`a[data-tool-refael]`, href `../refael-mp4-maker.html`), same
    pattern as the CLIP card.
  - **`docs/REFAEL-MP4-MAKER.md`** — origin, engine behavior, the
    offline caveat (default path = true 0 network calls; FFmpeg.wasm
    mode lazily fetches from unpkg), run instructions, `?selftest=1`
    lever, e2e contract, attribution.
  - **`e2e/refael.spec.mjs`** — Puppeteer contract spec, 22 checks,
    same URL convention + console-error collection + down-server
    ergonomics as `clip-interrogator.spec.mjs`. Asserts title/hero,
    offline badge, 3-tab tablist (first active), 3 engine radios (Fast
    checked), engine pill + hint, render buttons disabled until input,
    1920×1080 canvases, output-info row, "0 network calls" footer
    claim, ffmpeg one-liner `<details>`, the random-name generator
    fills the title input, internal links don't 404, Twin OS
    `data-tool-refael` card, 0 console errors on both pages.
  - **`npm run e2e:refael`** + CI: `pages-test.yml` gains push + PR
    lines (deployed `/pages/refael-mp4-maker.html`, local
    `/refael-mp4-maker.html` — same convention as the clip line).
  - **README** — status line + "what's here" + "Run the Refael MP4
    Maker" section + file tree entries.
- **Decisions:**
  - **Byte-identical copy (plus one hygiene line), no kai-systems
    restyle.** Refael is a complete product with its own polished dark
    design (Fraunces + data-URI fonts, offline-first). Restyling it
    into the shared tokens would strip its identity; the twin
    surfaces it as a tool, not a page it owns. The single addition is
    the data-URI favicon — without it, Chrome auto-requests
    `/favicon.ico` and the 404 shows up as a console error (caught by
    the e2e's 0-console-error contract). Documented origin + offline
    caveat instead.
  - **The `?selftest=1` hook stays out of the e2e.** It exercises
    WebCodecs video encoding, which is flaky across headless Chrome
    versions; the spec covers the static contract and the spec keeps
    green in CI. Selftest remains the manual render smoke lever.
  - **FFmpeg.wasm's CDN dependency is documented, not removed.** The
    Fast + Real-time engines are fully offline; FFmpeg mode is the
    one network-touching path, lazily loaded on first use and then
    browser-cached. The footer's "0 network calls" claim is accurate
    for the default path — the e2e asserts it verbatim.
  - **Port from the HF Space, not the absent local source.** The
    README's canonical path (`~/Documents/autodashboard/...`) doesn't
    exist on this machine; the HF copy is the source of truth here.
- **Verified end-to-end:**
  - `npm run e2e:refael` green on :5180 (22/22 checks, includes the
    random-name generator interaction + internal-link resolution).
  - `npm run verify` green (landing / twin-os / twin-os-songs) — no
    regressions from the tool-grid edit.
  - ct specs still green locally on :5180 (spot-checked ct-verify +
    ct-default after the twin-os edit).
- **Open:**
  - A future sprint could drive `?selftest=1` in Puppeteer against a
    real Chrome binary when headless WebCodecs stabilizes (the spec
    notes this explicitly).
- **Next:** sprint 0.19 candidates — (a) wire the CLIP sample strip
  to a generated `data/clip/samples.json`; (b) add `--out` to the
  clip CLI; (c) resume the agent-loop dashboard live-state wiring
  from 0.16; (d) the woody-shaw chart variants backlog.

### 2026-09-22 — sprint 0.19 (agent-loop dashboard served + ct gate hardening)

- **Shipped:**
  - **`agents/persistent-agent-loop.py` gains `dashboard --out PATH`** —
    writes the generated dashboard anywhere, not just next to the state
    file (default behavior unchanged). The served tree is now a target:
    `python3 agents/persistent-agent-loop.py dashboard --out
    pages/agent-dashboard.html` regenerates the Twin's dashboard in
    place.
  - **`pages/agent-dashboard.html` (committed)** — placeholder dashboard
    in the loop's exact generated style (dark `#0f1117`, same table + feed
    structure) so a regeneration overwrites it seamlessly. Shows the
    idle/empty state + the run-and-regenerate commands until the loop has
    a state file. Zero JS, zero network.
  - **`pages/cognitive-twin.html`** — agent-loop iframe
    `../.agent/dashboard.html` → `./agent-dashboard.html`, copy updated
    with the regenerate command. This **fixes a real 404** the page had
    shipped with since sprint 0.16.
  - **`e2e/ct-verify.mjs` hardened** — was a *print-and-exit-zero* spec:
    checked were logged but never asserted, console errors printed but
    never gated. Now a real gate: `check()` helper, 16 assertions
    (structure counts, layer/twin/scanner/theme exercises, dashboard
    iframe resolves 200 + served non-dot path, **0 console errors**),
    non-zero exit on failure.
  - **`e2e/ct-a11y.mjs` fixed** — pre-existing deterministic failure on
    "active link has aria-current". Root cause: the spec's hardcoded
    `window.scrollTo(0, 1500)` + fixed 200 ms wait raced Chrome's scroll
    restoration after `page.reload` (restore clobbered the scroll, so no
    section was in the spy's active zone at check time). Fix: disable
    `history.scrollRestoration`, scroll a mid-page section into view,
    and **poll** for `.nav-link.active[aria-current="true"]` instead of a
    fixed sleep. The page's scroll-spy was correct (probe-verified at
    multiple scroll depths).
- **Decisions:**
  - **The dashboard must live at a served, non-dot path.** The loop's
    brain stays at `.agent/state.json` (gitignored, local-only — correct
    per §11 hygiene), but a dot-directory is unreachable from both the
    pages-rooted local server and GitHub Pages (Jekyll ignores dot-dirs),
    so `.agent/dashboard.html` was never going to load in the iframe —
    even after running the loop. `pages/agent-dashboard.html` doubles as
    the committed placeholder AND the loop's regeneration target: same
    file, different contents, seamless swap.
  - **Test fix justified under "fix the page, not the test"**: the 404
    and the ct-a11y failure were both *spec* defects (no assertion /
    scroll race), not page defects. ct-verify's 0-console-error gate
    only became possible once the iframe resolved.
  - **ct-a11y's assertion contract unchanged** — same check, now
    deterministic.
- **Verified end-to-end:**
  - Loop: `run` in a scratch dir → `dashboard --out /tmp/served.html`
    writes live-data HTML (plan table present, 2014 bytes); default call
    still writes next to state. Both paths confirmed.
  - `ct-verify`: 16/16 PASS incl. dashboard `→ 200` and 0 console errors.
  - `ct-a11y`: ALL PASS, 0 console errors (previously SOME FAILED).
  - `ct-{default,icon,nav,progress,theme,phase3}`: all clean
    (`errors: []` where applicable).
  - `npm run verify` green; `e2e:clip` + `e2e:refael` green — no
    regressions.
  - Hygiene grep: no absolute filesystem paths in changed files.
- **Open:**
  - Live-state wiring is now *possible but not automatic*: running the
    loop + `dashboard --out pages/agent-dashboard.html` replaces the
    placeholder with live plan/memory/journal. Wiring that regenerate
    into the loop's own `run` (post-run hook) or a watcher remains a
    follow-up.
  - The other 0.19 candidates (CLIP `data/clip/samples.json`, clip CLI
    `--out`, woody-shaw chart variants) remain on the backlog.
- **Next:** sprint 0.20 candidates — (a) `run` auto-regenerates the
  served dashboard on pause/exit; (b) CLIP sample strip → generated
  `data/clip/samples.json`; (c) clip CLI `--out <file>`; (d) woody-shaw
  chart variants.

### 2026-09-22 — sprint 0.19.b (merge reconciliation with concurrent main work)

Shipped inside the merge of `origin/main` (which had advanced 7 commits
while sprint 0.19 was in flight — another session shipped a roving-
tabindex fix, a CI PR-mode server change, a ct-a11y scroll fix, and
boot auto-update docs):

- **Repo-wide URL convention converged.** Parallel work established the
  canonical serve shape: **repo root everywhere** (`python3 -m http.server
  5180 --directory .`) — production Pages, launchd dev server, and CI
  PR-mode server alike — with specs hitting `/pages/<page>.html` in every
  mode. Sprint 0.19's ct/clip/refael specs were aligned to this single
  path (ternaries collapsed); earlier pages-dir-convention docs and e2e
  hints updated (`docs/CLIP-INTERROGATOR.md`,
  `docs/REFAEL-MP4-MAKER.md`, README).
- **ct-a11y scroll fix merged with the parallel fix.** The other session
  disabled smooth scrolling and scrolled to `#architecture` with a fixed
  200 ms wait — which they noted *still failed against the deployed
  Pages site*. Sprint 0.19's poll-based fix (disable
  `history.scrollRestoration` + `scrollIntoView` + `waitForFunction`
  for the spy's observable output) was kept on top of their
  smooth-scroll insight; it is the version that passes in every mode
  including the deployed URL.
- **Kept from parallel work:** roving-tabindex spec additions in
  ct-a11y, the og:image path resolution fix in ct-phase3 (supersedes
  sprint 0.19's earlier ct-phase3 path tweak), the CI repo-root server
  switch, `.gitignore` gzip-log entry, and the boot auto-update /
  install-docs work.
- **Verified under the final convention** (repo-root :5180 server):
  ct-verify 16/16, ct-a11y ALL PASS, ct-{default,icon,nav,progress,
  theme,phase3} clean, clip + refael all checks pass, `npm run verify`
  green.
- **Open/next:** unchanged from sprint 0.19's list — auto-regenerating
  the served dashboard on loop pause/exit is the highest-value follow-up.

### 2026-09-22 — sprint 0.20 (how-to page)

- **Shipped:**
  - **`pages/how-to.html`** — the operator's manual for the whole
    repo. Single self-contained HTML file in the cognitive-twin style
    (stone palette, Inter + JetBrains Mono, paired light/dark via
    `prefers-color-scheme` + `<theme-toggle>` persisted to
    `localStorage["ht-theme"]` with a no-flash bootstrap, scroll-spy
    nav with progress bar, mobile drawer, copy-to-clipboard code
    blocks with `execCommand` fallback so headless never throws).
    Nine sections: 01 Quickstart (requirements, the repo-root serve
    command, page map table), 02 Twin OS, 03 CLIP Interrogator
    (setup/UI/CLI + the why-CPU callout), 04 Refael (engines +
    offline caveat), 05 Chart pipeline (export-all + chart-inbox
    watcher), 06 Song indexer (index-songs + audio-inbox watcher +
    empty-catalog fix), 07 Testing (all spec entry points), 08
    LaunchAgents (live state table + verify/tap commands), 09
    Troubleshooting (ports, 404 root cause, mscore exit-code quirk,
    uv cache fix, favicon rule, git author flags) + memory note.
    Every factual claim in the page was verified live before commit:
    `npm run test:all` exists as referenced, LaunchAgent states were
    pulled from `launchctl`, page count fixed to 7.
  - **cognitive-twin footer** — second `.footer-link` "How to run the
    twin" → `./how-to.html` (discoverability; ct-a11y only asserts
    the first footer link, verified before editing).
  - **`e2e/how-to.spec.mjs`** — Puppeteer contract spec, 16 checks:
    title/hero, 9 nav links match expected set, all 9 section ids,
    code blocks == copy buttons (12), copy click throws no errors,
    theme toggle → dark + persists on reload, cross-page links exist,
    every internal link resolves ≤ 400 (HEAD), 0 console errors in
    light + dark passes, screenshots → `e2e/artifacts/howto-{light,dark}.png`.
    Uses the single `/pages/how-to.html` URL convention in every mode.
  - **npm + CI** — `e2e:howto` script; `pages-test.yml` gains push
    + PR lines exactly like the clip/refael lines.
  - **README** — "what's here" bullet, e2e section note, file-tree
    entries, `npm run test:all` mention.
- **Decisions:**
  - **One page, one job: "how do I actually run this?"** The repo had
    landing (pitch), cognitive-twin (why), tool pages (what each tool
    does), and markdown docs (deep reference) — but no page that
    answers "how do I run all of it?" in one place. The how-to is
    deliberately the operator's manual: real commands, real watcher
    states, real failure modes.
  - **Facts verified before copy, not after.** The page documents
    LaunchAgent state (`pgrep`/`launchctl` live-checked: server,
    chart-watcher, songs-watcher, mj-watcher live; boot at login;
    log-rotate 03:00), npm script names (checked against
    package.json), and the repo-root serve convention. A how-to page
    that lies about the system is worse than no page.
  - **Theme key `ht-theme`, not a shared one.** Each page owns its
    localStorage key (dt-theme-pref / ct-theme / ci-theme / ht-theme)
    — keeps pages standalone-openable with zero cross-contamination.
  - **Copy buttons everywhere, fallback included.** `navigator.clipboard`
    in a secure local context can reject; the fallback
    (`textarea` + `document.execCommand('copy')`) guarantees a click
    never throws — which is what the 0-console-error e2e contract
    actually checks.
  - **No nav surgery on other pages.** Only touch = one footer link on
    cognitive-twin (the natural sibling). Landing/twin-os navs stay
    untouched — their e2e contracts are stable.
- **Verified end-to-end:**
  - `e2e:howto` 16/16 PASS on the repo-root :5180 server.
  - `ct-a11y` ALL PASS (footer link added safely), `ct-verify` 16/16
    (dashboard iframe still 200, 0 console errors).
  - `npm run verify` green (landing / twin-os / twin-os-songs).
  - `e2e:clip` + `e2e:refael` green, `npm run test:all` green
    (chart 13 + songs + mj 17).
  - Hygiene grep clean — no absolute filesystem paths in any new file.
- **Open:**
  - The how-to page is static; when the agent-loop dashboard
    auto-regenerates (sprint 0.20 backlog item), the how-to's
    LaunchAgents table + dashboard blurb may need a refresh pass.
  - Page-map table should gain a row when sprint 0.21+ ships another
    page (pattern: add row + bump hero count).
  - Other 0.19/0.20 backlog items unchanged: (a) `run` auto-
    regenerates the served dashboard on pause/exit; (b) CLIP sample
    strip → generated `data/clip/samples.json`; (c) clip CLI `--out`;
    (d) woody-shaw chart variants.
- **Next:** sprint 0.21 candidates — (a) auto-regenerating served
  dashboard (highest value; plumbing exists); (b) `data/clip/samples.json`;
  (c) clip CLI `--out <file>`; (d) chart variants backlog.

### 2026-09-22 — sprint 0.21 (Loopable Video Segmenter port)

- **Shipped:**
  - **`lib/loopable-video-segmenter/`** — uv-managed Python package (CPython
    3.12, `requires-python = ">=3.12,<3.13"`), port of the author's
    `kajica2/loopable-video-segmenter` Gradio app (MIT). `pyproject.toml` +
    committed `uv.lock` + gitignored `.venv/`/`dist/`. Deps:
    `gradio~=5.0`, `moviepy>=1.0.3,<2`, `librosa>=0.10`,
    `soundfile>=0.12`, `numpy>=1.26,<2` (numpy<2 because moviepy 1.0.3
    breaks on numpy 2). Four-module src layout:
    `__init__.py` + `core.py` (**no gradio import**) + `cli.py` + `ui.py`.
    Splits an MP4 into **N beat-aligned, mirror-loopable clips**
    (librosa beat tracking; equal-time fallback when no usable audio).
  - **`core.py`** — faithful port of the author's app.py logic with one
    structural addition: `compute_segments()` split out so CLI + UI share
    the same boundary-detection pipeline, and the status message reports
    which path actually ran (`beat detection` vs `equal-time fallback`)
    instead of upstream's always-claim.
  - **`cli.py`** — verbs `segment <video> [--segments N] [--no-loopable]
    [--out zip|dir] [--json]`, `check --self-check` (imports + deps +
    ffmpeg binary presence; no downloads). Exit codes 0 / 2 bad input /
    3 runtime. `--json` emits `{status, message, zip, segments, loopable}`.
  - **`ui.py`** — faithful Blocks port, plain 5.x-safe APIs (no
    `num_classes`, `api_name` on `.click()` not Button). Launches on
    **127.0.0.1:7861** — deliberately NOT 7860, which the CLIP
    Interrogator owns.
  - **`pages/loopable-video-segmenter.html`** — house-style tool page
    (stone palette, Inter + JetBrains Mono, paired light/dark under
    `localStorage["lvs-theme"]` with no-flash bootstrap, scroll-spy +
    progress bar, mobile drawer, copy buttons with execCommand fallback,
    data-URI ⛯ favicon). Sections: what / run (setup + UI + CLI) /
    params (3-row table) / how-it-works (5 steps) / notes (mirrored-audio
    caveat callout) / attribution. NO working browser demo.
  - **Twin OS** — Songs panel `.tool-grid` gains a third local card
    (`a[data-tool-lvs]`, href `../loopable-video-segmenter.html`).
  - **how-to page** — page-map gains the LVS row; hero count 7 → **8**
    (the sprint-0.20 open item "add row + bump hero count", closed).
  - **`docs/LOOPABLE-VIDEO-SEGMENTER.md`** — full reference: install,
    UI, CLI flags + exit codes, how the segmentation works, package
    layout, npm scripts, e2e, attribution, verified-run log.
  - **`e2e/loopable-video-segmenter.spec.mjs`** — Puppeteer contract
    spec, 19 checks, single `/pages/loopable-video-segmenter.html` URL
    convention, runs WITHOUT Python deps. Asserts hero, plain
    `#themeToggle` flip + reload persistence, params table 4 rows,
    how-it-works 5 steps, `npm run lvs:ui` in how-to-run, `--json`
    mention, mirrored-audio warning, attribution, local-first chip,
    **every code block has a copy button (3 blocks, 3 btns)**, internal
    links ≤ 400, twin-os `data-tool-lvs` card, 0 console errors on both
    pages, screenshots → `e2e/artifacts/lvs-{light,dark,twinos}.png`.
  - **npm scripts** — `lvs:setup` / `lvs:ui` / `lvs:segment` (includes
    the `segment` verb so `npm run lvs:segment -- video.mp4 --segments 4`
    is ergonomic) / `lvs:check` / `e2e:lvs`.
  - **CI** — `pages-test.yml` gains push + PR lines exactly like the
    clip/refael/how-to lines.
  - **README** — status line, "what's here" bullets, "Run the Loopable
    Video Segmenter" section, e2e note, file-tree entries (page + lib
    package + docs).
  - **`.gitignore`** — `lib/loopable-video-segmenter/.venv/` + `dist/`.
- **Decisions:**
  - **Same port pattern as CLIP, not Refael.** Python backend + gradio
    UI + headless CLI → uv-managed package with the core/CLI/UI split.
    The CLI gets real value here (the GUI flow is the primary path, but
    `--json` + `--out` make it scriptable for batch/drop-in use).
  - **MoviePy pinned 1.x, numpy pinned <2.** The author's proven stack
    (`moviepy.editor`, `subclip`, `vfx.time_mirror` are 1.x APIs);
    moviepy 1.0.3 does not support numpy 2. Don't port fresh and risk
    breaking the working code on a 2.x rewrite — document the swap as a
    future exercise instead.
  - **UI on 7861, not 7860.** The CLIP Interrogator owns
    `127.0.0.1:7860`; the twin runs both. Documented in page + docs.
  - **Status message reports the actual path.** Upstream's UI always
    claimed beat detection; the port says `beat detection` or
    `equal-time fallback`. Honest output matters for `--json` scripting.
  - **How-to page-map row, no new how-to section.** The how-to spec
    asserts exactly 9 nav links + 9 section ids; a full section would
    change that contract, which the sprint-0.20 pattern explicitly does
    NOT ask for. Row + count bump is the documented pattern.
  - **Stale spec whitelist fixed, not the page.** `twin-os-songs`
    hardcoded `['mp3','wav']` as valid format chips, but the indexer has
    emitted `.aif`/`.aiff` (format = extension sans dot) since sprint
    0.14. First row of the local catalog is `aif` → check failed. The
    page was right; the test's whitelist predated AIFF support. Fix:
    `['mp3','wav','aif','aiff']` now matches `SUPPORTED_EXTS`.
- **Verified end-to-end (real runs, not just static):**
  - `uv sync` clean: numpy 1.26.4 / moviepy 1.0.3 / gradio 5.50.0 /
    librosa 0.11.0 / soundfile 0.14.0.
  - `lvs:check` green — imports + deps + ffmpeg binary found.
  - CLI smoke on generated fixtures (ffmpeg testsrc + click track):
    **beat path** → `"using beat detection"`, ZIP with 2 real MP4s,
    ffprobe-verified 1.0s/2.0s (mirror doubling correct); **fallback**
    (silent video) → `"using equal-time fallback"`; **--no-loopable**
    → plain cuts; missing file → exit 2.
  - UI launch: binds 127.0.0.1:7861, `GET / → 200`, config carries
    `api_name: ['create-segments']` (in **dependencies**, not components
    — first probe looked in the wrong field), 1 markdown / 1 video /
    1 slider.
  - `npm run e2e:lvs` 19/19 PASS on the repo-root :5180 server.
  - `npm run verify` green after the twin-os tool-grid edit + the
    twin-os-songs whitelist fix.
  - `e2e:clip` + `e2e:refael` green (both touch twin-os cards).
  - ct-verify 16/16 + ct-a11y ALL PASS; `npm run test:all` green
    (chart 36 + songs 16 + mj 17).
  - `e2e:howto` green after the page-map row + hero count edit.
  - Hygiene grep clean — no absolute filesystem paths in any new file.
- **Open:**
  - The LVS CLI writes its zip to a temp dir by default (printed);
    `--out` handles the destination. Fine as-is.
  - BC: a future sprint could port the app to moviepy 2.x (numpy 2
    current) — not worth the regression risk now.
  - Other backlog unchanged: (a) auto-regenerating served dashboard;
    (b) `data/clip/samples.json`; (c) clip CLI `--out`; (d) woody-shaw
    chart variants.
- **Next:** sprint 0.22 candidates — (a) auto-regenerating served
  dashboard (highest value; plumbing exists); (b) `data/clip/samples.json`;
  (c) clip CLI `--out <file>`; (d) chart variants backlog.
