# Capture

`bin/capture-app.mjs` records the screen (or a specific window) in
fixed-length clips. macOS only — it wraps `/usr/sbin/screencapture`'s
video mode (`-V`), which writes a `.mov` continuously until it
receives `SIGINT`. The script sleeps for `seconds` and sends `SIGINT`,
producing one clip per loop.

```bash
./bin/capture-app.mjs                              # 1 × 5s, full screen
./bin/capture-app.mjs --seconds 10 --count 4       # 4 × 10s clips
./bin/capture-app.mjs --window-id 12345            # specific window
./bin/capture-app.mjs --output-dir recordings/     # custom dir
./bin/capture-app.mjs --no-cursor                  # hide cursor
./bin/capture-app.mjs --dry-run                    # plan only
```

Outputs `clip-001.mov`, `clip-002.mov`, … in `--output-dir`
(default `./recordings`).

## One-time permission

The first run may ask for Screen Recording permission for the
**calling terminal** in:

```
System Settings → Privacy & Security → Screen Recording
```

The grant covers the whole session for the terminal that holds it.
Re-grants are not required unless the terminal changes (e.g. Terminal.app
vs iTerm2 vs VS Code).

## Selecting a specific window

Every visible window has an ID. Get it with:

```bash
osascript -e 'tell application "System Events" to id of window 1 of (first process whose frontmost is true)'
```

Pass it to `--window-id N` to capture only that window — useful when
recording one app without screen noise from the rest of the desktop.

## Tips

- **Clips are sequential** — `screencapture -V` cannot run two parallel
  instances from the same terminal without frame overlap. For longer
  continuous takes, use `screencapture -V` directly and stop with
  Ctrl-C; segment offline with `ffmpeg -i recording.mov -c copy
  -segment_time 5 recording-%03d.mov`.
- **Audio** — `screencapture -V` records no audio by default. To
  capture system audio, route through BlackHole or use `ffmpeg
  -f avfoundation` directly.
- **Recordings dir is local** — `.gitignore`'d. The repo never
  carries binary captures.
- **Permission errors after a macOS update** — re-grant Screen
  Recording, then re-run; the script detects the empty file and
  surfaces an explanatory error.

## Files

- `bin/capture-app.mjs` — the script.
