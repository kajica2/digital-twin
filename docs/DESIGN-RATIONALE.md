# Design Rationale — digital_twin landing

> One short paragraph. Why this concept, what it evokes, the design
> tension you chose to resolve.

The brief was "a fully gigantic autonomous twin that knows me" — a
months-long vision, not a sprint deliverable. The landing page had to
honour that ambition without overselling it, so I built it as three
swappable *pitches* of the same product, each exposing a different
facet of what "twin" could mean. **Control** sells it as a tool
(pragmatic, operational — "One screen. Everything that matters."),
**Persona** sells it as a partner (emotional, persistent — "A version
of you. That never sleeps."), **Architecture** sells it as a system
(technical, structural — "Four layers. One philosophy."). The
architecture section (Scanner / Model / Reasoner / Orchestrator) stays
identical across all three because the *product* is identical — only
the *pitch* changes. The visual language is the kai-systems house
style: warm cream + copper + forest, DM Serif Display + Outfit +
JetBrains Mono, the hex mark, the editorial numbered sections, the
"design once · runs forever" closing line. The page reads as a true
spoke of the kai-systems hub, not a separate product. The design
tension I resolved: an "autonomous twin" is inherently a sci-fi
promise, but the page has to feel like a calm, real tool you'd
actually use on a Tuesday morning — the same way the existing twin
spoke does.

## Why the kai-systems house style, not the director-mode polish

The user pointed at two references: the `browser-use` director-mode
output (cool indigo, Fraunces, modern SaaS landing) **and** the
existing `kai-systems` site (warm copper, DM Serif Display,
editorial). The kai-systems site already has a twin page
(`/twin/index.html`) with the same throughline — "scans the
filesystem, indexes every tool, sets up the work so it runs without
being asked" — so the digital_twin landing is a *new take* on an
*existing* card, not a fresh product. To feel like part of the same
family, the landing adopts the kai-systems design tokens, type, brand
mark, and editorial voice. The director-mode craft (paired light +
dark, Web Components, scroll reveal, magnetic CTAs, mobile
responsive, no-JS fallback, reduced-motion guard) is preserved — it's
invisible craft, not visual style.

## How the variant switcher works

The page reads `?v=1|2|3` from the URL (with sensible default `v=1`)
and swaps the hero copy, lede, features grid, and CTA wording in
place — no reload, no flicker. The nav switcher updates the URL via
`history.replaceState` so each variant is shareable. The variant data
lives in a single `VARIANTS` object in the inline script, so adding a
fourth pitch is a 12-line change. The architecture, running
processes, domain twins, integrations, and CTA stay identical across
variants — the pitch is the only thing that changes.

## Color system

Sourced directly from `assets/shared.css` in the kai-systems repo:

- **Light:** warm cream `#f7f5f0` background, copper `#c97b3f`
  primary, forest green `#2f6f5e` accent, deep ink `#14171e`. Subtle
  radial wash overlay (top-left copper, bottom-right forest) on the
  body — the same wash the kai-systems hub uses.
- **Dark:** warm near-black `#1a1812` background, lifted copper
  `#d9925a` primary (better contrast on dark), lifted forest
  `#6ab098` accent, warm cream `#f4efe2` ink. Same radial wash
  overlay, same temperature.
- Both themes clear WCAG AA for text on surface. The theme bootstrap
  script applies the saved preference before first paint, so there's
  no flash on reload.

## Type system

`DM Serif Display` (display, with the italic em as the personality
carrying device) + `Outfit` (body) + `JetBrains Mono` (eyebrows,
kickers, status, demo). All loaded from Google Fonts with
`display=swap`. The display serif is large (up to 84px on the hero)
and editorial — the same size the kai-systems hub uses.

## Motion vocabulary

- **breathe** — none at the page level. The kai-systems site doesn't
  have a breathing hero mesh; the geom svg in the hero top-right is
  static.
- **reveal** — sections fade in + slide up 12px as they enter the
  viewport, via `IntersectionObserver`. Each new feature card added
  by the variant switcher is observed too. 1.5s safety net reveals
  anything still hidden if the IO never fires.
- **magnet** — primary CTAs follow the cursor by ±10px, giving a
  tactile "this button wants to be clicked" feel.
- **pulse** — the online status dot, the demo's live indicator, and
  the agent checkmarks use a single 2.4s `pulse` keyframe. Calibrated
  to feel "alive" not "alert".
- **wave** — the demo's audio waveform animates each bar on a 1.4s
  loop with staggered delays. Looks like music is actually playing.

## Sections

The page reads as a long-form product essay, not a SaaS landing:

1. **Hero** — the pitch (swaps per variant), with the kai-systems
   hex geom in the top-right corner.
2. **Features** — 6 features per variant. Section kicker + h-section
   + sub all swap per variant. Feature cards don't.
3. **Demo** — the control-room mockup. Stays the same across
   variants (the *product* doesn't change, only the pitch does).
4. **Quickstart** — a copyable pipeline block (`<copy-block>`) with
   the canonical install + index + open commands. Dark background,
   mono font, syntax tinting. Copy button in the top-right transitions
   "Copy" → "Copied" on click and falls back to `execCommand` for
   non-secure contexts.
5. **Architecture** — Scanner / Model / Reasoner / Orchestrator. The
   4-layer table the kai-systems twin page already documents. Stays
   the same across variants.
6. **What's already running** — the 4 flow nodes (arXiv swarm,
   Puppeteer gate, memory maintenance, E2E regression gate). Stays
   the same.
7. **Domain twins** — Music / Trumpet / Web / Research. The 4
   instantiations the kai-systems twin page already names. Stays the
   same.
8. **Integrations** — the "Plays nicely with" strip in display serif.
9. **CTA band** — "One twin. Every system, running." Backed by a
   secondary ghost button linking to the deep-dive on kai-systems.
10. **End-mark** — the hex mark + "design once · runs forever" — the
    kai-systems closing line.
