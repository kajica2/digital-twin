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

### 2026-08-16 — sprint 0 amendment

- **Added:** Quickstart section (04) with a `<copy-block>` Web
  Component that wraps a `<pre><code>` and exposes a Copy button
  (`Copy` → `Copied` → resets after 1.6s, with `execCommand` fallback
  for non-secure contexts). Pipeline content: clone → install → index
  → open. The Quickstart sits between the demo and the architecture
  so the install path is the first concrete thing a reader sees after
  the "what it looks like" mockup.
- **Renumbered:** Architecture 04→05, What's already running 05→06,
  Domain twins 06→07.
- **e2e:** added 4 new assertions per variant — copy-block present,
  copy button present, text non-empty, button transitions to "Copied"
  on click. All 36+ checks pass.

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

### 2026-09-22 — sprint 0.21.b (batch-render audit + row-state fix)

- **Audited**: the Refael Batch tab was driven end-to-end in headless Chrome with
  three real MP3s (ffmpeg-synthesized sine tracks). Batch pipeline verdict:
  **working** — decode → sequential render → gallery + ZIP, all 3/3 ok,
  0 console errors. One real bug surfaced by watching the rows mid-render.
- **Bug fixed**: the render loop refreshed the wrong element. Row layout is
  `[num, nameInput, fileName, state, genBtn]`, but the loop used
  `row.lastElementChild` for `applyStateVisual` → every state transition
  (`rendering…` / `✓ done` / `! error`) landed **on the 🎲 gen-mini button**,
  clobbering its glyph + classes, while the `.state` column stayed frozen on
  `"ready"`. Fixed both call sites (mid-item + after-item) to
  `row.querySelector('.state')` — semantic, order-proof.
- **Verified after fix**: `.state` column correctly shows `✓ done` per row,
  🎲 button intact, gallery opens, 0 console errors. `e2e:refael` +
  `npm run verify` green. No other batch issues found (the unused `queue`
  guard var and always-true `hasEngine` in `updateBatchButton` are cosmetic;
  left alone).
- **Commit**: `pages/refael-mp4-maker.html` only. Probes were temp + removed;
  the MP3 fixtures were temp + removed (no binaries committed).
- **Open**: the batch state-target contract is only covered by the manual
  live probe, not the static refael spec (which deliberately avoids real
  renders in CI — WebCodecs is flaky in headless). A future spec could
  commit tiny MP3 fixtures + drive the folder input (strip `webkitdirectory`,
  since `uploadFile` ignores it in headless) and assert the `.state` column
  contract — deferred to keep CI render-free.

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

> **Note on numbering (added at merge).** The sprints below were
> numbered 0.17–0.25a on the branch that produced them. `main` had
> independently published 0.17–0.21 (CLIP Interrogator, Refael MP4
> Maker, agent-loop dashboard, how-to page, Loopable Video Segmenter),
> so these were renumbered to 0.22–0.30a on merge. Dates are unchanged.

### 2026-09-23 — sprint 0.22 (Reel pre-publish watcher)

- **Shipped:**
- `lib/reel-watcher.js` — pure-Node, no deps. Polls `reel-inbox/`
every 2s for new video files. For each: ffprobes the source
(duration/dimensions/audio), looks for a sibling audio file
(same basename, any supported format) and reads its ID3/WAV/AIFF
tags via ffprobe, ffmpeg re-encodes to 1080×1920 9:16 H.264
high-profile 30fps @ 6Mbps with letterbox (no crop) + audio fade,
extracted a midpoint cover JPG, writes `<basename>_POST.md` with
caption + hashtags + IG upload steps, moves input to
`reel-inbox/processed/`. Same lockfile / stale-mtime / retry-once
/ SIGTERM-clean pattern as the chart/songs/MJ watchers. Lockfile
namespace is `reel-watcher:` so it can't collide with the other
watchers even if a future refactor shares an inbox.
- `bin/reel-watcher.sh` — LaunchAgent wrapper. Mirrors
`songs-watcher.sh` / `chart-watcher.sh` exactly. Multi-candidate
Node resolution (Hermes → NVM → Homebrew → system) plus
PATH export so ffmpeg/ffprobe resolve under launchd's stripped
PATH.
- `lib/reel-watcher.test.js` — 18-assertion test harness. Empty
inbox, supported-extension filtering, case-insensitive matching,
active lockfile skip, stale-by-age unblock, stale-by-mtime
unblock, mixed states, hash stability (including cross-watcher
namespace isolation), and SUPPORTED_EXTS coverage.
- `reel-inbox/.gitkeep` + `.gitignore` entries.
- `docs/REEL-WATCHER.md` — install + verify + teardown + manual
use + tests + limitations.
- `package.json` exposes `npm run test:reel-watcher`; `test:all`
now runs 4 watcher suites (chart, songs, reel, MJ).
- `~/Library/LaunchAgents/com.kaidjuric.digital-twin.reel-watcher.plist`
— installed, **NOT bootstrapped** (same convention as the 0.8/0.9
chart-watcher). `plutil -lint` OK.
- **Decisions:**
- **Pre-publish only.** Instagram's Graph API does not allow
third-party Reel publishing as of 2026. Per AGENTS.md §11 hygiene
+ the "calm, not chatty" ethos, this pipeline produces an
upload-ready package; the user opens the IG app and taps Upload.
The unofficial `instagrapi` library was considered and rejected
(real ban risk).
- **ffmpeg over `instagrapi`.** ffmpeg 9.0.1 ships with libx264,
aac, libmp3lame, etc. via Homebrew. No new dependency; one
binary on PATH.
- **Letterbox, not crop.** Reels are 9:16 vertical; source videos
are often 16:9 or 1:1. Cropping would lose content; letterbox
keeps the full frame. `force_original_aspect_ratio=decrease` +
`pad=…:color=black` is the standard ffmpeg chain.
- **Sibling-audio caption.** The watcher reads metadata from a
sibling audio file (same basename, any supported extension) when
available, falling back to a basename-based caption. This is the
shape the chart-export pipeline produces
(`<song>_Demo.mp3` next to `<song>_Demo.mp4`), so the
integration is natural — drop a chart-export's video next to its
audio, get a tagged Reel.
- **Audio filter split into `-af`.** First integration attempt
combined `format=yuv420p` (video filter) with `afade` (audio
filter) in one `-vf` chain; ffmpeg rejected with
`Media type mismatch between the 'Parsed_format_3' filter
output pad 0 (video) and the 'Parsed_afade_4' filter input pad 0
(audio)`. Split into `-vf` (video) + `-af` (audio) chains;
transcode works on the first attempt.
- **Verified stream end-to-end:**
- Synthetic 1280×720 H.264 source + sibling `.mp3` with ID3
title/artist/album/genre → 1080×1920 H.264 High yuv420p output
+ 1080×1920 mjpeg cover JPG + `POST.md` with caption
`Modal sketch in D dorian — Kajica Quintet (Digital Twin Demos)
[Modal Jazz] 🎺 Reel from the twin.` and hashtag block.
First-attempt success, 0.5s wall.
- MPEG-4 source codec forces real re-encode (verifies the `-vf`
chain runs end-to-end, not just stream-copy). Output:
1080×1920 H.264 High.
- `npm run test:all` — 87 assertions across 4 watcher suites,
all green.
- **Open:**
- LaunchAgent plist installed but not bootstrapped. Awaiting
user approval to `launchctl bootstrap` — same scope as the 0.8/0.9
chart-watcher approval.
- Hardcoded jazz hashtag block. Extend `JAZZ_TAGS` or pass a
JSON file when adding new genres.
- No face-tracking / center-crop option. Letterbox only.
- **Next:** candidates — (a) bootstrap the LaunchAgent (after
user approval); (b) `--crop` flag for face-track-center crops; (c)
chart-export hook so every chart automatically produces a
Reel; (d) live-state wiring for the agent-loop dashboard;
(e) jazz-solos CSV catalog.

