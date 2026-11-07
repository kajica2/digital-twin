# Treblo upload — batch the tracks into Treblo's developer API

The 29 tracks cut from *Traditional Music of Western Serbia* (see
`docs/AUDIO-SPLITTER.md`) needed to reach Treblo so they can be used as
references for new generations. `lib/treblo-upload.js` does that in one
command and writes down what came back.

```bash
node lib/treblo-upload.js "album-split"/*.mp3
npm run treblo:upload -- "album-split"/*.mp3      # the same thing
```

## The endpoint

```
POST https://api.treblo.com/v1/uploads
Authorization: Bearer <TREBLO_API_KEY>
Content-Type: multipart/form-data      field: file
→ 200 {"audio_upload_id": "<uuid>"}
```

It was read out of the API's own OpenAPI schema
(`https://api.treblo.com/openapi.json`), not guessed: the request body is
`Body_upload_audio_v1_uploads_post` with a single required binary field
named `file`.

**An upload costs no credits.** It stores a file; only a generation spends
the balance (`GET /v1/credits/balance` is what moves).

## The key

`TREBLO_API_KEY`, or `~/.treblo-api-key` (mode 0600, outside the
repository — the repo's secrets guard checks that every cookie and key path
resolves outside the tree). Never on the command line: an argv is visible to
every process on the machine and lands in shell history.

## What came back

**28 of the 29 tracks uploaded.** The report is in
`data/treblo/uploads.json` (gitignored) with the id of every file.

The one refusal is Treblo's own, and it is worth reading rather than
working around:

```
HTTP 422: This upload matches existing audio and cannot be used.
```

Re-encoding the file (192 k → 160 k) does **not** change the answer: the
match is perceptual, not byte-wise. So that piece is already known to
Treblo — most likely because it was uploaded before from another copy of the
same recording. There is no `GET /v1/uploads` to look the existing id up
with: the API offers `POST /v1/uploads` and nothing else on that path.

## The tool

- `lib/treblo-upload.js` — zero dependencies, Node's own `fetch` and
  `FormData`.
- `lib/treblo-upload.test.js` — 12 assertions, no network and no key: the
  key lookup, the flag guard, the multipart request, a missing file, a
  server error, a response with no id, and a batch that continues past one
  failure and reports every file.
- An **unknown flag is refused** with exit 2, never ignored — the same rule
  the rest of the twin's CLIs follow after the `--help`-started-a-render
  incident.
- `--dry-run` lists what would be uploaded without uploading anything;
  `--json` prints the report to stdout; `--out` chooses where the report
  lands.
