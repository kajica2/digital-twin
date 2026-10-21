# Coltrane / Woody Shaw Engraving Reference

> Domain reference for engraving jazz scores in the styles of John Coltrane
> (post-bop, modal, "sheets of sound") and Woody Shaw (hard-bop × modal,
> pentatonic, wide intervals, percussive articulation). Used by the twin
> agent fleet when generating parts, scores, or transcriptions.
>
> Last touched: 2026-09-09 · sprint 0.2.

---

## 1. Why this exists

Standard classical engraving rules do not apply to post-bop / modal / "new
thing" jazz. The music relies on harmonic density, rhythmic displacement,
and specific articulations that Finale/Sibelius/Dorico do not handle
well by default. This file encodes the conventions the twin should apply
when:

- transcribing a Coltrane or Woody Shaw solo
- engraving an original chart "in the style of" Coltrane or Woody Shaw
- writing horn-section backgrounds behind a soloist playing that style

---

## 2. Score layout — full band

**Top → bottom staff order** for a 22-piece big band:

```
Woodwinds:
  Flute · Oboe · Clarinet (Bb) · Bassoon
  Alto Sax (Eb) · Tenor Sax (Bb) · Baritone Sax (Eb)

Brass:
  Horn in F
  Trumpet 1 (Bb) · Trumpet 2 (Bb) · Trumpet 3 (Bb)
  Trombone 1 · Trombone 2 · Bass Trombone · Euphonium · Tuba

Rhythm Section:
  Guitar · Piano · Bass · Drums
```

**Jazz-band subset** (small group, 11-piece):

```
Alto Sax 1 (Eb) · Alto Sax 2 (Eb)
Tenor Sax 1 (Bb) · Tenor Sax 2 (Bb) · Baritone Sax (Eb)
Trumpet 1–4 (Bb) · Trombone 1–4
Guitar · Piano · Bass · Drums
```

---

## 3. Part-preparation rules

### Individual parts

- **Page turns** — leave at least 2 bars rest near the turn. Plan the
  layout before engraving, not after.
- **Cue notes** — include important melodic cues during long rests
  (typically the lead trumpet or lead sax line).
- **Rehearsal marks** — boxed letters (A, B, C…) every 8–16 bars.
- **Multi-measure rests** — show the count above a horizontal line with
  diagonal slashes (e.g. `8 ╱╱╱╱`). Break at rehearsal marks and key
  changes.
