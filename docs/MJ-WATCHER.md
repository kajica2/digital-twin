# Midjourney Automation — drop a prompt, get an image

> Drop `.md` prompt files into `prompts-inbox/`; the watcher submits them to
> Midjourney, tracks the resulting task, and moves the prompt to `processed/`.

---

## What it is

Two components following the repo's established watcher pattern (see
`docs/CHART-WATCHER.md` and `docs/SONGS-WATCHER.md`):

1. **`lib/mj-watcher.js`** — polls `prompts-inbox/` every 2 seconds for new
   `.md` files. Same lockfile-based concurrency guard, stale-lock detection,
   retry-once, SIGTERM-clean shutdown pattern as the chart and song watchers.

2. **A submitter backend**, chosen by `engine` in `lib/mj-config.json`:

| `engine` | Module | What it drives |
|----------|--------|----------------|
| `web` *(default)* | `lib/mj-web.js` | `midjourney.com/imagine` — the prompt bar in MJ's own web app |
| `discord` | `lib/mj-submitter.js` | the `/imagine` slash command in Discord, via the MJ bot |

Both accept identical CLI arguments, so the watcher swaps between them
without caring which is active.

**Prefer `web`.** The Discord route needs a second logged-in session
(Discord) inside the automation profile, and when that lapses the failure
surfaces as a generic 45-second "textarea not found" timeout. The web route
needs no Discord at all — just a cookie jar exported from a browser already
logged into midjourney.com.

## Files

| File | Purpose |
|------|---------|
| `lib/mj-watcher.js` | Poll-loop watcher. Pure-Node, no deps. |
| `lib/mj-web.js` | **Web backend** — drives midjourney.com/imagine. |
| `lib/mj-submitter.js` | Legacy Discord backend + shared CDP primitives. |
| `lib/mj-cookies.js` | Cookie-jar loading (Netscape + JSON), `__Host-` rules. |
| `lib/mj-config.json` | Configuration (engine, cookies, ports, MJ defaults). |
| `lib/mj-watcher.test.js` | Lockfile logic tests. |
| `lib/mj-cookies.test.js` | Cookie parsing + `__Host-` tests (37 assertions). |
| `bin/mj-watcher.sh` | LaunchAgent wrapper. Multi-candidate Node resolution. |
| `prompts-inbox/` | Drop zone for `.md` prompt files. |
| `prompts-inbox/processed/` | Processed prompts land here. |
| `mj-output/` | Per-prompt output: `<slug>/prompt-NN/` with `prompt.md` and `meta.json` (task id + the generated image URLs). |
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

Web-backend settings:

- **`engine`** — `"web"` (default) or `"discord"`. Selects the submitter.

- **`web.cookiesFile`** — Cookie jar exported from a logged-in browser
  (default `~/.midjourney-cookies.txt`). Netscape or JSON. **Secret.**

- **`web.userDataDir`** — Browser profile for the web backend (default
  `/tmp/mj-web-profile`). Separate from the Discord profile so the two
  backends never contend for one Chromium instance.

- **`web.acceptTimeoutMs`** — How long to wait for a new task to appear after
  pressing Enter (default 45s). This is the acceptance signal.

- **`web.generationTimeoutMs`** — How long to wait for that task's 4-up grid
  (default 180s). Relax-mode jobs queue, so this is deliberately generous.

- **`paths.webBrowserBin`** — Browser for the web backend. Must be a browser
  that runs headed (Chrome or Comet).

## Web backend setup (`engine: "web"`, default)

No Discord needed. Two steps.

### 1. Export a cookie jar from a logged-in browser

Open midjourney.com in a browser where you are signed in, and export the
cookies for that site (a "Get cookies.txt"-style extension, or a DevTools
cookie export as JSON — either format works). Save it to the path in
`web.cookiesFile` (default `~/.midjourney-cookies.txt`).

**This file is a live session token — treat it as a password.** It is
`.gitignore`d (`*-cookies.txt`, `mj-cookies*.txt`), and it lives outside the
repo by default. It expires; when MJ starts showing the login page again,
re-export.

Verify the jar before a run:

```bash
node lib/mj-web.js --prompt-file assets/mural-prompts/whats-gonna-be-groove.md \
  --all-prompts --preflight
```

`--preflight` launches the browser, checks the cookies were accepted, loads
the Imagine page, confirms the prompt bar exists, and reports how many
prompts are queued — **without submitting anything**. It costs no
generations, so run it whenever you suspect the session has lapsed.

### 2. Run it

```bash
node lib/mj-web.js --prompt-file <file.md> --all-prompts
node lib/mj-web.js --prompt-file <file.md> --all-prompts --dry-run   # no browser
```

### Two constraints worth knowing

**The browser must be HEADED.** Cloudflare fingerprints headless Chromium:
the first couple of submissions succeed, then `/api/submit-jobs` returns 403
and the page becomes the "Just a moment..." interstitial. A visible window
passes cleanly. The backend therefore never launches headless, and it detects
the interstitial and fails with an explanatory message rather than timing out.

**`__Host-` cookies must not carry a `Domain` attribute.** Both MJ auth
tokens use that prefix. A browser silently *drops* a `__Host-` cookie that has
a domain, and the site then just renders "Log in" with no error — the only
symptom is a 45s "textarea not found". `lib/mj-cookies.js` strips the domain
and expresses those cookies via `url` instead; it is unit-tested for exactly
this.

### How success is judged

A cleared prompt box is **not** proof of acceptance — the UI clears it either
way. The backend snapshots the task ids already in the feed, submits, then
waits for a **new** `cdn.midjourney.com/<uuid>/...` task to appear. That uuid
becomes the acceptance signal, and its image URLs are written to
`meta.json`, so a run leaves machine-checkable evidence rather than a claim.

## Chrome profile setup (one-time) — Discord backend only

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