# Suno backing bands — the seven briefs

`lib/suno-backing-bands.json` · `lib/suno-backing-bands.js` · `lib/suno-backing-bands.test.js`

## What a "band" is here

A brief for a rhythm section and a horn section that plays **behind** a
soloist. It is not a song, and it is not a solo. What it reserves is
**space**.

Every band carries exactly **two** `[Open Trumpet Space: 32 bars, ...]`
sections. That is the contract, and the test asserts it: a brief that
opens only one space leaves the soloist nowhere to go, and one that
opens three is a backing band with a soloist grafted on.

Every band also ends with the same three lines:

```
[No lead melody]
[No horn solos]
[No vocals]
```

## The three fields, and why they are three

| registry field | goes to | what it governs |
|---|---|---|
| `style` | Suno's **style/tags** field | the sound of the whole track |
| `negativeTags` | Suno's **exclusions** field | what this brief is NOT |
| `arrangement` | Suno's **lyrics/prompt** field | the section-by-section shape |

**The split is not cosmetic.** Suno *paraphrases* the style box — a style
submitted as

> "Recorded live to two-track in a natural concert hall, authentic room
> reflections, audible breathing, loose human timing"

came back as

> "raw two-track concert-hall recording with room reflections, audible
> breaths, tape wobble, bleed, dry close-mic room tone and unquantized
> timing"

— but the **arrangement comes back VERBATIM**: the clock times, the
movement titles, every tag. So the arrangement field is the part that is
a *contract*, and the style box is a *description of intent*. Putting
the arrangement in the style box would spend the characters the timbre
needs.

**The exclusions get their own field** because the house rule for
Pro/Premier already says so (Exclude Styles under Advanced Options),
and because it is measured: the account's own "UNPLUGGED IMPERFECT
TRUMPET" style is exactly **1000 characters** — the style limit — so the
exclusions cannot ride along in the same field.

## The 1000-character limit

Suno's style box holds 1000 characters. Measured style lengths:

| # | band | style | exclusions | open spaces |
|---|---|---|---|---|
| 1 | The Unfinished Prayer | 476 | 170 | 2 |
| 2 | Smoke Without Fire | 466 | 166 | 2 |
| 3 | Brass Under Pressure | 519 | 150 | 2 |
| 4 | Five Shadows Walking | 511 | 154 | 2 |
| 5 | Dust on the Tape | 550 | 150 | 2 |
| 6 | The Wrong Side of Morning | 577 | 129 | 2 |
| 7 | Nothing Left to Resolve | 597 | 177 | 2 |

Every one fits, with 403 characters to spare at the tightest. **No
truncation was needed**, so no band has an overflow rule — if a future
brief does overflow, cut the STYLE at a clause boundary and move the
excess into `negativeTags`, never mid-word. (That is the rule the KAI
sound DNA had to follow: its master style is 856 characters and the raw
suffix is 176 — 1034 together, over the limit.)

## The house vocabulary

The briefs use the concrete imperfections Suno has been shown to respond
to on this account — *close-mic spit, valve clicks, lip buzz,
unquantized timing drift, live one-take room recording, honest rough
performance* — rather than adjectives like "authentic" or "lo-fi" that
say nothing about what to do.

The raw register is the point: "no commercial polish", "honest mistakes
left in". A brief that asked for a polished backing band would be
asking for the opposite of the house sound.

**No brief names the subject's race or ethnicity.** The house rule
(AGENTS.md) is written about image prompts, but the vocabulary here is
deliberately free of it too, and the test asserts it. Note that
band 01's "Afro-Latin" is a *genre lineage*, not a subject descriptor —
so the matcher looks for whole ethnicity terms, not for "afro" alone.

## Using it

```bash
npm run suno:bands:list                     # the seven, with their lengths
npm run test:suno-backing-bands             # the contract
node lib/suno-backing-bands.js --one smoke-without-fire
```

To submit one, take the three fields and hand them to the cover path
(`lib/suno-run.js` — a cover renders and costs nothing on this account;
a plain generation is refused):

```bash
node lib/suno-run.js --cover <clip_id> \
  --tags "<style>" \
  --negative-tags "<negativeTags>" \
  --prompt "$(node -e 'const b=require("./lib/suno-backing-bands.js"); console.log(b.arrangementFlat("smoke-without-fire"))')" \
  --title "Smoke Without Fire"
```

The arrangement helper returns the section tags joined into one line —
the shape the lyrics field wants.

## The API

```js
const bands = require('./lib/suno-backing-bands.js');

bands.bands();                    // all seven, house order
bands.bySlug('dust-on-the-tape'); // one band
bands.byIndex(5);                 // one band by its number
bands.slugs();                    // the slugs
bands.arrangementText(band);      // the arrangement, one section per line
bands.arrangementFlat(band);      // the arrangement, one line
bands.openSpaceCount(band);       // how many open solo spaces (2)
bands.styleLength(band);          // the style length (the 1000-cap number)
bands.isWellFormed(band);         // the whole contract in one call
bands.notes();                    // the registry's own "why" notes
```

## Adding a band

1. Add an entry to `lib/suno-backing-bands.json` with `slug`, `name`,
   `index`, `style`, `negativeTags`, `arrangement` (an **array** of
   section tags), and `note`.
2. Two `[Open Trumpet Space: ...]` sections exactly.
3. End the arrangement with the three closing lines, in order.
4. Keep the style under 1000 characters.
5. `npm run test:suno-backing-bands` — it will tell you which rule you
   broke.