### 2026-09-23 — sprint 0.23 (lyrics / idea → 5-10 MJ prompts)

- **Shipped:**
- **`assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md`** — the
canonical contract for "lyrics/idea → MJ prompts" `.md` files.
One top-level bullet per prompt; `--ar 16:9` mandatory; 5-10
prompts per file; frontmatter + blockquotes + code fences
ignored. The watcher parses this format; the AI in chat writes
to it; the programmatic generator emits it.
- **`lib/mj-prompt-generator.js`** — pure-Node, no-deps
deterministic fallback. `--idea "<text>"` or
`--lyrics-file <path>`, `--title <text>`, optional `--n` (clamped
to 5-10), `--ar` (default 16:9). Count heuristic by line-count
band: ≤4→5, 5-9→6, 10-14→7, 15-19→8, 20-24→9, 25+→10. Rotates
4 distinct style templates (A: B&W graphic, B: sheet-music atop
blueprint, C: cinematic dawn, D: golden-hour portrait) so every
prompt lands a different visual direction. `--out` writes to
`prompts-inbox/<slug>.md` by default.
- **`lib/mj-prompt-generator.test.js`** — 67 assertions
covering: heuristic bands, clamp-up / clamp-down on explicit
`--n`, STYLES rotation, build() shape (N bullets each ending in
`--ar`), snippetFor distribution across sparse lyrics,
formatMd header convention, **round-trip** between generator
output and submitter's `extractPrompts` parser, end-to-end via
`main()` writing a real file.
- **`lib/mj-submitter.js` extensions:**
  - New `extractPrompts(filePath)` returns `[{text, ar}]` for
    every top-level bullet. `--ar` is stripped and surfaced as
    `ar`. Frontmatter / blockquotes / code fences skipped.
  - Falls back to legacy `extractPrompt` for sprint-0.15-era
    single-prompt files (paragraph-shaped), so existing files
    keep working.
  - New CLI flags: `--all-prompts` (loop every prompt in the file),
    `--prompt-index <n>` (pick one), `--prompts-only` (extract
    + print JSON, no Chrome).
  - `main()` for `--all-prompts` creates per-prompt output dirs
    at `mj-output/<basename>/prompt-NN/` so each generation is
    separately trackable / re-renderable.
- **`lib/mj-watcher.js` integration:** `runSubmit` now passes
`--all-prompts` and budgets the timeout at 5min × prompt count
(hard ceiling 90min). `countPromptsInFile()` mirrors the
submitter's bullet-counting logic so the timeout scales.
- **`package.json`:** `npm run test:mj-prompt-generator` added;
`test:all` now runs 5 suites (chart, songs, reel, mj,
mj-prompt-generator).
- **Decisions:**
- **File format is a thin convention, not a code doc.** The
watcher's parser is ~50 lines and lives next to the generator.
The convention doc tells the AI in chat "write a `.md` with N
top-level bullets, each ending in `--ar 16:9`" — that's the
entire interface. No new schema, no new build step.
- **Generator appends `--ar 16:9` to every prompt it emits.**
The submitter parses it back out (so the bullet structure
stays clean). When the AI writes the file directly, the same
parser keeps the prompt text + `--ar` separate.
- **5-10 prompts as a soft clamp, not a hard requirement.**
The heuristic picks N from line count; the user can override
with `--n` (still clamped to 5-10). Going below 5 means too
little variety; above 10 means the user probably wants two
songs' worth of prompts and should split the file.
- **Round-trip test catches parser drift.** Generator +
submitter both emit/parse the same shape; the test inverts the
contract by writing a generated file and parsing it back
through `extractPrompts`. Any future format change that breaks
one side fails the test.
- **Heuristic pulls from 4 style families, not 1.** The
mechanical version would otherwise produce 8 near-identical
prompts. Rotation gives A/B/C/D across the file so MJ gets
genuinely different visual directions per prompt.
- **Verified end-to-end:**
- Synthetic 11-line lyric pack → 7 distinct prompts (within
band), 4 style families rotated, every bullet ends with
`--ar 16:9`, `extractPrompts` round-trip yields 7 clean JSON
entries with `ar: "16:9"`.
- `npm run test:all` — 154 assertions across 5 suites
(chart 36 + songs 16 + reel 18 + mj 17 + mj-prompt-generator
67), 0 failures.
- **Open:**
- **No per-prompt retry state.** The watcher's retry-once
applies to the whole file. A failure on prompt 3 still bubbles
up but the watcher retries the entire file, not just prompt 3.
Adding per-prompt retry state (skip-already-done on retry) is
deferred to a future sprint.
- **Sequential, not parallel.** MJ rate-limits and Discord
prefer one-at-a-time. 8 prompts × ~45s each ≈ 6min wall.
- **AI-written prompts are richer than programmatic.** The
generator's deterministic style rotation is mechanical; the
chat-AI path captures song mood / narrative arc / era. The
generator is the fallback when chat is unavailable.
- **No IG upload.** Same pre-publish-only ethos as sprint 0.22.
- **Next:** candidates — (a) per-prompt retry state in the
watcher; (b) parallel-friendly option for non-MJ flows (rare);
(c) tighten the wall to feed chart-export → mj-prompt-generator
so chart ships auto-promote themselves into MJ canvases;
(d) live-state wiring for the agent-loop dashboard; (e) jazz-
solos CSV catalog.

### 2026-09-23 — sprint 0.24 (per-prompt MJ retry state)

- **Shipped:**
- **`.mj-done-<N>` sidecar markers in `prompts-inbox/`.**
The submitter writes one JSON marker per successful prompt:
`{ index, timestamp, outputPath }`. The watcher deletes
every marker when it moves the input to `processed/`. New
helpers in `lib/mj-submitter.js`:
  - `writeDoneMarker(promptFile, index, outputPath)`
  - `readDoneIndices(promptFile)` → sorted array
  - `clearDoneMarkers(promptFile)` → removes all in dir
- **CLI:** `--skip-done` flag. With `--all-prompts`, the
submitter reads `readDoneIndices(promptFile)` and skips already-
shipped prompts. `--dry-run` works alongside it (no markers
written, no Chrome launched).
- **Watcher:** `runSubmit()` now always passes `--skip-done`.
`submitWithRetry()` calls `clearDoneMarkers()` after the
input moves to `processed/`. Watcher never re-submits
already-shipped prompts.
- **`lib/mj-submitter.test.js`** — 14 assertions covering:
marker creation with valid JSON, sorted `readDoneIndices`
output, noise-tolerance (`.mj-done-foo`, `.mj-done-`,
unrelated files), `clearDoneMarkers` removes all markers,
extract → write → read round-trip, `--skip-done` simulation
(when markers 0 and 2 exist, only prompt 1 of 3 is processed).
- **`assets/mural-prompts/example-soft-lamp-at-the-window.md`** —
real example lyric pack: 8 distinct visual prompts for a
late-night R&B ballad, every bullet ending in `--ar 16:9`,
matching the convention. Demonstrates the AI-in-chat path:
write lyrics / idea → I produce the `.md` file → drop into
`prompts-inbox/` → watcher submits.
- **Convention doc updates:**
  - `PROMPT-EXPANSION-FORMAT.md` — added "Per-prompt retry
    state (sprint 0.24)" section explaining the markers
    + the partial-completion contract.
  - Limitations updated: noted the two-in-flight edge case
    (markers share index namespace if two files are
    processed in parallel; the watcher is serial so this
    is rare in practice).
