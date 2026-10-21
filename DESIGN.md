# DESIGN.md — the digital_twin design system

> The skinning contract for digital_twin **and every sibling project** in
> the kai-systems family. One file changes the look of the whole family.
>
> - **The machine-readable half:** `lib/skin-contract.js` (what a skin
>   must define) · `lib/skin.js` (the runtime) · `lib/skin-tokens.js`
>   (the validator)
> - **The skin files:** `assets/skins/<name>.css`
> - **This document:** the rules, the reasons, and the procedures.
>
> Sibling projects adopt this by copying §7. Nothing here is
> digital_twin-specific except the file paths.

---

## 1. Why this exists

Until sprint 0.45, every page in every project carried its own copy of
the design tokens. In digital_twin alone, **18 pages each defined their
own `:root` block**, and they had drifted into **three incompatible
naming families** for the same concepts:

| Concept | Family A (house) | Family B (dark tool) | Family C (marketing) |
|---|---|---|---|
| text | `--ink` | `--fg` | `--text-primary` |
| hairline | `--line` | `--border` | `--border-light` |
| raised surface | `--surface` | `--bg-card` | `--bg-secondary` |
| muted text | `--ink-muted` | `--fg-mute` | `--text-secondary` |

Re-theming meant editing eighteen files and hoping you got all
eighteen. The kai-systems hub had already solved this for itself
(`assets/shared.css` — "Future token changes are one edit, not eight"),
but that fix was not portable and was not carried by the spokes.

**The rule this document establishes:**

> The look of a project is a **file**, not a set of edits. A skin is
> one CSS file. Swapping skins is one `<link>`. Verifying a skin is one
> command.

---

## 2. The design principles

Unchanged from the house style, and unchanged by any skin. A skin
changes *values*, never *voice*.

1. **Calm, not chatty.** The twin reports; it does not perform. No
   eager glow, no bounce, no celebration. Motion is a whisper.
2. **Warm, not cold.** The house palette is cream and copper, not
   slate and electric blue. A skin may change the temperature but a
   project that has a voice keeps it.
3. **Local-first.** No web fonts beyond the three the family uses, no
   analytics, no CDN dependency for the chrome. The interface must
   render with the network off.
4. **Structure over decoration.** Grid, spacing, and type scale carry
   the hierarchy. Shadows are separators, not effects.
5. **Dark is a peer, not an inversion.** Every skin ships both
   themes, both complete. The dark theme is designed, not derived by
   negating the light one.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  page.html                                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ <link rel="stylesheet" href="../assets/skins/     │  │  ← the ONE file
