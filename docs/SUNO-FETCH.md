# Fetching a Suno clip as playable audio

Suno's media objects are **encrypted at rest**. Fetching the CloudFront
URL — with `curl`, with `fetch()`, or through the browser — returns
ciphertext: the same bytes every time, with no `ftyp` box, so nothing
will decode it.

The key material is not on the clip payload. It is issued on request by
Mango, Suno's media-rights service. This document is the full procedure:
what the handshake is, how the key is derived, how the bytes are
decrypted, and how to verify the result is really a media file.

Two modules implement it:

| module | what it does |
|---|---|
| `lib/suno-mango.js` | the rights handshake and the AES-CTR decryptor |
| `lib/suno-fetch.js` | the whole run — session, rights, fetch, decrypt, write |

---

## The quick version

```bash
node lib/suno-fetch.js --clip <clipId> \
  [--out data/suno/clips/<clipId>.m4a] \
  [--wait 600] \
  [--port 9455] \
  [--user-data-dir /tmp/suno-profile] \
  [--cookies ~/.suno-cookies.txt]
```

It prints the saved path, the byte count, the algorithm, and the source
URL, and it writes a sidecar `<clipId>.json` next to the media.

**The browser must be headed.** Turnstile does not yield a token in a
headless browser, so a headless run fails at the login wall rather than
at the fetch.

**The cookie jar lives outside the repo** (`~/.suno-cookies.txt`,
mode 0600). Nothing under `data/suno/` or any `*-cookies.txt` is
tracked — `npm run test:secrets` enforces that.

---

## Why the bytes are encrypted

The media URL is a plain CloudFront object:

```
https://d2lwuy8qc234o3.cloudfront.net/1/clip/<clipId>.m4a
```

What comes back is AES-CTR ciphertext. Measured (2026-10-30): the head
bytes are identical for `curl`, `curl --compressed` and the browser's
own `fetch()`, so neither the `Origin` header nor compression
negotiation is the differentiator. `Origin` does change the CDN cache
key (`x-cache` goes `Hit` → `Miss`) — with identical content.

---

## The Mango rights handshake

The key is issued per request:

```
POST https://suno.com/a/api/mango/rights
Content-Type: application/json

{ "content_params": { "content_id": "<clipId>", "content_type": "clip" } }
```

The answer carries three fields:

| field | what it is |
|---|---|
| `key` | base64 — the wrapped AES-CTR key |
| `iv` | base64 — the wrapped AES-CTR IV |
| `glt` | a JWT from `rights.suno.com` — the licence grant |

**The request must come from the page.** It carries the session
cookies, so `lib/suno-mango.js` issues it in-page through the CDP
client rather than from Node.

### The `glt` has a one-hour TTL

The grant is short-lived. The rights are therefore **not cached** —
each run fetches fresh key material. A run that fails with a
`ftyp`-brand error hours after the handshake usually means an expired
`glt`, not a wrong clip id.

---

## Deriving the key

`glt` is not the key. It is the key-encryption key:

```
gcmKey  = SHA-256(glt)                                  // 32 bytes
ctrKey  = AES-256-GCM-decrypt(base64(key), iv = blob[0:12], aad = clipId, key = gcmKey)
ctrIv   = AES-256-GCM-decrypt(base64(iv),  iv = blob[0:12], aad = clipId, key = gcmKey)
```

The details that matter:

- **The GCM IV is the first 12 bytes of the blob itself**, not a
  separate field. The remaining trailing 16 bytes are the auth tag.
- **The AAD is the clip id.** The same `gcmKey` with a different clip
  id yields a different plaintext — so `clipId` must be the exact id
  that was requested, and it must be the same id in both unwraps.
- **The unwrapped key length picks the algorithm**: 16 bytes →
  `aes-128-ctr`, 24 → `aes-192-ctr`, 32 → `aes-256-ctr`.

---

## Decrypting

```js
const cipher = crypto.createDecipheriv(algo, ctrKey, ctrIv);
cipher.setAutoPadding(false);          // CTR is a stream cipher — no padding
const plain = Buffer.concat([cipher.update(encrypted), cipher.final()]);
```

