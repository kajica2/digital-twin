# Treblo — songs from a prompt

Treblo (formerly Sonauto) is a hosted music model with a public API.
This repo wires it into the twin: a prompt becomes a song, the audio is
downloaded before the link expires, and the result is a file the rest
of the pipeline can use.

- **API docs:** https://treblo.com/developers/docs
- **Developer account:** https://treblo.com/developers/account
- **Client:** `lib/treblo.js`
- **Tests:** `lib/treblo.test.js` (`npm run test:treblo`)
- **Page:** `pages/treblo.html` (root copy: `treblo.html`)

---

## The contract

| Step | Call | Result |
|---|---|---|
| submit | `POST /v1/generations/v3` | `{ task_id }` |
| poll | `GET /v1/generations/status/:task_id` | `"GENERATING"` — a bare JSON **string** |
| fetch | `GET /v1/generations/:task_id` | `{ song_paths: [ … ] }` |

Base URL `https://api.treblo.com/v1`. Auth is
`Authorization: Bearer <api key>`.

A v3 generation costs **100 credits**. A **failed** generation is not
charged.

### The status ladder

`RECEIVED` → `PROMPT` → `TASK_SENT` → `GENERATE_TASK_STARTED` →
`BEGINNING_GENERATION` → `GENERATING` → `DECOMPRESSING` → `SAVING` →
`SUCCESS` (or `FAILURE`).

The status endpoint answers with a **bare JSON string** — `"GENERATING"`,
not `{ "status": "GENERATING" }`. The client normalises it, and the
normalisation is the point: the vocabulary is a *pipeline*, so the
poll ends only on a **known final state**
(`SUCCESS`, `FAILURE`, `FAILED`, `ERROR`, `CANCELLED`, `CANCELED`,
`EXPIRED`, `REJECTED`, `REFUSED`) and keeps going through every other
step. A body it cannot read three times in a row ends the run with
`UNREADABLE_STATUS` rather than hanging until the timeout.

> Two earlier versions of this client got this wrong, and both cost
> live generations. The first compared against `SUCCESS`/`FAILURE`
> only, so a body that is not an object never matched and the poll
> hung. The second treated "not a known in-progress state" as
> terminal — which killed five running generations the moment they
> reported `PROMPT`, because `PROMPT` was not in the allowlist. The
> rule is now: **terminal means a known final state**, never the
> absence of a known one.

### The request body

The API's own best practice: **send the prompt and nothing else.** The
model infers the tags, the lyrics and the tuning; hand-written tags
usually make the result worse.

```json
{ "prompt": "a chill lofi beat for studying" }
```

For an instrumental:

```json
{ "prompt": "…", "instrumental": true }
```

`instrumental: true` and **no lyrics** — the two contradict each
other, so the client drops the lyrics rather than sending both.

Useful extras (all optional): `tags` (min 1 if you send it),
`negative_tags`, `length_range` `[min, max]` in seconds (multiples of
30, min 0–270, max 30–300), `output_format` (`mp3` | `ogg` | `flac` |
`wav` | `m4a`; default `ogg`), `output_bit_rate` (mp3/m4a: 128, 192,
256, 320), `style_scale` (1.0–12.0, default 2.3), `prompt_strength`
(1.0–4.0, default 1.0), `webhook_url`, `align_lyrics`.

> **v3 tuning:** exactly one of `style_scale` and `prompt_strength`
> must be greater than 1.0. Raising `prompt_strength` above 1.0 means
> dropping `style_scale` to 1.0. The client sends neither by default.

---

## The key

The key is **never in the repository**. The client reads it from, in
order:

1. `$TREBLO_API_KEY`
2. `~/.treblo-api-key` (mode 0600, outside the repo)

```bash
printf '%s' 'your-key-here' > ~/.treblo-api-key
chmod 600 ~/.treblo-api-key
```

The key is minted at
https://treblo.com/developers/account → **API Keys** → *Create Key*
(a name and the API-terms checkbox).

`.gitignore` carries `*-api-key`, `*.api-key`, `.api-key` and
`treblo-api-key` as a second line of defence. The real file lives
outside the tree, so those rules are a net, not a lock.

---

## Running it

A pack is **one top-level bullet per prompt** — the same convention the
Midjourney packs use, so one file can feed both pipelines. Frontmatter,
blockquotes and code fences are ignored.

```bash
# the plan and the credit cost — nothing spent
npm run treblo:dry -- --prompt-file assets/treblo-prompts/kai-djuric-5.md

# the run
npm run treblo:generate -- --prompt-file assets/treblo-prompts/kai-djuric-5.md \
  --out data/treblo/kai-djuric-5 --instrumental
```

