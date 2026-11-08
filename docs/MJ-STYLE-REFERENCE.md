# Setting a Midjourney job as a style reference — what was measured

**Status (2026-11-06):** solved, by measurement. The answer is a
`--sref` URL, and the account already had one.

The ask was: *set this job's look as the style prompt* —
`https://www.midjourney.com/jobs/c6403638-a132-4a68-8f2f-26bb4cca9f45`.

Four probes, in order, each answering a question the previous one
raised. None of them guessed.

---

## 1. There is NO server route for a style reference

Thirteen candidate routes, asked of the live account in one sweep
from inside the page (so the session cookies and the CSRF header
apply):

```
GET /api/styles                     → 404
GET /api/styles/create              → 404
GET /api/styles/create/             → 404
GET /api/style                      → 404
GET /api/style/create               → 404
GET /api/style/create/              → 404
GET /api/style-reference            → 404
GET /api/style-reference/           → 404
GET /api/style-references           → 404
GET /api/style-references/          → 404
GET /api/style/create-from-job      → 404
GET /api/styles/list                → 404
GET /api/styles/mine                → 404

CONTROL  GET /api/characters        → 404
CONTROL  GET /api/jobs              → 404
CONTROL  GET /api/imagine           → 400 {"error":"Invalid user_id"}
```

The control matters: `/api/imagine` answered **400**, so the probe
itself worked. A sweep where the controls also 404 would prove
nothing about the session.

**A 404 is a discovery** — it proves the feature does not exist
server-side under that name. The repo already learned this with
`/api/characters` (see `references/measured-behaviours.md` §8).

## 2. Every style reference this account uses is a URL

Read off the feed's own `full_command` across 200 jobs:

| form | count |
|---|---|
| `https://s.mj.run/<code>` | 7 jobs, 3 distinct URLs |
| a bare numeric id (`--sref 1454119249`) | the studio's own generated styles |

Both forms appear in `--sref`. The `s.mj.run` link is the one the
artist's own work uses.

## 3. The job ALREADY carries the style reference

The artist's job, verbatim from the feed:

```
A man in a dark overcoat, and the chair behind him, beside a single
window, dust in the air, wet black asphalt, umbrella lights reflected
in the road, muted teal and orange, anamorphic, no text
--ar 16:9 --sref https://s.mj.run/cATLXOMsR-o --profile ub2pnlv --v 8.2
```

So "set this job's look as the style prompt" was **already true** —
the job's look IS that style reference, and the studio renders it as
a thumbnail.

## 4. The studio's control is labelled `Style Reference (--sref)`

The per-image action bar carries a button whose markup is the proof:

```html
<button type="button" title="Style Reference (--sref)"
        aria-disabled="false" draggable="true"
        class="group/thumb cursor-copy relative active:opacity-90 transition-opacity">
  <img draggable="false" alt="https://s.mj.run/cATLXOMsR-o"
       src="https://s.mj.run/cATLXOMsR-o?thumb=true&size=128">
  <span role="button" title="View full size" …>
```

Three things in that markup:

- the thumbnail's `alt` and `src` are **the job's own style reference**;
- the class is **`cursor-copy`** — the control COPIES the reference;
- the sibling is `View full size`.

So the button is not a mint action. It hands you the reference the
image already carries.

### THE TWO CONTROLS SHARE A PREFIX — AND THAT IS A TRAP

There are TWO buttons on the page:

| label | where | what it is |
|---|---|---|
| `Style Reference` | the composer's control row, next to the `--sref 178272779` chip | opens the style picker |
| `Style Reference (--sref)` | the image's action bar, next to `View full size` | the image's style reference |

A probe that matched `/style/i` or the plain label presses the
**composer's** control — and reports "nothing happened", because the
composer's control does something else entirely. **The parenthetical
is the whole selector.**

### A SYNTHETIC `.click()` IS NOT A CLICK

Pressing the image's button with `element.click()` produced **zero
requests and no toast** — a false negative about the action, not a
finding about it. Dispatching a real CDP mouse event at the button's
coordinates produced the same silence.

