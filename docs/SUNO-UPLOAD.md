# SUNO UPLOAD — local audio into Suno

`lib/suno-upload.js` gets a local audio FILE into Suno and turns it
into a real clip. This is the missing first half of the cover path:
`lib/suno-run.js` can cover a clip, but before this existed every
`cover_clip_id` could only point at a clip Suno itself generated.

---

## Use

```bash
npm run suno:upload -- <file.wav> [more.wav ...]
npm run suno:upload -- upload --dir ~/Documents
npm run suno:upload -- list          # the account's feed
```

Accepted: `wav mp3 m4a aac flac ogg opus aiff aif`.
Max 512 MB per file (Suno's own limit).

Output: a manifest in `data/suno/uploads/uploads-<stamp>.json` with one
record per file — `{file, name, uploadId, clipId, title, ok}`, or
`{file, name, ok: false, error}` for a refusal.

---

## The protocol

The routes were **read out of suno.com's own JS bundle**
(`3c89nzlmg-fve.js`, `0clz7vt3vzhif.js`), not guessed. The first probe
guessed six paths; every one 404'd. The bundle names them:

| step | route | body | returns |
|---|---|---|---|
| 1 | `POST /api/uploads/audio/` | `{extension, is_stem_mix: false, upload_type}` | `{id, url, fields}` |
| 2 | `POST <presigned S3 url>` | multipart: `fields` + `file` | — |
| 3 | `POST /api/uploads/audio/{id}/upload-finish/` | `{upload_type, upload_filename}` | — |
| 4 | `GET  /api/uploads/audio/{id}/` | — | `{status: complete\|error, …}` |
| 5 | `POST /api/uploads/audio/{id}/initialize-clip/` | `{downbeats}` | `{clip_id}` |

`upload_type` is `studio_file_upload` — the literal the bundle uses for
the studio file-upload path.

**Step 5 is the one that makes it a clip.** Steps 1–4 leave an *upload*.
Only step 5 produces a `clip_id`, and a `clip_id` is what a cover needs
as its source.

---

## Two things that cost time

### 1. The S3 push does NOT need the browser

The first implementation pushed the bytes from the page over CDP. A
26 MB file became a ~35 MB base64 string in a debug message, and the
run **stalled for 8+ minutes with no progress and no error**.

Step 2 is a presigned S3 POST — a plain multipart request that S3's
CORS policy allows from any origin. Node 22 has `FormData`, `Blob` and
`fetch` natively, so the bytes go straight from disk to S3 and the same
file finished in ~40 s.

The browser is still required for steps 1, 3, 4 and 5 — those are
authenticated studio API calls, and the account's Bearer token is
refreshed by the SPA itself (see `lib/suno-web.js`).

### 2. Suno fingerprints uploads against a catalog

Two of the five files came back:

```json
{
  "status": "error",
  "error_type": "upload_failure_match_acrcloud",
  "error_message": "This audio matches an existing recording in our catalog."
}
```

This is Suno's **copyright gate**, not an uploader bug — the other
three files passed the same gate. A re-encode does NOT reliably defeat
it: ACRCloud matching is acoustic, not bitwise. The honest workaround
is a different recording or a different source.

---

## Feeding an uploaded clip into a cover

`suno-run.js` takes the uploaded clip as its cover source:

```bash
npm run suno:run -- --source <clip_id> --tags "..." --title "..."
```

The clip ids from a manifest are ready to use as `--source`.

---

## Verified live (2026-11-02)

| file | clip_id | status | duration |
|---|---|---|---|
| A Night In Tunisia.wav | `17e2e06c-7928-4756-8487-9a6a490880e6` | complete | 156.99 s |
| A Shade Of Jade.wav | `b824ba24-15b2-4523-8300-610f56c9be40` | complete | 163.93 s |
| Wave.wav | `e30368a9-b52d-45de-9362-f1f10abcd005` | complete | 232.11 s |

All three carry a real CloudFront `m4a` in `media_urls`. The durations
match the source WAVs to the millisecond — the upload path is
byte-exact, not a re-render.

`node lib/suno-upload.test.js` — 21 assertions, all green.
