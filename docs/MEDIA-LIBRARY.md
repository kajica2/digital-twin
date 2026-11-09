# The Media Library — a shelf of the clips the twin owns

`lib/story/media.py` is where the twin's **video** lives before it becomes a
music video. The director cuts *frames* into a film; this is the shelf the
frames come from.

A clip is ingested once, probed once, and recorded by content hash. Drop the
same file twice and it is one file. Pull the frames out of a clip and the
existing director cuts them exactly as it cuts Midjourney stills.

```bash
# 1. put clips on the shelf
npm run story:media:ingest -- ~/Movies/*.mp4

# 2. what is on it
npm run story:media:list

# 3. frames for the director
npm run story:media -- extract <clip> --out /tmp/frames --fps 0.5

# 4. cut them
python3 lib/story/director.py --frames /tmp/frames --lines assets/music-video/x.lines.tsv \
  --track song.mp3 --cutlist /tmp/cut.json
node bin/cut-list-to-mp4.mjs /tmp/cut.json --out /tmp/film.mp4
```

## The shelf

```
lib/story/media/
├── clips/          the video
└── index.jsonl     one JSON line per clip
```

Both are **local state** and are gitignored — the clips are the author's own
video, and the index describes files that only exist on this machine. The
library's *code* is tracked; what it holds is not. Same rule as
`data/songs/catalog.json`.

A record:

```json
{
  "file": "kisna-soba-ep1-ep2-cut-20261109.mp4",
  "sha256": "63f0371539f4382834e4648ba3fe2d598481b97017e41af755cfd7725a5b6fe4",
  "bytes": 12995159,
  "source": "kisna-soba-ep1-ep2-cut.mp4",
  "ingested_at": "2026-11-09T15:36:33+00:00",
  "duration_s": 60.0,
  "width": 1920, "height": 1080, "fps": 30.0,
  "v_codec": "h264", "frames": 1800,
  "audio": null
}
```

## Three decisions worth knowing

**The index records the source's BASENAME, not its path.** An absolute path
names the author's filesystem, and the index travels — it is pasted, shared,
read by other tools. `--keep-abspath` puts the full path back for local
debugging. This is the same contract `lib/songs-indexer.js` already uses.

**`ffprobe`, not PyAV.** Probing a container does not need a 476 MB
virtualenv. The one that does — PyAV — stays where it earns its keep:
frame-accurate decode in `waveform.py`. `media.py` is pure stdlib plus
`ffprobe`, so it runs on the system Python with no `uv sync` at all.

**The index is keyed by the clip's name, not appended to.** Re-ingesting the
same name replaces its record. An index that grows a line per re-ingest is an
index nobody can read — and `--force` would grow it on every run.

## The verbs

| verb | what it does |
|---|---|
| `ingest FILE...` | add clips. `--move` moves instead of copying, `--force` re-ingests a known file, `--dry-run` says what would happen and does nothing |
| `list` | the shelf as a table. `--json` for machine-readable output |
| `extract CLIP` | pull frames out of a clip. `--fps`, `--start`, `--duration` window it |

`extract` accepts a path, an exact library name, or a stem — so
`kisna-soba` finds `kisna-soba-ep1-ep2-cut-20261109.mp4`. A stem that matches
several clips is an error, not a guess.

## Exit codes

| code | when |
|---|---|
| 0 | success |
| 2 | bad input — a missing file, an unreadable clip, an ambiguous clip name |
| 3 | a runtime failure — `ffprobe` missing, a write that failed |

## Tests

```bash
npm run test:media
```

Pure stdlib, no network, no model — 44 checks over the naming, the path
redaction, the ffprobe parsing and the index's round trip. It is wired into
`npm run test:all`.

## What it does NOT do

- **No watching.** Ingest is explicit. A file on the Desktop does not appear
  on the shelf until it is handed over.
- **No transcoding.** The shelf holds the files as they are; `extract` pulls
  frames at the source's own resolution.
- **No audio extraction.** A clip's sound is noted in the index (`audio` is
  `null` when the clip is silent) but never pulled out.
- **No search.** The shelf is small enough to read as a table. When it is
  not, `--json` plus `grep` does the job.
