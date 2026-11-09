# The Descriptions — video and music

`lib/descriptions.js` holds the copy for the videos and the music, rendered
at three lengths from one set of facts.

A YouTube description is 800 characters of room. A music platform's track
page shows about 300. A streaming bio is 160. Writing those three
separately means they drift, and a listener who reads one and then sees
another finds a different song. So: one set of facts per work, rendered at
three lengths.

```bash
npm run descriptions            # print every description
npm run descriptions -- --json  # machine-readable
npm run test:descriptions       # 130 checks
```

## The three lengths

| function | for | length |
|---|---|---|
| `pitch(work)` | a playlist row, a bio | one line |
| `musicDescription(work)` | a track page | ~300 characters |
| `longDescription(work)` | a video, or a "more" toggle | ~1,200 characters |
| `videoDescription(work)` | a YouTube video — the long form plus hashtags | ~1,400 characters |
| `cutDescription(work, cut)` | one cut of the film series | ~900 characters |

## Every number is measured

The copy states numbers, so the numbers are recorded in a `facts` block and
the test checks that **every number in the prose is a number in the
facts**. A figure typed by hand into a sentence is a figure nothing
verifies.

Measured off the actual files:

| | Geometric Shadow Box | Find Your Flow |
|---|---|---|
| length | 159.2 s | 196.6 s |
| tempo | 117 BPM | 110 BPM |
| spectral centroid | 219 Hz | 265 Hz |
| energy below 250 Hz | 94% | 96% |
| dynamic range (10th → 95th pct) | **40.3 dB** | **16.9 dB** |

That last row is the whole difference between the two records, and it is
why they get different descriptions. The Shadow Box starts in a room with
something happening behind you and about two minutes in the floor gives way
— 40.3 dB is a huge gap between quiet and loud. Find Your Flow holds a
level and walks; 16.9 dB is a record that never builds to a reveal.

The video's own audio was checked against the master: correlation 0.9999,
difference −48.9 dBFS (codec noise only). The film carries the track
unmodified, so the film's description can describe the music.

The film's third cut carries one more measurement: the picture travels
**1.79** in CLIP space over the cut where the lyric order would have
travelled **2.69**. The evolution is smoother because it travels less.

## The three cuts

The three nov8 films are three different films of the same song, so each
gets its own title and its own paragraph:

| cut | file | what makes it different |
|---|---|---|
| v1 | `nov8-v1-curtain.mp4` | the seven lines are spread over the WHOLE picture — a spectrum curtain, not a strip at the bottom — and coloured by the band they draw |
| v2 | `nov8-v2-lines.mp4` | the SECOND strongest picture for each line of the lyric: looser, quieter, never landing on the obvious image |
| v3 | `nov8-v3-lines.mp4` | the pictures are ordered by how close they LOOK to each other, not by the words — the character's evolution |

The copy leads with each cut's own difference and says which cut of three
it is. It does not describe the other two — a viewer of the second film
does not need to know what the third one is.

## The rules the test enforces

1. **No duplicate tag.** A tag typed twice is a bug in the list.
2. **No duplicate sentence.** The CLIP measurement appeared twice in the
   third cut before the test caught it.
3. **No measurement outside its own cut.** The first cut does not claim the
   third cut's numbers.
4. **No engagement bait.** "viral", "you won't believe", "part 1 of 999",
   "#fyp" — the audience reads it as spam and the algorithm buries it.
5. **The process is named.** A creative teenager is here for HOW it was
   made: Midjourney for the frames, a Python director that measured every
   frame for softness and near-duplication before selecting, Pillow for the
   waveform overlay, ffmpeg for the composite.
6. **Every work credits the label.**
7. **Every number is a recorded fact** (see above).

## What it does NOT do

- **No scheduling.** This is the copy, not the publisher.
- **No per-platform variants** beyond the three lengths. Instagram and TikTok
  want different copy again, and a fourth length is a fourth set of facts
  to keep true.
- **No AI-written descriptions.** Every sentence here was written against
  a measurement. The one thing this file will not do is describe a record
  it has not measured.
