# Work Schedule — the marketplace corpus

A production calendar derived from a study of the existing marketplace
corpus (`assets/marketplace/`, `pages/marketplace.html`,
`assets/mural-prompts/`) and the prompt packs that feed it. The
schedule is built around three ideas:

1. **The marketplace is a living artifact, not a gallery.** New
   cards are added on a cadence; old cards retire when their
   window passes.
2. **Every prompt pack has a template, not a vibe.** The packs are
   prose-aesthetic-brief + 5–16 bullets. New packs write to the
   template; the look stays coherent across the family.
3. **The pipeline already does the shipping.** Prompts drop in
   `prompts-inbox/` and the existing `mj-watcher` LaunchAgent
   submits them through the MJ web backend. Music drops in
   `audio-inbox/` and the `songs-watcher` indexes it. Nothing here
   reinvents those wheels.

The schedule below defines what ships when, the per-pack shape, and
the guardrails that keep the corpus coherent.

---

## 1. The marketplace as published today

| Section           | Card count | Cadence       | Source                       |
|-------------------|-----------:|---------------|------------------------------|
| The Eight         | 8          | curated       | `assets/mural-prompts/mood-frames-eight.md` |
| Studio Extras     | 3          | per cycle     | `assets/mural-prompts/mood-frames-extras.md` |
| Cover Studies     | 12         | monthly       | `assets/marketplace/covers/` (3 families × 4-5) |
| System Error      | 10         | monthly       | `assets/marketplace/system-error/` |
| Motion            | 1 video    | monthly       | `assets/marketplace/midjourney_animated.{jpg,mp4}` |
| Daily Mood        | 1 / day    | automated     | `lib/daily-pipeline.js` → `prompts-inbox/` |

Read this table as **what keeps each section alive**. The Eight and
Studio Extras are the curated calendar (one cycle ≈ 12 days, mood-cycle
length). Cover Studies and System Error refresh on a monthly cadence.
Motion is the showcase. Daily Mood is the always-on conveyor.

---

## 2. The cycle

```
12-day mood cycle          (still → dusk → dawn → drift → ember → neon
                            → hush  → vault → tide → gloss → ache → bloom)
3-4 packs of 5-8           Studio Extras per cycle
1 update                   The Eight (one figure every 12 days)
1 refresh                  Cover Studies (rotate out at 4 weeks)
1 refresh                  System Error (rotate out at 4 weeks)
```

Each mood day carries one Daily Mood auto-prompt (in the existing
pipeline) plus, on the cycle-day the user authors manually, the
backbone that the marketplace card itself carries.

---

## 3. Per-pack template

The shape of `assets/mural-prompts/<pack>.md`. The corpus already
follows this shape; new packs write to it.

```
# <Mood name> — <N> assets (16:9)

> Aesthetic: <one-line, atmospheric>.
> For <genres, tempos>. <tempo range>.
> <One load-bearing visual contract, named in plain English>.
> <What the constraint means — concretely, in the language of the image>.
>
> Subject first. <anti-patterns>. --ar 16:9 on every bullet.

## <Section 1 — usually 3-4 bullets>
- <Subject>, <detail>, <details>, <aesthetic clauses>, <ending in --ar 16:9>

## <Section 2>
- ...

## <Section 3 (optional)>
- ...
```

The bullets themselves follow a stable micro-shape learned from the
corpus:

```
<Subject phrase>, <adjacent detail>, <compositional anchor>,
<aesthetic clauses (3-5)>, <ending in --ar 16:9>
```

### Hard rules (do not break)

| Rule | Why |
|---|---|
| Subject first (never "An image of…" or "A picture of…") | The MJ acceptance-matcher excerpts characters 100–200; a non-subject opener collapses 12 variants into 1. |
| Every bullet ends in `--ar 16:9` | The mj-submitter extractor keys off this token. |
| No text in frame; no watermark, no logo, no letters | Diffusion models paint letters; baked-in text always mis-spells. Letters go in the layout, never in the prompt. |
| No empty subjects ("empty room", "lonely figure") | The acceptance-matcher collapses them. The subject should be a noun doing a verb. |
| The aesthetic clauses are concrete ("film grain", "kodachrome palette", "sodium streetlight") | "Beautifully lit" or "cinematic" is a vibe-name, not a clause the model renders. |
| End-of-bullet flags are last (`--ar 16:9 --s 100 --raw --v 8.2`) | Midjourney honours the last occurrence; flags before `--ar` can be silently overridden. |

