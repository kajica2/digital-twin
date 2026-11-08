# MJ Console — write a prompt, see the command, save it, find it again

> The console at `pages/mj-console.html`. Write a Midjourney prompt, see the
> exact command the submitter will send, save it to a local library, and export
> the library as a prompt pack the watcher already knows how to read.

---

## What it is

Three things in one page:

| | what it does |
|---|---|
| **Compose** | Type a prompt, choose a ratio, see the composed command — the one `--ar`, emitted last. |
| **Library** | Saved prompts on this machine, searchable, with their composed commands attached. |
| **Export** | The library as a MJ prompt pack — the file format `lib/mj-watcher.js` reads. |

Run it: `npm run serve`, then open <http://127.0.0.1:5173/pages/mj-console.html>.

---

## The one rule that shaped the whole thing

**The console must not compose prompts differently from the submitter.**

Midjourney honours the **last** `--ar` it sees. This repo has already paid for
that lesson twice:

- the submitter appended `--ar <caller>` and then the whole `defaultArgs`
  string — which itself contained `--ar 3:4` — producing `--ar 16:9 --ar 3:4`,
  so the config silently overrode the requested ratio;
- the `--style raw` default and the artist's own `--style raw` were both
  emitted, so the config's coupled `--s` value overrode the artist's.

A console that re-implemented the flag rules would be a **second source of
truth**: it could show `--ar 16:9` while the submitter sent `--ar 3:4`, and
the user would have no way to tell — the generation would just come out wrong.

So the rules live in **one** file, loaded by both:

```
lib/mj-flags.js        ← the submitter (Node) AND the console (browser)
lib/prompt-lint-core.js ← the linter (Node) AND the console (browser)
```

`lib/mj-submitter.js` and `lib/prompt-lint.js` re-export from these; they
did not used to, and the re-export is what keeps a dozen existing callers
working.

### The parity test is the point

`lib/mj-console.test.js` loads `lib/mj-flags.js` **the way a browser loads it**
— as a classic script, in a `vm` sandbox with no module system — and compares
its output against the Node-loaded module, prompt by prompt:

```
2. the browser-loaded module and the Node module agree
  ✓ browser and Node compose identically for every case
  ✓ browser and Node lint identically for every case
```

That test was **proved to bite**: introducing a browser-only branch that
emitted `--ar` first turned it red (`59 passed, 1 failed`), and restoring it
turned it green again.

---

## The two gates a prompt passes through

### 1. The identity lint

A prompt must not name the subject's race or ethnicity.

These prompts are written so a **reference photo** can be attached — and a
demographic adjective overrides the photo. The model renders whoever the
prompt named, whatever the reference actually contains.

The console applies the rule **as you type**, using the same
`lib/prompt-lint-core.js` the repo's linter uses on every pack. A flagged
prompt shows the offending phrase and **cannot be saved**:

> **The prompt names the subject's identity ("Black man").** Describe the
> scene — light, lens, wardrobe, gesture — and leave the person to the
> reference photo. This prompt cannot be saved until it is reworded.

The rule is not a blunt word-ban. "a man in a black coat", "a black-and-white
portrait", "white wine on a table" are all fine — only a claim about a person
is a finding.

The server enforces the same gate independently (`422` with the violations), so
a client that skipped the browser check still cannot get a violating prompt
into the library.

### 2. The flag composer

The stored prompt keeps its **text and ratio separate**, and the composed
command is **derived on read** — never stored. A stored composed command would
go stale the moment the config's `defaultArgs` changed.

The console reads `lib/mj-config.json` for the house defaults rather than
hardcoding them: the defaults are an artistic choice that changes (`--s 21`
replaced the style block on 2026-10-18), and a copy in the page would compose
a different command than the submitter sends.

---

## Where the library lives

`data/mj/prompts.json` — inside the repo, next to the other MJ catalogs.

**It is gitignored.** The library is the artist's private working material;
the repo's rule for generated state is that the source is tracked and the
output is not (same as `data/songs/`, `data/scene-presets/`).

**It is not in localStorage.** A browser-local library would mean "save a
prompt" and "use the prompt" are two different libraries — the CLI, the
watcher and any other browser could not see what you saved. The file is the
source of truth; the console is one writer among several.

