# The Director — cutting frames into a music video

`lib/story/director.py` decides which of a pile of frames earn screen time
and which are cut, then plans the cut: the shot lengths, the camera move
per shot, the look per shot. `bin/cut-list-to-mp4.mjs` renders it.

The problem it solves: a hundred frames and a song is not a video. One
frame per line in file order is a slideshow. The director treats it as a
selection problem — measure everything, cut what is broken, cut what
belongs to nothing, and let each lyric line keep only the frames that
actually depict it.

## The run

```bash
# 1. the cut
python3 lib/story/director.py \
  --frames ~/Downloads/midjourney_session\ \(47\) \
  --lines assets/music-video/find-your-flow.lines.tsv \
  --track ~/Desktop/flow.mp3 \
  --per-line 3 --threshold 0.15 \
  --cutlist /tmp/flow-cut.json

# 2. the film
node bin/cut-list-to-mp4.mjs /tmp/flow-cut.json \
  --out mj-output/flow-music-video/flow-music-video.mp4
```

`npm run story:direct` and `npm run story:render` are the same two steps.

## What it decides, and how

**Measure** (`measure_frame`) — every frame is measured by ffmpeg, never
loaded into Python:

| measurement | how | what it catches |
|---|---|---|
| blur | `blurdetect` mean | a soft frame (≈3 on a sharp linocut still, ≈52 on a sigma-12 blur) |
| luma | `signalstats` YAVG | a black or blown-out frame |
| range | YMAX − YMIN | a flat frame — a white wall or a black hole |
| dhash | 9×8 grayscale difference hash | a near-duplicate of a frame already in the cut |

**Cut the broken** (`technical_reject`) — unreadable, too soft, too dark,
too bright, too flat. Each rejection carries the number that failed.

**Cut the duplicates** (`collapse_duplicates`) — the same picture twice.
The threshold is measured, not guessed: on the sixty-frame Breath Forgets
the Count set, byte-identical copies sit at dhash distance 0 and the
nearest two *distinct* frames sit at 6, so the threshold is 3. At 8 (the
first guess) real frames were being collapsed — two cells of one Midjourney
grid are different pictures.

**Match to the lyric** (`match`) — CLIP ranks every (frame, line) pair.
Each frame is ASSIGNED to the line it fits best, so no frame is used
twice and no line steals another line's picture. Each line keeps up to
`--per-line` frames, best score first. Everything else is cut:

- a frame whose best score is under `--threshold` — *below the threshold*
- a frame that lost to the frames already kept for its own line — *a
  runner-up*
- a frame no line claims — *no line claims it (best score N)*

**A line with no frame is a GAP, not a wrong picture.** The first version
of the matcher filled every line with its nearest neighbour, and the cut
came out looking finished while a coffee-cup lyric played over a man
sitting on the floor. A gap is reported with its reason instead.

**Plan the cut** — the shot length comes from the track: the shots are
spread across the song and each boundary is pulled onto the nearest beat,
so a cut lands ON the beat and the last shot ends with the song. The
camera move per shot cycles push / pull / pan and never repeats itself
twice in a row. The look per shot comes from `FX` in `lib/render/plan.mjs`;
the grade is one pass over the joined cut.

## Three versions, always

`--versions 3` (the default) makes three cuts of the same song, and
**they share no picture**:

- **version 1** takes each lyric line's best frame,
- **version 2** takes its second,
- **version 3** takes its third — and is then re-ordered into the
  **evolution of the character**,
- **version 3, the evolution** — the shots are re-ordered so the
  character moves through his states one small step at a time instead of
  following the song's word order. The order is a nearest-neighbour walk
  through the CLIP embedding space, and the claim is measured: the
  version's travel is printed next to the lyric order's.

Measured on *November 8 — Geometric Shadow Box*: the lyric order travels
**2.693** in CLIP space across the cut; the evolution travels **1.792**
— a third less, because the character never jumps.

Each version is its own cut list (`<name>.v1.json`, `.v2.json`,
`.v3.json`) and its own film:

```bash
python3 lib/story/director.py --frames <dir> --lines <song>.lines.tsv \
  --track <song>.wav --per-line 1 --versions 3 --cutlist /tmp/song.json
node bin/cut-list-to-mp4.mjs /tmp/song.v1.json --out v1.mp4
node bin/cut-list-to-mp4.mjs /tmp/song.v2.json --out v2.mp4
node bin/cut-list-to-mp4.mjs /tmp/song.v3.json --out v3.mp4
```

## The lines file