The reason is that the control's job is to COPY to the clipboard, and
the copy needs a **user gesture**. A synthetic click is not one. The
measurement that settled it: the clipboard was seeded with a sentinel,
the button was pressed, and the clipboard came back **unchanged**
— because the copy was refused, not because the button is inert.

(That test is also why the mechanism is now known to be a copy: the
markup says `cursor-copy`, and the reference is in the thumbnail's
`alt`. Neither needed a network call to establish.)

### WHERE THE ROUTE CAME FROM

Guessing route names is a bad search. **Watching the page that uses
the feature is a complete one.** The Style Creator page load revealed:

```
GET https://www.midjourney.com/api/explore-styles-likes
→ [{ "id": "0_2030310574", "formatted_sref": "2030310574",
     "liked_by_user": true, "isStyleJob": true, "type": "style", … }]
```

Twenty style references, each with a numeric id. The page renders
them as `https://cdn.midjourney.com/styles/0_<id>/landscape_384_N.webp`.

That route is the **studio's own generated styles** — not the
artist's job. The artist's reference is the `s.mj.run` URL.

---

## The finding that changes a registry

The job's command carries `--profile ub2pnlv`. Measured across 200
feed jobs:

| flag value | jobs carrying it |
|---|---|
| `--v 8.2` | 164 |
| `--ar 16:9` | 101 |
| `--stylize 21` | 89 |
| `--profile kgvnzd9` | 33 |
| `--profile ub2pnlv` | **6** |
| `--profile brvazka` | 3 |

`ub2pnlv` rides on six of two hundred jobs — so it is a **deliberate
grade on that one job**, not the account's default. And the repo's
own docs record that the account's personalization is applied to every
generation by default.

**So it is left out of the registry.** Pinning a default into a
registry pins an accident: the next job the artist makes without that
code would silently inherit it.

The flags that ARE pinned are the ones measured as the account's own
working vocabulary: `--ar 16:9` (101 jobs), `--raw` (85), `--v 8.2`
(164).

---

## The tools

All under `tools/`, all read-only except where noted:

| tool | what it answers |
|---|---|
| `mj-style-probe.js` | does a style route exist? (route sweep with controls) |
| `mj-style-urls.js` | what URL forms does the account use for `--sref`? |
| `mj-style-list.js` | the account's style references, via `/api/explore-styles-likes` |
| `mj-style-ui-probe.js` | what does the studio page offer? |
| `mj-style-menu-probe.js` | the job card's overflow menu |
| `mj-style-image-menu.js` | the per-image overflow menu |
| `mj-style-lightbox.js` | the action bar on OUR job's own cell |
| `mj-style-enumerate.js` | every style/reference control, with its ancestor chain |
| `mj-style-action.js` | presses the control, watches the network |
| `mj-style-set2.js` | the same, with a REAL mouse event |
| `mj-style-clipboard.js` | does the control copy? (sentinel → press → read) |
| `mj-style-routes.js` | every route the Style Creator page actually calls |
| `mj-feed-flags.js` | the account's flag vocabulary, by frequency |
| `mj-fetch-url.js` | fetch any URL through the logged-in browser |

**The lesson worth keeping: a probe that reports "nothing happened"
must distinguish "the action does nothing" from "I pressed the wrong
control" and "my click was not a real click".** Each of those three
produced a false negative here, and each needed a different
instrument to resolve. The button that finally answered the question
was not pressed harder — it was *located* better (by its exact
label) and then *observed* through a different channel (the
clipboard, and the markup).

---

## What is still open

- **No generation was spent.** The twelve frames of THE WATCHED MAN
  are composed and verified, but not rendered. One pack command
  renders them.
- **The style reference is the job's, not a fresh mint.** If the
  artist wants a NEW style minted from a specific cell, the route is
  not on the API — it is the studio's UI, and the account's own
  generated styles are the ones it mints.
- **`--profile` remains unpinned** in every registry built from this
  session, deliberately.
