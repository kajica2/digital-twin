# Floating Toolset

A draggable panel that floats above whatever page it is dropped on. Four
surfaces the twin keeps an eye on — **today**, **now playing**, **code**,
**patterns** — packed into one always-there corner.

- **Component:** `lib/floating-toolset.js` (no build step, no dependencies)
- **Page:** `pages/floating-toolset.html`
- **Payload:** `data/twin/toolset.json`
- **Unit suite:** `lib/floating-toolset.test.js` (`npm run test:floating-toolset`)
- **e2e:** `e2e/floating-toolset.spec.mjs` (`npm run e2e:floating-toolset`)

---

## Why it exists

The twin already has surfaces for all four of these (the Twin OS Today
panel, the Songs panel, the agent hub, the pattern cards), but they live in
different pages. The toolset is the one-glance version: a single panel you
can park in the corner of whatever you are working in.

It is deliberately **calm**. Nothing pops up, nothing pushes a
notification, and the only motion in the whole component is the equalizer
in NOW PLAYING — which stops under `prefers-reduced-motion`.

---

## Dropping it on a page

Two lines:

```html
<script src="/lib/floating-toolset.js"></script>
<floating-toolset src="/data/twin/toolset.json"></floating-toolset>
```

Relative paths work too — from `pages/`, the component is
`../lib/floating-toolset.js` and the payload `../data/twin/toolset.json`.

The component ships its own styles inside a **shadow root**, so it cannot
collide with the host page's CSS. CSS custom properties inherit through
the shadow boundary, so the skin tokens (`--primary`, `--bg-card`,
`--line`, `--mono`, …) still reach it and the panel re-tints with the
family — light or dark, house or studio.

---

## The payload

One JSON object. Every key is optional: whatever you leave out falls back
to the built-in demo state, so a partial payload never blanks a panel.

```json
{
  "title": "~/twin — online · local",
  "live": true,
  "panels": {
    "today": {
      "items": [
        { "time": "09:00", "label": "morning warm-up" },
        { "time": "10:30", "label": "deep work block" }
      ]
    },
    "nowPlaying": {
      "title": "Coltrane — Naima",
      "meta": "Bb minor · 76 BPM",
      "peaks": [0.18, 0.32, 0.52, 0.28]
    },
    "code": {
      "items": [
        { "repo": "resona", "task": "fix YIN threshold", "done": true }
      ]
    },
    "patterns": {
      "items": [
        { "when": "9am", "label": "warm-up", "detail": "always jazz" }
      ]
    }
  },
  "footer": {
    "left": "twin  3 agents running · 8 events today · 0.4¢ spent",
    "right": "local"
  }
}
```

| Key | Shape | What it does |
|---|---|---|
| `title` | string | Centre of the chrome bar. |
| `status` | string | Free-form status string, reserved for a future badge. |
| `live` | boolean | Shows the red **live** badge in the corner. |
| `panels.today.items[]` | `{ time, label }` | One agenda line each. |
| `panels.nowPlaying` | `{ title, meta, peaks[] }` | The track and its equalizer. `peaks` are 0..1 heights; each becomes a bar. |
| `panels.code.items[]` | `{ repo, task, done }` | One piece of work each. `done: true` fills the tick. |
| `panels.patterns.items[]` | `{ when, label, detail }` | One observed rhythm each, with the `▸` arrow between label and detail. |
| `footer` | `{ left, right }` | The bar under the panels. |

Payloads are fetched with `cache: 'no-cache'`. If the fetch fails the
panel keeps its built-in state and logs a warning — a missing payload is
never a reason to show an empty panel.

---

## The API

```js
const panel = document.querySelector('floating-toolset');

panel.setData({ panels: { nowPlaying: { title: 'Shaw — Fair Weather' } } });
panel.data;             // the merged payload
panel.open();
panel.close();
panel.toggleCollapse();
panel.toggleZoom();
panel.zoomed;           // boolean
panel.closed;           // boolean — true while the panel is closed
```

Events:

| Event | Detail | Fires when |
|---|---|---|
| `toolset:open` | — | the panel is shown |
| `toolset:close` | — | the panel is closed |
| `toolset:collapse` | `{ collapsed }` | the body collapses to the chrome bar |
| `toolset:move` | `{ x, y }` | the panel was dragged |

---

## The window

Three lights, macOS-style, all functional:

| Light | Action |
|---|---|
| red | close — the window hides, a small **twin** tab stays in the corner so it can be restored |
| yellow | collapse — the body folds away, the chrome bar stays |
| green | widen — the panel switches to its single-column layout |

Closing hides the *window*, not the host element — the restore tab is a
child of the shadow root, so hiding the host would take the way back in
down with it. Read `panel.closed` to know which state you are in.

The chrome bar is the drag handle: press and move to reposition. It is
also focusable — with the bar focused, the arrow keys nudge the panel
(shift for bigger steps). The panel is clamped to the viewport, so it can
never be dragged off screen.

The three lights keep the **macOS system colors** (`#ff5f57` /
`#febc2e` / `#28c840`) — the only pixels in the component that do not
come from the skin. The panel is claiming to *be* a macOS window, and
the affordance only reads if the middle dot is yellow; the house skin's
`--warning` is a burnt amber (`#b45309`) and the studio skin's is olive
(`#725f03`), either of which makes the dot read as a smudge. Same call
as the Refael page keeping its own dark palette: a foreign design
language is preserved rather than re-skinned.

Position, collapsed state and zoom state are remembered per browser in
`localStorage` under **`dt-floating-toolset-pos`**.

---

## Files

```
lib/floating-toolset.js        the component (shadow DOM, no dependencies)
lib/floating-toolset.test.js   28 pure-function checks
pages/floating-toolset.html     the page that hosts it
data/twin/toolset.json         the demo payload
e2e/floating-toolset.spec.mjs  25 browser checks
```

---

## Verified

- `npm run test:floating-toolset` — 28/28.
- `npm run e2e:floating-toolset` — 26/26 against the repo-root server on
  `:5180`: the four cards and their rows, the chrome bar and its three
  lights, the equalizer bars, the footer numbers, open / collapse / zoom /
  close / restore, a real pointer drag (moved exactly −100px / −60px),
  the remembered position, the viewport clamp, the embed snippet, a copy
  click that throws nothing, the theme flip and its persistence across a
  reload, and **0 console errors**. The same spec passes 26/26 against
  the live Vercel URL.
- `npm run skin:check` — the page loads a skin and defines none of the
  contract's tokens itself.

## Limits

- **Static payload.** The panel reads JSON; it does not poll the agent hub
  or the Twin OS state. Point `src` at whatever the twin writes.
- **No cross-panel interaction.** The ticks are display-only — they do not
  write back to the payload or to any task list.
- **One panel per page.** Two instances would both be draggable and both
  remember a position under the same storage key.
