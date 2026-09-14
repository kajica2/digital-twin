# Midjourney Automation — drop a prompt, get an image

> Drop `.md` prompt files into `prompts-inbox/`; the watcher submits them to
> Midjourney via Discord web (Chrome DevTools Protocol), captures the
> generated image, and moves the prompt to `processed/`.

---

## What it is

Two components following the repo's established watcher pattern (see
`docs/CHART-WATCHER.md` and `docs/SONGS-WATCHER.md`):

1. **`lib/mj-watcher.js`** — polls `prompts-inbox/` every 2 seconds for new
   `.md` files. Same lockfile-based concurrency guard, stale-lock detection,
   retry-once, SIGTERM-clean shutdown pattern as the chart and song watchers.

2. **`lib/mj-submitter.js`** — drives Discord web via Chrome DevTools Protocol
   (CDP). Launches or attaches to a debug Chrome, navigates to the configured
   Discord channel, types `/imagine prompt: <prompt>`, submits, and captures
   the generation result.

## Files

| File | Purpose |
|------|---------|
| `lib/mj-watcher.js` | Poll-loop watcher. Pure-Node, no deps. |
| `lib/mj-submitter.js` | CDP-based Discord/MJ automation core. |
| `lib/mj-config.json` | Configuration (Discord channel, Chrome port, MJ defaults). |
| `lib/mj-watcher.test.js` | Lockfile logic tests (13 assertions). |
| `bin/mj-watcher.sh` | LaunchAgent wrapper. Multi-candidate Node resolution. |
| `prompts-inbox/` | Drop zone for `.md` prompt files. |
| `prompts-inbox/processed/` | Processed prompts land here. |
| `mj-output/` | Generated result images + metadata JSON. |
| `logs/mj-watcher.log` | One line per prompt processed. |

## Quick start

```bash
# 1. Install ws (CDP dependency)
npm install ws

# 2. Edit config to point at your Discord Midjourney channel
#    Open lib/mj-config.json and set:
#      discord.channelUrl: the Discord channel URL where MJ lives
#      chrome.userDataDir: a Chrome profile you'll sign into Discord ONCE

# 3. Start the watcher (foreground, one-shot)
node lib/mj-watcher.js --once

# 4. Drop a test prompt
cat > prompts-inbox/test-prompt.md <<'EOF'
# my test prompt

A serene Japanese garden at golden hour, koi pond, cherry blossoms,
warm light filtering through maple trees, cinematic, 35mm photography
--ar 16:9 --s 250
EOF

# 5. Process it
node lib/mj-watcher.js --once

# 6. Check results
ls mj-output/
tail -5 logs/mj-watcher.log
```

## Prompt file format

Prompt files are Markdown. The first non-frontmatter paragraph is used as the
Midjourney prompt. MJ parameters (`--ar`, `--style`, `--s`, `--sref`, etc.)
are embedded in the prompt text.

```markdown
---
title: My Prompt
tags: [urban, graffiti]
---

Street-level medium shot of a brightly painted Buenos Aires tenement
at first light, every panel a different saturated color, covered in
fresh graffiti, cinematic, shot on 35mm --ar 3:4 --style raw --s 250
```

Metadata beyond the prompt body is optional — only the prompt text is sent.
YAML frontmatter (between `---` delimiters) is stripped automatically.

## Configuration

Edit `lib/mj-config.json`:

```json
{
    "discord": {
        "channelUrl": "https://discord.com/channels/@me"
    },
    "chrome": {
        "debugPort": 9444,
        "userDataDir": "/tmp/mj-chrome-profile"
    },
    "mj": {
        "outputDir": "mj-output",
        "defaultArgs": "--ar 3:4 --style raw --s 250",
        "generationTimeoutMs": 120000
    },
    "paths": {
        "chromeBin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    }
}
```

Key settings:

- **`discord.channelUrl`** — The Discord channel URL. Defaults to DM with MJ
  bot (`@me`). Replace with your Midjourney server's channel URL like
  `https://discord.com/channels/123456/789012`.

- **`chrome.userDataDir`** — Chrome profile directory. **You must sign into
  Discord in this profile once.** A fresh profile starts logged-out and the
  watcher will fail. See "Chrome profile setup" below.

- **`chrome.debugPort`** — CDP port (default `9444`). Picked to avoid
  collision with any existing Chrome debug port (`9222`, `9333`).

- **`mj.defaultArgs`** — Default MJ parameters appended when a prompt doesn't
  include `--ar`, `--style`, etc. Override per-prompt by including them in
  the prompt text.

- **`mj.generationTimeoutMs`** — Max wait for MJ to generate (default 120s).
  MJ 4-up grids typically take 30-90s.

## Chrome profile setup (one-time)

The watcher needs a Chrome profile where you're signed into Discord and have
access to the Midjourney server.

```bash
# 1. Pick a profile directory (set it in mj-config.json)
mkdir -p /tmp/mj-chrome-profile

# 2. Launch Chrome with that profile AND remote debugging
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9444 \
  --user-data-dir=/tmp/mj-chrome-profile \
  --no-first-run

# 3. Sign into Discord in this Chrome window.
# 4. Navigate to your Midjourney bot DM or server channel.
# 5. Verify /imagine works by typing one prompt manually.
# 6. Close Chrome.

# The profile now has Discord auth cookies. The watcher reuses it.
```

**After setup, verify the profile works headlessly:**
```bash
# Test that the submitter can connect
node lib/mj-submitter.js --dry-run --prompt "test prompt --ar 1:1"
```

## Interactive use (without the watcher)

Run the submitter directly to send a one-off prompt:

```bash
# Submit a text prompt directly
node lib/mj-submitter.js --prompt "A serene Japanese garden at golden hour --ar 16:9"

# Submit from a file
node lib/mj-submitter.js --prompt-file prompts-inbox/my-prompt.md

# Dry run (validate prompt parsing without launching Chrome)
node lib/mj-submitter.js --dry-run --prompt "test --ar 3:4"
```

## Install as a LaunchAgent

```bash
# 1. Validate plist syntax
plutil -lint ~/Library/LaunchAgents/com.kaidjuric.digital-twin.mj-watcher.plist

# 2. Bootstrap (service starts immediately)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.mj-watcher.plist

# 3. Force an immediate run
launchctl kickstart -k gui/$(id -u)/com.kaidjuric.digital-twin.mj-watcher

# 4. Confirm it's running
launchctl print gui/$(id -u)/com.kaidjuric.digital-twin.mj-watcher | grep -E "(state|last exit|program)"
```

## Tests

```bash
# Lockfile logic tests (no Chrome/Discord needed)
npm run test:mj

# Dry-run smoke test (validates config + prompt parsing)
node lib/mj-watcher.js --once --dry-run
```

## Limitations

- **Requires Discord login.** A fresh Chrome profile needs one-time sign-in.
  The profile persists auth cookies for subsequent runs.
- **Discord DOM may change.** Discord's web app is a moving target. The
  selector logic may need updating if Discord changes their textarea or
  message rendering.
- **No upscale workflow yet.** The submitter captures the 4-up grid (or
  whatever MJ returns). Automatic upscale (clicking U1-U4) is a future
  enhancement.
- **Single-process.** Backlog of N prompts takes N × ~90s. No parallel
  submissions.
- **CDP dependency requires `ws` package** for WebSocket. `npm install ws`
  in the repo root.