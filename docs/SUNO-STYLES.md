# Suno style variants — reference

Ten **style variants** of one song, generated from the reference-lock
protocols already published in `pages/suno-prompts.html`.

A style variant is a cover of the same source audio, generated with a
different *style directive* and a different **Audio Influence** value.
The song changes character; the reference it covers does not.

---

## The three scripts

| Script | What it does |
| --- | --- |
| `lib/suno-styles.js` | Pure logic: protocol → variant (tags, title, influence). No network. |
| `lib/suno-web.js` | The authenticated studio client (browser-driven). CLI: `styles`, `create`, `clip`, `billing`. |
| `lib/suno-style-batch.js` | Builds the 10 variants from a song and (optionally) saves them as Suno styles. |
| `lib/suno-run.js` | Submits one generation per variant. |

```bash
npm run suno:web   -- clip --id <clip_id>          # inspect a song's settings
npm run suno:web   -- billing                      # credits
npm run suno:styles -- --song <clip_id> --apply    # build + save the 10 styles
npm run suno:run   -- --song <clip_id> --apply     # generate the 10 songs
```

---

## The composition rule

```
tags = <protocol's "Copy Prompt" directive> + <the song's style descriptor>
```

capped at the server's **1000-character** tag limit, with the
**descriptor always preserved** — the directive is what gives way. A
variant that loses the descriptor is not a variant of the reference
song; it is a different song.

The rule was reconstructed from the user's own saved style batch (the
style titled "Kai record"), not invented.

Field limits, mirrored from `GET /api/custom-model/shared`:

| Field | Limit |
| --- | --- |
| `title` | 100 |
| `tags` | 1000 |
| `negative_tags` | 1000 |
| `prompt` | 5000 |

---

## The ten protocols

Read from `const PRESETS` in `pages/suno-prompts.html` — the canonical
home, so there is only ever one copy.

| # | Protocol | Influence |
| --- | --- | --- |
| 1 | Absolute Fidelity Lock | 90% – 95% |
| 2 | Cover Feature Fidelity | 85% – 92% |
| 3 | Seamless Extend Preservation | 80% – 90% |
| 4 | Vocal Performance Preservation | 85% – 95% |
| 5 | Instrumental Performance Preservation | 85% – 92% |
| 6 | Structure and Arrangement Lock | 85% – 90% |
| 7 | Mix and Sonic Texture Preservation | 88% – 94% |
| 8 | Minimal Technical Change Only | 92% – 96% |
| 9 | Strict Reproduction, Not Remix | 88% – 95% |
| 10 | Ultimate Reference Lock | 90% – 95% |

The **influence** string is a range; the value sent to the API is its
**midpoint**, floored to two decimals (`"90% - 95%"` → `0.92`).

---

## The generation payload

`POST /api/generate/v2-web/` — the shape was read from the endpoint's
own 422 schema, not guessed:

```json
{
  "prompt": "[Instrumental]",
  "task": "cover",
  "cover_clip_id": "<uploaded source clip>",
  "cover_start_s": 0,
  "cover_end_s": 22.36,
  "mv": "chirp-hawk",
  "title": "KO TO TAMO VERA - Absolute Fidelity Lock",
  "tags": "<directive> <descriptor>",
  "negative_tags": "",
  "make_instrumental": true,
  "duration": 198,
  "generation_type": "TEXT",
  "override_fields": ["prompt", "tags"],
  "project_id": "default",
  "transaction_uuid": "<uuid4>",
  "metadata": {
    "is_max_mode": true,
    "control_sliders": {
      "audio_weight": 0.92,
      "weirdness_constraint": 0,
      "aug_creativity": 1
    }
  }
}
```

Two facts the 422 body taught, both now pinned by
`lib/suno-run.test.js`:

- The body is **flat**. A nested `{ params: {...} }` envelope is
  rejected — `params` is the pydantic *model's* name in the 422 `loc`,
  not a field the endpoint reads.
- `duration` must be an **integer**. The reference song reports 198.4
  seconds; sending the fraction returns 422 `int_from_float`.

---

## The captcha

Generation is gated behind **Cloudflare Turnstile**.

```
POST /api/c/check  {"ctype":"generation"}  ->  {"required": true, "captcha_version": 2}
```

The generation body must then carry `token` (the Turnstile token) and
`token_provider: <captcha_version>`, or the server answers 422
`token_validation_failed`. Tokens are **single-use** — a fresh one is
fetched per submission.

The token is obtained by rendering the widget in the live page
(`window.turnstile.render` with the generation site key
`0x4AAAAAADI7xDNyj-3LcIbi`).

### The browser must be headed

**Measured 2026-10-21.** In headless Chrome the widget renders but no
token ever arrives — the request dies at `captcha token timed out`
after 45 s. Headed, the same widget returns a ~730-character token in
about 2 s.

`lib/suno-config.json` therefore ships `"headless": false`, and the
note in that file records the measurement. The headless flag is still
implemented (`launchChrome(port, dir, bin, headless)` in
`lib/mj-submitter.js`) and is re-verified on every run, so a headless
regression fails loudly instead of silently degrading.

---

## Why a browser and not plain HTTP

- `api.suno.ai` answers **503** from this network; `auth.suno.com/api/v1/auth/refresh` answers **404**. Both were probed with the jar's own tokens.
- The API the app actually calls is `https://studio-api-prod.suno.com/api/...`, and it demands `Authorization: Bearer <access token>`.
- That token is **refreshed by the SPA itself** from the `__client` refresh cookie. A hand-exported access token is routinely expired; the browser's session is not.

So the client drives a real browser over CDP and reads the
`authorization`, `browser-token` and `device-id` headers off a request
suno.com actually made.

---

## Credentials

The cookie jar lives **outside the repo**: `~/.suno-cookies.txt`
(Netscape or JSON format). It is covered by `.gitignore`'s
`*-cookies.txt` rule and is not tracked.

> **A jar was committed once** (in `cd434e4`, "Add Suno reference
> prompts tool") and has been untracked. The live `__session` /
> `__client` token is therefore still in the repository's history and
> **must be rotated** — sign out of suno.com everywhere and re-export
> the jar.

---

## Credits

`GET /api/billing/info/` reports the balance. Credits are **reserved
when a generation is submitted and deducted when it completes**, so the
balance right after a submission is unchanged. Measure the cost by
comparing the balance before the first submission with the balance
after the last one completes.

---

## Tests

```bash
npm run test:suno-styles   # 49 assertions — tag composition, influence, presets
npm run test:suno-run      # 25 assertions — the generation body
npm run test:suno-web      # 28 assertions — the request the client builds
```

No network, no browser, no credentials. The three suites are part of
`npm run test:all`.

---

## The manifest

`data/suno/style-variants.json` records every run: the title, the
protocol, the influence value, the source clip, the submitted-at
timestamp, the generated clip id, and the credit balance before and
after. It contains **no secrets** — only ids, titles and tags.

`lib/suno-run.js` skips any variant already marked `ok` in the
manifest, so a re-run only submits what is missing.
