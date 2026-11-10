# Tool Dashboards

Floating family panels for every suite in `npm run test:all`. One panel per
*family* of tools — not one panel per suite — so eighty-six scripts sit
behind eight calm windows.

## What it is

`<tool-dashboard>` is a Web Component that reuses the chrome of
[`<floating-toolset>`](FLOATING-TOOLSET.md): Shadow DOM, skin tokens through
inheritance, traffic-light window controls, drag, collapse, zoom, and a
restore tab on close. The 2×2 grid is remapped to:

| Panel | Content |
|---|---|
| **TESTS** | every `npm run test:*` / `skin:check` / `prompt:check` in the family |
| **RUN** | the one or two commands that exercise the family |
| **DOCS** | links into `docs/` for that family |
| **STATUS** | a calm one-line state (`green` / `quiet` / `unknown`) |

The catalog that feeds it is [`data/twin/tool-dashboards.json`](../data/twin/tool-dashboards.json).
Eight families cover every entry of `test:all` (86 scripts):

| Family | Suites (approx.) | What it covers |
|---|---|---|
| watchers | 3 | chart / songs / reel inbox daemons |
| midjourney | 21 | MJ web submitter, feed, revise, contact sheet, look / scene presets, nema / srce / watched-man |
| suno | 15 | styles, mutator, upload, DNA, humanize, kai runner |
| treblo | 3 | API client, cookie install, upload |
| social | 10 | social engine, persona pack, Gumroad, X / IG / YouTube posters |
| media | 12 | musicxml→pdf, images→mp4, Cadenza, audio splitter, HeartMuLa, director, FLUX.2, lettering, CLIP samples, jazz-solos |
| marketplace | 5 | daily content / reels / pipeline, hourly burst, taxonomy |
| platform | 17 | skin, floating-toolset, tool-dashboard, process-graph, prompt lint, agent loop / hub, improve-loop, secrets, boot, log-rotate, auto-check, ingest, deepseek |

## Drop-in

```html
<script src="../lib/theme.js" data-theme-key="td-theme"></script>
<script src="../lib/skin.js"></script>
<script src="../lib/tool-dashboard.js"></script>
<tool-dashboard
  src="../data/twin/tool-dashboards.json"
  family="watchers"></tool-dashboard>
```

Attributes:

| Attr | Meaning |
|---|---|
| `src` | catalog URL (fetched on connect; a failed fetch leaves the demo family) |
| `family` | which family to show (`watchers` by default) |
| `closed` | start closed (restore tab visible) |
| `collapsed` / `zoomed` | window state |

API (on the element):

| Method / property | Meaning |
|---|---|
| `showFamily(id)` | switch the panel to another family; fires `dashboard:family` |
| `open()` / `close()` | show / hide the window (restore tab stays reachable) |
| `toggleCollapse()` / `toggleZoom()` | yellow / green lights |
| `setData(catalogOrFamily)` | replace the catalog or the current family |
| `catalog` / `familyId` / `closed` | getters |
| `data` | the shaped payload currently rendered |

Events: `dashboard:close`, `dashboard:open`, `dashboard:collapse`,
`dashboard:move`, `dashboard:family` (`detail: { id }`).

Position is remembered under `localStorage['dt-tool-dashboard-pos']`.

## Host page

[`pages/tool-dashboards.html`](../pages/tool-dashboards.html) lists the eight
families as cards, opens the floating panel for each, and carries the house
skin + a theme toggle persisted under `td-theme`.

```bash
node lib/serve.js --port 5180
# → http://127.0.0.1:5180/pages/tool-dashboards.html
```

## Tests

```bash
npm run test:tool-dashboard   # pure Node, no browser
npm run e2e:tool-dashboard    # Puppeteer against :5180
```

The unit suite pins:

- every `test:all` entry appears in exactly one family (no missing, no
  duplicates, suiteCount === 86);
- `familyToPayload` / `mergeCatalog` / `findFamily` / `listSuites` /
  `clampPosition` / `escapeHtml` behave;
- the demo family is present so a failed fetch still leaves a panel.

The e2e asserts the hero, the eight cards, the catalog endpoint, the
TESTS / RUN / DOCS / STATUS grid, family switching, traffic lights
(open / collapse / close / restore), theme persistence, the embed
snippet, internal links, and 0 console errors.

## Pure helpers (Node)

```js
const {
  familyToPayload, mergeCatalog, findFamily, listSuites,
  clampPosition, escapeHtml, DEMO_FAMILY, DEMO_CATALOG
} = require('./lib/tool-dashboard.js');
```

These are the same functions the component uses, so the unit suite and the
browser stay in lockstep.

## Design notes

- **One panel per family, not per suite.** Eighty-three floating windows
  would be noise; eight is a readable desk.
- **Self-contained chrome.** The component copies the floating-toolset
  STYLE / helpers rather than requiring it at runtime — there is no
  bundler, and a browser `<script>` cannot `require`.
- **Skin tokens only.** Every colour comes from the inherited CSS custom
  properties; a `?skin=studio` swap re-tints the panel.
- **Failed fetch → demo family.** A partial or missing catalog never
  blanks the panel.
- **Close hides the window, not the host.** The restore tab is a child of
  the shadow root; closing sets a `closed` attribute so the tab stays
  reachable (same fix as floating-toolset).
