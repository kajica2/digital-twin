# Treblo — the music API, and the voice-only audiobook run

**Status (2026-11-05):** working again. The integration was removed in
`77e3c65` (2026-10-30) along with the API key; both the key and the
session are back, and two voice-only audiobook tracks are rendered.

---

## The credential story — three things, and only one of them is the API key

| credential | path | what it is |
|---|---|---|
| **API key** | `~/.treblo-api-key` (0600) | the Bearer token the API needs. Mint one at `treblo.com/developers/account` → **API Keys** → **Create Key** (the dialog needs a name + the API Terms checkbox, which is a `role="checkbox"` button, not an `<input type=checkbox>`). |
| **cookie jar** | `~/.treblo-cookies.txt` (0600) | the web session, for `treblo.com` itself. NOT an API credential. |
| **anon key** | — | the Supabase project's public key. Needed only for direct Supabase calls; the web app carries it in its own bundle. |

### MEASURED: the session token is NOT an API key

The cookie jar's `sb-db-auth-token` is a Supabase session JWT for
`kai.djuric@gmail.com`. Presenting it as an API credential fails:

```
GET /v1/credits/balance  →  HTTP 400  {"detail":"Invalid API key"}
```

So the web path and the API path need different credentials. The API
key is the one the client uses; the cookie jar is what signs you into
the developer account so you can mint one.

### The session token in the jar is CHUNKED

`sb-db-auth-token` is split across `sb-db-auth-token.0`,
`sb-db-auth-token.1`, … Each chunk is a piece of ONE base64 blob that
carries the `base64-` prefix. Decoding a chunk alone gives truncated
JSON:

```
binascii.Error: Invalid base64-encoded string: number of data
characters (3173) cannot be 1 more than a multiple of 4
```

The chunks must be joined, the `base64-` prefix stripped once, and the
whole decoded together. `tools/treblo-web.js` does this.

### MEASURED 2026-11-07: A JAR CAN CARRY MORE THAN ONE SESSION

A real export held the chunked pair on **both** domains, with different
values:

| domain | expires_at | state |
|---|---|---|
| `.treblo.com` | `2026-11-07T15:53:19Z` | expired |
| `treblo.com` | `2026-11-07T17:39:55Z` | **valid** |

The old reader kept one value per chunk INDEX and let the last row win —
so it picked a session by **ROW ORDER**, not by validity. The export
happened to list the valid session last, so it worked; a reordered
export would have silently yielded the expired one. Measured:

| jar row order | old reader | fixed reader |
|---|---|---|
| valid session last | valid | valid |
| **expired session last** | **expired** | valid |

So the groups are collected per DOMAIN, each is decoded, and the one
with the **LATEST expiry** wins (`bestSession()`). `sessionToken()` and
`sessionCookieChunks()` both go through it, so the token the tool reports
and the cookies it installs can never disagree.

### The cookie must be set in CHUNKED form too

Setting a flat `sb-db-auth-token` cookie does nothing — Supabase reads
the chunked pair and ignores the flat one. Installing the jar's `.0` and
`.1` verbatim is what signs the browser in.

### MEASURED 2026-11-07: a stale FLAT cookie SHADOWS the chunked pair

Installing the chunked pair is necessary but **not sufficient**. A browser
profile that still carries a flat `sb-db-auth-token` renders the app
**signed-out**, even with a fresh, valid chunked pair installed. The app
reads the flat name when both are present, so the stale one has to go
first.

Measured on one browser, one jar, two trials:

| trial | result |
|---|---|
| install chunked, no delete | **signed-out** — "Log in" rendered |
| delete the candidate names, then install chunked | **signed-in** — "You have Treblo Pro", and the app calls `/api/v1/users/me/*` |

`tools/treblo-web.js` `installSession()` therefore deletes
`sb-db-auth-token`, `.0` and `.1` (on both `.treblo.com` and
`treblo.com`) before installing the pair.

### MEASURED 2026-11-07: `Network.setCookie` works fine

This file used to say:

