# Loopable Video Segmenter (audio-aware) — local port

> Status: **shipped** (sprint 0.21) · Origin: `github.com/kajica2/loopable-video-segmenter`

Port of the author's Gradio app into the digital-twin as a uv-managed
local package: same segmentation logic (`core.py`, no gradio), a gradio
UI (`ui.py` → `127.0.0.1:7861`), and a headless CLI (`lvs-segment`).

Splits a long MP4 into **N loopable clips** whose boundaries land on
musical beats detected by **librosa**. Each segment plays forward then
mirrors back (`time_mirror`) — dropped into a video sequencer or a
social-media loop slot it cycles without a visible seam. Falls back to
equal-duration slices when the video has no usable audio or too few
beats, so it always produces output.

---

## Install

```bash
# ffmpeg is required by MoviePy for encode/decode
brew install ffmpeg            # if not already installed

npm run lvs:setup              # uv sync --project lib/loopable-video-segmenter
npm run lvs:check              # imports + deps + ffmpeg presence (no model downloads)
```

Resolution as of sprint 0.21 (uv lock committed):

| Package   | Version | Why                                                        |
| --------- | ------- | ---------------------------------------------------------- |
| gradio    | 5.50.0  | 5.x pinned (`~=5.0`), 4.x-era APIs deliberately not used   |
| moviepy   | 1.0.3   | the code uses the 1.x API — `moviepy.editor`, `subclip`, `vfx.time_mirror` |
| librosa   | 0.11.0  | beat tracking                                              |
| numpy     | 1.26.4  | pinned `<2` — moviepy 1.0.3 does not support numpy 2       |
| soundfile | 0.14.0  | audio IO via librosa                                       |

## UI

```bash
npm run lvs:ui
# gradio app on http://127.0.0.1:7861
```

Port note: the UI deliberately binds **7861**, not 7860 — the CLIP
Interrogator already owns `127.0.0.1:7860` and the twin runs both.

Controls (faithful to upstream): upload MP4 → `Number of segments`
slider (1–20, default 4) → "Make each segment loopable" checkbox
(default on) → **Create segments** → ZIP download + status line.

## CLI

```bash
npm run lvs:segment -- video.mp4 --segments 4
npm run lvs:segment -- video.mp4 --segments 8 --no-loopable --json
npm run lvs:segment -- video.mp4 --segments 2 --out /path/to/out.zip
```

| Flag            | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `--segments N`  | number of clips (1–20, default 4)                                  |
| `--no-loopable` | plain cuts; skip the forward+reverse mirror build                  |
| `--out PATH`    | destination zip path or directory (default: a temp dir, printed)   |
| `--json`        | machine-readable output: `{status, message, zip, segments, loopable}` |

Exit codes: `0` ok, `2` bad input (missing file, invalid count),
`3` runtime failure (ffmpeg/codec/render error).

`--json` output is clean — the library's banner prints go to stderr —
so it parses with `python3 -m json.tool` directly.

## How the segmentation works

1. **Extract** audio to a temp WAV (22.05 kHz mono) via MoviePy.
2. **Detect** beats with `librosa.beat.beat_track`; keep beat times
   inside the video duration.
3. **Divide** the beat list into N contiguous groups → N `(start, end)`
   windows that begin and end on downbeats (`segment_by_beats` uses
   `np.linspace` indices into the beat array).
4. **Build** each clip: `subclip(start, end)` then
   `concatenate([sub, sub.fx(vfx.time_mirror)])`, encoded libx264 + aac.
5. **Zip** the segments and hand the archive back (UI file widget or
   CLI `--out`).

Status message reports which path actually ran — **beat detection** or
**equal-time fallback** — instead of upstream's always-claim (small
honesty improvement over the original UI text).

## Package layout

```
lib/loopable-video-segmenter/
├── pyproject.toml                 # hatchling, src layout, script: lvs-segment
├── README.md
├── uv.lock                        # committed
├── .venv/                         # gitignored (uv-managed)
└── src/loopable_video_segmenter/
    ├── __init__.py                # version
    ├── core.py                    # segmentation logic — NO gradio import
    ├── cli.py                     # lvs-segment (segment / check verbs)
    └── ui.py                      # gradio Blocks (127.0.0.1:7861)
```

`core.py` is a faithful port of the author's `app.py` with one
structural addition: `compute_segments()` is split out so CLI and UI
share the same boundary-detection pipeline, and the status message
reports which path was actually used.

## npm scripts

| Script          | Command                                                          |
| --------------- | ---------------------------------------------------------------- |
| `lvs:setup`     | `uv sync --project lib/loopable-video-segmenter`                 |
| `lvs:ui`        | `uv run --project lib/loopable-video-segmenter python -m loopable_video_segmenter.ui` |
| `lvs:segment`   | `uv run --project lib/loopable-video-segmenter lvs-segment segment` |
| `lvs:check`     | `uv run --project lib/loopable-video-segmenter lvs-segment check --self-check` |
| `e2e:lvs`       | Puppeteer contract spec (no Python deps)                         |

The `lvs:segment` script includes the `segment` verb so passthrough
args are ergonomic: `npm run lvs:segment -- video.mp4 --segments 4`.

## E2E

`e2e/loopable-video-segmenter.spec.mjs` is a static-contract Puppeteer
spec: hero, theme toggle + reload persistence, how-to-run contains
`npm run lvs:ui`, params table rows, how-it-works steps, notes
callouts, attribution links, Twin OS `data-tool-lvs` card, every
internal link resolves, **0 console errors** on both pages, light +
dark screenshots. Runs from the repo root

```bash
python3 -m http.server 5180 --directory .     # in one terminal
npm run e2e:lvs                                # in another
```

## Verified end-to-end (sprint 0.21)

- `uv sync` clean: numpy 1.26.4 / moviepy 1.0.3 / gradio 5.50.0 /
  librosa 0.11.0 / soundfile 0.14.0.
- `lvs:check` green — imports + deps + ffmpeg binary found.
- CLI smoke against generated fixtures:
  - click-track MP4 → `"using beat detection"`, ZIP with 2 real MP4s
    (ffprobe-verified durations 1.0s / 2.0s — mirror doubling correct);
  - silent MP4 → `"using equal-time fallback"`;
  - `--no-loopable` → plain cuts (`loopable: false`);
  - missing file → exit `2`.
- UI launch: binds `127.0.0.1:7861`, `GET / → 200`, config carries
  `api_name: ['create-segments']`, 1 markdown / 1 video / 1 slider.

## Attribution

Port of `kajica2/loopable-video-segmenter` (MIT, © 2026 Kai Djuric /
kajica2). Stack: Gradio, MoviePy, librosa, soundfile, numpy, ffmpeg.