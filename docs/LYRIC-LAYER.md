# The Lyric Layer — the words, on the picture

`lib/story/lyrics.py` puts the lyric on the screen.

The director already knows which lyric line each shot carries — it matches
the words to the pictures with CLIP and writes them into the cut list. Until
now that knowledge stopped at the cut list: the words were an **input** to
CLIP, never an **output** to the screen. This is that output.

```bash
# the film (from the director, via the renderer)
node bin/cut-list-to-mp4.mjs cut.json --out film.mp4

# the words
npm run story:lyrics -- --cutlist cut.json --video film.mp4 --out film-lyrics.mp4
```

Each lyric line fades in over its own shot, holds, and fades out when the
shot gives way to the next.

## Why not `drawtext`

`drawtext` is the obvious way to put text in a video, and **it is not
available on this machine**: the ffmpeg on PATH is a Homebrew build without
libfreetype, so `ffmpeg -filters | grep drawtext` returns nothing.

```
$ ffmpeg -hide_banner -filters | grep -c drawtext
0
```

(A bundled ffmpeg elsewhere on the box *does* have it — but every tool in
this repo invokes the PATH ffmpeg, and a tool that only works when a
different binary happens to be first on PATH is a tool that breaks quietly.)

So the text is **drawn**, not typeset by ffmpeg: Pillow renders it to an
RGBA overlay, and the overlay is streamed into ffmpeg's `overlay` filter.
That is the same shape `lib/story/waveform.py` already uses for the
waveform lines — proven, and it needs no special ffmpeg build.

## The timing is the renderer's timing

The renderer **joins** the shots, and with a crossfade they overlap: the
second shot starts fading in before the first has finished. A lyric timed
as if the shots were back to back lands on the wrong picture.

The window is the shot's **dominant span** — from the moment it starts to
take over to the moment the next one does. With a crossfade that is the
midpoint of each dissolve, which is exactly where the picture crosses
half-and-half. The windows never overlap, so two lyrics are never on the
screen at once.

The arithmetic is the renderer's own: `lib/render/plan.mjs` computes the
join offset as `sum(segments before) - i * fade` and the film's total as
`sum(durations) - (n - 1) * fade`. Measured against the real renderer:

| case | renderer | the lyric layer |
|---|---|---|
| 4s + 4s, 1s dissolve | join at 3.000s, film 7.000s | 0.00 → 3.50, 3.50 → 7.00 |
| 4s + 2s, 5s dissolve asked | clamped to 1s, film 5.000s | 0.00 → 3.50, 3.50 → 5.00 |
| 4s + 4s + 4s, 1s dissolve | film 10.000s | 0.00 → 3.50, 3.50 → 6.50, 6.50 → 10.00 |

## The type

| | |
|---|---|
| face | Georgia — the first of six system faces that carry the Serbian Cyrillic and the Latin Extended-A the lyrics are written in |
| colour | the house cream `#f4efe2` |
| position | the lower third (`--bottom 0.10` of the height) |
| size | 4.5% of the height (`--size 0.045`) |
| wrap | 78% of the width (`--max-width 0.78`) |
| shadow | a four-way dark halo, so the text is legible on ANY picture |

The shadow is not decoration. The picture behind a lyric can be black or it
can be cream, and cream text on a cream picture is invisible — the same
lesson the waveform lines learned when they were cream and vanished into a
cream-and-pink still.

A line longer than the wrap width is **wrapped**, and a single word longer
than the line is broken by character — a lyric that runs off the edge of the
picture loses the END of the sentence, which is the part that lands.

## The flags

| flag | what it does |
|---|---|
| `--cutlist` | the cut list the director wrote (required) |
| `--video` | the film to put the words on (required) |
| `--out` | where the film with words goes (required) |
| `--size` | the type size, as a fraction of the height (default 0.045) |
| `--max-width` | the wrap width, as a fraction of the picture (default 0.78) |
| `--bottom` | the baseline, as a fraction up from the bottom (default 0.10) |
| `--fade-in` / `--fade-out` | the lyric's own fade, in seconds (default 0.4) |
| `--dry-run` | print the shot windows, run nothing |

## Exit codes

| code | when |
|---|---|
| 0 | success |
| 2 | bad input — an unreadable cut list, a cut list with no shots |
| 3 | a runtime failure — Pillow or ffmpeg missing, a write that failed |

## Tests

```bash
npm run test:lyrics
```

59 checks, pure stdlib, no network and no model: the window arithmetic
against the renderer's own numbers, the fade curve, the wrap, and **the
ffmpeg input order**.

That last one is not a formality. The first version of this tool had the
film as input 0 and the overlay as input 1, so the opaque film was painted
*on top of* the text: it wrote 180 frames, **exited 0**, and changed
**zero pixels**. The order is now a pure function (`build_ffmpeg_command`)
and is asserted — and the assertion was checked against a deliberately
broken build, where it fails.

## What it does NOT do

- **No word-by-word timing.** A line fades in with its shot, not with its
  syllables. Karaoke timing needs a forced aligner.
- **No styling per line.** One face, one colour, one position for the whole
  film.
- **No burn-in at render time.** The words are a separate pass over the
  finished film, so they can be re-laid without re-rendering the cut.