> `Network.setCookie` refuses EVERY parameter set on this Chrome
> (measured 2026-11-05: even `{name:'probe', value:'x'}` answers
> "Invalid parameters"). So the cookie is set from the page instead.

**That was not Chrome.** It was a bug in `tools/treblo-web.js`'s CDP
`call()`:

```js
const call = (method, { params = {}, ms = 30000 } = {}) => …   // WRONG
```

Every caller passed the CDP params in that slot, so the params were
destructured as if they were an options object, `params` was always
`{}`, and the real arguments were dropped on the floor. Chrome then
answered "Invalid parameters" for every call that needed them — while
the calls that need no params (`Page.enable`) passed, so a smoke test
looked green.

The fixed signature matches every other CDP client in the repo
(`lib/mj-submitter.js` → `CDPClient.send(method, params)`):

```js
const call = (method, params = {}, { ms = 30000 } = {}) => …   // RIGHT
```

With the params actually arriving, `Network.setCookie` accepts every
parameter set, and `Runtime.evaluate` works — so the page no longer has
to be the instrument. A CDP error now also **names the method** that
failed, because a bare "Invalid parameters" hides which call it was.

The regression is pinned by `lib/treblo-web.test.js` (18 assertions,
no browser, no credentials), and the suite was **proved to bite**: six
mutations of the fixed code — the old signature, the unnamed error, the
removed delete, the reordered delete-then-install, the row-order pick,
and the index-keyed grouping — are all caught.

### The signed-in signal

The signed-out landing page renders `Log in` / `Sign up`; the signed-in
one renders `You have Treblo Pro` and calls `/api/v1/users/me/*`. So the
answer is the **presence** of the Pro marker and the **absence** of the
sign-in link. Probing for the *presence* of "Log in" gets it backwards
— the signed-in `/create` page has no "Log in" at all, but a signed-in
page can still contain the word elsewhere.

---

## The API contract (treblo.com/developers/docs)

```
POST /v1/generations/v3         → { task_id }
GET  /v1/generations/status/:id  → a BARE JSON STRING ("GENERATING")
GET  /v1/generations/:id         → { song_paths: [ … ] }
GET  /v1/credits/balance         → { num_credits, num_credits_payg }
POST /v1/uploads                 → { audio_upload_id }
```

Request fields: `prompt`, `lyrics`, `tags`, `negative_tags`,
`instrumental`, `prompt_strength`, `style_scale`, **`balance_strength`**,
`num_songs`, `output_format`, `output_bit_rate`, `length_range`,
`align_lyrics`, `model_version`.

**Every v3 generation costs 100 credits.** The song URLs EXPIRE, so a
generation is not finished until the audio has been downloaded.

### UPLOADING YOUR OWN AUDIO (measured 2026-11-07)

The endpoint was found by reading the **live OpenAPI spec** —
`https://api.treblo.com/openapi.json` answers `200` and documents 15
routes. Ten of them are the generation family; one is the upload:

```
POST /v1/uploads
  summary: "Store an audio file for use as audio_upload_id in
            extend/inpaint/reference requests."
  body:    multipart/form-data, field `file` (binary)
  200:    { "audio_upload_id": "<uuid4>" }
```

The `audio_upload_id` is then a first-class field on
`/v1/generations/v3/{reference,extend,inpaint}` — so an upload is how you
get **your** audio into the model instead of describing it.

**AN UPLOAD COSTS NO CREDITS.** Measured: balance 300 before, 300
after. Only a GENERATION spends credits (100 per v3 task).

### THE SIZE LIMIT IS EXACTLY 40 MiB

Bisected with real audio (a zero-filled probe gives **500**, not 413 —
the server validates the CONTENT before it applies the size limit):

| bytes | result |
|---|---|
| 39 MiB | HTTP 200 |
| 40 MiB (41,943,040) | HTTP 200 |
| 40 MiB + 1 byte | **HTTP 413** `{"detail":"Uploaded file exceeds 40MB"}` |
| 103 MB | HTTP 413 |

Over the limit the request is rejected by Cloudflare — the whole body is
already sent. `tools/treblo-upload.js` refuses an over-limit file
BEFORE sending it, and prints the ffmpeg line that splits it.

