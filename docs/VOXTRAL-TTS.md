# Voxtral TTS — the twin's voice

The Twin OS can say a line back. Type into the **Speak** control in the
Today panel and the twin speaks it, using Mistral's **Voxtral TTS 3**
(`voxtral-mini-tts-3-0`).

The text leaves the machine — to Mistral, to be spoken. Nothing is stored:
the server holds the key, Mistral holds the audio, and the twin holds
nothing.

---

## What it is

| Piece | Where |
|---|---|
| The client (one POST, base64 in, bytes out) | `lib/api/voxtral-tts.mjs` |
| The route | `POST /api/tts` in `lib/api/router.mjs` |
| The control | `pages/twin-os/index.html` — the Speak block in the Today panel |
| The tests | `lib/api/voxtral-tts.test.mjs` (unit) + `e2e/twin-os.spec.mjs` (browser) |

There is **no npm package**. The client is a single `fetch` against
Mistral's documented endpoint, the same way `lib/deepseek.js` talks to
DeepSeek — no SDK, no dependency, nothing to install.

## Setup

Get a key at <https://console.mistral.ai> and export it in the shell that
runs the server:

```bash
export MISTRAL_API_KEY='your-key-here'
npm run serve          # or: node lib/serve.js --port 5173
```

Then open <http://127.0.0.1:5173/pages/twin-os/> and use the Speak control.

The key is read from the environment **per request**, so exporting it after
the server is already running works — no restart.

To make the key survive a reboot, add it to the server LaunchAgent's
`EnvironmentVariables` (the plist is at
`~/Library/LaunchAgents/com.kaidjuric.digital-twin.server.plist`). Keep the
key out of the repo: `lib/secrets-guard.test.js` fails the build if
credential-shaped material is ever committed.

### Check it is configured

```bash
curl -s http://127.0.0.1:5173/api/health | python3 -m json.tool
```

```json
"tts": {
  "configured": true,
  "model": "voxtral-mini-tts-3-0",
  "voiceId": "gb_jane_neutral"
}
```

`configured: false` means `MISTRAL_API_KEY` is not in the server's
environment.

## The API

### `POST /api/tts`

Request:

```json
{ "text": "The twin is online.", "voiceId": "gb_jane_neutral", "responseFormat": "mp3" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `text` | yes | — | 1–5000 characters |
| `voiceId` | no | `gb_jane_neutral` | A preset slug — see below |
| `responseFormat` | no | `mp3` | `mp3`, `wav`, `pcm`, `flac`, `opus` |

Response: the **audio bytes**, with the matching content type
(`audio/mpeg`, `audio/wav`, …) and two headers naming the model and the
voice (`x-tts-model`, `x-tts-voice`). The bytes are what a player wants —
there is no base64 to unwrap on the client.

```bash
curl -s -X POST http://127.0.0.1:5173/api/tts \
  -H 'content-type: application/json' \
  -d '{"text":"The twin is online."}' \
  -o hello.mp3
```

Errors are JSON: `{ "error": "…" }`.

| Status | When |
|---|---|
| 400 | No text, or an unknown `responseFormat` |
| 401 | The caller is not trusted (see below) |
| 429 | Mistral is rate-limiting |
| 502 | Mistral refused, or the network failed |
| 503 | `MISTRAL_API_KEY` is not set on the server |

### Who may call it

The route spends the owner's API key, so it is not open. The server binds
`0.0.0.0`, which means the whole LAN can reach it — so the rule is:

1. **The admin key** (`x-admin-key`) always works.
2. **A browser request** (one carrying an `Origin` header) must come from
   this server's own origin. A page on another website is refused even
   though the browser is running on this machine and the request arrives
   from loopback — otherwise any site you visited could spend your key.
3. **A script** (no `Origin` — curl, a local tool) is allowed from this
   machine only.

The Twin OS page is served by the same server, so it is same-origin and
always allowed.

### Voices

Preset voices, from [Mistral's voice list](https://docs.mistral.ai/studio/audio/text-to-speech/voices):

| Voice ID | Name | Language |
|---|---|---|
| `voice_478` | Sheila | English (US) |
| `voice_447` | Margaret | English (US) |
| `voice_485` | Rob | English (US) |
| `voice_1787` | Mary | English (UK) |
| `gb_jane_neutral` | Jane | English (UK) — the default |
| `en_paul_neutral` | Paul | English (US) |
| `fr_marie_neutral` | Marie | French |
| `voice_592` | Marie | French |

An unknown voice is a `404` from Mistral, surfaced as a `502` here.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MISTRAL_API_KEY` | — | The key. Without it the route answers `503`. |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` | Override the API host |
| `MISTRAL_TTS_MODEL` | `voxtral-mini-tts-3-0` | Override the model |
| `MISTRAL_TTS_VOICE` | `gb_jane_neutral` | Override the default voice |
| `MISTRAL_TTS_TIMEOUT_MS` | `60000` | Upstream timeout |

## Tests

```bash
npm run test:voxtral-tts     # the unit suite
npm run e2e:twin-os          # the browser suite (needs a free port; PORT=5199)
```

The unit suite makes no network call and needs no key: the client takes an
injected `fetch`, and the router takes an injected synthesizer. It covers
the request Mistral receives, the base64 decode, every error path, and the
trust rule — including the drive-by-page case.

## Limits and notes

- **The text goes to Mistral.** This is a cloud voice, not a local one.
- **No streaming.** The whole clip is synthesized, then played. Mistral's
  realtime endpoint (`voxtral-mini-tts-realtime-3-0`) would cut the wait;
  it is not wired here.
- **Not on the static deploy.** The Pages/Vercel build is static and has no
  `/api/tts`, so the Speak control reports that the API is not running.
  The control is for the local server.
- **Not credit-metered.** The render endpoints charge the credits ledger;
  TTS does not, because it is not a render. If that changes, the charge
  belongs in the route next to the trust check.
