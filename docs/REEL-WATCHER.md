# Reel Watcher — drop a video into reel-inbox/, get an IG-ready Reel package

> Sprint 0.17. Sibling of `docs/CHART-WATCHER.md` and
> `docs/SONGS-WATCHER.md`. Drop a video (`.mp4` / `.mov` / `.m4v`
> / `.mkv` / `.webm` / `.avi`) into `reel-inbox/`; the watcher
> re-encodes to 9:16 vertical H.264/AAC, picks a cover frame, and
> writes a `POST.md` with caption + hashtags derived from the
> sibling audio file's ID3 tags (or a static fallback).

## Why this exists

Instagram's Graph API does not allow third-party apps to publish
Reels as of 2026. This pipeline is the boring, defensible path:
**pre-publish only**. The watcher produces an upload-ready package;
you open the IG app and tap Upload. AGENTS.md §11 hygiene + the
"calm, not chatty" ethos both lean against using the unofficial
`instagrapi` library (real ban risk).

## What it does

`lib/reel-watcher.js` polls `reel-inbox/` every 2 seconds for new
video files. For each new file:

1. `ffprobe` the source (duration, dimensions, has-audio).
2. Look for a sibling audio file — **same basename**, `.mp3` /
   `.wav` / `.aif` / `.aiff` / `.m4a` / `.flac`. If found, read its
   ID3 / RIFF / metadata via `ffprobe`. Nothing else in the inbox
   is ever treated as a sibling: an audio file with a different
   basename is left strictly alone.
3. Build a caption from the audio tags (`Title — Artist (Album)
   [Genre] 🎺 Reel from the twin.`) + hashtag block. The hashtags
   follow the genre: a jazz genre (or no genre at all — a chart
   demo) gets the jazz block, anything else gets `#reel`,
   `#digitaltwin` and the genre's own words.
4. `ffmpeg` re-encode the source to 1080×1920 (9:16) H.264 high-
   profile, 30 fps, ~6 Mbps, with `force_original_aspect_ratio=
   decrease` + black-pad letterbox (no crop), audio fade in/out.
   AAC LC stereo 44.1 kHz @ 128 kbps. `+faststart` for IG mobile
   upload.
5. `ffmpeg` extract a single frame at the midpoint as the cover
   JPG (1080×1920 mjpeg).
6. Write `<basename>_POST.md` with the caption, file list, source
   metadata, and the next-step instructions.
7. Move the dropped video to `reel-inbox/processed/` **and** move
   the consumed sibling audio out of the inbox too, parked under
   `<basename>_audio<audioExt>`.

### The inbox contract

The inbox is a queue, and a queue only works if it drains.

| Situation | Video | Sibling audio | Unrelated files |
|-----------|-------|---------------|-----------------|
| Successful run | moved to `processed/<base>_source<videoExt>` | moved to `processed/<base>_audio<audioExt>` | untouched |
| Failed run (ffmpeg/ffprobe error) | stays in the inbox | stays in the inbox | untouched |
| No same-basename audio present | moved to `processed/<base>_source<videoExt>` | — | untouched |

- **A failed run leaves the inbox exactly as it found it.** Both
  moves happen only *after* ffmpeg + ffprobe succeed, so a file the
  watcher could not decode is still there — with its audio — for the
  next attempt or for manual inspection.
- **Only the sibling that was actually consumed may be moved.** A
  file with a different basename is never paired, never read for
  tags, and never moved.
- **Why the sibling must leave the inbox.** A leftover audio file
  sits there indefinitely, and a later drop with the same basename
  silently pairs itself with that stale audio — the wrong caption,
  the wrong tags, with no signal that anything was stale.

### File-naming rules

Every name the run writes into `reel-inbox/processed/` is derived
from the dropped file's basename, and no two of them can ever
collide.

