# Media Toolchain — local set & server set

One framework for every media tool in this repo, built so that the class of bug
we hit on 2026-10-21 (`FFmpeg is not defined`) cannot reach a user again.

## The incident, and what it taught us

`pages/images-to-mov.html` loaded `@ffmpeg/ffmpeg` from unpkg at runtime and
called `new FFmpegFFmpeg()` — a global that exists in no build of the library.
Every render died with `FFmpeg is not defined`. The page also hand-patched the
worker into a `blob:` URL, because a cross-origin `Worker` is blocked, and a
blob URL has no directory, so the worker's own relative imports died with it.

Three rules came out of that:

1. **One loader.** `pages/assets/ffmpeg-client.mjs` is the only place in the
   repo that boots ffmpeg.wasm. Pages import it; they never import
   `@ffmpeg/ffmpeg` themselves.
2. **No runtime CDN.** The wasm core is vendored under `/vendor/ffmpeg` and
   pinned by sha256 in `vendor/ffmpeg/manifest.json`. The tools work with the
   network unplugged.
3. **One plan.** `lib/render/plan.mjs` builds the ffmpeg argument list for both
   sets, so a browser render and a server render of the same images produce the
   same video.

`node bin/doctor.mjs` enforces all three and fails the build when a page goes
back to rolling its own loader.

## Install

```bash
bin/setup.sh          # or: npm run setup
```

The script is idempotent and does everything a new machine needs:

1. makes sure the **system ffmpeg** and **ffprobe** are on PATH (installs via
   Homebrew when available) and that the build has `libx264`, `zoompan` and
   `concat` — the three things `lib/render/plan.mjs` depends on;
2. `npm install` for the repo root and for `e2e/`;
3. `node bin/install-vendor.mjs` — downloads the pinned ffmpeg.wasm ESM build
   into `vendor/ffmpeg/` and records a sha256 per file in
   `vendor/ffmpeg/manifest.json`. Re-running it re-validates the pins: a
   changed byte is a hard error, not a silent update;
4. `node bin/doctor.mjs` — the full preflight (see below).

Preflight on demand: `npm run doctor`. Vendor check on demand:
`npm run vendor:verify`.

## The two sets

### Local set — browser, ffmpeg.wasm, unmetered

Runs entirely on the user's machine. No server, no credits, no network.

```js
import { renderImagesToMp4 } from '/pages/assets/ffmpeg-client.mjs';

const bytes = await renderImagesToMp4({
  files,                 // File[] — PNG/JPEG/WebP, transcoded to PNG in-browser
  fps: 24,
  duration: 3,           // seconds per image
  kenBurns: 'zoom-in',   // none | zoom-in | zoom-out | pan-left
  container: 'mp4',      // mp4 | mov
});
```

The client exposes `loadFFmpeg()` (the raw ffmpeg.wasm instance), `probeImageSize()`,
`planGeometry()` and `ensureToolchain()`. Every failure path ends in a
`ToolchainUnavailableError` whose message names the exact command that fixes it.

### Shell — the same plan, no browser and no credits

For the repo's own image sets (a Flux pack, the plate families, a daily run):

```bash
node bin/images-to-mp4.mjs assets/marketplace/system-error --size 9:16 --loop
```

`bin/images-to-mp4.mjs` is a third caller of the same two pieces — it decides
which files form the set (`lib/render/sets.mjs`) and hands them to the server
executor; it owns no filter graph of its own. See
[`docs/IMAGES-TO-MP4.md`](IMAGES-TO-MP4.md) for the flags and the measured
numbers.

### Server set — node, system ffmpeg, metered

The same render, executed by the system ffmpeg on the server, charged against a
credit balance. The API lives behind `lib/serve.js` under `/api/`:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | – | ffmpeg version, credit price, vendor status |
| GET | `/api/credits` | bearer | current balance for the caller |
| GET | `/api/credits/pricing` | – | what one render costs |
| POST | `/api/credits/grant` | `x-admin-key` | add credits to a user |
| POST | `/api/render/images-to-mov` | bearer | stills → video (202) |
| POST | `/api/render/thumbnail` | bearer | one still → JPEG (202) |
| POST | `/api/render/clip` | bearer | video → trimmed clip (202) |
| GET | `/api/jobs/:id` | bearer (owner) | job status, kind and progress |
| GET | `/api/jobs/:id/output` | bearer (owner) | the rendered file (video or image) |

All three render endpoints take the same shape — base64 payloads and the
options for the job — and all three are metered the same way:

```jsonc
// POST /api/render/images-to-mov
{ "images": [{ "name": "a.png", "dataBase64": "…" }],
  "fps": 24, "duration": 3, "kenBurns": "zoom-in", "width": 1080, "height": 1080 }

// POST /api/render/thumbnail
{ "image": { "name": "a.png", "dataBase64": "…" }, "width": 320, "height": 320 }

// POST /api/render/clip
{ "video": { "name": "a.mp4", "dataBase64": "…" }, "startSec": 0.5, "endSec": 1.5 }
```

The response is always `{ jobId, status: "queued", kind, creditsCharged, balance }`;
poll `GET /api/jobs/:id` and then fetch `GET /api/jobs/:id/output`.

Credit model:

- A user is a bearer token. The server stores only its sha256; the raw token
  is shown once, at grant time.
- `POST /api/render/...` charges `CREDITS_PER_RENDER` credits (default 1) with
  the job id as the idempotency key, so a retried request never double-charges.
- A failed render refunds the charge automatically.
- Insufficient credits → `402` with the current balance. Another user's job →
  `403`/`404`.

Configuration (environment):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CREDITS_PER_RENDER` | `1` | credits charged per render job |
| `ADMIN_KEY` | `dev-admin-key` | key required by `/api/credits/grant` |
| `PORT` | `5173` | static + API port |

## Layout

```
lib/render/plan.mjs        the shared render plan (browser + node safe)
lib/render/server.mjs      system-ffmpeg executor for the server set
lib/render/sets.mjs        Node-side set questions: which files, size, timing
bin/images-to-mp4.mjs      CLI: a directory of stills → MP4, same plan + executor
lib/credits/store.mjs      sqlite credit ledger (users, ledger, jobs)
lib/api/router.mjs         the /api endpoints
pages/assets/ffmpeg-client.mjs  the one browser loader
vendor/ffmpeg/             pinned ffmpeg.wasm assets + manifest.json
bin/install-vendor.mjs     download + pin the vendored assets
bin/doctor.mjs             preflight: toolchain, encoders, lint
bin/setup.sh               one-shot install
e2e/media-set.spec.mjs     proves both sets end to end
```

The credit database lives at `data/credits.sqlite` and rendered jobs at
`data/jobs/<jobId>/` — both are local runtime state, not source.

## Verification

```bash
npm run e2e:media
```

`e2e/media-set.spec.mjs` covers both halves:

- **Part A — local set.** A real Chrome render of three images with *every
  third-party request blocked*. If a page ever reaches for a CDN again, this
  test fails. The output is probed with `ffprobe` and checked for h264 and the
  expected geometry.
- **Part B — server set.** Grants credits, starts a job, waits for it, fetches
  the MP4, and asserts the balance moved, that a user without credits gets a
  `402`, and that one user cannot read another user's job.