A plain `.txt` is one lyric line per line. A `.tsv` is
`display <tab> query` — the display text is what the report prints, and
the query is what CLIP is asked. The split matters: a lyric line
("Hinges swing, current finds the tongue mid-sentence") is not a caption,
and CLIP will not match it to a picture on its own. The query is the
scene in words.

```
display	query
Hinges swing, current finds the tongue mid-sentence	a man in profile at a doorway, mouth open mid-sentence, a door swinging behind him, loose pages lifting in the draught
```

## What CLIP is and is not

CLIP ranks; it does not measure. It is good at "is this a room with a
door" and bad at "is this the room with the door that opened by itself".
The numbers in the report are similarities, not verdicts.

Measured on the Breath Forgets the Count set, where prompt-NN generated
line NN: CLIP's best cell for each of the twelve lines came from the
right prompt **12/12**, and the director's own assignment also **12/12**.
That is a real result on real frames, and it is still a ranking — which
is why every decision is reported with its score and its reason, and why
the cut list is a plain JSON file you can read and overrule.

## The cut list

`write_cutlist` writes the contract between the two halves:

```jsonc
{
  "images":    ["a.png", "b.png"],          // in cut order
  "durations": [6.9, 7.1],                  // seconds per shot
  "motions":  ["zoom-in", "zoom-out"],      // per shot
  "fx":       ["grain", "grain"],           // per shot
  "grade":    "vignette",                   // once, over the joined cut
  "transition": "none",                     // none | crossfade
  "track":    "song.mp3",
  "shots":    [{"line": "…", "image": "…", "duration": 6.9, "score": 0.39}]
}
```

`bin/cut-list-to-mp4.mjs` reads it and hands it to the shared executor —
`lib/render/server.mjs` — which builds the ffmpeg graph with
`lib/render/plan.mjs`, the same plan the browser set uses. The director
owns no filter graph of its own, so a clip rendered from a cut list and a
clip rendered from the page are the same video.

## Narration — the story that rides with the cut

When stills become a video, the cut list says what to show. The narration
says what to say over it: one spoken beat per shot, timed to the shot's
place on the **rendered** timeline, written in the house voice (short
sentences; silence is a note — see `docs/PERSONALITY-TONE-GUIDE.md`).

`write_cutlist` writes the companion files by default, beside the cut
list:

| file | what it is |
|---|---|
| `<cut>.narration.json` | timed segments: start/end, lyric, picture query, spoken line, word budget |
| `<cut>.narration.md` | a readable script a narrator can hold, plus the full arc |

The lyric is the voice; the scene query is the ground. A short lyric may
pick up a grounding clause ("We see …"); a long one is trimmed to the
word budget so it can be read inside the shot. Same cut → same story —
no model call.

**Timestamps follow the renderer.** For a hard cut that is just the
running sum of durations. For a crossfade each join overlaps by the
dissolve, so shot `i` starts at `sum(d[0..i-1]) − i × fade` — the same
offset `lib/render/plan.mjs` feeds to `xfade`. The word budget still
uses the full shot length (you speak across the dissolve); only the
start/end markers move. `durationSec` is the film length
(`sum(durations) − (n−1) × fade`), not the sum of the shot lengths.

```bash
# skip narration when writing the cut
python3 lib/story/director.py --frames <dir> --lines <song>.lines.tsv \
  --track <song>.wav --cutlist /tmp/song.json --no-narration

# write (or rewrite) narration for an existing cut list
python3 lib/story/director.py --narrate-cutlist /tmp/song.v1.json
```

`bin/cut-list-to-mp4.mjs` also ensures the narration siblings exist before
it renders, so a cut list that arrived without them still gets a story.
Pass `--no-narration` to leave them alone. Narration status lines go to
**stderr**, so `--json` keeps stdout as one parseable object.

## Tests

```bash
python3 lib/story/director.test.py     # no model, no network
```

The decisions are the product, so they are pinned: a frame belongs to one
line, a line with no frame is a gap, a runner-up is reported once and not
twice, a duplicate group collapses to one frame, no two shots repeat a
camera move, and the narration budgets words to the shot length and
writes deterministic siblings beside the cut list.

## Limits

- **CLIP needs the clip-interrogator venv.** Without it the director
  still measures, rejects and collapses duplicates, but the lyric match is
  skipped and the frames are taken in file order.
- **One image per line per cell.** The Midjourney 4-up gives four takes
  per beat; the director keeps the best-scoring of them (and the others
  are cut) unless `--per-line` says otherwise. With `--versions 3` each
  version takes a different rank of each line, so the three films share
  no picture — but a line with fewer frames than the version number runs
  short and reports the gap.
- **The beat grid is an energy envelope.** It finds the pulse of the
  track; it does not know the downbeat. A track with a half-time feel
  will be cut on the eighth notes.
