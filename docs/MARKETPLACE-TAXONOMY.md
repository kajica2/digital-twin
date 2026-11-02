# Marketplace taxonomy — the storefront's discovery keywords

`lib/marketplace-taxonomy.json` · `lib/marketplace-taxonomy.js` · `lib/marketplace-taxonomy.test.js`

## What this is

The canonical list of the categories the marketplace sells into, and the
keyword a shopper would type to find them. **Seven groups, 41 terms.**

## What this is NOT

Three similar-looking things live in this repo, and they are different
jobs:

| file | names | job |
|---|---|---|
| `lib/marketplace-taxonomy.json` | the CATEGORIES | what the storefront sells into, and how a shopper finds it |
| `lib/daily-collections.json` | the COLLECTIONS | what gets rendered on Midjourney, and its caption/alt copy |
| `assets/marketplace/daily/index.json` | the CATALOGUE | what has been published |

The taxonomy is the storefront's *vocabulary*. The collections registry is
the render plan. The catalogue is the output.

## A term carries four things

```json
{
  "label": "blender",
  "slug":  "blender",
  "query": "blender",
  "hint":  "3D models"
}
```

- **label** — how the category is written to a shopper. The source's own
  spelling and capitalisation.
- **slug** — the URL-safe handle. The programmatic address.
- **query** — the search keyword to type.
- **hint** — the word the source used *after* the bracketed term
  ("3D models" for blender, "brushes" for procreate). The qualifier,
  kept so the shelf label can be assembled without losing the source's
  phrasing.

`shelfLabel()` joins the two: `blender` + `3D models` → "blender 3D
models".

## The seven groups

| group | terms |
|---|---|
| Creative Assets & Tools | 7 |
| Templates & Productivity | 4 |
| Audio & Music | 7 |
| Education & Writing | 7 |
| Mind & Body | 6 |
| Visual Media & Art | 7 |
| Niche Markets | 3 |

**Audio & Music** is this artist's own shelf: instrumental music,
singles, sample pack bundles, Ableton project files, sheet music, jazz
resources, VJ loops.

## The source, and the one oddity

Transcribed verbatim from the marketplace's own category list. Where the
source spelled a term in a bracketed link, the link text is the search
keyword and is kept exactly as written, lowercased — `notion template`,
`kdp interior`, `after effects`, `sample pack`, `workout program`.

**`spark ar` is kept verbatim.** It reads like a truncation of "Spark
AR" (the AR toolkit is a plausible reading), but the source says
`spark ar` and this registry's job is to record what the storefront
says, not to correct it. The test pins it, so a silent "fix" will fail
rather than pass unnoticed. If the storefront later spells it "Spark AR",
change `query` and `label` together and the slug follows.

## Using it

```bash
npm run marketplace:taxonomy                # the seven groups, all terms
npm run test:marketplace-taxonomy           # the contract
node lib/marketplace-taxonomy.js --one jazz
```

```js
const tax = require('./lib/marketplace-taxonomy.js');

tax.groups();                  // every group, storefront order
tax.byGroup('audio-music');    // one group, by id or by display name
tax.termsIn('audio-music');    // its terms
tax.allTerms();                // every term, with its group attached
tax.bySlug('kdp-interior');    // one term
tax.queryFor('kdp-interior');  // 'kdp interior'
tax.shelfLabel('blender');     // 'blender 3D models'
tax.queriesIn('mind-body');    // the group's search queries
tax.notes();                   // the registry's own "why" notes
```

## Adding a term

1. Add it to its group's `terms` array in
   `lib/marketplace-taxonomy.json`, with `label`, `slug`, `query` and
   `hint`.
2. The slug is lowercase, hyphen-separated, and unique.
3. If it is a NEW group, give it a kebab-case `id` too, and update the
   expected group sizes in `lib/marketplace-taxonomy.test.js` — the test
   pins the counts so a dropped term fails loudly.
4. `npm run test:marketplace-taxonomy`.
