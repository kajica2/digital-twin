# Chart Watcher — automated MusicXML → chart package

> Sprint 0.8. Drop a `.musicxml` into `chart-inbox/`; the watcher
> runs the full export pipeline and produces PDFs, MP3s, and the
> MIDI next to the input. Move-on, walk-away automation.

---

## What it does

`lib/chart-watcher.js` polls `chart-inbox/` every 2 seconds. For
each new `.musicxml` file, it:

1. Acquires a lockfile (`.processing-<sha1>`) so concurrent
   runs of the watcher don't double-process.
2. Invokes `bin/export-all.sh` — which splits the MusicXML
   into per-instrument parts, mutes the trumpets / saxes,
   renders PDFs + MP3s via MuseScore, and writes a multi-track
   MIDI.
3. Moves the input to `chart-inbox/processed/` so it's clear
   what shipped and what hasn't.
4. Appends a one-line `[start]` / `[done]` / `[fail]` entry to
   `logs/chart-watcher.log`.

Outputs land in `chart-inbox/` next to where the input file
was. Same convention as `bin/export-all.sh` when called
manually — the watcher is just the always-on wrapper.

## Files

| File | Purpose |
|------|---------|
| `lib/chart-watcher.js` | The watcher itself. Pure-Node, no deps. |
| `bin/chart-watcher.sh` | LaunchAgent wrapper. Resolves Node, execs the JS. |
| `chart-inbox/` | Drop your `.musicxml` files here. |
| `chart-inbox/processed/` | Inputs land here after a successful export. |
| `logs/chart-watcher.log` | One line per file processed. |

## Install + activate

The LaunchAgent plist already lives at
`~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist`
(it's part of this repo's tooling — same drop-in install model as
the existing `com.kaidjuric.digital-twin.server` + `.boot` agents).

```bash
# 1. Validate plist syntax
plutil -lint ~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist

# 2. Validate wrapper script works
bin/chart-watcher.sh --once --help

# 3. Bootstrap (this is the irreversible step — service starts)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist

# 4. Force an immediate run to verify
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.chart-watcher

# 5. Confirm it's loaded + running
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.chart-watcher | grep -E "(state|last exit|program)"

# 6. Drop a test file and watch the log
cp /tmp/modal-sketch.musicxml chart-inbox/test.musicxml
sleep 15
tail -10 logs/chart-watcher.log
ls chart-inbox/ chart-inbox/processed/
```

## Disable / remove

```bash
# Stop without removing the plist
launchctl bootout gui/$(id -u)/com.kaidjuric.digital-twin.chart-watcher

# Full removal
rm ~/Library/LaunchAgents/com.kaidjuric.digital-twin.chart-watcher.plist
launchctl bootout gui/$(id -u)/com.kaidjuric.digital-twin.chart-watcher
```

## Manual use (without the LaunchAgent)

```bash
# Process everything currently in the inbox, then exit
node lib/chart-watcher.js --once

# Run as a foreground daemon (Ctrl+C to stop)
node lib/chart-watcher.js --interval 5
```

## Decisions

- **Poll loop, not `fs.watch`.** `fs.watch` / FSEvents under a
  GUI LaunchAgent has known reliability gaps on macOS — events
  drop. A 2-second poll is boring and predictable. Matches the
  twin's "calm, not chatty" ethos.
- **Single in-process watcher, no concurrency.** Each export
  takes ~10s. Serial processing is the right default for a
  personal twin. To parallelize later, add a worker pool.
- **Move to `processed/`, not delete.** The user can see what
  shipped. The processed dir is .gitignored.
- **No `fs.watch`, no Slack/IM notifications.** Logging only.
  Match AGENTS.md "silent unless something matters."
- **ThrottleInterval=10 in the plist.** If launchd restarts the
  watcher (crash), don't let it tight-loop — at least 10 seconds
  between respawns.
- **`EnvironmentVariables.PATH` includes `~/.hermes/node/bin`
  first.** LaunchAgent runs with launchd's stripped PATH; the
  Hermes-managed Node is the preferred binary here.

## Logs

The watcher writes to:

| File | Source |
|------|--------|
| `logs/chart-watcher.log` | the watcher's own per-file `[start]` / `[done]` / `[fail]` lines |
| `logs/chart-watcher.out.log` | launchd's stdout from `bash bin/chart-watcher.sh` |
| `logs/chart-watcher.err.log` | launchd's stderr |

Daily rotation at 03:00 is handled by `bin/log-rotate.sh` (also
shipped in this repo) via the
`com.kaidjuric.digital-twin.log-rotate` LaunchAgent. Keeps 7
daily `.gz` rotations, deletes the rest. Not bootstrapped by
default — install with:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.log-rotate.plist
```

Manual rotate:

```bash
bin/log-rotate.sh                 # rotate everything in logs/
bin/log-rotate.sh logs/foo.log    # rotate just one file
```

## Tests

```bash
npm run test:watcher
```

Runs `lib/chart-watcher.test.js` — pure-Node harness, no deps.
36 assertions covering: empty inbox, single file, active lockfile
skip, stale-by-age lockfile unblock, stale-by-mtime lockfile
unblock (the "replace file at same path" case), mixed states,
deterministic ordering, non-musicxml extension filtering,
lockFor hash stability, retry path (success on first / success
on retry / permanent fail), concurrent watcher lockfile blocking,
and post-success hook (fires on success / not on permanent fail /
hook failure doesn't break the export). Uses `WATCHER_TEST_DIR`
env var to point the watcher at a scratch dir so no real files
in `chart-inbox/` are touched.

## Limitations

- **No concurrency.** A backlog of N files takes N × 10s. Add a
  worker pool when N > 5 is routine.
- **Single-process watcher.** Two simultaneous watcher instances
  on the same inbox will both see the same files but the
  lockfile (`.processing-<sha1>`) prevents double-export.
- **Retries once on transient failure.** A persistent failure
  (bad MusicXML, mscore crash loop) logs `[fail]` and leaves
  the input in `chart-inbox/` (does NOT move to processed/).
  Manual intervention required.
- **No chord-symbol / slash notation** in the output MusicXML.
  The watcher ships whatever the chart-export pipeline produces.

## Notifications (Apple Notes ping)

When the LaunchAgent wrapper (`bin/chart-watcher.sh`) is used
with `--notify-on-success` (which is the default — see the
wrapper script), every successful chart export posts a note to
the user's Apple Notes account under the `twin OS` folder. The
note is created via `bin/chart-notes.applescript` using the same
account/folder resolution pattern as `bin/notes.applescript` from
sprint 0.1.

To disable: edit `bin/chart-watcher.sh` and remove the
`--notify-on-success` flag, then `launchctl kickstart -k
gui/$UID/com.kaidjuric.digital-twin.chart-watcher` to restart.

Notes accumulate (scroll up for history). Per-note content:

```
chart export

when   <ISO timestamp>
song   <basename without .musicxml>
time   <wall time in seconds, 1 decimal>
try    <attempt count, 1 or 2>

demo    chart-inbox/<song>_Demo.mp3
full    chart-inbox/<song>_Full_Score.pdf
parts   chart-inbox/<song>_PDF/parts/
```