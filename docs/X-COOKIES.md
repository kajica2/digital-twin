# Posting to X (Twitter)

The twin can post to X on your behalf. This is the reference for the
cookie, the poster, and the gates in front of them.

Three pieces:

| Piece | What it is |
|---|---|
| `lib/x-cookie-capture.js` | Captures your logged-in X session out of Chrome into a cookie jar |
| `lib/x-cookies.js` | Parses and validates that jar; encodes it for the browser |
| `lib/x-poster.js` | Posts a caption (and optional media) through the web composer |
| `lib/x-text.js` | The 280-character rules |

---

## Why the web UI and not the API

X's REST endpoints reject this session with a **401**:

```json
{"errors":[{"code":89,"message":"Invalid or expired token"}]}
```

That happens with a perfectly valid cookie, the public web bearer and
a correct `x-csrf-token`. The API and the website are separate
authentication systems for third-party clients, and there is no
documented path through them.

So the poster drives the **web composer in a headed browser**, exactly
like `lib/ig-poster.js` drives Instagram. Two consequences worth
knowing:

- **The session check is a page check.** "Is the composer there and is
  the login wall down?" — not "does an API call return 200?". An
  API-first poster would look broken while the cookie is fine.
- **The browser must be headed.** Headless Chromium gets challenged by
  Cloudflare on the compose page.

---

## Capturing the cookie

```bash
node lib/x-cookie-capture.js            # capture to ~/.x-cookies.txt
node lib/x-cookie-capture.js --check    # validate what is on disk
node lib/x-cookie-capture.js --profile "Profile 1"
node lib/x-cookie-capture.js --out ~/somewhere/else.txt
```

The capture reads Chrome's own cookie database, decrypts the values
with the **Chrome Safe Storage** key from the macOS Keychain, and
writes a Netscape cookie jar.

It is **hard-scoped to X**: the host allowlist (`.x.com`, `x.com`,
`.twitter.com`, `twitter.com`) is applied *before* anything is
decrypted, so the tool cannot be repurposed into a general credential
extractor for your browser. If another platform needs this treatment,
it gets its own module with its own allowlist.

**The jar lives outside the repo** (`~/.x-cookies.txt`, mode `0600`).
The capture refuses to write anywhere inside the repository, and
`.gitignore` carries a `*-cookies.txt` rule as a second line of
defence. A cookie in git history is a leaked session.

### Which profile

Chrome keeps a separate cookie database per profile. The capture
reports every profile that holds X cookies and picks the one whose
`auth_token` expires **latest**:

```
captured: 19 X cookies from Chrome profile "Profile 1"
jar: ~/.x-cookies.txt
domains: .twitter.com, .x.com, x.com
session: complete (auth_token + ct0)
other profiles with X cookies: Default (19, complete); Profile 2 (5, no session)
```

A profile with cookies but no `auth_token` is not a logged-in session —
the capture says so rather than writing a jar that will not work.

### What a valid session needs

Two cookies, both required:

| Cookie | Why |
|---|---|
| `auth_token` | The session itself |
| `ct0` | The CSRF token. X's page reads it out of `document.cookie`, so it must **not** be marked HTTP-only — marking it HTTP-only breaks every write while still authenticating the read. |

`lib/x-cookies.js` preserves the `httpOnly` flag on the way through the
jar round trip, which is why `auth_token` stays HTTP-only and `ct0`
does not.

### The `__Host-` rule

A cookie named `__Host-…` must be sent **without** a `Domain`
attribute — the browser drops it silently if you set one, and the site
renders "Log in" with no error at all. The only symptom is a timeout
waiting for a composer that never appears.

`toBrowserCookies()` handles it: those cookies are expressed with a
`url` + `path: /` + `secure: true` and no domain. Today's X jar has no
`__Host-` cookies, but the rule is encoded anyway.

---

## Posting

```bash
node lib/x-poster.js --text "hello world"
node lib/x-poster.js data/social/neon-pulse-cover     # a package
node lib/x-poster.js --text "hello" --dry-run         # fit and print only
```

The poster:

1. loads the jar, validates `auth_token` + `ct0`;
2. launches (or attaches to) a **headed** Chrome on port 9447;
3. sets the cookies;
4. opens `https://x.com/compose/post`;
5. asserts the composer is there and the login wall is down;
6. types the caption with `Input.insertText`;
7. waits for `button[data-testid="tweetButton"]` to become **enabled**;
8. clicks it, and waits for the toast **"Your post was sent."**;
9. reports the new `a[href*="/status/"]` link.

### The composer is not a textarea