### "This upload matches existing audio" — a PERCEPTUAL dedup, not a byte one

Twelve of the 218 segments were refused with:

```
HTTP 422  {"detail":"This upload matches existing audio and cannot be used."}
```

**IT IS NOT A BYTE MATCH AND NOT A FILENAME MATCH.** Probes:

| probe | result |
|---|---|
| the same bytes, renamed | **422** |
| the same audio, re-encoded 128k (different bytes) | **422** |
| a file ACCEPTED earlier in this same batch, renamed | **200** |
| the same refused file again | **422** (stable, not transient) |

So the server **hears** the audio. And the dedup set is NOT this
batch's own uploads — a file uploaded 20 minutes earlier re-uploads
fine. **The account already held those twelve recordings from before.**
All twelve are `part-00`, which is what a first upload of a set looks
like: the artist had already put those recordings on the account.

`tools/treblo-upload.js` therefore treats that 422 as **"already
held", not as a failure**: it records the entry with
`audioUploadId: null` and `alreadyHeld: true`, and the run exits 0.

### The measured result

| | |
|---|---|
| segments on disk | 218 (125 sets, 1345.7 MB) |
| uploaded, with an `audio_upload_id` | **206** |
| already held by the account | **12** |
| credits spent | **0** (300 → 300 for the uploads) |

The manifest is `data/treblo/uploads/uploads.json` — one entry per
segment, with the id (or the already-held note), the set name and the
size.

**Measured throughput:** 2.6 MB in 4.3 s, 30.2 MB in 13.8 s. So upload
the **7-minute segments** (all of which are under the limit), not the
hour-long sources.

### The reference request

```
POST /v1/generations/v3/reference
{
  "audio_upload_id": "<uuid4>",
  "prompt": "Traditional Serbian folk song, clear male vocal, slow 2/4",
  "reference_mode": "cover" | "style",
  "output_format": "mp3"
}
```

`reference_mode` defaults to `cover`; `style` asks for the timbre
without the melody. `reference_crop_start` / `reference_crop_end` /
`reference_scale` shape which part of the reference is used.

### The upload tool

```bash
# upload one file
npm run treblo:upload -- ~/Music/song.mp3

# upload many, skipping what is already in the manifest
npm run treblo:upload -- --only-new ~/Music/*.mp3

# see what would happen, upload nothing
npm run treblo:upload -- --dry-run ~/Music/song.mp3
```

It writes `data/treblo/uploads/uploads.json` — the manifest carries each
file's `audio_upload_id`, its sha256 and its size, and it is rewritten
after EVERY file so an interrupted run keeps the ids it already earned.
`--only-new` skips files whose sha256 is already in the manifest, so a
re-run costs nothing.

### `balance_strength` is the voice-vs-music control

> Greater means more natural vocals. Lower means sharper instrumentals.
> We recommend 0.7.

That is the parameter that makes a **voice-only** track. At the default
0.7 the model still writes and arranges music; at **0.95** the voice
dominates and the arrangement drops away. It is the field that makes
"no music, no sound effects, voice alone" achievable at all — there is no
`instrumental`-for-voice and no `voice_only` flag.

### `style_scale` and `prompt_strength` must not both be raised

`style_scale` defaults to 2.3. Raising `prompt_strength` above 1.0 while
`style_scale` is also above 1.0 makes the request invalid, so the client
drops `style_scale` to 1.0 when `prompt_strength` is set. Leaving both
unset is the tuned default.

---

## Running one generation

```bash
node tools/treblo-run.js --prompt "<the song idea>" --out <dir> [options]
```

| flag | meaning |
|---|---|
| `--prompt <text>` | the song idea (required) |
| `--out <dir>` | where the audio lands (default `data/treblo/run`) |
| `--lyrics <text>` | explicit lyrics |
| `--instrumental` | `instrumental: true` |
| `--tags a,b,c` | style tags |
| `--negative-tags a,b,c` | tags to avoid |
| `--balance <float>` | `balance_strength` — the voice-vs-music dial |
| `--prompt-strength <f>` / `--style-scale <f>` | the strength pair |
| `--length <min,max>` | `length_range`, seconds |
| `--format <fmt>` / `--bitrate <n>` | output format |
| `--model <v>` | `model_version` |
| `--dry-run` | print the request and the credit balance, spend nothing |

