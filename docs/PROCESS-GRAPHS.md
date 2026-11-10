# Process Graphs

Allowlisted pipelines the twin already knows how to run. Dry-run by
default. Apply only when every command is concrete.

## The four Midjourney flows

| id | what it does |
|---|---|
| `lyrics-to-frames` | Idea / lyric → prompt pack → submit → chosen cells → video cut |
| `next-in-order` | Story director lyric-order cut (version 1) |
| `evolution` | Three versions; v3 is a CLIP nearest-neighbour walk |
| `mutation` | Re-evolve an edit job; the prompt owns `--style` / `--s` |

Plus `chart-export` and `index-songs`.

## Catalog

`data/twin/process-graphs.json` is the source of truth. Each package
carries:

- `id`, `title`, `summary`
- `nodes[]` — `{ id, label, cmd, optional?, note? }`
- `edges[]` — `[from, to]` pairs; Kahn topological order decides the
  dry-run / apply sequence
- `browserOk` — safe to show / plan in the browser; apply still refuses
  any command that still carries a placeholder (`<slug>`, `<job-id>`, …)
- `dryRunFlag` — the flag that makes the package's own CLI a no-op
- `docs[]` — relative paths to the deep references

## CLI

```bash
node lib/process-graph.js --list
node lib/process-graph.js --show lyrics-to-frames
node lib/process-graph.js --dry-run evolution --with-optional
node lib/process-graph.js --apply index-songs
```

`--apply` refuses a step whose command still contains a placeholder.
Among the shipped packages, only `index-songs` is fully concrete today;
the MJ flows keep `<lyric or vibe>` / `<slug>` / `<job-id>` until the
operator fills them in.

## HTTP API

Mounted on `lib/serve.js` via `lib/api/router.mjs`:

| method | path | behaviour |
|---|---|---|
| `GET` | `/api/process` | list packages |
| `GET` | `/api/process/:id` | package + plan (with optional nodes) |
| `POST` | `/api/process/:id` | `{ dryRun?: true, withOptional?: false }` — dry-run by default |

Apply (`dryRun: false`) requires the `x-admin-key` header **and**
`browserOk: true`. Placeholder refusal still applies.

## UI

- Page: `pages/process-graphs.html`
- Component: `<process-graph>` in `lib/process-graph-ui.js`
- Twin OS Songs tool-grid + Twin storefront both link the page; the
  floating toolset / tool-dashboard embeds live on the Twin OS shell.

## Tests

```bash
npm run test:process-graph
npm run test:process-graph-ui
npm run e2e:process-graphs
```

`test:process-graph` is chained into `test:all`.
