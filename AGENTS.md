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
