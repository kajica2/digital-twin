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

# Set the details of a video that is already uploaded — no file, no
# second upload, and the input is left where it is:
node lib/youtube-poster.js --resume <videoId> --title "..." --tags "a,b"
```

Exit codes: `0` uploaded · `1` fatal · `2` uploaded but the claim
could not be confirmed.

## Configuration

`lib/youtube-config.json`:

| key | meaning |
|---|---|
| `cookiesFile` | Netscape cookie jar — **outside the repo**: `~/.youtube-cookies.txt` (never in the tree; `lib/secrets-guard.test.js` fails if a jar moves inside) |
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
2. Opens `studio.youtube.com` and — this is the part that is easy to
   get wrong — clicks **Create → Upload videos**. The channel
   dashboard has **no file input at all**; the input (`Filedata`)
   only exists once that dialog is open. A file handed to an input
   nobody is listening to starts nothing.
3. Hands the file over through the DOM domain
   (`DOM.setFileInputFiles`) and then **dispatches the input's
   `change` event**. `DOM.setFileInputFiles` sets the file but fires
   no event, and YouTube's uploader starts on that event — which is
   why Puppeteer's `uploadFile()` dispatches it.
4. Waits for the upload to finish, then **finds the video in the
   channel's content list** and opens its own edit page. The URL is
   built from that id. Reading a watch link off the page does not
   work: a Studio page is full of watch links, and only one of them
   is the upload.
5. Fills in the details **on the edit page**, where the fields are
   reachable — in the upload dialog they sit behind closed shadow
   roots.
6. Clicks Save and waits for Studio to say it saved.

## The details are typed, not assigned

Three things about Studio's edit page cost a session each, and all
three are the same lesson: **a write that looks like it worked is not
proof.**

| field | what it really is | what works |
|---|---|---|
| title | a `contenteditable` div, aria-label *"…describes your video"* | focus → select the contents → `Input.insertText` |
| description | a `contenteditable` div, aria-label *"…Tell viewers about your video"* | the same |
| tags | a **chip editor** behind a "Show more" button | type each tag → **Enter** commits it as a chip |
| visibility | a dropdown whose container carries `privacy-public-icon` | read the class, open `#select-button` only if it is not the wanted one |

The title and description are typed because a contenteditable bound
to a model ignores a value that was never typed into. The tags are
typed **and committed with Enter** because the input is a chip
editor: typed text sits in the input until Enter turns it into a
chip, and saving without that loses every tag. (An earlier version
of this tool typed a comma-joined list and saved — and the video
quietly kept the tags it already had.)

The visibility is verified by **reading the control's own class**,
not by trusting a click. Studio's default is Private, so an unset
visibility is a warning, not a detail.

## Limits

- **Headed Chrome only.** Studio signs you out of headless sessions.
- **One upload at a time.** Studio's upload UI has no queue.
- **`lib/youtube-batch.js` is a stub.** Its `uploadVideo()` returns
  `{ success: true, url: 'manual' }` before any of the real upload
  code; the 64 videos on the channel were uploaded by hand. Do not
  use it.
- **The save confirmation is a toast.** It takes a few seconds and
  it does not appear when there was nothing to save, so the poster
  also treats a disabled save button as confirmation.

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