The composer is a **React-controlled contenteditable DIV** with
`data-testid="tweetTextarea_0"`. Assigning `innerText` does nothing the
page can see — the Post button stays disabled. `Input.insertText` types
the way a person does, and the button comes alive. It also handles
embedded newlines correctly.

Two traps:

- **Assert on `tweetButton`, not `tweetButtonInline`.** The inline
  button stays disabled in the composer modal. Waiting for it gives a
  false negative.
- **The cleared textbox is not a success signal.** X clears the
  composer whether or not the submission was accepted. Success is the
  toast text and the new status link.

### Media

X takes one video or up to four images. The poster attaches media with
`DOM.setFileInputFiles` — a real DOM node, so CDP hands it absolute
paths directly, with no base64 round trip through the page.

The files come from the **package directory**, not from `post.json`.
The engine links an item's media into its package as symlinks, so the
package directory *is* the media list; resolving it that way keeps the
shipped package free of machine-specific paths.

X opens an alt-text dialog over the composer after an upload. It is a
modal, so it has to be dismissed before the Post button can be
clicked — Escape, with a `[aria-label="Close"]` fallback.

---

## The 280-character rule

X counts a tweet in **weighted** characters, not raw ones:

- most Latin text counts 1 per character
- CJK, emoji and other wide characters count 2
- a URL counts as 23, no matter how long it is

The engine's caption is body + a full line of hashtags, which comes to
**424 characters** for a typical package. Something has to give, and
which thing gets cut is a publish decision:

- the **body wins** — it is only shortened if it cannot fit on its own;
- the **hashtags** fill what is left, in tier order (primary →
  secondary → niche);
- the first tag that does not fit **ends the list** — a less important
  tag must not displace a more important one;
- whatever was dropped is **reported**, not silently discarded.

`lib/x-text.js` is the implementation; `lib/x-poster.js` fits the
caption again on the way out (fitting is idempotent), so the poster is
safe on its own with any text.

The trim happens in `lib/social-engine.js` at **package build time**,
not in `lib/social-shared.js`. The shared module is the one
implementation of "what a caption is" and must not grow a per-platform
rule. Trimming at build time is what makes the stored caption and the
published caption the same string — a package that says one thing and
posts another is a lie in the record.

---

## The gates

Posting to a personal account is the least reversible thing this repo
does, so there are three switches and they are all off by default.

```jsonc
// lib/social-config.json
"posting": {
    "enabled": true,            // master switch for the whole posting path
    "autoPublish": false,       // false = an item must say publish: true
    "dryRunPoster": false,      // true = run the poster, but with --dry-run
    "twitter": {
        "enabled": false,       // false = X is never posted to, even if the item opts in
        "poster": "lib/x-poster.js",
        "dryRunPoster": false
    }
}
```

`posting.twitter.enabled` is separate from `posting.enabled` on
purpose. Arming it is a deliberate edit, and it needs a valid session
cookie.

The per-item opt-in (`publish: true` in the item's `item.json`) is the
real gate: **every item in the live catalogue currently has
`publish: false`**, so nothing posts.

A dry run is not a post. The registry keys "already published" off the
result, so a dry run that claimed it would keep the item from ever
being picked up again.

---

## Tests

```bash
npm run test:x-cookies    # the jar format, the __Host- rule, the capture
npm run test:x-text       # the character counting and the fitting
npm run test:x-poster     # the poster's pure parts — caption, media, args
```

No browser, no network, no cookies. The live half — the composer, the
Post button, the file input — is exercised by the smoke run, not by the
suite.

---

## Troubleshooting

**"the composer is missing or the login wall is up"**
The jar is not a logged-in session, or it expired. Re-capture:
`node lib/x-cookie-capture.js`.

**The poster times out waiting for the Post button**
The caption was not accepted by the composer. Check the character
count first — the poster logs `caption: N/280 characters`.

**`cookie file not found`**
`~/.x-cookies.txt` does not exist. Run the capture.

**`cookie jar is missing auth_token, ct0`**
The profile was not logged in, or only part of the session was written.
`node lib/x-cookie-capture.js --check` says which.

**A 401 from `api.x.com`**
Expected. See "Why the web UI and not the API" above. It does not mean
the cookie is bad.

**The failure message does not say enough**
The browser is a black box: a failure can be a dialog that closed, a
test id that moved, or a session that expired, and the one-line message
rarely says which. Set `X_POSTER_DEBUG` and the poster writes the
error and the stack to a file:

```bash
X_POSTER_DEBUG=1 npm run x:post -- --text "hello"   # → $TMPDIR/x-poster-error.json
X_POSTER_DEBUG=/tmp/x-debug.json npm run x:post -- --text "hello"
```

The file carries the error message and the stack. It never carries a
cookie value.
