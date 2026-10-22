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
| `lib/mj-revise.js` | **Re-evolve an edit job** — new prompt, the SAME attachments, style reference, profile and flags. |
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
way. The acceptance signal is **Midjourney's own answer**: the response to
`POST /api/submit-jobs` carries the new job id, the job type and the full
command the job was created with. That response is captured in the page and
read back, so a run leaves machine-checkable evidence rather than a claim.

The feed is only consulted afterwards, for the finished images — it lags the
submission by 9–15 seconds and longer when the queue is busy.

### The composer is driven with ENTER, not the send button

Measured against the live page (2026-10-22), clicking the composer's send
button **does not submit**, however the click is delivered: `element.click()`,
a full CDP mouse sequence (`mouseMoved` / `mousePressed` / `mouseReleased`
with `buttons:1`), a pointer+mouse+click event sequence, and the same with
`document.hasFocus()` confirmed true at click time. `elementFromPoint` at the
button's centre resolves to the button's own SVG path, so the coordinates are
right — and no `/api/submit-jobs` request is made either way.

Pressing **ENTER** in the composer does submit. The focus matters: after the
composer re-renders it takes the focus with it, and an ENTER that lands on
the page body does nothing. The backend refocuses the textarea before every
ENTER, which is what makes consecutive submissions land.

This is also why the older note "Enter degrades after the first submission of
a session" was wrong: the cause was lost focus, not ENTER.

### The account's job queue can refuse a prompt — silently

Midjourney's relaxed mode holds a couple of jobs at a time. When the queue is
full, a submission is **turned away without a word**: the composer logs the
prompt (`/api/prompt-session-log`), never asks for a submission
(`/api/submit-jobs`), and shows no error. The prompt just stays in the
composer.

A tool that only watches for the submit response reads that refusal as
"nothing happened" — which is exactly how it first presented. The backend
reads Midjourney's own queue readout ("2 queued jobs"), waits for room, and
retries. A submission is accepted with one job queued and refused with two.

### A bad parameter is refused the same silent way

The refusal above has a second cause, and it needs the **opposite** response:
the queue is fine, and the **prompt** is what Midjourney turned down. Waiting
will not help — the prompt has to change.

Measured live on 2026-10-22 with an empty queue, one prompt each:

| parameter | result |
|---|---|
| `--style raw` | accepted |
| `--style niji` | **refused** — 0 submissions |
| `--style fire` | **refused** |
| `--style neon` | **refused** |
| no style | accepted |