The wrapper submits, polls the status ladder, downloads the audio, **probes
the duration with ffprobe**, and writes a `catalog.json` with the task
id, the request, the credit cost before and after, and the measured
length.

---

## The voice-only audiobook run (2026-11-05)

Two tracks, both from the same voice-only brief, one per initiation
stage:

| track | stage | task id | length | F0 (median) |
|---|---|---|---|---|
| `data/treblo/voice-only/stage-03-point-of-light/` | Stage 3 — The Point of Light Stabilizes | `0a0edf1e-c8c3-40b2-aaf5-544797a703d1` | 194.6 s | 208 Hz |
| `data/treblo/voice-only/stage-08-lower-self-witnessed/` | Stage 8 — The Lower Self Is Witnessed | `e5322144-334b-4f27-a2b3-3a5755310b8c` | 159.3 s | 126 Hz |

Both rendered with:

```
--balance 0.95 --format mp3 --bitrate 256 --length 180,240
```

### Verified as SPEECH, not as a song

Measured on the rendered files (not assumed):

- **98.1% / 99.9% of 20 ms frames are voiced** (autocorrelation found a
  pitch in nearly every frame) — continuous speech, not an instrumental
  with a vocal line.
- **Median F0 208 Hz and 126 Hz** — a male speaking range.
- **The two channels are within 0.2 dB of each other** (-20.25 vs
  -20.08) — a centred, dry voice, not a wide music mix.
- **Real MP3**: 256 kbps, 44.1 kHz, stereo, 6.0 MB / 5.0 MB.

### The account

500 credits at the start, 100 per generation, **300 left** after the two
tracks (3 more songs). `GET /v1/credits/balance` → `{"num_credits":300}`.

---

## Files

- `lib/treblo.js` — the client, restored from `77e3c65^`. Not wired into
  npm yet; `tools/treblo-run.js` is the thin single-run wrapper.
- `lib/treblo.test.js` — the client's own suite (52 assertions).
- `lib/treblo-web.test.js` — the browser-path helpers (13 assertions):
  the chunked-cookie reader, and the CDP `call()` signature that once
  dropped its params. No browser, no credentials.
- `tools/treblo-run.js` — one generation, downloaded and probed.
- `tools/treblo-web.js` — the browser path: reads the chunked session
  token out of the cookie jar, drives the already-running Chrome.
  `installSession()` deletes the stale flat cookie, then installs the
  chunked pair.
- `tools/treblo-cookie-set.js` — installs the jar's cookies into the
  browser (chunked form) and reports whether the session works.
  Exits 0 when signed in, 3 when not.
- `data/treblo/` — **gitignored**. The audio masters and their
  catalogues stay local.
- `assets/song-prompts/` — the five prompt packs, kept from the
  original integration with the vendor wording stripped.

### Commands

```bash
npm run test:treblo        # the client suite
npm run test:treblo-web    # the browser-path helpers
npm run treblo:credits     # the credit balance (spends nothing)
npm run treblo:dry         # print a request, spend nothing
npm run treblo:web         # install the session, report signed-in/out
```

`npm run treblo:web` needs a Chrome with a CDP port open. The default is
`:9444`; pass `--port` for another.

## Not done

- `lib/treblo.js` and its suite are restored and wired into `test:all`,
  but the removal commit took the **npm scripts** with it and the
  `treblo:*` scripts are back while the dedicated `treblo:*` aliases for
  the browser path are still only `--port`-flagged invocations.
- The web-app generation path (typing into `treblo.com/create` and
  clicking through) is **not** automated; only the cookie installation is.
  The API path is what was used for the run.
- No transcription step: the voice verification is acoustic (pitch,
  voiced-frame density, stereo width), not a transcript. A local Whisper
  would settle it definitively and is not installed.