### Soft style precedents (the *only* successful writers in this corpus)

From a study of the existing packs:

- **morning-haunt.md** — top-tier aesthetic prose. Loads "kodachrome warmth"
  in the front-matter and never has to re-explain it. Use as a model.
- **brutalist-architecture.md** — perfect monochrome discipline. Uses one
  accidental accent if colour appears; otherwise strict grey.
- **sunset-water-burst.md** — the "Source:" line is the strongest
  precedent for grounding a pack in a real photographic reference.
  Worth reading the formula: *what I saw, where I was, what the
  light did.*

---

## 4. Calendar — twelve-week cadence

| Week | Books | Pipeline output |
|------|-------|-----------------|
| 01 | One new mood pack (8 prompts) for *The Eight*. Three new moods → three new Still frames. | Old Three fade to "Studio Extras" |
| 02 | One Cover Studies family (5 cards). Cover positioning follows the new month's mood of the cycle (4 weeks). | One family rotates in; previous family drops to `pages/marketplace.html`'s footer. |
| 03 | **System Error** refresh: 10 plates, one explicit failure-mode per plate (RGB split, scanline tear, datamosh, broken LCD, …). | Scene 1: pick which 3 plates retire. |
| 04 | **Motion** showcase: one mp4 in the corpus. Source: the prior month's strongest pack, voice-over from a daily mood brief. | mp4 lands in `assets/marketplace/<mood>-motion.mp4`. |
| 05 | *Studio Extras* cycle drops one new "outtake" — a pack that didn't make The Eight, repurposed. | Bridges weeks to keep the marketplace visually fresh. |
| 06 | Mid-cycle review: are The Eight still the strongest 8? Replace any that have lost their hold. | The cadence above assumes yes. |
| 07 | One Cover Studies family (5 cards). Different aspect, different family. | Variety: light heavy next month. |
| 08 | **System Error** refresh (10 plates). | One new failure mode. |
| 09 | Cover letter/copy pass: every card has a 2-line teaser that reads. | The market edit (deep house, soundhealing, cyberpunk/hk, collective, …) is named. |
| 10 | *Studio Extras* cycle drop (one). | One outtake. |
| 11 | Mid-cycle review + One new mood pack for *The Eight* (8 prompts). | Old three fade. |
| 12 | **Motion** showcase for the second half + holiday variant (year-end cover). | mp4 lands. |

The cadence is a *default*, not a rule. The One Screen at the centre
of the marketplace does not change on a calendar — it grows.

---

## 5. Music side (parallel to the visual cadence)

The marketplace **sells music first** and visuals second. The two
streams must land in the same week for a coherent release:

| Cadence | Action | Files | Pipeline |
|---------|--------|-------|----------|
| Daily (auto) | Suno brief for the day's mood | `daily/<date>-music.md` | `lib/daily-pipeline.js` (one-shot) → paste into Suno UI by hand |
| Weekly | Generate one cover-audio pair (audio + cover) | `assets/marketplace/covers/<mood>/cover.jpg` + indexed audio in `audio-inbox/` | `npm run index-songs` produces `data/songs/catalog.json` → Twin OS Songs panel surfaces it |
| Monthly | Jazz-solos corpus refresh | `data/songs/catalog-jazz-solos.json` | `npm run index-jazz-solos`; checks every manifest row against disk |
| Per track | Cover layout in layout, not in prompt | `assets/marketplace/covers/<slug>/cover.jpg` | `lib/flux2-renderer/lettering.py` handles typesetting; sleeves set in the layout |

### Rule: a cover that must read correctly gets its lettering in the layout, **not** in the prompt.