| File | Content |
|------|---------|
| `<base>.mp4` | Re-encoded 9:16 H.264/AAC ready to upload to Instagram. |
| `<base>_cover.jpg` | mjpeg cover image, 1080×1920, midpoint frame. |
| `<base>_POST.md` | caption + hashtags + file list + IG upload steps. |
| `<base>_source<videoExt>` | the original dropped video, kept for re-runs. |
| `<base>_audio<audioExt>` | the original sibling audio, kept for re-runs. |

The `_audio` infix is what makes the parked sibling safe:

- The reel is `<base>.mp4`, the cover is `<base>_cover.jpg`, the
  caption sheet is `<base>_POST.md` and the parked source is
  `<base>_source<videoExt>`. The `_audio` infix is used by nothing
  else, so `<base>_audio<audioExt>` can never equal any of them.
- The audio extension can never be `.mp4`, `.jpg` or `.md`, so it
  cannot land on the reel, the cover or the caption sheet either.
- It also stays clear of the `_source` family — which is exactly
  the case that needs care: a `.mov` video with a `.mp3` sibling, or
  a `.mp4` video with a `.m4a` sibling, where the source video and
  the sibling audio would otherwise want neighbouring names.

The older `<base><ext>` park name is gone for good: for an `.mp4`
drop it *was* the reel output path, so parking the source there
overwrote the transcoded reel with the original.

Same proven pattern as the chart-watcher / songs-watcher: poll
loop, lockfile-based concurrency guard (namespace-prefixed
`.processing-<sha1>` so cross-watcher collisions are impossible),
stale-lock detection by mtime, retry-once on transient failure
(5s sync sleep), SIGTERM-clean shutdown.

## Files

| Path | Purpose |
|------|---------|
| `lib/reel-watcher.js` | the watcher itself. Pure-Node, no deps. |
| `lib/reel-watcher.test.js` | 98-assertion lockfile + listPending + inbox-contract test harness. |
| `bin/reel-watcher.sh` | LaunchAgent wrapper. Multi-candidate Node resolution, sets PATH for ffmpeg. |
| `reel-inbox/` | drop zone for new video files. `.gitkeep` keeps the dir in the repo. |
| `reel-inbox/processed/` | outputs land here (`.gitignore`d). |
| `logs/reel-watcher.log` | one line per file processed. |
| `~/Library/LaunchAgents/com.kaidjuric.digital-twin.reel-watcher.plist` | LaunchAgent (installed, **not bootstrapped**). |

## Supported video formats

| Extension | Source test coverage | Notes |
|-----------|---------------------|-------|
| `.mp4` | yes | most common source |
| `.mov` | yes | QuickTime / iPhone |
| `.m4v` | yes | iTunes-style MP4 |
| `.mkv` | yes | Matroska |
| `.webm` | yes | VP9/VP8 — ffmpeg re-encodes to H.264 |
| `.avi` | yes | legacy |

The watcher is permissive (any ffmpeg-readable container); the
transcode step always targets 9:16 H.264/AAC regardless of source
codec. If `ffmpeg` can read it, the watcher can ship it.

## Output contract

For a dropped `modal-sketch-demo.mp4` with a sibling
`modal-sketch-demo.mp3`, `reel-inbox/processed/` will contain:

| File | Content |
|------|---------|
| `modal-sketch-demo.mp4` | Re-encoded 9:16 H.264/AAC ready to upload to Instagram. |
| `modal-sketch-demo_cover.jpg` | mjpeg cover image, 1080×1920, midpoint frame. |
| `modal-sketch-demo_POST.md` | caption + hashtags + file list + IG upload steps. |
| `modal-sketch-demo_source.mp4` | the original input, kept for re-runs. |
| `modal-sketch-demo_audio.mp3` | the original sibling audio, kept for re-runs. |

The generic form of those names, and why none of them can collide,
is under **File-naming rules** above.

## Install + activate