│  │                       house.css" data-skin-stylesheet>│ │    that changes
│  │ <script src="../lib/skin.js"></script>             │  │  ← swaps it on ?skin=
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ <style>  /* page layout only — NO token values */   │  │  ← page keeps its
│  └────────────────────────────────────────────────────┘  │    own structure
└──────────────────────────────────────────────────────────┘
```

Three rules make this work:

1. **A page never defines a token value.** Its inline `<style>` block
   holds layout, typography *application*, and component rules — never
   a colour literal and never a token definition. A page that defines
   `--bg` is a page that cannot be re-skinned.
2. **A skin is one file** with exactly two scopes: `:root` (light) and
   `:root[data-theme="dark"]` (dark).
3. **The runtime swaps the file, not the values.** `lib/skin.js`
   rewrites the stylesheet's `href`. Nothing is re-computed, so the
   swap is atomic and cannot half-apply.

### 3.1 Why a link and not an inline block

An inline `<style>` block per page was the old way, and it is exactly
what this system replaces. The link is not a build step: the file is
plain CSS served next to the page, it works from `python3 -m
http.server`, and it works from GitHub Pages and Vercel. The kai-systems
hub already links `assets/shared.css`; this is the same pattern,
extended to skins.

The cost is one HTTP request for the stylesheet. That is the right
trade: it is cacheable, and it is the thing that makes the skin a
single file.

---

## 4. The token contract

The contract is **machine-readable**: `lib/skin-contract.js` is the
source of truth, and `lib/skin-tokens.js` validates every skin against
it. This document explains it; the code enforces it.

### 4.1 The three kinds of token

| Kind | Must be defined | Skin may change it | Lives in |
|---|---|---|---|
| **themed** | light **and** dark | yes — this is the point | `:root` + `:root[data-theme="dark"]` |
| **static** | base scope | yes (fonts, radii, spacing) | `:root` only |
| **local** | nowhere | **never** | the page that owns it |

**Themed** tokens are colours. They are the skin.

**Static** tokens are the constant parts of the look: font stacks, the
spacing scale, radii, shadows, motion durations, container widths. A
skin *may* override them — a different skin can be a different
typographic voice — but it does not have to, and a themed/dark pair is
never required for them.

"Defined once" does not mean "the same value in both themes". A static
token may *derive* from a themed one, and then it resolves differently
per theme without being redefined. The house skin's shadows do
exactly this:

```css
--shadow-sm: 0 1px 2px color-mix(in srgb, color-mix(in srgb, var(--bg) 12%, #000000) 4%, transparent);
```

One rule, two results: on the cream ground the shadow is a warm grey,
on the near-black ground it is a deeper, quieter one. The contract's
rule is that a static token appears in the base scope and is **not
repeated in the dark scope** — a repeated value would pin the light
theme's shadow onto the dark one, which is the bug this avoids.

**Local** tokens are one-off palettes that belong to a page's
*content*, not to the project's look: a sepia photographic treatment, a
flag's three stripes, a building's stone. They are listed in the
contract so the validator can tell "this page forgot to migrate" apart
from "this was never skinnable". **A skin must never define them.**

### 4.2 The groups

| Group | Owns | Examples |
|---|---|---|
| `surfaces` | the ground, back to front | `--bg` `--bg-warm` `--surface` `--line` `--line-soft` |
| `ink` | text and its three levels of emphasis | `--ink` `--ink-muted` `--ink-faint` |
| `brand` | the project's own voice | `--primary` `--primary-2` `--primary-soft` `--primary-mid` |
| `accent` | the supporting voice + the ten domain accents | `--accent` `--accent-2` `--accent-3` `--accent-scanner` |
| `status` | feedback | `--success` `--error` `--warn` |
| `code` | inline and block code | `--code-bg` `--code-text` |
| `typography` | families, sizes, leading | `--font-display` `--fs-lg` `--lh-tight` |
| `space` | the spacing scale | `--space-1` … `--space-9` |
| `radius` | corner radii | `--radius-sm` … `--radius-xl` |
| `shadow` | separators | `--shadow-sm` … `--shadow-glow` |
| `motion` | durations and easings | `--dur-fast` `--ease-out-expo` |
| `layout` | content widths | `--container` `--container-wide` |

The exact token list lives in `lib/skin-contract.js`. Read it; do not
transcribe it here and let the two drift.

### 4.3 Legacy aliases

The three naming families from §1 coexist in the contract. The
canonical name wins; the alias is a synonym emitted by the same skin so
that a page using either name skins correctly.

| Canonical | Aliases (same value) |
|---|---|
| `--ink` | `--fg` `--text-primary` |
| `--ink-muted` | `--fg-mute` `--muted` `--text-secondary` |
| `--ink-faint` | `--fg-dim` `--text-tertiary` |
| `--line` | `--border` `--border-medium` |
| `--line-soft` | `--border-light` |
| `--surface` | `--bg-card` `--bg-primary` |
| `--bg-warm` | `--bg-secondary` `--bg-soft` |
| `--bg` | `--bg-soft-2` |

**Do not add new aliases.** A page that needs a new name adds a
*canonical* token to the contract, in one place, for every project.

---

## 5. The skin file format

A skin is one file at `assets/skins/<name>.css`:

```css
/*! skin: house
 *  title: House (kai-systems)
 *  author: digital_twin
 *  note: warm cream and copper — the family's default voice
 */

:root {
  /* Surfaces */
  --bg: #f7f5f0;
  --bg-warm: #f4f0e7;
  --surface: #ffffff;
  --line: #e9e3d6;
  --line-soft: #f0eadf;
  /* … every themed token (light) … */
  /* … every static token … */
  --font-display: 'DM Serif Display', serif;
  /* … */
}

:root[data-theme="dark"] {
  /* every themed token again, dark values */
  --bg: #1a1812;
  --bg-warm: #211e16;
  /* … */
}
```

Hard rules, all machine-checked by `lib/skin-tokens.js`:

- The first line is the `/*! skin: <name>` header. `<name>` equals the
  filename stem. A mismatch is an error.
- The base scope holds **every themed token** (light values) **and every
  static token**.
- The dark scope holds **every themed token** again (dark values).
- No token outside the contract's `all` list. No `LOCAL` token.
- Every value resolves: no `var(--something-undefined)`.
- A themed token with the *same* value in light and dark is a
  **warning** — it is almost always a token the skin forgot to re-tint.

### 5.1 Soft variants are derived, never hand-picked

A skin that changes `--primary` must re-tint `--primary-soft` and
`--primary-mid` automatically. Write them as:

```css
--primary-soft: color-mix(in srgb, var(--primary) 8%, transparent);
--primary-mid:  color-mix(in srgb, var(--primary) 18%, transparent);
```

Never as a literal. A literal is a second thing to remember when the
skin changes, which is the failure mode this whole system exists to
remove.

---

## 6. Writing a new skin

1. **Copy the nearest skin** as a starting point:
   `cp assets/skins/house.css assets/skins/<name>.css`.
2. **Change the header**: `/*! skin: <name>` and a `title` / `note`.
3. **Re-tint the base scope.** Start with `--bg`, `--bg-warm`,
   `--surface`, `--line`, `--line-soft`; then `--ink`, `--ink-muted`,
   `--ink-faint`; then `--primary` and its derived soft/mid; then
   `--accent` and the ten domain accents.
4. **Re-tint the dark scope** the same way, and *separately*. Dark is
   not the light theme with the brightness pulled down: a dark surface
   needs a lifted brand colour to hold contrast, and a shadow in dark
   is a suggestion, not a plane.
5. **Derive every soft/alpha variant** with `color-mix` (§5.1).
6. **Check the domain accents stay mutually distinguishable** in both
   themes, and that each `*-text` companion is legible on `--surface`.
7. **Register the name** in `KNOWN_SKINS` in `lib/skin.js`. The runtime
   carries the list of skin names so that an unknown `?skin=` is never
   *requested* — a request for a file that does not exist is a 404 in
   the console, and a typo should be a no-op, not a broken request.
   `lib/skin-lint.js` fails if this list and `assets/skins/` drift
   apart, so the two cannot rot independently.
8. **Validate**:
   ```bash
   npm run skin:check
   ```
   This validates every skin in `assets/skins/` against the contract
   and exits non-zero on any error. **A skin that does not validate does
   not ship.**
9. **Look at it**: load a page with `?skin=<name>` and check both
   themes. The e2e spec `e2e/skin.spec.mjs` does this automatically.

---

## 7. Adopting the contract in another project

The kai-systems family shares a visual language; it should share a
mechanism too. To adopt in a sibling repo (RESONA, bob-mover, a new
spoke):

1. **Copy the contract and the runtime** into the project:
   ```bash
   cp digital_twin/lib/skin-contract.js digital_twin/lib/skin.js  <project>/lib/
   ```
   `lib/skin.js` has no dependencies and no build step. It is a browser
   script and a pure function; nothing else is required.
2. **Copy the skin files** into the project's own `assets/skins/`, or
   point at the shared hub's copies if the project prefers one source
   of truth for the house skin.
3. **In each page**, replace the inline `:root { … }` and
   `[data-theme="dark"] { … }` blocks with:
   ```html
   <link rel="stylesheet" href="../assets/skins/house.css" data-skin-stylesheet>
   <script src="../lib/skin.js"></script>
   ```
   (adjust the relative depth for the page's location — pages at the
   repo root use `assets/skins/…` and `lib/skin.js`).
4. **Delete every token definition from the page's inline `<style>`.**
   This is the step people skip, and it is the step that breaks
   skinning. A page that still defines `--bg` keeps its own `--bg`.
5. **Run the validator** against the project's skins and fix what it
   reports. The most common report is a token the page used that no
   skin defines — add it to the contract, not to the skin.
6. **Run the project's e2e.** A page that changes appearance is a
   changed page; its spec may assert a colour or a contrast.

### 7.1 The migration order (per project)

Migrate in this order, so a broken intermediate state is caught early:

1. A page with no e2e spec (lowest risk).
2. A page whose spec asserts structure but not colour.
3. A page whose spec asserts colour or contrast — last, and read the
   spec first.

---

## 8. Reference skins

### `house` — the kai-systems default

Warm cream, copper, forest. The family's original voice, extracted from
the kai-systems hub's `assets/shared.css` and completed with the
twon's own dark theme. Light: cream `#f7f5f0` ground, copper `#c97b3f`
brand, forest `#2f6f5e` accent, ink `#14171e`. Dark: warm near-black
`#1a1812`, lifted copper `#d9925a`, lifted forest `#6ab098`, cream ink
`#f4efe2`.

### `studio` — Suno Studio 2.0

A dark, precise, instrument-panel skin. Modelled on Suno Studio 2.0
(`https://suno.com/studio-welcome`) — "be a control freak" — with a
palette **extracted from Suno's own production CSS**, not invented:
the near-black `#000` ground, a hot strawberry `#fd429c` brand,
amethyst `#8b6efe` and dodger-blue `#1f8bff` accents, and Suno's
inverted neutral ramp (their "dumbo" scale runs dark→light from 50 to
950). The light theme is a genuine inverted counterpart, not a wash.

`studio` exists to prove the mechanism does something the house skin
cannot: a skin that is not warm, not cream, not copper, and still
produces a coherent, legible, contract-valid interface.

---

## 9. Verification

| Check | Command | Guards |
|---|---|---|
| Contract coverage + pages | `npm run skin:check` | every skin defines every token in both themes; no page defines a token of its own; the runtime's skin list matches the skins directory |
| A skin, on its own | `npm run skin:validate` | the same validator, per file, with a per-group report |
| Runtime behaviour | `npm run test:skin` | the validator's parser and the skin-resolution function |
| Visual contract | `npm run e2e:skin` | a page really re-skins, both themes, `?skin=` beats the stored choice, an unknown skin falls back, 0 console errors |
| Everything else | `npm run verify` | the existing e2e suite still passes after a skin change |

A skin change is not done until `skin:check`, `test:skin`, `e2e:skin`
and `verify` are all green.

### 9.1 The pages that are deliberately not skinned

Six pages keep their own palettes on purpose, and `lib/skin-lint.js`
knows their names:

| Page | Why |
|---|---|
| `refael-mp4-maker.html` | a standalone product with its own dark design language — restyling it would be a fork, not a skin |
| `sacred-geometry-cymatic.html` | a generative art piece; the black-and-gold palette *is* the artwork |
| `leaf-skeleton.html`, `leaf-skeleton-macro.html` | art pieces; the paper-and-ink palette is local |
| `terazije-postcard.html` | a postcard; the sepia and flag palette is the piece |
| `agent-dashboard.html` | generated by the agent loop; it owns no palette |

The list is short on purpose. Every entry is a claim that re-theming
that page would damage it, and it has to be re-argued if it grows. A
page that is *not* on this list and still defines a token is a bug, and
the lint says so.

---

## 10. Anti-patterns

- **A page defines a token.** The single most common way to break
  skinning: the page's inline `:root` wins over the skin and the skin
  silently does nothing on that page.
- **A hard-coded colour in a component rule.** `color: #c97b3f` in a
  page's CSS is unskinnable. Use `var(--primary)`.
- **A skin that only defines light.** A missing dark scope means the
  dark theme falls back to the light values — a legible but wrong page.
- **A literal soft variant.** §5.1. A literal is a second edit.
- **A new alias.** Aliases are the historical families from §1. Adding
  one grows the contract instead of shrinking it.
- **A skin that changes the page's structure.** A skin changes values.
  If a skin needs a different layout, that is a fork, not a skin.
- **Skipping the validator.** It exists because the failure is silent:
  a missing token does not error, it just renders wrong.

---

## 11. Where things live

```
lib/skin-contract.js      the contract — what a skin must define
lib/skin.js               the runtime — ?skin= swaps the stylesheet
lib/skin-tokens.js        the validator — npm run skin:validate
lib/skin-tokens.test.js   the validator's tests — npm run test:skin
lib/skin-lint.js          the permanent guard — npm run skin:check
assets/skins/house.css    the house skin
assets/skins/studio.css   the Suno Studio 2.0 skin
e2e/skin.spec.mjs         the visual contract spec
```

The lint is the piece that makes the rest hold. It asks three
questions of every page in the repo:

1. Does a page that **consumes** a contract token load a skin? A page
   reading `var(--ink)` with no skin link renders with the token
   undefined — silently, as the fallback value.
2. Does a page that **defines** a contract token own its palette? A
   page that still declares `--ink` overrides the skin, so the skin
   does nothing there. Only the §9.1 list may.
3. Is every skin valid against the contract, and does the runtime's
   `KNOWN_SKINS` match the skins directory?

Related: `docs/DESIGN-RATIONALE.md` (why the *landing page* is shaped
the way it is) and `AGENTS.md` (the repo's working rules).