Midjourney's own
[parameter list](https://docs.midjourney.com/hc/en-us/articles/32859204029709-Parameter-List)
confirms why: **v8 has no `--style` parameter at all.** The only style
control is `--raw` (Raw Mode), and `--niji` is a *model* switch, not a
style. A style value that v8 does not know is dropped along with the whole
submission, with no error anywhere.

The backend distinguishes the two cases with Midjourney's own queue readout:
room in the queue means the prompt was refused, so the run **fails fast**
with a message naming the likely parameter, instead of burning eight
retries on a prompt that can never land. The refusal is recorded per prompt
and the pack continues.

### The account's moodboards apply to every prompt

The composer's **Personalize** control is on by default, and it puts the
account's profile and moodboards into every generation — whatever the prompt
says. There is no flag for "no moodboards": the prompt text cannot express
it, and a style reference (`--sref`) is a different thing entirely.

Measured on the account used for the sheets (2026-10-22): profile #8 plus
four moodboards (#92, popart, yellow taxi, kowloon city). Every generation
inherited them until the control was cleared.

`--no-personalize` clears it before the pack runs:

```bash
node lib/mj-web.js --prompt-file <file.md> --all-prompts --no-personalize
```

Two things make this less obvious than it looks:

- **A React `element.click()` does not flip the control.** It needs a real
  mouse event (`Input.dispatchMouseEvent`) at the button's coordinates.
- **The state has no attribute to read.** The selected option is painted a
  saturated coral and the unselected one a neutral grey, so the two are
  separated by their oklab **chroma** (~0.23 against ~0.02).

The backend therefore reads the state, clicks, and then **reads it again** —
a flip that did not take is reported rather than silently producing
personalised output.

The flag is opt-in: the default path is untouched. That is deliberate for a
**comparison sheet**, where every variant has to be rendered under the same
conditions — re-rendering one tile without the account's moodboards would
make it the odd one out visually, whatever the angle says.


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
---

## Re-evolving an edit job (`lib/mj-revise.js`)

An **edit job** is one made with images attached — a face photo, a
scene photo. Its command carries them:

```
iphone camera realistic couple dancing --ar 3:4 --raw
  --sref https://s.mj.run/LIw4i-evx5g
  --profile xy9cz8o 5s2lvkr nq7qlpg gx3g58u 5vodqxt xr39csb det21e6
  --edit https://s.mj.run/1kgq0q6JG4s https://s.mj.run/3MjF3uJtjlI
  --stylize 0 --v 8.2 --hd
```

`lib/mj-revise.js` takes that job and re-runs it with **new prose**,
keeping the attachments, the style reference, the profile, the moodboard
codes and every flag:

```bash
npm run mj:revise -- --source <jobId> \
  --prompt-file assets/mural-prompts/<pack>.md
```

The prompt file is an ordinary pack (one top-level bullet per prompt).
The tool reads the source job's own `full_command` from the live feed,
so the flags are **never transcribed by hand** — "the same settings" is
true by construction.

### Which flags the new prompt wins

The source's flags are carried over, but a flag the **new prompt**
already names is not appended a second time. Midjourney resolves a
doubled flag by taking the **last** one, so a collision does not error
— it silently picks the wrong value, and the artist never finds out.

Concretely: the source job was made with `--style raw --s 21`, and the
new prompt says `--style niji`. Appending the source's flags blindly
produced

```
… --style niji --style raw --s 21 --edit … --ar 16:9
```

MJ takes the last `--style`, so the source's `raw` won and the
prompt's `niji` was discarded. Same failure class as the duplicated
`--ar` and `--sref` (PM-2026-09-24-dup-flags).

The rule, one flag at a time:

| Flag | Owner | Why |
| --- | --- | --- |
| `--style` / `--raw` | the **new prompt**, if it names one | the prompt's style must not be shadowed by the source's |
| `--s` | the **new prompt**, if it names one — or if it names a style | the source's `--s` is coupled to the source's `--style` |
| `--ar` | the **source** | this tool re-evolves a job, so it keeps the job's shape. Emitted **last** so it wins. |
| `--edit` | the source's attachments | emitted before `--ar` |
| everything else | the source | carried verbatim |

`--raw` is the same switch as `--style raw`, so a prompt carrying
`--raw` owns the style slot too. The guards match the **flag**, not a
value: a prompt ending in a bare `--style` still means the prompt owns
that flag.

**Every flag is resolved exactly once — the composed command never
contains two of the same flag.** That invariant is what
`npm run test:mj-revise` checks, across six prompt shapes.

### Why `--edit` travels in the prompt text

Midjourney's web composer has an "Attach to prompt" slot, and driving
it over CDP means fighting a file input that sits behind a React
portal, that toggles open and closed, and that MJ **dedupes** (the
same bytes return the same `s.mj.run` id and render no new chip at
all). Every one of those is a *silent* failure: the submission lands as
a plain generation with no reference image and nothing says so.

Typing the source's own `--edit <url> …` into the prompt text does the
same job with none of that. Verified: the result comes back as
`v8-2_edit_diffusion` / `edit_ref_diffusion` with the **exact** source
URLs in its command — one submission in ~8s.

### The outcome check

A submission can still land as a plain `diffusion` job. The tool checks
the resulting job for the attachments and the edit job type, and says
so loudly when they are missing rather than shipping the image as a
success.

### Reuse

A variant whose prose **and** attachments already exist in the feed is
reused instead of re-generated (the feed match requires the source's
`--edit` URLs, so an unrelated job can never be mistaken for it). Use
`--no-reuse` to force a fresh generation.

### Its own browser

The MJ web profile is one mutable resource — one page, one composer,
one file input — so two agents on the same instance fight over it. The
tool runs on its own port (`:9445`) with its own copy of the profile
(`/tmp/mj-revise-profile`); a copied profile keeps Chrome's singleton
lock, which the tool clears before launching.

### Output

`mj-output/revise/<pack>/prompt-NN/` — the 4-up grid plus a `meta.json`
carrying the task id, the composed command, the attachment URLs and
`imageUrls` (the key the dashboard index and the contact sheet read).
`node lib/mj-contact-sheet.js --pack revise/<pack>` builds the
comparison sheet.