Flags:

| Flag | Meaning |
|---|---|
| `--prompt-file <file>` | a pack: one top-level bullet per prompt |
| `--prompt "<text>"` | a single prompt |
| `--out <dir>` | where the audio + `catalog.json` are written |
| `--instrumental` | instrumental (the default) |
| `--vocal` | allow the model to write lyrics |
| `--format <fmt>` | `mp3` (default) \| `ogg` \| `flac` \| `wav` \| `m4a` |
| `--limit <n>` | only the first n prompts |
| `--no-download` | do not fetch the audio (the URLs expire — do not) |
| `--adopt <taskId>` | finish a task that is already running (repeatable) — no new submission, no new credits |
| `--dry-run` | print the plan and the credit cost, spend nothing |
| `--json` | machine-readable output |

### What a run writes

```
data/treblo/<pack>/
  01-<slug>.mp3        the audio
  02-<slug>.mp3
  catalog.json         prompt → task id → file → size
```

`data/` is gitignored — the audio is working product, not repo content.

### Adopting a running generation

A generation that was started and then abandoned is not a lost one —
it is already paid for, and the task id is all the client needs:

```bash
npm run treblo:generate -- --adopt <taskId> --out data/treblo/<pack>
```

`--adopt` **makes no POST**: it reads the prompt from
`GET /v1/generations/:id`, polls the same ladder, and downloads the
audio when the task reaches `SUCCESS`. The catalog records
`source: "adopted"` and each item carries `adopted: true`.

The extension follows the URL that came back, not the requested
format — an `.ogg` answer to an `mp3` request is saved as `.ogg`,
because a file whose name lies about its container is a trap for
whatever plays it next.

### The URLs expire

Treblo's own words: the song URLs are *unlisted rather than
access-controlled* — anyone with the URL can fetch the file — and they
**expire**. A run that records a URL and never downloads the audio has
produced nothing. The client therefore always downloads, and a
`SUCCESS` with no `song_paths` is an **error**, not a quiet success.

---

## The five prompts

`assets/treblo-prompts/kai-djuric-5.md` — five instrumentals:

1. Melancholic flugelhorn soliloquy, warm tape saturation, sparse Rhodes.
2. Smoky muted trumpet, amp reamping, slow walking bass.
3. Percussive trumpet staccato, Ethiopian pentatonic, doubled with EWI.
4. Floating flugelhorn fragments, tape loops, degrading repeats.
5. Triumphant trumpet lead, gospel-inflected hard bop, layered horns.

Five generations = **500 credits**.

---

## Out of credits

The API answers:

```
HTTP 402  {"detail":"Out of credits. Please purchase more at https://treblo.com/developers."}
```

Nothing is charged, and the client's error names the page that fixes
it: **https://treblo.com/developers/account** → *Activate Free Trial*
(verify a card, 3,000 free credits ≈ 30 songs, no charge, no
auto-conversion).

> This is the answer to a 402, not a statement about any particular
> account. The key in use during the first real run was accepted and
> the generations completed — the 402 was read out of a *probe* that
> had been given a deliberately bad key.

---

## What the twin does with the songs

A song is a normal file once it is downloaded. The reel pipeline can
cut a vertical clip from it, the social worker can package it with a
caption and a price, and the song indexer can catalogue its metadata.

```
prompt → POST /generations/v3 → task_id → poll /generations/status
       → song_paths → download → data/treblo/<pack>/NN-slug.mp3 + catalog.json
```

---

## Tests

```bash
npm run test:treblo     # 39 checks, no network, no credentials
npm run e2e:treblo      # the page contract (Puppeteer)
```

The unit suite drives a **fake transport**: it asserts the request the
client builds, the way it reads the responses, and what it does when
the account has no credits. The e2e spec is a page contract — no
credentials, no API calls.

Two real bugs were found by writing them:

- The 402 guidance lived in `err.detail` while the CLI printed
  `err.message`, so the fix hint never reached the user. The message
  carries the fix now.
- The test harness was synchronous while nine checks were async, so an
  async failure printed as a **pass** and escaped as an unhandled
  rejection. The helper awaits now.

---

## Limits

- **No streaming in the client.** The API can stream a v3 song
  (`enable_streaming`, `stream_format`); the client polls instead —
  simpler, and the whole song lands on disk.
- **No extend / inpaint / reference endpoints.** The client covers
  generation only.
- **No lyrics alignment.** `align_lyrics` exists in the API; the
  client does not request it.
- **Credits are the account's.** The client has no way to buy them.
