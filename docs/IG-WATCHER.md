# Instagram Auto-Posting

The Instagram watcher automates posting Reels to Instagram. It watches for post-ready reels created by the reel-watcher and posts them automatically.

## Overview

```
reel-inbox/processed/  →  [IG Watcher]  →  Instagram (web)
                           ↓
                    reel-inbox/posted/
```

## Workflow

1. **Reel-watcher** creates post-ready packages in `reel-inbox/processed/`:
   - `*.mp4` (vertical 9:16 video)
   - `*.jpg` (cover frame)
   - `POST.md` (caption + hashtags)

2. **IG Watcher** picks up each package and posts to Instagram via the web interface

3. **Posted** reels are moved to `reel-inbox/posted/`

## Setup

### 1. Export Instagram Cookies

1. Open Instagram in Chrome (must be the same browser you want to use for posting)
2. Install a "Get cookies.txt" extension or use DevTools
3. Export cookies for `instagram.com` in Netscape format
4. Save to `~/Downloads/d1925cb8-c34b-4805-aaa9-56eda9fc7f10.txt` (or update `lib/ig-config.json`)

### 2. Verify Cookies

```bash
npm run ig:check-cookies
# Or:
node -e "const c=require('./lib/ig-cookies.js'); console.log(c.validate(c.parseCookieFile('/path/to/cookies.txt')).valid)"
```

### 3. Test the Poster (Dry Run)

```bash
# Create a test reel in processed/
mkdir -p reel-inbox/processed/test
# Add test.mp4, cover.jpg, POST.md

# Dry-run (won't actually post)
node lib/ig-poster.js reel-inbox/processed/test --dry-run

# Or run the watcher in dry-run mode
node lib/ig-watcher.js --once --dry-run
```

### 4. Run the Watcher

```bash
# Manual run
node lib/ig-watcher.js

# Or with LaunchAgent (requires bootstrap)
# Copy plist to LaunchAgents and bootstrap:
cp com.kaidjuric.digital-twin.ig-watcher.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kaidjuric.digital-twin.ig-watcher.plist
```

## Configuration

Edit `lib/ig-config.json`:

- `cookiesFile` - Path to cookie jar
- `userDataDir` - Browser profile directory
- `browserBin` - Chrome binary path
- `chrome.debugPort` - CDP port (default 9445)
- `post.uploadTimeoutMs` - Upload timeout
- `post.outputDir` - Where posted reels go

## Commands

```bash
npm run ig:poster     # Post a single reel
npm run ig:watch      # Run the watcher
npm run ig:check-cookies  # Verify cookie validity
```

## Limitations

- **Browser must be headed** - Instagram blocks headless Chrome
- **Cookies expire** - Re-export cookies when login expires
- **One at a time** - Sequential posting only (to avoid rate limits)
- **Manual verify** - Check Instagram after posting to confirm success

## What the web composer actually does

Publishing through instagram.com's web composer has four behaviours
that are not obvious and cost real time to rediscover. All four are
handled by `lib/ig-poster.js` and pinned by `lib/ig-poster.test.js`.

**The caption commits on blur.** Instagram's caption editor keeps the
typed text in a local state and commits it when the field loses
focus. Clicking "Share" while the field still has focus publishes the
PREVIOUS caption — the empty one — while the editor's own counter
still reads the new text ("124/2,200"). The counter is not proof the
post carries the caption; only the published page is. So the field is
blurred explicitly before the publish button is pressed.

**Only a real text insertion lands.** `document.execCommand('insertText')`
returns `true` and inserts nothing into Instagram's caption box. CDP's
`Input.insertText` is the insertion Instagram accepts — it arrives as
a real input event and the counter moves.

**The publish modal needs a focused page.** Clicking "Share" opens a
modal that Instagram renders itself, and a backgrounded tab throttles
that render: the modal sits on a spinner indefinitely and the post
never goes up. The poster turns on Chrome's focus emulation
(`Emulation.setFocusEmulationEnabled`) so the modal completes without
stealing the user's window.

**A vertical video opens the "New reel" panel.** The create menu has
no "Reel" tab — only Post, Live video and Ad — but a vertical video
still opens a panel titled "New reel". The publish button is labelled
"Share", and its search must stay scoped to the create dialog: the
feed behind the modal has a "Share" button on every post, and finding
that one opens a share sheet for somebody else's post.

The confirmation is read from the modal ("Shared reel — Your reel has
been shared.") or from the URL, whichever arrives first. A fixed wait
cannot tell "published" from "hung".

## Files

- `lib/ig-config.json` - Configuration
- `lib/ig-cookies.js` - Cookie parsing
- `lib/ig-poster.js` - Single poster
- `lib/ig-poster.test.js` - Poster contract tests (no browser needed)
- `lib/ig-watcher.js` - Watcher loop
- `bin/ig-watcher.sh` - LaunchAgent wrapper
- `com.kaidjuric.digital-twin.ig-watcher.plist` - LaunchAgent plist
