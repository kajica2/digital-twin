# Component Catalogue — digital_twin landing

All components are Web Components (custom elements) defined inline in
`pages/landing.html`. No bundler, no framework, no runtime cost
beyond the browser's built-in support.

---

## `<theme-toggle>`

- **Purpose:** system / light / dark theme picker. Persists choice to
  `localStorage.dt-theme-pref`, listens to system preference changes
  while on `system`.
- **Props / attrs:** none — reads `data-theme-pref` from `<html>`.
- **States:** pressed = current preference, hover, focus-visible.
- **Events:** none (mutates `<html data-theme>` directly).

## `<variant-switcher>`

- **Purpose:** switch the page between the three pitches
  (`?v=1|2|3`). Updates URL via `history.replaceState`, re-runs
  `applyVariant()` to swap hero/lede/features/CTA copy in place.
- **Props / attrs:** none — reads `data-variant` from `<html>`.
- **States:** pressed = active variant, hover, focus-visible.

## `<twin-demo>`

- **Purpose:** the animated control-room mockup in the "How it looks"
  section. Shows the twin's "Today / Now Playing / Code / Patterns"
  panels + a status bar + sequential checkmark animations on the code
  tasks. Adapted from the kai-systems visual language — warm cream
  surfaces, copper primary, mono labels.
- **Props / attrs:** none.
- **States:** task-checkmarks animate from empty → done every 1.6s,
  loop forever. Waveform bars pulse on a 1.4s loop with staggered
  delays. Reduced-motion stops both, marks all checks done immediately.

## Reusable SVG icon library

The `ICONS` object (in the inline script) holds 14 inline SVG paths
(scan, memory, route, orch, wave, lock, brain, pen, bell, moon,
compass, swap, plug, plus the default magnifier). All rendered
through `iconSVG(name)`. No external icon font, no sprite file.

## Layout primitives (no JS, just CSS classes)

These are not Web Components — they're styled `<div>` blocks
reused across the page. Documented here so future agents can
extend them without re-inventing the structure.

### `.hub-nav` (top of every page)

- The kai-systems hub nav: a left-side mark (`← kai-systems` + the
  hex icon) and a right-side row of links to other spokes + the
  theme/variant toggles. Bottom border, mono `hub-sub` text in the
  middle.
- The `hub-nav-right` is a flex row; theme/variant toggles are last.
- See `assets/shared.css` in the kai-systems repo for the original.
  This landing reimplements it inline (no shared file — the landing
  is self-contained).

### `.hero`

- `kicker` eyebrow → big `h-display` headline with italic em → `lede`
  paragraph → CTA row → trust row → divider with the hex mark.
- The `geom geom-tr` SVG sits absolutely positioned in the top-right,
  behind everything else, at 8% opacity.

### `.section`

- Each content section uses the same skeleton: `section-kicker` →
  `h-section` (h2) → `section-sub` paragraph → the content.
- 104px bottom margin (the kai-systems rhythm).

### `.level` (architecture layer row)

- The 4-layer architecture table. Each level: large copper
  `level-num` on the left, name/title/desc/tools on the right.
  Hovering the row paints it with `primary-soft`.

### `.flow-node` (running process card)

- Either `signal` (copper left border) or `action` (forest left
  border) — the two colors the kai-systems twin page uses for
  different flow types.

### `.twin-card` (domain twin card)

- A numbered (`twin-num`), named (`twin-name`), titled
  (`twin-title`), described (`twin-desc`) card. Hovering paints
  the border copper.

### `.feature-card`

- The 6 features per variant. Icon, title, description. Hovering
  paints the card with `primary-soft`.

### `.feature-icon`

- 40×40 rounded square with the icon, in `primary-soft` background
  and copper color.

## Reveal pattern

Every section that should fade in on scroll has `class="reveal"`. The
CSS rule is `.js .reveal { opacity: 0; transform: translateY(12px); }`
— only when JS has run and set `.js` on `<html>`. The
`IntersectionObserver` (with threshold 0.08) flips `.reveal` to
`.reveal.in`, which transitions to visible. A 1.5s safety net reveals
any element still hidden if the IO never fires (e.g. element was
already in view but the threshold wasn't met during headless
screenshot capture). Reduced motion collapses the transition to
0.01ms.
