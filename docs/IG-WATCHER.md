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

## Files

- `lib/ig-config.json` - Configuration
- `lib/ig-cookies.js` - Cookie parsing
- `lib/ig-poster.js` - Single poster
- `lib/ig-watcher.js` - Watcher loop
- `bin/ig-watcher.sh` - LaunchAgent wrapper
- `com.kaidjuric.digital-twin.ig-watcher.plist` - LaunchAgent plist