```bash
# 1. ffmpeg must be on PATH. Homebrew install if missing.
which ffmpeg ffprobe || brew install ffmpeg

# 2. Validate plist syntax
plutil -lint ~/Library/LaunchAgents/com.kaidjuric.digital-twin.reel-watcher.plist

# 3. (Optional) Bootstrap — irreversible step, service starts.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.reel-watcher.plist
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.reel-watcher
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.reel-watcher | grep -E "(state|last exit|program)"

# 4. Drop a test file and watch the log
cp /path/to/test-clip.mp4 reel-inbox/
sleep 5
tail -5 logs/reel-watcher.log
ls reel-inbox/processed/
```

> **The plist is installed but not bootstrapped** as of sprint
> 0.17. The 0.8/0.9 convention was: drop the plist into
> `~/Library/LaunchAgents/` and wait for explicit user approval
> before going live. Bootstrap is a one-line `launchctl bootstrap`
> away.

## Disable / remove

```bash
launchctl bootout gui/$(id -u)/com.kaidjuric.digital-twin.reel-watcher
rm ~/Library/LaunchAgents/com.kaidjuric.digital-twin.reel-watcher.plist
```

## Manual use

```bash
node lib/reel-watcher.js --once                # process all pending, then exit
node lib/reel-watcher.js --interval 5         # poll every 5s instead of 2s
bash bin/reel-watcher.sh --once                # same, via the LaunchAgent wrapper
```

## Tests

```bash
npm run test:reel-watcher
```

Runs `lib/reel-watcher.test.js` — 98 assertions covering: empty
inbox, supported-extension filtering, case-insensitive matching
(`.MP4` / `.MoV` / `.MKV`), active lockfile skip, stale-by-age
lockfile unblock, stale-by-mtime lockfile unblock, mixed states,
deterministic ordering, lockFor hash stability (incl. cross-
watcher namespace isolation from the songs-watcher), full
SUPPORTED_EXTS coverage, the transcode output surviving the input
move, and the inbox contract:

- the consumed sibling audio leaves the inbox on a successful run
  and is parked as `<base>_audio<ext>`, under a name distinct
  from every other output of the run;
- an unrelated audio file in the inbox is left untouched — not
  read for tags, not moved;
- only a same-basename file counts as a sibling;
- a failed export leaves both the video and the sibling audio in
  the inbox, and parks nothing;
- moving the sibling does not disturb the lockfile / stale-mtime
  logic, and the parked file stays inert for the `processed/`
  sweep (flat file, not a reel directory).

The integration smoke test (real ffmpeg + ffprobe against a
synthetic `.mp4` + sibling `.mp3` with ID3 tags) is documented in
AGENTS.md sprint 0.17 — verify that path after any ffmpeg API
change.

## Limitations

- **No concurrency.** Single-process watcher. Backlog of N files
  takes N × ~0.5s per Reel (4–10s for a 30s clip).
- **No retry on persistent failure.** A file that ffmpeg cannot
  decode is logged `[fail]` and left in `reel-inbox/`. Manual
  inspection required.
- **Caption from sibling audio only.** The watcher doesn't pull
  metadata from the video file itself; it expects an audio file
  with ID3/WAV/AIFF tags in the same directory with the same
  basename — and only that basename counts, so an unrelated audio
  file in the inbox is ignored rather than guessed at. A dropped
  `.mov` with no sibling audio falls back to
  `basename — 🎺 Reel from the twin.` with default hashtags.
- **The jazz tag block is built-in.** A reel with no genre, or a
  jazz-ish one, gets `JAZZ_TAGS` from `lib/reel-watcher.js`; a reel
  with another genre gets `#reel`, `#digitaltwin` and the genre's own
  words instead. Extend `JAZZ_TAGS` when the project's vocabulary
  grows — a new tag map per genre is the natural next step.
- **No IG upload.** Intentional. See top of doc.
- **Letterbox, not crop.** Videos with a non-9:16 source aspect
  ratio get black bars top/bottom or left/right. Cropping
  (face-tracking or center-crop) is a future enhancement.

## Provenance

The watcher follows the same 4-step watch contract as the chart,
songs, and MJ watchers — see `docs/CHART-WATCHER.md` for the
canonical rationale on poll loops vs `fs.watch`, lockfile-based
concurrency guards, and stale-lock mtime detection.