The store writes **atomically** (temp file + rename), so a half-written
library is never observed.

---

## The API

Four routes, all local, none metered (a render costs compute; writing a prompt
to a local file costs nothing).

| route | what it does |
|---|---|
| `GET /api/mj/prompts` | the library, each prompt with its composed command |
| `POST /api/mj/prompts` | save one — `422` if the identity lint fires |
| `DELETE /api/mj/prompts/<id>` | remove one — `404` if it is not there |
| `GET /api/mj/pack?title=…&ids=…` | the library as a prompt pack |
| `POST /api/mj/compose` | compose without saving (the browser does this locally too) |

```
POST /api/mj/prompts
{ "title": "Dawn trumpet",
  "prompt": "a trumpet player alone on a stage at dawn",
  "ar": "16:9",
  "tags": ["jazz", "dawn"],
  "notes": "why this one works" }
```

The saved record:

```json
{ "id": "p_mw53lagv_d6814609",
  "title": "Dawn trumpet",
  "prompt": "a trumpet player alone on a stage at dawn",
  "ar": "16:9",
  "tags": ["jazz", "dawn"],
  "notes": "",
  "createdAt": "2026-11-06T14:56:47.935Z",
  "updatedAt": "2026-11-06T14:56:47.935Z",
  "composed": "a trumpet player alone on a stage at dawn --style raw --s 21 --ar 16:9" }
```

`composed` is attached on read. It is not in the file.

### The deployed site has no API

The Vercel deploy is a static site: `/api/...` 308s to the page. The console
**degrades gracefully** there — the composer and the linter still work (they
run in the browser), and a banner explains that saving needs the local server:

> **The server API is not reachable.** The composer and the linter still work —
> they run in this browser — but saving to the library needs the local server:
> `npm run serve` (or the launchd server on `:5173`).

The e2e spec asserts both paths: the full save/find/delete round trip against
a local server, and the graceful-degradation banner against a host with no
API.

---

## The pack export — the bridge to the pipeline

The library exports as the format `lib/mj-watcher.js` watches for:

```markdown
# Saved prompts — 2 prompts

> Saved in the Midjourney console. 2 prompt(s).

- a trumpet player alone on a stage at dawn --ar 16:9
- a stage at night, one lamp --ar 3:4
```

Save it as a `.md` file and drop it in `prompts-inbox/` — the watcher picks it
up and submits every prompt in order.

The round trip is **tested**: the exported pack is parsed back through the
submitter's own `extractPrompts()`, and it must yield the same prompts with
the same ratios. A pack the watcher cannot read is not a pack.

---

## The CLI

The same library, from the terminal:

```bash
npm run mj:console -- --list
npm run mj:console -- --add "Dawn trumpet" \
    --prompt "a trumpet player alone on a stage at dawn" --ar 16:9 --tags jazz,dawn
npm run mj:console -- --remove p_mw53lagv_d6814609
npm run mj:console -- --pack --title "My pack"
```

Exit codes: `0` ok · `2` bad input (including the identity lint) · `3` store
fault.

---

## Tests

```bash
npm run test:mj-console   # 60 assertions — the store, the gates, the parity
npm run e2e:mj-console   # 33 browser checks — the page contract
```

The e2e spec starts its own server on a free port with
`MJ_PROMPT_STORE` pointing at a scratch file, so **it never writes the
artist's real library**.

---

## Files

| path | what it is |
|---|---|
| `pages/mj-console.html` | the console |
| `lib/mj-flags.js` | the shared flag composer (browser + Node) |
| `lib/prompt-lint-core.js` | the shared identity rule (browser + Node) |
| `lib/mj-console-store.js` | the library: read, write, validate, export |
| `lib/mj-console.test.js` | the store + parity tests |
| `e2e/mj-console.spec.mjs` | the browser contract spec |
| `data/mj/prompts.json` | the library itself — gitignored |

---

## Open

- **No bulk actions.** Save, edit and delete one prompt at a time. A
  multi-select "export these five" would be the next useful thing.
- **The library has no tags beyond a flat list.** The store normalises and
  dedupes them, but nothing filters by them yet.
- **The console does not submit.** It composes and saves; the watcher
  submits. That split is deliberate — a submission spends MJ compute, and
  this page is meant to be free of consequence.