Diffusion models paint letter-shaped marks and reliably misspell every
glyph they emit. `lib/flux2-renderer/lettering.py` is the established
pattern: render a clean plate, then set the type on top.

---

## 6. Editorial bar (what good actually reads like)

The strongest packs share three traits. New packs should match them.

1. **The prose paragraph at the top is not throat-clearing.** It
   names the load-bearing visual contract ("film grain is load-bearing"
   is the strongest sentence in the corpus), gives one concrete
   instruction, and stops. No "this pack contains…" preambles.

2. **Every bullet is a sentence a viewer could not have written
   themselves.** A test: if the bullet reads like a stock-image
   caption, rewrite. "Film grain, warm, nostalgic" is a vibe-name;
   "the pillow still holding the shape of someone's head" is the
   image.

3. **The pack speaks one language.** Morning-haunt speaks kodachrome.
   Brutalist architecture speaks monochrome grid. Sunset-water-burst
   speaks dusk-through-water. Two languages in one pack is the
   corpus's most common failure mode — a shooter who can't decide
   between "dusk" and "noon" will land on neither.

---

## 7. Guardrails (what we never do)

These are observations from the working corpus. Each is enforced by
one tool:

| Guardrail | Enforcement |
|-----------|-------------|
| No baked-in text in any rendered still | `lib/skin-tokens.js` + every MJ submission reviewed as a thumbnail before selection |
| No emoji or unicode decorative characters in prompts | prompt-author convention |
| No empty subject ("an image of", "lonely figure") | `lib/mj-submitter.js` excerpt-matcher surfaces these |
| No duplicate prompts inside one pack | `lib/mj-prompt-generator.test.js` |
| No `--ar` mismatch (`1:1` mid-pack, `16:9` elsewhere) | convention + reader’s eye |
| Cookie + auth on the live submissions only, never on tests | `e2e/mj-dashboard.spec.mjs` filters the CDN challenge |
| Every shipped card has alt text that describes the image, not the title | `pages/marketplace.html`'s alt= contract |

---

## 8. Distribution

A marketplace card is only finished when three things have happened:

1. **It's on the page.** `pages/marketplace.html` updated with the new
   `<figure>` or `<div class="story">` (and section counter increased).
2. **It's known to the watcher fleet.** The corresponding prompt
   pack or audio file sits in `prompts-inbox/` / `audio-inbox/`
   long enough for one full ping cycle (~2s).
3. **It's queued for one distribution push.** A reel pull
   (`bin/reel-watcher.sh` → `reel-inbox/`) and a single share.

The fastest cadence that respects all three is one pack per day. The
*authored* cadence above is one pack per *weekday* at most; the rest
of the time is consolidation.

---

## 9. The untouched surfaces

These belong to a later sprint:

- **A/B testing marketplace variants** (`?v=1|2|3`). The page is a
  variant-aware story; the next step is per-card variant matrix.
- **Sound-matching by mood class.** The music catalog right now
  carries ID3/WAV metadata but no per-track mood labelling; pairing
  a Still frame with audio that shares its mood is the obvious next
  step.
- **Calendar export of the mood journey.** Subscribe to the 12-mood
  cycle as an `.ics` so a future Twin OS subscriber sees the next
  mood a day ahead.
- **Letterpress covers.** Some pack requests letterform plates that
  hold under print at 1200 dpi — a future sprint for
  `lettering.py` plus a print-profile renderer.

---

## 10. How to use this schedule

- The 12-week table (§4) is a default tempo. The marketplace can
  absorb up to two packs per day if the watcher fleet is current;
  below one pack per week, the live currency starts to drift.
- The per-pack template (§3) is the floor. New packs that violate it
  should be re-drafted, not accepted.
- The musical cadence (§5) is what makes the cards *feel* like a
  release rather than a slide. Skipping the music half is the most
  common reason a marketplace look stalls in "reading as design".
- The guardrails (§7) belong to the corpus. A pack that violates
  them makes the next three packs look unfinished.
