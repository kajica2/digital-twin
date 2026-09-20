# digital_twin

**→ Live at [kajica2.github.io/digital-twin/](https://kajica2.github.io/digital-twin/)**

A personal AI twin that knows your stack, your taste, your schedule,
your weird preferences. Built to run locally, learn from patterns, and
turn ten open tabs into one calm surface.

Part of [kai-systems](https://kajica2.github.io/kai-systems/) — the
meta-layer that makes all the other kai-systems stacks run
themselves.

> **Sprint 0 status:** Landing page live. Three A/B-testable variants
> in one HTML file. Twin OS shell + song indexer queued for sprint 1.

## What this is

A long-running project. The landing page is the public face; the Twin
OS shell is the thing you'll actually use every day. The shell and the
song indexer are sprint 1.

For now, what's here:

- **`pages/landing.html`** — the landing page. Three swappable pitches
  (Control / Persona / Architecture) via `?v=1|2|3` or the nav
  switcher. kai-systems house style (DM Serif Display + Outfit +
  JetBrains Mono, warm copper), paired light + dark, WCAG AA in both
  themes.
- **`docs/DESIGN-RATIONALE.md`** — why the page looks the way it does.
- **`docs/COMPONENT-CATALOGUE.md`** — what each Web Component does.
- **`e2e/landing.spec.mjs`** — Puppeteer smoke test that loads each
  variant, screenshots, and asserts the variant switcher roundtrips.

## Install from GitHub

Requires **macOS** (the boot core and LaunchAgents are macOS-only), **git**, and **Python 3** (system `python3` works). The pages are static — no build step, no bundler.

```bash
# 1. Clone (repo path matters: boot.sh and the LaunchAgents use ~/digital-twin)
git clone https://github.com/kajica2/digital-twin.git ~/digital-twin
cd ~/digital-twin

# 2. (optional) e2e test runner — only needed to run the Puppeteer specs
cd e2e && npm install && cd ..

# 3. Run the site locally
python3 -m http.server 5173 --bind 0.0.0.0
#   → http://localhost:5173/pages/landing.html
#   → http://localhost:5173/pages/twin-os/        (Twin OS PWA)
#   → http://localhost:5173/pages/cognitive-twin.html
```

### Self-update on launch

The repo ships with **auto-update on launch** (`bin/auto-update.sh`, wired into `bin/boot.sh`):

- At every login, `boot.sh` runs `auto-update.sh` which fetches `origin/main`, **detects new commits**, and fast-forwards the repo only if there are any.
- After a clean pull it **reloads any running watcher LaunchAgents** (chart / songs / MJ) so new code goes live without a logout/login cycle.
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

## Run the e2e test

```bash
cd e2e
npm install
node landing.spec.mjs
```

The test:
1. Spawns a local static file server on port 5173.
2. Loads the landing page in headless Chrome.
3. Switches through all three variants and screenshots each.
4. Asserts the variant switcher round-trips (`?v=1` → `?v=2` → `?v=3`
   → `?v=1`).
5. Asserts 0 console errors on each variant.
6. Saves screenshots to `e2e/artifacts/`.

## Architecture (sprint 0 + planned)

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
│   └── songs/
│       └── catalog.json      # built by lib/songs-indexer.js (sprint 1)
├── e2e/
│   └── landing.spec.mjs      # Puppeteer test
├── agents/                   # twin agent definitions (sprint 2+)
│   ├── today.md
│   ├── songs.md
│   └── ...
├── docs/
│   ├── DESIGN-RATIONALE.md
│   ├── COMPONENT-CATALOGUE.md
│   └── ARCHITECTURE.md       # TBD sprint 1
├── assets/                   # brand assets (logo, mark, etc.)
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