- **Staff size** — 8.5–10 mm staff size for parts (larger than the
  conductor's score).

### Conductor score

- **Page size** — 11×17" (tabloid).
- **Staff size** — 4–7 mm.
- **System breaks** — every 4–8 bars depending on density.
- **Instrument names** — full name on first page, abbreviated after.
- **Bar numbers** — every 5–10 bars, or at every rehearsal mark.

---

## 4. Section-specific engraving

### Brass

- **Harmony parts** — slash notation + chord symbol when the section is
  improvising. Write out specific voicings only when the passage is
  composed and harmonically precise.
- **Articulation consistency** — every player in a section must have
  identical articulations on shared passages. Drift between players
  breaks the section sound.
- **Dynamic balance** — dynamics are marked **individually per part**,
  not globally for the section.
- **Lead-trumpet cues** — write them in the lower brass parts as small
  notes during their long rests.

### Saxophone section

- **Section soli** — all parts use the **same articulations, slurs, and
  phrasing**. Write it once, copy verbatim to every part, then verify.
- **Breath marks** — essential on long passages. Don't omit.
- **Sax-specific techniques** — mark altissimo notes with fingerings
  only when extreme (above F#6 for alto, F#6 for tenor).

### Rhythm section

- **Piano / Guitar** — chord symbols + slash notation as the default.
  Write specific voicings only when the harmonic moment is composed
  (e.g., an intro or interlude). Hits use rhythmic notation (slashes
  with stems).
- **Bass** — write the bass line on the head. For solos, let them walk
  — chord symbols + a text marking ("Walking", "Two-feel"). For
  ostinato sections, write 2 bars then `simile` / `Repeat figure`.
- **Drums** — slash notation (time) with section figures above. For
  modern post-bop feels, use **groove text** ("Elvin feel",
  "polyrhythmic time", "broken swing", "Afro-Cuban 6/8") rather than
  trying to notate every cymbal pattern. Write specific ensemble hits
  or fills only where they lock with a horn figure.

---

## 5. Coltrane-style saxophone notation

### Articulation & phrasing

- **The "Trane" slur** — articulate the first note of a group, slur the
  rest, even across the beat. Be mathematically exact with slur
  placement; a missing slur changes the phrasing entirely.
- **Ghost notes** — parenthesized notehead: `(x)` or `( )`. Critical for
  bop / post-bop lines.
- **Sheets of sound** — do NOT beam strictly to the quarter note. Beam
  across the barline or group in irregular phrases (5, 7, 9) so the
  page reads as a continuous stream rather than a metric grid.

### Extended techniques

- **Altissimo** — write the desired pitch with ledger lines. Do not use
  8va / 15ma — saxophonists need the actual pitch to interpret the
  tension. Fingerings go as tiny diagrams or text notes above the
  staff only when extreme.
- **Multiphonics** — diamond notehead for the fingering, sounding
  resultant pitches in parentheses above (or vice-versa). Always
  include a performance note in the part explaining the technique.
- **Overblowing / growl** — text marking `overblow` or `growl` above the
  staff. For the German convention, `Knarren`.

---

## 6. Woody Shaw-style trumpet notation

### Intervallic readability

- **No 8va / 8vb** — Shaw's lines leap 4ths, 5ths, 6ths, octaves. The
  trumpet player must see the contour to gauge embouchure and lip
  tension. Ledger lines are preferred over octave transposition.
- **Lip slurs vs. articulated leaps** — when a wide interval is a
  smooth lip slur, the slur marking is **mandatory**. When the leap is
  meant to pop (percussive re-tongue), mark the second note with
  staccato or tenuto + accent.

### The "Shaw" articulations

- **The popped high note** — when a line leaps up a 5th, 6th, or 7th,
  notate the top note with **marcato ( ^ ) + tenuto ( – )**. Hit hard,
  with length and air, not a sharp jab.
- **The Shaw grace note** — quick, biting, usually a half-step below or
  above the target. Notate as **acciaccatura** (small note, slashed
  stem), NOT appoggiatura.
- **Scoops** — quick upward bend into a note. Notate as a small
  ascending grace note or a curved upward bend line. Never a generic
  glissando.
- **Half-valving** — slide between notes via half-valve technique. Use
  a diagonal line connecting the two notes + text `half-valve` or
  `fall`.
- **Growls / flutters** — `Flz.` (flatterzunge) for rolled tongue;
  `Growl` for throat growl. Shaw often combined these with Harmon mute.

### Harmon mute specifics

- `Stem in` — soloistic, buzzing. Pair with `+` (closed) and `o` (open)
  for the wah-wah effect.
- `Stem out` — classic, broader. Same `+` / `o` notation.
- **Always** leave 2–4 bars of rest before a mute change. The mute
  change itself is not a "free" event; it needs planning room.

---

## 7. Full-band implications of these styles

### Rhythm section

- **Piano (modal / harmonic)** — chord symbols (e.g., `E7sus4`,
  `F#7alt`). For the Tyner-style quartal sound, write voicings as
  stacks of 4ths in standard notation, but only in intro / interlude /
  composed moments. Open comping text during solos.
- **Bass** — write the head's bass line. For solos, chord symbols +
  `Walking`. For vamp sections, write 2 bars then `Ostinato` or
  `simile`.
- **Drums** — slashes + groove text. Do not try to notate Elvin
  Jones–style polyrhythms; write `polyrhythmic time` or
  `Elvin feel`. Notate specific ensemble hits above the staff.

### Horns (backgrounds behind a soloist)

- **Stabs** — short, accented, often `staccato` + `marcato`.
- **Pads** — long tones. In modal sections these are often cluster
  chords or perfect 4ths/5ths. Mark with `niente` (fade from nothing)
  or `fp` to build tension.

### Soli writing (the sax soli)

- Stack the saxes (Alto / Tenor / Bari) in tight clusters or 4ths.
- **Beam identically across the whole section** so it reads as one
  massive instrument, not four separate parts.

---

## 8. Rhythmic feel notation

- **Straight 8ths over swing ride** — explicitly mark the feel at the
  top of the chart. Mark switches in feel: `Swing (ride cymbal)`,
  `Even 8ths`, `Broken swing`.
- **Double-time feel** — DO NOT change the time signature. Write
  `Double Time Feel` or `2x` above the section.
- **Metric modulation** — visual equation above the staff:
  `(Old note value) = (New note value)`. Example: `Half note = Dotted
  Quarter note`.
- **Laying back** — text `Lay back` or `Behind the beat`. More useful
  than micro-shifting MIDI playback.

---

## 9. Summary checklist

### For the trumpet part

- [ ] Wide interval slurs marked exactly (mandatory on lip slurs)
- [ ] Popped high notes: marcato + tenuto
- [ ] Shaw grace notes: acciaccatura (slashed stem)
- [ ] No 8va / 8vb anywhere
- [ ] Harmon mute text and + / o markings; 2–4 bars rest before changes
- [ ] Effects text (Flz, Growl, Half-valve, Scoop) where applicable

### For the saxophone parts

- [ ] Slurs precise across the beat
- [ ] Ghost notes parenthesized
- [ ] Sheets-of-sound passages beamed across the barline
- [ ] Altissimo with ledger lines, not 8va
- [ ] Breath marks on long passages
- [ ] Section soli: identical articulation + phrasing across all parts

### For the rhythm section

- [ ] Piano / Guitar: chord symbols + slashes; voicings out only when
      composed
- [ ] Bass: head line written out; walking text for solos; ostinato
      simile for vamps
- [ ] Drums: slashes + groove text; specific ensemble hits above
      staff; no micro-notated polyrhythm

### For the score

- [ ] Bar numbers every 5–10 bars, at rehearsal marks
- [ ] Rehearsal marks boxed, at section breaks / key changes / tempo
      changes / solos / D.S. al Coda points
- [ ] Instrument names full first, abbreviated after
- [ ] Page turns in parts: 2-bar rest before the turn

---

## 10. Cross-references

- `lib/songs-indexer.js` — extracts ID3 + WAV metadata for the catalog
  the twin surfaces in the Songs panel
- `docs/COMPONENT-CATALOGUE.md` — what each Web Component does
- `docs/DESIGN-RATIONALE.md` — why the PWA looks the way it does
- `AGENTS.md` — sprint log + repo conventions