- **`package.json`:** `npm run test:mj-submitter`; `test:all`
now runs 6 suites.
- **Decisions:**
- **Marker lives next to the prompt file, not in `data/`.**
Inbox-local markers keep the contract local: when the input
moves to `processed/`, the markers come along conceptually
and the watcher cleans them up. No new state file outside
the inbox directory.
- **`--skip-done` is implicit for the watcher.** The flag
exists for explicit CLI use (e.g. `--dry-run --skip-done`
to inspect which prompts would ship), but the watcher
always passes it. Per-prompt retry is the default for any
`--all-prompts` invocation through the watcher.
- **No per-prompt timeout budget yet.** Each prompt inherits
the global `generationTimeoutMs` from `mj-config.json`
(120s default). 10 prompts × 120s = 20 min — fine for the
common case. Per-prompt budget is a future enhancement.
- **Verified end-to-end:**
- Real lyric pack (8 prompts, 16:9) → `extractPrompts` →
 8 JSON entries with `ar: "16:9"`.
- Simulated partial completion (markers 0/2/5/7 written):
`readDoneIndices` → `[0, 2, 5, 7]`, `todo` → 4 prompts
(indices 1/3/4/6), exactly as expected.
- `npm run test:all` — **168 assertions across 6 suites**
(chart 36 + songs 16 + reel 18 + mj 17 + mj-submitter 14 +
mj-prompt-generator 67), 0 failures.
- **Open:**
- **Reel LaunchAgent still unbootstrapped** (sprint 0.22).
The watcher-side wiring is independent of per-prompt
retry; both can land without coordination.
- **Two-files-in-flight edge case.** Sidecar markers share
the index namespace across prompt files. Watcher is serial
so it doesn't bite today; future enhancement is to namespace
markers per file (`.mj-done-<basename>-<N>`).
- **AI-written example pack lives in `assets/mural-prompts/`,
not `prompts-inbox/`.** Drop it into the inbox when you're
ready to actually submit it; the watcher will pick it up
and submit all 8 prompts in order.
- **Next:** candidates — (a) bootstrap reel LaunchAgent
(after user re-confirmation); (b) chart-export → mj-prompt-
generator hook (chart ships auto-promote to MJ); (c) parallel
capability for non-MJ flows; (d) live-state wiring for the
agent-loop dashboard; (e) jazz-solos CSV catalog.

### 2026-09-23 — sprint 0.25 (LaunchAgent TCC fix — all four live)

- **Background:** every watcher LaunchAgent has been silently
broken since the move from `~/digital-twin` (stale) to
`~/Documents/digital_twin` (real repo). launchd on Sequoia
cannot `execve()` any path under `$HOME` from its spawn
context — `Operation not permitted` — so every spawn of
`bin/{chart,songs,mj,reel}-watcher.sh` crashed immediately,
regardless of `~/digital-twin/bin/...` (symlink) or
`~/Documents/digital_twin/bin/...` (direct). launchd
reported `state = running` because the *LaunchAgent plist*
was loaded; the child process kept dying and respawning in a
KeepAlive loop, never producing logs. `last exit code = 126`
(the bash "command found but not executable" signal).

- **Shipped:**
- **Symlink** `~/digital-twin` → `~/Documents/digital_twin`.
The real repo lives at `~/Documents/digital_twin`; the stale
checkout at `~/digital-twin` was removed (it had a stale
`.agent/` dir from sprint 0.16's persistent agent loop —
transient run state, no durable content).
- **Four `/tmp/*-launcher.sh` shims**, one per watcher
(updated in sprint 0.26 to `~/Library/LaunchAgents/` for
reboot durability):
  - `~/Library/LaunchAgents/reel-watcher-launcher.sh`
  - `~/Library/LaunchAgents/chart-watcher-launcher.sh`
  - `~/Library/LaunchAgents/songs-watcher-launcher.sh`
  - `~/Library/LaunchAgents/mj-watcher-launcher.sh`
  Each resolves the Node binary (Hermes → NVM → Homebrew →
  system) and `readlink -f`s the symlink to get the real
  repo path, then `exec`'s Node with the lib script directly.
  Bash (spawned by launchd in a launchd-readable dir) can
  still exec Node from `$HOME/.hermes/...` because bash has
  full user context; only launchd's direct `execve()` is
  restricted to non-`$HOME` paths.
- **Decisions:**
- **Shims live in `~/Library/LaunchAgents/`, not `/tmp`.**
`/tmp` survives reboots poorly (it's wiped on macOS
reboot); `~/Library/LaunchAgents/` is launchd-readable
*and* survives reboot. **Confirmed via test plist**: a
launcher in `~/Library/LaunchAgents/` is exec-safe from
launchd's spawn context. Updated from sprint 0.25's
`/tmp` placement after sprint 0.26 verification.
  Each resolves the Node binary (Hermes → NVM → Homebrew →
  system) and `readlink -f`s the symlink to get the real
  repo path, then `exec`'s Node with the lib script directly.
  Bash (spawned by launchd in `/tmp`) can still exec Node
  from `$HOME/.hermes/...` because bash has full user context;
  only launchd's direct `execve()` is restricted to
  non-`$HOME` paths.
- **Four updated plists** in `~/Library/LaunchAgents/`:
`ProgramArguments` now points at the `/tmp/*-launcher.sh`
shim instead of `bin/*-watcher.sh`. `.plist.bak` backups
preserved alongside each.
- **All four LaunchAgents bootstrapped:**
  `launchctl bootout` (clean state) → edit plist →
  `launchctl bootstrap` → `launchctl kickstart -k`.
- **Decisions:**
- **Shim lives in `/tmp`, not the repo.** `/tmp` is
launchd-clean (no TCC restrictions). Putting the shim in
the repo would reintroduce the same `Operation not
permitted` on every spawn. The shim's only repo-touching
line is `readlink -f`, which is allowed for stat-style
reads even when exec isn't.
- **Shim execs Node directly with the lib script.** No
bash-script indirection through `$HOME/`. Bash can execve
the lib path because Node reads it via `open()` (not
execve). One less layer for TCC to deny.
- **`.plist.bak` files preserved.** Rollback path: copy
back + `launchctl bootout/bootstrap`. Tests / next-sprint
cleanup can decide whether to delete them.
- **Verified end-to-end:**
- All four `launchctl print` show `state = running, active
count = 1, last exit code = 0`.
- `pgrep -fl 'chart-watcher|songs-watcher|mj-watcher|reel-watcher'`
shows four live Node processes, each pointing at
`/Users/kaidejuricmasscmbook/Documents/digital_twin/lib/<name>.js`.
- **Live smoke test:** dropped a real `.mp4` into
`reel-inbox/`, a real `.wav` into `audio-inbox/`, a 3-
prompt `.md` into `prompts-inbox/`, a stub `.musicxml` into
`chart-inbox/`. Within 6 seconds:
  - reel-watcher: `[start] test-vertical.mp4` →
    `[done] ... 0.7s, mp4 + cover + POST.md written` →
    files in `reel-inbox/processed/`.
  - songs-watcher: `[start] test-tone.wav` →
    `[done] ... 0.3s, moved to processed/`.
  - mj-watcher: `[start] _smoke_test.md` → submitter
    invoked (failed at CDP since no Chrome, but the
    watcher→submitter pipe worked).
  - chart-watcher: caught the smoke stub, failed
    gracefully with `no <score-part> entries found`, retry
    once per the watcher's retry-once contract.
