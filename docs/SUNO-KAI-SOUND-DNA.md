# The KAI sound DNA — Nordic Modern Jazz Big Band

The house's signature style: Scandinavian contemporary orchestral jazz,
restrained brass writing, spacious harmonies, asymmetric rhythmic
phrasing, acoustic intimacy and natural ensemble dynamics.

The defining character is **a large ensemble playing with the intimacy
of a small jazz group**. Not big-band blasts — the music develops
through subtle tension, silence, shifting meters and carefully balanced
instrumental colors.

## Three fields, not one

| field | what it holds | length | server limit |
|---|---|---|---|
| `style` | the master style text | 856 | 1000 |
| `negativeTags` | the exclusions | 211 | 1000 |
| `prompt` (lyrics field) | the arrangement, as section tags | 626 | 5000 |

**The style and the exclusions are 1069 characters together — over the
1000-character tag limit.** So they go in separate fields, which is
what the house rule says to do on Pro/Premier anyway: move the
exclusions into *Exclude Styles* under Advanced Options.

## The style

```
Nordic contemporary modern jazz big band, 16-piece acoustic ensemble,
restrained muted trumpets, soft trombone voicings, breathy saxophone
section, lyrical low-register flugelhorn, intimate piano, resonant
upright bass, delicate ride cymbal and brushed snare. Alternating 4/4
and 7/8 phrases, medium tempo around 105 BPM, subtle polyrhythmic
displacement, sparse unresolved modal jazz harmony, suspended chords,
melancholic Scandinavian atmosphere. Minimalist orchestral writing,
slowly evolving motifs, understated brass counterpoint, conversational
improvisation, delicate ensemble swells, spacious pauses. Recorded live
to two-track in a natural concert hall, authentic room reflections,
audible breathing, loose human timing, unprocessed acoustic
instruments, wide dynamic range, warm analog texture. Instrumental
only, no vocals, no commercial polish.
```

## The exclusions

```
EDM, synth bass, cinematic trailer brass, aggressive swing, bebop
shredding, glossy studio production, quantized drums, exaggerated
crescendos, pop chord progressions, vocals, autotune, artificial
orchestration.
```

## The musical architecture

| element | direction |
|---|---|
| Tempo | 105 BPM, medium and fluid |
| Meter | Alternating 4/4 and 7/8 |
| Brass | Muted, understated, layered |
| Saxophones | Breath-driven counterpoint |
| Piano | Sparse quartal and suspended voicings |
| Bass | Acoustic, melodic, slightly behind the beat |
| Drums | Ride cymbal, brushes, delicate accents |
| Harmony | Modal, ambiguous, unresolved |
| Recording | Live-to-2-track, natural hall ambience |

## The arrangement — the architecture of silence

Six movements, written as square-bracketed section tags carrying the
clock time and the movement's title:

```
[Intro | 0:00-0:35 | The Empty Hall — Solo piano, upright bass harmonics, distant muted brass]
[Instrumental | 0:35-1:15 | Uneven Footsteps — Ride cymbal establishes pulse; alternating 4/4 and 7/8]
[Instrumental | 1:15-2:00 | Sixteen Breaths — Quiet brass harmonies, flugelhorn introduces the melody]
[Break | 2:00-2:45 | Fractured Conversation — Saxophone counterpoint, piano responses, bass improvisation]
[Crescendo | 2:45-3:30 | The Room Opens — Gradual ensemble crescendo, dense suspended harmony, no explosive climax]
[Outro | 3:30-4:00 | Unfinished Light — Instruments withdraw, solitary flugelhorn, natural room decay]
```

Note the shape: it opens with ONE instrument and ends with ONE
instrument. The ensemble swells in the middle and there is **no
explosive climax** — the crescendo section says so explicitly.

## The suggested settings

| | |
|---|---|
| Weirdness | 60% |
| Style influence | 80% |

## The house's own variation

> Keep the Nordic orchestral discipline, but make your low flugelhorn the
> emotional center. Let the orchestra respond to your breathing rather
> than forcing your phrases into a fixed arrangement. The 7/8 should
> feel like a natural hesitation, not a mathematical exercise.

**Nordic Chamber Big Band × Raw Kai Flugelhorn × Asymmetric Jazz
Minimalism** — 667 characters, and it ships as a second roll:

```
Nordic chamber big band, raw flugelhorn as the emotional center,
16-piece acoustic ensemble responding to the lead rather than a fixed
arrangement, alternating 4/4 and 7/8 with the 7/8 as a natural
hesitation rather than a mathematical exercise, muted brass, breathy
saxophone section, intimate piano, resonant upright bass, delicate ride
cymbal and brushed snare, sparse unresolved modal jazz harmony,
suspended chords, asymmetric jazz minimalism, spacious pauses, live to
two-track in a natural hall, audible breathing, loose human timing,
unprocessed acoustic instruments, wide dynamic range, warm analog
texture, instrumental only, no vocals, no commercial polish
```

## Running it

```bash
# the plan — nothing submitted
npm run suno:kai -- --workspace <wid> --source <clipId>

# with the house's variation as a second roll
npm run suno:kai -- --workspace <wid> --source <clipId> --with-variation

# submit
npm run suno:kai -- --workspace <wid> --source <clipId> --with-variation --apply

# print it
npm run suno:kai:list
```

Covers, because a plain generation is refused on this account (see
[`SUNO-METER-PROMPTS.md`](SUNO-METER-PROMPTS.md)).

## Files

| file | what it is |
|---|---|
| `lib/suno-kai-sound-dna.json` | the registry — style, exclusions, architecture, arrangement, settings, variation |
| `lib/suno-kai-dna.js` | the loader, the three fields, the arrangement as lyrics |
| `lib/suno-kai-dna.test.js` | 51 assertions |
| `lib/suno-kai-run.js` | the runner |

## Tests

```bash
npm run test:suno-kai-dna
```

The tests pin the limit arithmetic (the style and the exclusions do not
fit one field together, and do fit as two), the arrangement's shape and
contiguous clock times, the house rules the lyrics field obeys, every
one of the twelve exclusions, and the variation's own text.
