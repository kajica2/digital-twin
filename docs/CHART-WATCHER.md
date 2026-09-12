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

## Limitations

- **No concurrency.** A backlog of N files takes N × 10s. Add a
  worker pool when N > 5 is routine.
- **Single-process watcher.** Two simultaneous watcher instances
  on the same inbox will both see the same files but the
  lockfile (`.processing-<sha1>`) prevents double-export.
- **No retry on failure.** A failed export logs `[fail]` and
  leaves the input in `chart-inbox/` (does NOT move to
  processed/). Manual intervention required.
- **No chord-symbol / slash notation** in the output MusicXML.
  The watcher ships whatever the chart-export pipeline produces.