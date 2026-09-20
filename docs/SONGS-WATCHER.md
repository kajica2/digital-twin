# Songs Watcher — drop audio into audio-inbox/, get a refreshed catalog

> Sprint 0.36. Sibling of `docs/CHART-WATCHER.md` for the
> audio-corpus pipeline. Drop `.mp3` / `.wav` / `.aif` / `.aiff`
> / `.m4a` / `.aac` / `.flac` / `.ogg` files into `audio-inbox/`;
> the watcher regenerates `data/songs/catalog.json` automatically.

---

## What it does

`lib/songs-watcher.js` polls `audio-inbox/` every 2 seconds for new
audio files. For each new file, it invokes `lib/songs-indexer.js`
`--apply --yes --add <file>` to regenerate the catalog, then moves
the dropped file to `audio-inbox/processed/`. Same proven pattern as
the chart-watcher: poll loop, lockfile-based concurrency guard,
stale-lock detection by mtime, retry-once-on-transient-failure,
SIGTERM-clean shutdown.

## Files

| File | Purpose |
|------|---------|
| `lib/songs-watcher.js` | the watcher itself. Pure-Node, no deps. |
| `bin/songs-watcher.sh` | LaunchAgent wrapper. Multi-candidate Node resolution. |
| `audio-inbox/` | drop zone for new audio files. `.gitkeep` keeps the dir in the repo. |
| `audio-inbox/processed/` | inputs land here after a successful reindex. |
| `logs/songs-watcher.log` | one line per file processed. |
| `data/songs/catalog.json` | regenerated output (auto-generated, `.gitignore`d). |

## Supported audio formats

| Extension | Metadata extracted | Sprint added |
|-----------|--------------------|----|
| `.mp3` | ID3v2.3 / ID3v2.4 (TIT2 / TPE1 / TALB / TYER / TDRC / TCON / TBPM / TRCK / TKEY) | 0.7 |
| `.wav` | RIFF `fmt ` + LIST/INFO (INAM / IART / IPRD / ICRD / IGNR / IBPM / ITRK) | 0.7 |
| `.aif` / `.aiff` | FORM/AIFF + COMM (80-bit IEEE 754 extended-precision sample rate) + NAME/AUTH/ANNO + optional ID3 | **0.35** |
| `.m4a`, `.aac`, `.flac`, `.ogg` | dropped into inbox, passed to indexer `--add`. Indexer's `SUPPORTED_EXTS` is narrower than the watcher's filter — files in these formats are picked up but currently fail at parse time and stay in `audio-inbox/` for manual handling. |

## Install + activate

```bash
# Validate plist syntax
plutil -lint ~/Library/LaunchAgents/com.kaidjuric.digital-twin.songs-watcher.plist

# Bootstrap (this is the irreversible step — service starts)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.songs-watcher.plist

# Force an immediate run
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.songs-watcher

# Confirm it's loaded + running
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.songs-watcher | grep -E "(state|last exit|program)"

# Drop a test file and watch the log
cp /path/to/test.mp3 audio-inbox/
sleep 5
tail -5 logs/songs-watcher.log
ls audio-inbox/audio-inbox/processed/
```

## Disable / remove

```bash
launchctl bootout gui/$(id -u)/com.kaidjuric.digital-twin.songs-watcher
rm ~/Library/LaunchAgents/com.kaidjuric.digital-twin.songs-watcher.plist
```

## Manual use

```bash
node lib/songs-watcher.js --once                # process all pending, then exit
node lib/songs-watcher.js --interval 5         # poll every 5s instead of 2s
bash bin/songs-watcher.sh --once                # same, via the LaunchAgent wrapper
```

## Tests

```bash
npm run test:songs-watcher
```

Runs `lib/songs-watcher.test.js` — 16 assertions covering: empty
inbox, supported-extension filtering, case-insensitive matching
(`.MP3` / `.WaV` / `.AIF`), active lockfile skip, stale-by-age
lockfile unblock, stale-by-mtime lockfile unblock, mixed states,
deterministic ordering, lockFor hash stability, and a real-file
AIFF parse against
`/Users/kaidejuricmasscmbook/Downloads/adoresoundcloudver (2).aif`
(format=aif, sampleRate=44100, channels=2, durationSec > 50s).

## End-to-end (filesystem) e2e

```bash
cd e2e && node songs-watcher.spec.mjs
```

Puppeteer-driven filesystem contract test. Drops a tiny valid WAV,
invokes `bin/songs-watcher.sh --once`, asserts the audio file moved
to `processed/`, the catalog regenerated with the manual entry,
and the log records `[start]` + `[done]`. Mirrors `watcher.spec.mjs`
for the chart-watcher.

## Limitations

- **No concurrency.** Single-process watcher. Backlog of N files
  takes N × ~1s.
- **No retry on persistent failure.** A file that the indexer
  rejects (e.g. unsupported format, corrupt header) is logged
  `[fail]` and left in `audio-inbox/`. Manual inspection required.
- **M4A / AAC / FLAC / OGG are not actually parsed by the
  indexer.** The watcher accepts them (so they don't pollute
  `audio-inbox/`), but `lib/songs-indexer.js`'s `SUPPORTED_EXTS`
  is narrower than the watcher's filter. Files in these formats
  end up as `[fail]` log entries. Adding parse support is a
  future sprint — the watcher's contract is "drop audio, get
  catalog" but the indexer's contract is "parse MP3 / WAV /
  AIFF, log the rest".
- **No Apple Notes ping** like the chart-watcher's `--notify-on-success`.
  Audio files are typically processed in larger batches; one
  note per drop would be noisier than it's worth. Future
  enhancement.