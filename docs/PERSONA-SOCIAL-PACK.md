# Persona Social Pack

Give the page a URL that carries creative-persona descriptions. It finds
every persona on that page and returns, for each one:

- **three hashtag tiers** — primary (5–7), secondary (7–10), niche (10–15)
- **YouTube metadata** — title, description, tags
- **four social posts** — Instagram, TikTok, X/Twitter, Facebook captions

A port of [Persona-hashtags](https://github.com/kajica2/Persona-hashtags)
to the twin's conventions: no build step, no dependencies, plain DOM on
the page and a CommonJS module in Node.

| | |
|---|---|
| Page | `pages/persona-social-pack.html` |
| Logic | `lib/persona-social-pack.js` |
| Unit suite | `lib/persona-social-pack.test.js` (`npm run test:persona-social-pack`) |
| e2e | `e2e/persona-social-pack.spec.mjs` (`npm run e2e:persona-social-pack`) |

## Run it

```bash
node lib/serve.js --port 5173
# → http://127.0.0.1:5173/pages/persona-social-pack.html
```

Paste a Gemini API key into the page and hit **Generate pack**.

## The key never leaves the tab

The twin is a static site — there is no `api/` directory, and
`lib/serve.js` is a GET/HEAD-only static server shared with a launchd
LaunchAgent, so it is not the place for a secret. The page therefore
calls Gemini **from the browser**:

```
POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
headers: x-goog-api-key: <key>, Content-Type: application/json
body:    {"contents":[{"parts":[{"text": prompt}]}],
          "tools":[{"url_context":{}},{"google_search":{}}]}
read:   candidates[0].content.parts[*].text
```

- The key lives in **`sessionStorage` only** — it dies with the tab. It is
  never written to the repo, to `localStorage`, or to any file. The e2e
  asserts both halves of that: the key is in `sessionStorage` and
  `localStorage` carries no key at all.
- The tool keys are **snake_case** in the v1beta REST body (`url_context`,
  `google_search`); camelCase is SDK-only.
- `url_context` reads the page at the URL, `google_search` backs the
  fallback prompt's "find a better URL".
- Default model `gemini-2.5-pro`, overridable in the page.

CORS was verified against the live endpoint: the `OPTIONS` preflight
returns 200 with `access-control-allow-origin` echoing the origin and
`access-control-allow-headers: content-type,x-goog-api-key`, so a
browser-side call is viable.

## The JSON contract

One array. Upstream's five keys are unchanged; the platform content is
added alongside, never replacing:

```json
[{ "personaName": "…", "description": "…",
   "primarySet": ["#…"], "secondarySet": ["#…"], "nicheSet": ["#…"],
   "youtube": { "title": "…", "description": "…", "tags": ["…"] },
   "social": { "instagram": { "caption": "…" }, "tiktok": { "caption": "…" },
               "twitter": { "caption": "…" }, "facebook": { "caption": "…" } } }]
```

Two-phase generation is preserved from upstream: the base prompt runs
first, and only if it comes back empty does the fallback prompt run
(search for a better URL, then analyse that). "Empty" includes a blank
answer — see *Nothing found is not an error* below.

## Normalisation

- every tag is forced to start with `#`; blanks dropped; duplicates
  removed (case-insensitively)
- tier sizes are capped at the declared maximum (7 / 10 / 15) and are
  **never padded** — a short tier is reported as a warning on the card,
  not invented
- missing `youtube` / `social` sub-objects are tolerated: they come back
  empty, they do not throw
- `youtube.tags` keep their `#`; `tagsCsv` is the `--tags "a,b,c"` string
  `lib/youtube-poster.js` expects, so the CSV drops the `#`

## POST.md and `lib/ig-poster.js`

`toIgPostMd(persona)` writes the file `lib/ig-poster.js` reads to post a
reel. That file's `readCaption()` is not exported, so the unit suite
replicates its parse loop exactly and asserts the generated file against
it. The behaviour it encodes:

- the title is the first `# ` heading
- a `## ` heading switches "inNext" on when the heading says `Next`
- the first non-empty line after `## Next` **breaks** the loop, so
  nothing after it enters the body
- `hashtags` is `content.match(/#[a-zA-Z0-9_]+/g)` over the **whole
  file**, not just the body

So the generated file is:

```
# <persona name>

## Caption

<caption body — inline #tags stripped>

## Next

1. Open the Instagram app → Reel → Upload.
2. Paste the caption above, then the hashtag line.

## Hashtags

#tag1 #tag2
```

→ the body is the caption alone, the hashtags are read out of the
trailing section, and every tag appears **exactly once** in the posted
caption. The `## Hashtags` section deliberately sits *after* the
`## Next` break, so it is never part of the body.

## Lib API

```js
buildPrompt(url)            // base prompt: personas + 3 tiers + youtube + 4 socials
buildFallbackPrompt(url)    // upstream's "find a better URL, then analyse it"
parsePersonas(text)         // strip ```json fences → JSON.parse → must be an array
normalizePersona(raw)       // '#'-prefix, dedupe, tier caps, coerce missing fields
buildPlatformContent(p, o)  // assemble youtube + the four social captions
toIgPostMd(p)               // ig-poster-compatible POST.md
toYoutubeMetadata(p)        // {title, description, tags[], tagsCsv}
generatePack(url, o)        // Gemini call; o = {apiKey, baseUrl, model, fetch}
```

`lib/persona-social-pack.js` is dual-mode: CommonJS in Node, and
`window.PersonaSocialPack` in the page. Zero dependencies; the `fetch`
and `baseUrl` are injectable, which is how the unit suite drives the
whole Gemini path against a local stub server without a key.

### Error convention

Follows `lib/deepseek.js`: `err.code = 'NO_KEY'` with a message that
names the env var (`PERSONA_PACK_API_KEY`) and how to get one. The key
is never echoed — only `redactedKey()`'s masked preview is ever shown.

| code | meaning |
|---|---|
| `NO_KEY` | no API key was supplied |
| `NO_URL` | no URL was supplied |
| `EMPTY_RESPONSE` | `parsePersonas` was handed an empty string |
| `INVALID_JSON` | the response was not JSON |
| `NOT_AN_ARRAY` | the response was JSON but not an array of personas |
| `NO_CANDIDATES` | the API answered 200 with no `candidates` array at all |
| `TIMEOUT` / `NETWORK` | the request did not complete |
| `http_<status>` / the API's own code | the API refused the request |

### "Nothing found" is not an error

A **blank** answer is "no personas found", not a failure — so the second
phase (search for a better URL) gets its turn. Upstream says the same
thing, and the reason is the same: a blank response is exactly the case
the fallback exists for. Only a *malformed* answer (not JSON, or JSON
that is not an array) is an error, because a misparse must never be
mistaken for "nothing found" — that decision drives the fallback, so
hiding a broken response behind it would hide the real failure.

## The page

- head order per `pages/integrations.html`: skin link → `lib/skin.js` →
  `lib/theme.js` (`data-theme-key="psp-theme"`) → meta → title →
  description → fonts → favicon → inline no-flash script → `<style>` →
  body; scripts at end of body
- **skin contract**: exactly one `data-skin-stylesheet` link
  (`../assets/skins/house.css`), exactly one `lib/skin.js` script tag, and
  no contract token defined in a `:root` / `html` / `body` /
  `[data-theme=…]` scope — `npm run skin:check` stays green
- `house.css` defines tokens only, so the page supplies its own
  page-scoped classes. Borders use `--line` / `--line-soft`; `house.css`
  has no `--border-*` tokens
- no new Web Component — plain DOM. `docs/COMPONENT-CATALOGUE.md`
  therefore needs no entry
- UI: URL input · API-key input (session only) · model · Generate ·
  status line · one card per persona (three tier blocks, a YouTube block
  and four social blocks, each with a copy button) · export buttons ·
  theme toggle (light / system / dark)

The exports are per persona where the format is per persona: **POST.md**
and **metadata JSON** sit on each persona's card, because `ig-poster`
reads one POST.md per reel directory. Two pack-level buttons sit under
the cards: **copy all hashtags** and **Download metadata JSON** for the
whole pack in one file.

Every copy button carries the exact text it copies in `data-copy`, and
every download button carries its exact file content in `data-content` —
so what lands on the clipboard or on disk is the string the button
promises, and the e2e can assert it.

## Testing

The unit suite is offline and credential-free: a local stub HTTP server
plus the base-URL override stand in for Gemini. It covers the prompts,
the parser, the normaliser, `toIgPostMd` against a replica of
`ig-poster`'s parser, `toYoutubeMetadata`, and the whole Gemini path
(method, path, `x-goog-api-key` header, the two tools, response
normalisation, both fallback phases, the `NO_KEY` path and the API-error
path).

Every check is **awaited**. That is not a style point: the Gemini-path
checks are async, and a synchronous helper would let a failing
assertion inside an async body print "ok" and escape as an unhandled
rejection — a green suite that cannot report a failure.

### The drift guard

`lib/social-shared.js` — the social worker's rules module — carries a
second copy of the tag/tier/POST.md rules this lib also implements. The
two copies are equivalent today, and the unit suite **proves** it: it
runs both implementations over the same fixtures and fails if they ever
diverge (the tier contract is compared too). The check is skipped when
`social-shared.js` is absent, so the suite never depends on it.

That is deliberate. This lib stays standalone — no cross-module
`require`, so it drops into the browser and into Node without a
bundler — while the duplication is kept honest by a test instead of
left to rot silently. **When the two sides are next edited together,
the fix is to make one of them require the other, not to leave two
conventions to drift apart.**

The e2e spec runs against the built page with **no live key**: the
Gemini endpoint is intercepted — the CORS preflight is answered locally
and the POST comes back with a two-persona fixture. It asserts the
persona cards, the `#` prefix on every tag, the tier counts, the YouTube
title, all four social blocks, that the copy buttons expose the text on
screen, that a real copy click copies exactly that text without raising
a page error, that the theme persists under `psp-theme`, that the key is
in `sessionStorage` and not in `localStorage`, that the no-key guard
makes no request at all, that the empty-result path reports an error
instead of a blank page, and 0 console errors on both paths.

```bash
node lib/persona-social-pack.test.js
npm run skin:check
node lib/serve.js --port 5180 --host 127.0.0.1 &
cd e2e && CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" PORT=5180 node persona-social-pack.spec.mjs
```

## Known limits

- The persona descriptions have to be reachable from the URL. A page that
  only links to them (rather than stating them) will come back empty and
  trigger the fallback search.
- A tier shorter than its target is reported, not fixed. Padding it would
  invent reach the model did not promise.
- The `## Hashtags` line in POST.md is a single line of space-separated
  tags, which is what `ig-poster` expects and what Instagram's caption
  field takes.
