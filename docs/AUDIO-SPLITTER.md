# audio-splitter — detect the tracks in a long recording and cut them apart

A "Traditional Music of Western Serbia" album arrives as **one** mp3: 57 minutes,
no tags, and no silence you can find with `ffmpeg silencedetect` — because the
room tone sits at about **-44 dBFS**, not at digital silence. The boundaries are
still there; they are just quiet.

`lib/audio-splitter/` finds them from the energy profile and cuts the file into
its pieces.

- **Package**: `lib/audio-splitter/` (uv-managed, numpy only)
- **CLI**: `npm run audio:split -- <file>`
- **Setup**: `npm run audio:setup` · **Tests**: `npm run test:audio-splitter`
  (14 assertions) · `npm run test:songs-indexer` (5)

## The method

1. **Decode** the file to mono 22050 Hz (ffmpeg → raw float32).
2. **Frame** it: 1024 samples = 46.4 ms per frame.
3. **RMS per frame**, in dBFS.
4. **The noise floor** — the 10th percentile of the frame dB. Robust: a tenth of
   an album is quiet enough to set the floor.
5. **Quiet runs** — maximal runs of frames within `--floor-db` (default 6 dB) of
   that floor, at least 0.8 s long.
6. **Track gaps** — the quiet runs at least `--min-gap` seconds long (default
   3.5 s). The boundary is placed in the **middle** of the gap, so both pieces
   keep the same silence.
7. **Cut** each segment with ffmpeg, re-encoded (never stream-copied: a copy
   that starts mid-frame clicks), tagged with its track number, and listed in
   `manifest.json`.

## Why the threshold works on this album

Measured on the Western Serbia recording (3443.74 s, 29 pieces):

- the noise floor is **-43.8 dBFS**, so a quiet frame is anything under -37.8 dB;
- the album's **splice gaps are a distinct population**: 3.9-4.6 s (28 of them);
- the **within-piece pauses** are 1.0-3.0 s.

3.5 s separates the two populations cleanly. `--min-gap` is the one knob to turn
if another recording wants a different cut — and `--dry-run` prints the detected
segments and the longest gaps before anything is written, so the threshold can
be judged from the shape rather than guessed.

## Two things that bite

**1. The source carries a cover picture, and ffmpeg will write the cover.**
The album mp3 has an attached **mjpeg** stream. Without an explicit audio map,
ffmpeg picks *that* stream and writes a **0.236 s** file — the cover's display
time. It only bites the **first** cut, because a later `-ss` has already left the
cover behind, so the other 28 files came out right. The fix is `-map 0:a:0 -vn`
on every cut.

**2. A cut that silently produced the wrong length is worse than a failed cut.**
So every file is probed after it is written and compared against the segment it
was asked for; a mismatch fails the run.

## Using it

```bash
npm run audio:setup                                    # uv sync (numpy)
npm run audio:split -- "album.mp3" --dry-run           # detect and report, cut nothing
npm run audio:split -- "album.mp3"                     # cut into album-split/
npm run audio:split -- "album.mp3" --out parts/ --format wav --min-gap 4.0
```

The cut files carry ID3 tags: the title is `<album> — <n>`, the album is the
source's name, and the track number is `n/total`.

## Feeding the Songs panel

The twin's song indexer takes the parts in one go:

```bash
node lib/songs-indexer.js --add "album-split"/*.mp3 --apply --yes
```

They land under the synthetic **manual** root in `data/songs/catalog.json`.

> The indexer's ID3 reader used to keep the NUL that terminates a text frame —
> `String.trim()` does not remove a NUL — so every tag ended in `"\0"` and the
> panel showed "Track 3/29". Fixed, and pinned by `lib/songs-indexer.test.js`.

## What this does NOT do

It splits a recording into its **pieces** (the tracks the album was spliced
from). It does **not** separate the instruments inside a piece — that needs a
source-separation model. Cadenza (see `docs/CADENZA.md`) is where a separation
plugin would be *hosted*; the splitting here is the album level.