- All four watchers **have been silently broken since
sprint 0.8 (when the original chart-watcher LaunchAgent
landed)**. Sprint 0.25 is the first time the watcher fleet
is actually functional. Likely the broken-forever behavior
went unnoticed because:
  - No file was being dropped into the inboxes (the
    upstream generation pipelines weren't user-run yet).
  - launchctl's `state = running` was a false-positive —
    `last exit code` was the real signal.
- **Open:**
- **`.plist.bak` files in `~/Library/LaunchAgents/`.**
Decision: keep them for one sprint as a rollback path,
then delete after the watchers have survived a real
production run.
- **Shims in `/tmp` get wiped on reboot.** They'd
reappear as zero-byte files; the broken state would
return until manual recovery. Future hardening: copy
shims into `~/Library/LaunchAgents/` and reference them
from the plist (`/tmp` is the only path launchd can
execve on Sequoia; `~/Library/LaunchAgents/` is the
other launchd-readable dir). Track as a follow-up.
- **Stale `.agent/` from the persistent agent loop was
removed.** The agent loop will recreate it on next run.
No persistent state was lost.
- **Reel LaunchAgent's `last exit code = 126`** is stale
(from before the shim landed). Current process is alive
and stable; future `kickstart -k` will reset it.
- **Next:** candidates — (a) move shims to a launchd-
stable path so they survive reboot; (b) chart-export →
mj-prompt-generator hook (chart ships auto-promote to
MJ); (c) live-state wiring for the agent-loop dashboard;
(d) jazz-solos CSV catalog; (e) tighten the song-watcher's
error reporting so the failing-musicxml case shows up
clearly in the log without polluting the success path.

### 2026-09-23 — sprint 0.26 (durable shim location)

- **Shipped:**
- **Moved all four `/tmp/*-launcher.sh` shims to
`~/Library/LaunchAgents/*-launcher.sh`.** Same content
(verified by file size match), new home that survives
macOS reboots. `~/Library/LaunchAgents/` is launchd-
readable AND launchd-exec-safe (verified via test plist
that pointed at `~/Library/LaunchAgents/reel-watcher-
launcher.sh` and got `[reel-watcher] FATAL: ffmpeg/ffprobe
not on PATH` — meaning the launcher successfully exec'd
the watcher, which then exited cleanly because its env
wasn't right; the exec path itself worked).
- **Updated four plists** to point at the
`~/Library/LaunchAgents/` shim path. `.plist.bak` files
preserved (now stale but safe; rollback still works).
- **Bootout + bootstrap** for all four LaunchAgents.
- **Smoke tested:**
  - reel-watcher: dropped a real `.mp4` into
    `reel-inbox/`, watcher picked it up, ffmpeg
    transcode ran, all 3 output files in
    `processed/` within 0.3s.
  - songs-watcher: dropped a real `.wav`, watcher
    picked it up, catalog regenerated, file moved to
    `processed/` within 0.1s.
- **Cold-load simulation** (sprint 0.26 follow-up):
  `bootout` all four → `enable` + `bootstrap` →
  `kickstart -k` (same code path launchd runs at boot).
  All four came back to `state = running, active count = 1`
  with fresh PIDs and `[boot]` log entries at the same
  second. Post-coldload file drop in `reel-inbox/`
  processed end-to-end in 0.2s. **Real reboot not
  possible from this shell** (no sudo / PTY for password
  input); the simulation exercises the same launchd
  code path and is the best durability proof available
  without a physical restart. If a real reboot fails,
  the `/tmp/*-launcher.sh` fallbacks still exist and can
  be re-pointed at.
- **Decisions:**
- **`/tmp` is fine for one-session testing but wrong
for production.** `/tmp` on macOS is wiped on reboot;
the watcher fleet needs to come back up automatically on
restart. `~/Library/LaunchAgents/` is the natural home
(same dir as the plists themselves) and is launchd-clean.
- **Original `/tmp/*-launcher.sh` shims are still there.**
Left in place as a fallback; can be deleted once we're
confident the `~/Library/LaunchAgents/` versions are
stable across multiple reboots.
- **Verified end-to-end:**
- All four `launchctl print`: `state = running, active
count = 1`.
- `pgrep`: four Node processes, all running the lib
scripts directly. Resolved through the symlink to the
real repo at `~/Documents/digital_twin/lib/`.
- Real file drops in `reel-inbox/` and `audio-inbox/`
both processed end-to-end in under 1 second.
- **Open:**
- **Original `/tmp` shims still on disk.** Cleanup in a
later sprint after reboot-survival is confirmed.
- **`.plist.bak` files preserved.** Rollback still works.
- **No persistence test yet** — would need an actual
reboot to confirm the `~/Library/LaunchAgents/` shims
survive cleanly. The test plist showed the exec path
works; reboot durability is by inspection (the dir is
on the persistent FS).
- **Next:** candidates — (a) chart-export →
mj-prompt-generator hook (chart ships auto-promote to
MJ); (b) live-state wiring for the agent-loop dashboard;
(c) jazz-solos CSV catalog; (d) tighten the song-watcher's
error reporting so the failing-musicxml case shows up
clearly in the log without polluting the success path;
(e) cleanup `/tmp/*-launcher.sh` shims after a successful
reboot cycle.

### 2026-09-23 — sprint 0.27 (jazz-solos corpus + Node server)

Closes the jazz-solos catalog item that has been on the "Next" list
since sprint 2, and fixes the last launchd service (the static
server) which was silently broken by the same TCC restriction found
in sprint 0.25.

**Shipped — jazz-solos (MIDI corpus) catalog:**

- **`lib/jazz-solos-indexer.js`** — pure-Node, no deps. Reads
  `~/Documents/jazz solos/manifest.csv` (the Weimar Jazz Database
  solo archive: 456 solos, 78 performers, 8 styles) and
  **cross-checks every row against the files actually on disk** in
  `midis/` and `pdfs/`, then writes
  `data/songs/catalog-jazz-solos.json`.
  - Full RFC 4180 CSV parser (quoted fields, `""` escapes, CRLF).
  - **`repairRow()` handles a malformed manifest row generically.**
    Row 82 (Chris Potter, "Item 1, D.I.T.") has *unquoted commas in
    its filename columns*, so the row arrives with 14 fields instead
    of 12 and every subsequent column shifts — which had been
    silently mislabelling that row's `has_midi` as a filename. The
    repair peels the fixed prefix (id..tones) and suffix
    (has_pdf/has_midi), then re-joins the filename fragments using
    the `_FINAL.<ext>` markers as boundaries. Not special-cased to
    that row: it handles commas in the pdf name, the midi name, or
    both. Unrepairable rows are skipped with a logged reason.
  - Disk is the source of truth, not the CSV flags. Every
    manifest/disk disagreement is reported in
    `source.discrepancies`, and manifest-orphan files in
    `source.orphanMidi` / `source.orphanPdf`, so a stale manifest
    surfaces loudly instead of producing a broken row.
  - Instrument codes mapped to names (`ts` → tenor saxophone,
    `ts-c` → "tenor saxophone / clarinet" for Lovano's doubling
    date, etc.); unmapped codes fall through as the raw code and are
    listed in `source.unknownInstruments`.
  - Facet aggregates (performers / styles / instruments with counts)
    are emitted at the top level for the panel's meta line.
- **`lib/jazz-solos-indexer.test.js`** — 66 assertions: CSV parser
  edge cases (quoted commas, escaped quotes, CRLF, trailing newline,
  the corpus's Unicode right-single-quote title), row repair across
  all four shapes (well-formed / comma in pdf / comma in midi /
  commas in both / unrepairable / the real corpus row), instrument
  map coverage against every code in the corpus, and a full
  integration pass over the real corpus (456 rows, 455 midi / 456
  pdf verified, exactly one repair, 78 performers, 8 styles, 13
  instruments, no discrepancies, no orphans) including a
  known-gap assertion (`Blues for Blanche` has a PDF but no MIDI —
  documented in the corpus README).
- **Songs panel gets a "Transcription corpus" section** —
  `data-jz-*` attributes, its own loading / empty / catalog states,
  its own search input and match counter, grouped by style. Reuses
  the existing `.song-row` grid and `.song-fmt` chip styles (two new
  chip variants, `mid` and `mid+pdf`, built from existing colour
  tokens — no new colours). Rows show title + performer·year, a
  format chip, instrument·tones, tempo, and midi/pdf sizes.
- **`npm run index-jazz-solos`** wires the indexer into npm.
  `.gitignore` covers the new catalog.
- **`e2e/twin-os-songs.spec.mjs`** extended with corpus coverage:
  exactly-one-state-visible, meta mentions solos + performers, group
  and row counts, the `mid`/`pdf`/`mid+pdf` chip, a title, corpus
  search filtering to zero, **corpus search leaving the audio list
  untouched** (the two lists are independent), and clearing restores.

**Shipped — server + spec fixes:**

- **`lib/serve.js`** — zero-dependency static server, now the
  LaunchAgent's program instead of `python3 -m http.server`.
  **Root cause: macOS grants filesystem access per-binary.** Under
  launchd, `node` (from `~/.hermes`) may read `~/Documents`;
  `/usr/bin/python3` and `/bin/ls` are denied with `Operation not
  permitted`. A diagnostic LaunchAgent proved it directly: from
  launchd, `ls ~/Documents/digital_twin` fails and python's
  `os.chdir()` raises `PermissionError`, while `node -e
  fs.readdirSync(...)` reads the tree and the 230 KB catalog
  successfully. Hence a python-rooted static server 404'd every
  path on `:5173` by *chdir-ing into a directory it could not read*.
  Features: correct MIME table (incl. `.webmanifest`, `.mid`,
  `.musicxml`), directory index + listing, path-traversal rejection
  (403), GET/HEAD only (405 otherwise), `no-store` on JSON, graceful
  SIGTERM/SIGINT shutdown. `--bind` is accepted as an alias for
  `--host` so the LaunchAgent's python-era arguments keep working
  verbatim (they were silently ignored before the alias existed).
- **`~/Library/LaunchAgents/serve-launcher.sh`** — durable shim in
  the same pattern as the watcher launchers (launchd cannot execve
  anything under `$HOME`, so the shim resolves node + the repo
  symlink and execs the server). `com.kaidjuric.digital-twin.server`
  now points at it. `.plist.bak` preserved.
- **`e2e/landing.spec.mjs`** — the spec's local server now resolves
  root-absolute `/favicon.ico` and `/favicon.svg` from the repo root,
  matching what Pages does (the deployed site root is the repo root,
  the pages live under `/pages/`). This was a **pre-existing
  failure** at HEAD: the page asks for root-absolute favicons, the
  spec's server rooted at `pages/`, so both 404'd and the
  console-error assertion failed.
- **`e2e/twin-os.spec.mjs` + `e2e/twin-os-songs.spec.mjs`** — local
  test servers now map the whole `/data/` subtree to the repo root
  (was the single audio catalog), so both catalogs load; console
  filters widened to any `catalog*.json` 404, because catalogs are
  gitignored and a deployed page legitimately 404s on them while the
  panel shows its "not indexed yet" state. The songs spec's selectors
  are scoped to `[data-songs-catalog]` now that a second
  `.song-row`-using list exists, and its format-chip assertion
  accepts every format the indexer emits (AIFF was added in sprint
  0.35 but the assertion still only allowed mp3/wav).
- **`bin/auto-update.sh`** — its post-pull reload list predated both
  the reel watcher and the Node server; now reloads
  `reel-watcher` and `server` too, so a pull that changes
  `lib/serve.js` or `lib/reel-watcher.js` actually takes effect.
- **`README.md`** — dropped the Python 3 requirement (Node only),
  documented the `~/digital-twin` symlink the LaunchAgents resolve
  through, replaced the `python3 -m http.server` commands with
  `node lib/serve.js`, explained why, refreshed the (long-stale)
  architecture tree, and added an indexer comparison table.

- **Decisions:**
- **A second indexer, not an extension of `songs-indexer.js`.**
  Different input (a CSV manifest + two file trees vs. audio
  headers), different output schema, independent rebuild trigger.
  Same reasoning as the watchers being separate files.
- **Cross-check the manifest against disk; never trust the CSV
  flags.** The corpus ships one documented gap (no MIDI for
  `Blues for Blanche`) and one malformed row. Deriving `hasMidi` /
  `hasPdf` from the filesystem and reporting disagreements makes
  both visible instead of silently trusting a stale manifest.
- **Repair the malformed row generically.** Special-casing "row 82"
  would rot the moment another filename gains a comma; the
  prefix/suffix + `_FINAL.<ext>` boundary scan handles the general
  case and degrades to a logged skip.
- **Node for the static server rather than granting python3 TCC
  access.** Granting Full Disk Access to `/usr/bin/python3` would
  require GUI approval and hand a system interpreter blanket access
  to the user's Documents. Node already has the grant, `serve.js` is
  90 lines with no dependencies, and it makes `npm run serve`
  identical to what launchd runs.
- **Flatten the corpus facets to the top level of the catalog.** The
  first panel implementation read `source.performers` and rendered
  "0 performers"; the data is top-level. Caught by browser
  verification, not by the e2e (which only asserted on the audio
  section at that point) — the new corpus assertions close that gap.
- **Verified end-to-end:**
- `npm run test:all` — **234 assertions across 7 suites**
  (chart 36, songs 16, reel 18, mj 17, mj-submitter 14,
  mj-prompt-generator 67, jazz-solos 66), 0 failures.
- Full e2e: landing, twin-os, twin-os-songs, all seven `ct-*`
  specs, watcher (22 checks), songs-watcher (16 checks) — all green.
- Browser verification on `:5173` (launchd Node server): Songs panel
  renders the audio catalog (5 items) **and** the corpus
  ("456 solos · 78 performers · 8 styles · 455 midi · 456 pdf",
  456 rows, 8 style groups, first row `mid+pdf | Billie's Bounce |
  Charlie Parker · 1945 | alto saxophone · 303 tones | 158.5 BPM`),
  corpus search "soprano" → exactly 23 rows (matching the 23 `ss`
  entries), 0 console errors, screenshots captured.
- Server: all routes 200 from launchd (`/`, both catalogs,
  `/pages/twin-os/`, `sw.js`, `landing.html`); traversal → 403;
  POST → 405; HEAD works.
- **Open:**
- **The corpus catalog is gitignored**, so the deployed Pages site
  shows the corpus section's "not indexed yet" empty state. That is
  consistent with how the audio catalog already behaves on deploy,
  and the specs tolerate it. Committing it would make the deployed
  showcase work (the WJazzD data is public and the catalog carries
  no personal paths) but adds a 230 KB generated artifact to the
  repo — a call for the user.
- **Corpus search is substring-only** (performer / title / style /
  instrument / instrumentName / year), no fuzzy match, no
  tempo-range or year-range filters.
- **`--keep-abspath` is accepted but inert** in
  `jazz-solos-indexer.js` — the indexer never emits an absolute path.
  Kept for CLI parity with `songs-indexer.js`.
- **Next:** candidates — (a) decide whether to commit
  `catalog-jazz-solos.json` for the deployed showcase; (b) filters
  for the corpus (style / instrument / tempo range); (c) link corpus
  rows to their PDF/MIDI (currently display-only); (d) chart-export →
  mj-prompt-generator hook; (e) live-state wiring for the agent-loop
  dashboard; (f) cleanup the now-superseded `/tmp/*-launcher.sh`
  shims and `.plist.bak` files.

### 2026-09-23 — sprint 0.28 (live pipeline test — three bugs found)

Ran every pipeline end-to-end against the live LaunchAgents with real
inputs (a generated 4-part MusicXML chart, a WAV, an MP4 + tagged MP3
sibling, and a 6-prompt lyric pack). Three real bugs surfaced, all now
fixed with regression coverage.

**Bug 1 — the reel watcher clobbered its own output (data loss).**

`lib/reel-watcher.js` parks the dropped source in `processed/` after
exporting, and parked it as `<base><ext>`. The reel output is
`<base>.mp4` — so for the common case of an `.mp4` drop, the move
overwrote the transcoded reel with the original. **Every dropped
`.mp4` shipped an un-transcoded 16:9 file labelled as the Reel.**
Confirmed by md5: the processed "reel" was byte-identical to the
input.

Only source extensions other than `.mp4` escaped it, which is exactly
why the sprint 0.22 smoke test (a `.mov` source) passed and every
later check reported `[done]` — the log line fires regardless of what
the file contains.

Fixed: the source is parked as `<base>_source<ext>`, which cannot
collide for any source extension. The cover JPG (1080×1920) had been
correct all along, which is how the mismatch was spotted.

Regression test (`lib/reel-watcher.test.js` §10) drives the real
`processOne` with a mocked export that writes a marker, then asserts
the marker survived and the source landed separately. Verified the
test **fails against the old code** (`✗ source parked under a distinct
name`) and passes against the fix, for both `.mp4` and `.mov` sources.

**Bug 2 — `--ar` was emitted twice, so the config default silently won.**

`submitToMidjourney` appended `--ar <caller>` and then appended the
whole `defaultArgs` string — which itself contains `--ar 3:4` — because
its guard tested the extracted prompt text, from which
`extractPrompts` had already stripped every flag. The result was:

```
… cinematic --ar 16:9 --ar 3:4 --style raw --s 250
```

Midjourney honours the LAST `--ar`, so **the requested 16:9 was
silently overridden by the config's 3:4** — defeating the entire point
of the sprint 0.23 lyric-pack flow.

Fixed with `buildFullPrompt(prompt, ar, defaultArgs)`: resolves the
ratio exactly once (prompt-embedded > caller > config default), strips
`--ar` out of the defaults, and emits it **last** — matching how these
prompts are authored (`… --style raw --s 250 --ar 16:9`). 16 new
assertions in `lib/mj-submitter.test.js`, including an end-to-end pass
over the real extracted pack asserting every composed prompt carries
exactly one `--ar`, and that it is 16:9. Verified live: 6/6 prompts
now end with `--ar 16:9`.

**Bug 3 — MuseScore hangs on malformed MusicXML instead of failing.**

Found while debugging a hang: mscore 4.7.5 spawns, produces no output,
and sits indefinitely on a truncated score — still running after 150s
for a file that renders in 0.58s when valid. The watcher's export
timeout did bound it, but the cost of one bad input was two 5-minute
attempts before a `[fail]`.

Fixed in `lib/chart-export.js`: `musicXmlIsWellFormed()` (a tag-depth
scan that strips comments/CDATA/PI/DOCTYPE first) runs before mscore is
spawned, plus an explicit 180s `spawnSync` timeout as a backstop.
Measured: truncated input now fails in **3.3s** with
`unclosed tag(s) at EOF (depth 1) — file is truncated` instead of
stalling for 10 minutes.

**Bug 4 (test, not product) — the songs-watcher spec raced the live service.**

The spec dropped a WAV and then ran its own `--once` instance. With the
LaunchAgent now genuinely working (sprints 0.25/0.26), the live watcher
claimed the file ~170ms *before* the spec's instance booted, so the
spec's run found nothing, exited immediately, and asserted against the
other process's writes mid-flight:

```
22:20:40.481 [start] e2e-songs-…wav     ← live watcher claims it
22:20:40.649 [boot]  … once=true        ← spec's instance
22:20:40.650 [exit]  --once mode        ← nothing to do
22:20:40.661 [done]  … moved            ← written by the LIVE watcher
```

The lockfile did its job (no double-processing) — the spec was wrong to
assume it was the only watcher. Fixed: when the LaunchAgent is running
the spec now *delegates* to it (which also exercises the real
production path) and polls for the moved file, the `[done]` line, and
the catalog entry instead of assuming instant completion. Falls back to
a direct wrapper invocation when no agent is loaded (CI / fresh box).
`watcher.spec.mjs` already delegated correctly — it waits for chart
outputs rather than running its own instance — so it needed no change.

**Verified end-to-end (real inputs, live services):**

- **songs-watcher**: real 3s WAV → indexed + moved in 0.1s.
- **reel-watcher**: real 1280×720 MP4 + tagged MP3 sibling →
  `[done] 0.7s`, output **1080×1920 H.264/AAC** + 1080×1920 cover +
  `POST.md` whose caption was built from the sibling's ID3
  (`Pipeline Test — Kajica Quintet (digital_twin e2e) [Modal Jazz]`)
  + hashtags; source parked at 1280×720 as `_source.mp4`.
- **chart-watcher**: real 4-part MusicXML → `[done] 11.5s`, full
  package: `Full_Score.pdf` (PDF v1.4), 4 per-part PDFs in canonical
  band order with correct transpositions (Trumpet Bb / Piano C /
  Bass C / Drums C), `Demo.mp3` + `No_Trumpet.mp3` + `No_Sax.mp3`
  (MPEG layer III 128 kbps 44.1 kHz, 11.08s), and a 5-track
  (conductor + 4 parts) format-1 MIDI.
- **mj-watcher** (dry-run, so nothing posts): real 6-prompt lyric pack
  → 6 prompt dirs, `--skip-done` markers written and cleared on move,
  every composed prompt ending `--style raw --s 250 --ar 16:9`.
- `npm run test:all` — **261 assertions / 7 suites, 0 failures**
  (up from 234: +11 reel, +16 mj-submitter).
- Full e2e — all 12 specs pass; the songs spec ran 3× consecutively
  green to confirm the race is gone.

**Decisions:**

- **Park the source, never overwrite an output.** The general lesson
  from bug 1: when a watcher both writes outputs and relocates its
  input into the same directory, the relocations must be namespaced so
  they cannot collide with generated artifacts, for *every* input
  extension.
- **Validate before invoking an external renderer that hangs rather
  than errors.** The guard is 30 lines with no dependency, and it turns
  a 10-minute stall into a 3-second message. Worth it for any tool with
  unknown failure semantics.
- **Make `--ar` resolution a pure, tested function.** It was previously
  inline string concatenation with two overlapping guards — precisely
  the shape that produces duplicated flags. A pure function is
  trivially testable and the ordering is now explicit.
- **Specs must not assume they own the machine.** With the watchers
  genuinely live, e2e must either delegate to the service or stop it;
  silently racing produces flakes that look like product bugs.

**Open:**

- **The reel watcher leaves the sibling audio in the inbox.** It only
  moves video files, so dropping `clip.mp4` + `clip.mp3` leaves the mp3
  in `reel-inbox/` indefinitely. Not harmful (the watcher ignores
  non-video extensions) but confusing, and a later drop with the same
  basename would silently pair with the stale audio. Should move (or
  archive) the consumed sibling too.
- **The MIDI from the test chart has PPQ 2** because the fixture used
  `divisions=2`. `midi-export.js` maps MusicXML divisions straight to
  PPQ; real charts use 4–480 so this is a fixture artifact, but a very
  coarse input produces a very coarse MIDI. Consider a floor (e.g.
  `max(divisions, 24)`).
- **Four bugs in the tests themselves** were fixed alongside (reel
  spec selectors, songs spec race, landing favicon server, format-chip
  assertion) — all cases of the suite lagging the code it guards.
- **Next:** as sprint 0.27's list, plus (g) move/archive the reel's
  consumed sibling audio; (h) PPQ floor in `midi-export.js`.

### 2026-09-23 — sprint 0.29 (MusicXML → PDF, standalone)

Asked for a way to turn MusicXML into a PDF. The repo already rendered
PDFs, but only as one stage of the full chart pipeline (split parts →
muted variants → manifest → MIDI → MP3), which is a lot of machinery
when you want one file out. Added the single-purpose path.

**Shipped:**

- **`lib/musicxml-to-pdf.js`** + `npm run musicxml-pdf` — one job: a
  PDF per score. Inputs may be files, directories (walked
  recursively), or a mix. Handles plain `.musicxml` / `.xml` and
  **compressed `.mxl`** (the ZIP container MuseScore and most
  engravers ship — 5,277 of the files on this machine are `.mxl`).
  Options: `--out`, `--jobs`, `--timeout`, `--skip-existing`,
  `--keep-tree`, `--flat`, `--dry-run`, `--quiet`.
- **`lib/xml-guard.js`** — the well-formedness check extracted from
  `chart-export.js` so there is one implementation instead of a second
  copy. Improved while extracting: it now tracks a **tag stack**, not
  just a depth counter, so crossed nesting (`<a><b></a></b>`) and
  spurious closing tags are caught too — a counter accepts both.
  `chart-export.js` now requires it.
- **`lib/musicxml-to-pdf.test.js`** — 31 assertions: guard acceptance
  and every rejection class (truncated / crossed / extra close / empty
  / element-less / missing file), ignored constructs (comments, CDATA,
  PI, DOCTYPE), self-closing tags and `>` inside attributes,
  `collectInputs` discovery (recursive, deduped, sorted, skips
  unsupported + dotfiles), target naming, and two real mscore renders
  (magic bytes, byte-stability across re-renders).
- `npm run test:musicxml-pdf`, wired into `test:all`.
- README section documenting the command and its two non-obvious
  behaviours.

**Bug found while testing it — `--jobs` was a no-op.**

The first implementation used `spawnSync` inside an `async` worker
pool. `spawnSync` blocks the event loop, so the pool ran strictly
serially: measured **10.2s at both `--jobs 1` and `--jobs 4`**. A flag
that advertises parallelism and silently does nothing is worse than not
having the flag. Switched to async `spawn` with a kill-timer, and the
pool became real:

| Mode | 12 `.mxl` files |
|------|-----------------|
| `--jobs 1` | 10.2s |
| `--jobs 4` | **3.0s** (3.4×) |
| `--jobs 8` | 3.0s (no further gain) |

Serial stays the default: mscore is a full Qt app (~200 MB resident)
that writes shared state under
`~/Library/Application Support/MuseScore`, so unrestrained concurrency
is a real hazard. Four is the measured sweet spot on this machine.

**Verified end-to-end:**

- Plain `.musicxml` → PDF in 1.0s; `.mxl` → PDF in 0.6s.
- Malformed input refused in **0.044s** with a named reason, having
  written nothing — versus the >150s hang mscore exhibits on the same
  file.
- 12-file batch serial and parallel produce identical output sets
  (12/12 both ways); `--skip-existing` correctly re-runs nothing.
- Discovery over the full **5,277-file** bob-mover corpus in 0.092s.
- Outputs are real PDFs: `%PDF-1.4` magic, correct page counts
  (2 pages at 590×203 pt for the cropped exercise shape, 1 A4 page for
  a full study).
- `npm run test:all` — **292 assertions / 8 suites, 0 failures**.
  All 5 filesystem/render e2e specs pass, including `watcher.spec.mjs`
  which exercises the modified `chart-export.js` render path.

**Decisions:**

- **Judge success by the output file, not mscore's exit code.**
  MuseScore's Qt shutdown routinely exits non-zero — including 134
  (SIGABRT) — *after* writing a complete PDF. Confirmed again here:
  the plain-`.musicxml` render returned 134 with a valid 17 KB PDF on
  disk. This is the long-standing convention from
  `lib/chart-export.js`; the new tool inherits it explicitly.
- **Fail before spawning, not after timing out.** Given mscore's
  hang-instead-of-error behaviour on bad input, a 30-line preflight is
  worth far more than a longer timeout.
- **Compressed `.mxl` skips the XML guard.** It's a ZIP, so a tag scan
  doesn't apply and unwrapping it would add a zip dependency. Those
  files rely on `--timeout`. Documented rather than papered over.
- **Default to serial, expose `--jobs`.** Correctness and
  non-interference with MuseScore's shared state by default; speed on
  request.

**Corpus context (for whoever runs the batch):**

`~/Documents/github-recovery/bob-mover-jazz-lexicon/musicxml/` holds
**5,277 `.mxl`** files (≈407 exercises × 12 transpositions) produced by
Audiveris OMR. Projected full conversion at measured throughput:
**≈22 min at `--jobs 4`**, ≈75 min serial. That project's `README.md`
advertises a "PDF API" in `server.py`; **no such route exists** — the
only PDF mentions there are code comments. If those PDFs are wanted
in-app, this converter is the thing to wire in.

**Open:**

- Nothing blocking. The batch has not been run — 5,277 PDFs (~160 MB)
  is a decision for the user, and the tool is ready for it.
- `.mxl` files get no preflight validation (see Decisions).
- `--keep-tree` naming is implemented but only lightly covered by tests
  (the unit test verifies the relative-path rule directly rather than
  exercising the flag, which is read at module load).
- **Next:** as sprint 0.28's list, plus (i) run the bob-mover batch if
  wanted; (j) offer this converter as a `server.py` PDF route in that
  project.

### 2026-09-24 — sprint 0.30 (Midjourney **web** submitter)

The lyric-pack flow (sprint 0.23) was wired end to end but could not
actually submit: the only backend was the Discord route, and it needs a
logged-in Discord session inside the automation profile. Chasing that
down produced the finding below, and this sprint adds a backend that
works.

**Root finding — the Discord route was unverifiable and the web route
was already available.**

Sprint 0.28's first real submission attempt (every prior run had been
`--dry-run`) failed at 45s with "Discord textarea not found". The
diagnostic screenshot showed Discord's **login page** — the Comet
profile was never signed in. That failure is indistinguishable from a
slow page load, which is why it had gone unnoticed.

Meanwhile the user's browser was already authenticated to
**midjourney.com itself**, which has its own prompt bar and needs no
Discord at all. That is now the default backend.

**Shipped:**

- **`lib/mj-web.js`** — drives `midjourney.com/imagine` over CDP.
  Same CLI contract as the Discord submitter (`--prompt-file`,
  `--all-prompts`, `--skip-done`, `--output`, `--dry-run`) plus
  `--preflight`. Reuses the existing CDP primitives and prompt logic
  from `mj-submitter.js` rather than duplicating them.
- **`lib/mj-cookies.js`** — cookie-jar loading (Netscape **and** JSON),
  plus the `__Host-` normalisation described below.
- **`lib/mj-cookies.test.js`** — 37 assertions.
- **`lib/mj-watcher.js`** — submits via the backend named by
  `engine` in `lib/mj-config.json` (`web` default, `discord` legacy).
  The now-unused `SUBMITTER` constant was deleted.
- **`lib/mj-config.json`** — gained `engine`, a `web` block
  (cookies file, profile, timeouts, imagine URL) and
  `paths.webBrowserBin`; every key documented in-file.
- **`docs/MJ-WATCHER.md`** — backend comparison, web setup, and the
  two constraints below written up as first-class notes.
- `.gitignore` covers downloaded cookie jars; `test:mj-cookies` wired
  into `test:all`.

**Two constraints, both encoded rather than left to the caller:**

**1. The browser must be HEADED.** Headless Chromium passed Cloudflare
for the first couple of submissions, then `/api/submit-jobs` began
returning 403 and the page title became **"Just a moment..."** — the CF
interstitial. A visible window passed cleanly and completed all 8. The
backend never launches headless, and it detects the interstitial and
fails with an explanation instead of timing out.

**2. `__Host-` cookies must not carry a `Domain` attribute.** Both MJ
auth tokens use that prefix. Handed to a browser with a domain,
Chromium **silently drops them** and the site renders "Log in" with no
error whatsoever — the only symptom is the 45s textarea timeout that
made the Discord route look broken. `toBrowserCookies()` expresses
those cookies via `url` + `path:/` + `secure:true` instead. This is the
single most expensive thing learned this sprint and it is unit-tested
directly.

**Design decision — success is a new task id, not a cleared textbox.**

The MJ composer clears whether or not the submission was accepted, so
"the box is empty" is worthless as a signal. The backend snapshots the
task ids in the feed, submits, then waits for a **new**
`cdn.midjourney.com/<uuid>/…` task to appear. That uuid is the
acceptance proof, and its image URLs are written to `meta.json`. A run
therefore leaves machine-checkable evidence.

**Verified end-to-end, with real submissions:**

- `--dry-run` — 8 prompts extracted, each composing to exactly one
  trailing `--ar 16:9` (sprint 0.28's fix still holding).
- `--preflight` — **6.3s**: 11 cookies accepted (2 `__Host-`), headed
  Chrome up on :9444, Imagine page loaded, prompt bar found, no CF
  challenge, **zero generations spent**.
- **Real submission** of one throwaway prompt — 10.8s: new task
  `d96d57fc-3679-4879-be8c-8ec08c2a0b35` detected, 4 image URLs
  captured to `meta.json`, `.mj-done-0` marker written.
- Those 4 images independently confirmed **rendering in the browser at
  1141×640** (= 16:9) by re-querying the task id over CDP.
- `npm run test:all` — **329 assertions / 9 suites, 0 failures**.

**Also fixed along the way:** the config's `~/.midjourney-cookies.txt`
was used literally (no shell to expand it), so every run died with
"cookie file not found". Path-valued options now expand a leading `~`.

**Open:**

- **The Discord backend is still unconfigured** and now explicitly
  legacy. It remains in the repo because the CDP primitives live there
  and `engine: "discord"` should keep working if someone signs in.
- **The cookie jar expires.** When MJ returns the login page, re-export
  to `~/.midjourney-cookies.txt`. `--preflight` is the cheap way to
  check before a real run.
- **Brave/strict-mode ordering is not handled**: if the user's browser
  rejects third-party cookies the jar may still be incomplete.
- **No parallelism.** Prompts submit serially (needed for the task-id
  diff to be unambiguous).
- **Next:** as sprint 0.29's list, plus (k) reload the watcher and
  confirm the lyric-pack flow runs unattended end to end; (l) surface
  the captured image URLs in the Twin OS Songs/Twin panels.

### 2026-09-24 — sprint 0.30a (task-detection misattribution — found by running it)

Running the flow twice surfaced a bug in the web backend's own
acceptance check. Worth recording because the first version *looked*
right and the failure was silent.

**The bug.** Acceptance was "a task id I haven't seen before". The feed
is **virtualized** — only the cards near the viewport are mounted — so a
pre-existing task that happened to be unmounted during the snapshot
reads as brand-new when it later scrolls into view. That recorded a task
against the wrong prompt.

Caught by noticing the same uuid in two runs:

```
whats_gonna_be_groove/prompt-04  ec5922dc   ("silhouettes vs white strobe")
tribalismo/prompt-02             ec5922dc   ("overhead circle of people")
```

One task cannot be two prompts. Loading
`cdn.midjourney.com/ec5922dc…/0_0_640_N.webp` directly settled which was
wrong: it is a black-and-white silhouette shot, so the earlier run was
correct and `tribalismo/prompt-02` was misattributed.

**Scope: 1 of 16 recorded tasks** (15 distinct ids where 16 were
expected). The submission itself was never at risk — the prompts were
typed and submitted regardless; only the bookkeeping lied. But the
backend's whole claim is that it leaves machine-checkable evidence, so
a wrong task id undermines exactly the thing it promises.

**First fix was insufficient, and testing showed it.** I tightened the
rule to "the id must be new *and* different from the previously-topmost
id". Reasoning it through, that still passes the bug case, because
`ec5922dc` was unmounted at snapshot time — absent from both sets — so
it satisfies both conditions when it surfaces. Worth noting as a case
where reasoning alone would have shipped a non-fix.

**Actual fix: match the prompt text.** The task card is the nearest
ancestor of a CDN image that also carries the prompt text (>120 chars).
Acceptance is now "find the card whose text contains our prompt" — the
only check that cannot misattribute, because a card can only match the
prompt actually typed. The old positional test is kept as a recorded
cross-check (`isNewestTask`) rather than an enforced one.

Two DOM details that cost time and are now encoded:

- `innerText` on a card concatenates the UI's own label, so it reads
  `"Loop<the prompt>…"`. An anchored `^` match on the prompt's first
  word therefore finds nothing — hence `includes`, tested directly.
- The card's text >120 chars is what distinguishes a task container
  from an image wrapper; the level-5 ancestor is the card.

`promptExcerpt()` strips params before taking 40 chars, so MJ's own
truncation of a long prompt's tail can't break the match. `lib/mj-web.test.js`
(15 assertions) pins the excerpt's distinctness, its literal presence in
the rendered card form, and that the generated matcher is an IIFE with a
JSON-encoded excerpt that cannot be broken out of by a quote in a prompt.

Also removed: the pre-submit `READ_TASK_IDS` snapshot, now dead — one
fewer CDP round-trip per prompt.

**Verified:** `npm run test:all` — **351 assertions / 10 suites, 0
failures**. Watcher reloaded with the corrected detection.

**Open:** the one misattributed `meta.json` is left as-is rather than
guessed at; its prompt and images are correct, only the `taskId` is
wrong. Re-running the pack would produce clean metadata at the cost of
8 more generations. The remaining 15 attributions were not individually
image-verified, so treat per-prompt `taskId` as best-effort until a run
is checked end to end.
