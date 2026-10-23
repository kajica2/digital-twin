# YouTube Poster

`lib/youtube-poster.js` uploads a video to YouTube Studio through a
real Chrome session, with the title, description, tags and visibility
filled in for you.

```bash
node lib/youtube-poster.js <video-file> \
    [--title "Sainted Word - <mood>"] \
    [--description "..."] \
    [--tags "SaintedWordRecords,AIArt,GenerativeMusic,Ambient"] \
    [--visibility public|unlisted|private] \
    [--cookies <file>] [--port <port>] [--user-data-dir <dir>] \
    [--output <dir>] [--dry-run]
```

Exit codes: `0` uploaded · `1` fatal · `2` uploaded but the claim
could not be confirmed.

## Configuration

`lib/youtube-config.json`:

| key | meaning |
|---|---|
| `cookiesFile` | Netscape cookie jar (`lib/youtube-cookies.txt`, gitignored) |
| `userDataDir` | Chrome profile the poster drives |
| `chrome.debugPort` | CDP port — **must not collide with another tool's browser** |
| `upload.outputDir` | Where the poster logs the upload |
| `upload.visibility` | Default visibility when `--visibility` is absent |
| `defaults.tags` | Tags merged with the mood |
| `title.prefix` / `title.pattern` | The channel's title convention |

The Instagram poster also uses port 9446 by default. Run the YouTube
poster on its own port (`--port 9447`) with its own profile, or the
two tools drive each other's browser.

## The session is the hard part

A cookie jar is not a session. Instagram's cookies stay valid for
weeks; Google's are bound to the browser session that produced them,
and a jar copied out of a profile can be rejected server-side even
when every cookie in it looks right — `studio.youtube.com` answers
with a 302 to `accounts.google.com/ServiceLogin`.

So: **sign in by hand, once, in the browser the poster drives.** The
poster reuses that browser's profile, and the session stays alive
until Google decides otherwise.

## What the poster does

1. Connects to Chrome over CDP and sets the cookies.
2. Opens `studio.youtube.com/upload` and hands the file to the upload
   input through the DOM domain (`DOM.setFileInputFiles`).
3. Fills title, description and tags. Studio's inputs are React
   controlled, so a plain `.value` write is swallowed — the value is
   set through the native setter and then read back, because a write
   that looks like it worked is not proof.
4. Walks the visibility control and logs whether it actually applied.
   Studio's default is Private, so an unset visibility is a warning,
   not a detail.
5. Clicks Publish, waits, and reads the watch URL back from the page.

## Limits

- **Headed Chrome only.** Studio signs you out of headless sessions.
- **One upload at a time.** Studio's upload UI has no queue.
- **The visibility step is a walk, not a setting.** If the control
  cannot be found the poster says so loudly and the video may be left
  on Studio's default.
- **`lib/youtube-batch.js` is a stub.** Its `uploadVideo()` returns
  `{ success: true, url: 'manual' }` before any of the real upload
  code; the 64 videos on the channel were uploaded by hand. Do not
  use it.

## Tests

```bash
npm run test:youtube-poster
```

The pure logic — filename parsing, title/description/tag generation —
is covered, and so is the CDP plumbing. `uploadToYouTube()` takes an
injected `client` and `sleep`, so the whole path runs against a fake
browser that implements only the CDP client's real surface (`send()`
and `js()`). A call to a method the client does not have — which is
how `client.getDOMain()` survived in the committed code, since nothing
could reach the path — now fails the suite instead of failing at
runtime.

The fake is not a browser: it asserts the command sequence and the
values carried into the page, not that YouTube accepted them. The
last mile is still verified by a real run.