`setAutoPadding(false)` matters: the default padding handling expects
a block-aligned scheme and will throw on a stream cipher.

---

## Verify before you write

A wrong key produces **plausible-looking garbage** — the right number
of bytes, no error, and a file that will not decode. So the decryptor
checks the result starts with an `ftyp` box:

```
decrypted media for <clipId> does not start with an ftyp box (brand: …)
— the key material is wrong or expired
```

**`lib/suno-fetch.js` decrypts before it writes.** The output path
never holds encrypted bytes, not even briefly. The sidecar JSON records
`decrypted: true` and the `algorithm` used.

---

## The fetch path

`lib/suno-fetch.js` tries the plain Node fetch **first**, and only falls
back to reading through the browser when the plain fetch fails (a
session-gated URL, for example):

```
plain fetch  →  node fetch() with AbortController, bounded
browser read →  in-page fetch() + base64, bounded twice:
                  an in-page AbortController  AND  a per-call CDP timeout
```

The in-page read is bounded **twice** on purpose. The in-page
`AbortController` bounds the page's own fetch; the per-call CDP
`timeoutMs` bounds the round trip that carries the result back to Node.
Either alone leaves a hang: without the in-page bound the page waits
forever; without the CDP bound a page that never answers the CDP call
leaves Node waiting forever.

---

## Flags

| flag | default | what it does |
|---|---|---|
| `--clip <clipId>` | — | **required** — the clip to fetch |
| `--out <path>` | `data/suno/clips/<clipId>.m4a` | where the decrypted media lands |
| `--wait <seconds>` | `0` | poll the clip until it has audio (seconds, not milliseconds) |
| `--port <n>` | the configured port | the browser's CDP port |
| `--user-data-dir <dir>` | the configured profile | the Chrome profile to use |
| `--cookies <file>` | the configured jar | the session cookie jar |

`--wait` is in **seconds**. It was milliseconds once, which made the
poll loop exit before the first check could run.

### Exit codes

| code | meaning |
|---|---|
| `0` | the media was fetched, decrypted and written |
| `1` | a fatal error (no cookie jar, no Chrome, a decryption failure) |
| `2` | the clip has no audio yet (with `--wait`, the wait ran out) |

A clip with no audio writes **no file** and no sidecar.

---

## Using a fresh browser profile

The default profile may be locked by another Chrome (the always-on
Suno session holds the lock). Give the run its own:

```bash
node lib/suno-fetch.js --clip <clipId> \
  --port 9460 --user-data-dir /tmp/suno-fetch-profile
```

The session is the **cookie jar**, not the profile — the jar is
injected into the browser on every run, so a fresh or wiped profile
still authenticates. The profile directory is a convenience, not a
dependency.

---

## Rate limits

Suno's API rate-limits per session. Prefer the **singular** route over
a batch one:

```
GET /api/clip/<id>          ← use this
get_songs_by_ids             ← 429 after roughly six reads
```

Reuse one browser session across a batch of clips, and space the
probes. A 429 means *wait*, never *empty*.

---

## Verified

A live run against clip `543c6f53-9dca-4319-b90a-d894f2becc40`:

```
[suno-web] cookies: 42/42 set
[suno-web] session authenticated
[suno-fetch] saved data/suno/clips/543c6f53-….m4a (4.24 MB, aes-128-ctr)
[suno-fetch] source url: https://d2lwuy8qc234o3.cloudfront.net/1/clip/543c6f53-….m4a
```

- The bytes are **byte-identical** to the reference capture
  (`cmp` → no difference).
- `ffprobe` reads them: `codec_name=opus`, `sample_rate=48000`,
  `channels=2`, `duration=247.600000`, `size=4445147`.
- The plaintext was independently confirmed against the app's own
  MSE-decrypted playback: **0 differing samples out of 7,679,376**,
  correlation `1.0`.

---

## Related

- `docs/SUNO-MUTATOR.md` — the variants tool, and the measurements
  that led to the Mango handshake.
- `docs/SUNO-PLAYLIST.md` — putting finished clips in a playlist.
- `lib/suno-web.js` — the authenticated studio client (`SunoClient`).
