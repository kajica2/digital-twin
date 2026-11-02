# Suno mutator — send a URL, get custom variants

Hand it a Suno link. It works out which song that is, reads the song's
own settings, and builds **custom variants** of it — the same audio, a
different style applied to each.

```bash
# the built-in mutations, as a plan (nothing submitted)
npm run suno:mutate -- --url https://suno.com/song/<uuid>

# save each variant as a custom style in the account
npm run suno:mutate -- --url https://suno.com/song/<uuid> --save-styles --apply

# generate a cover of the source for each variant
npm run suno:mutate -- --url https://suno.com/song/<uuid> --generate --apply

# both, and your own mutations
npm run suno:mutate -- --url https://suno.com/s/<slug> \
  --mutation "dub;orchestral:0.6:symphonic strings, brass" \
  --save-styles --generate --apply
```

---

## The URL it accepts

| you paste | what it is |
|---|---|
| `https://suno.com/song/<uuid>` | a song page |
| `https://suno.com/s/<uuid>` | a share link with the id in it |
| `https://suno.com/s/<slug>` | a **short** share link — resolved over the network |
| `https://suno.com/hook/<uuid>` | a hook (a section of a song) |
| `https://suno.com/create?wid=<uuid>` | a workspace |
| `<uuid>` | a bare clip id |

Anything else is refused with a message that says what is accepted. A
host that is not `suno.com` is refused too — a lookalike must not send the
mutator somewhere else.

### The short link

**MEASURED 2026-11-01:** `https://suno.com/s/htrR5vlSCxATy77v` answers
with a **307** to `/song/4fa05b74-e3bd-4fc1-b6f0-479bc4f67cf4?sh=…`, so
the clip id is in the redirect target. The mutator follows it and reads
the uuid out. A short link whose song is private or deleted resolves to
nothing, and the mutator says so rather than guessing.

---

## The composition rule

```
tags = <the source song's own style descriptor> + <the mutation>
```

with the **descriptor always preserved** — when the two together exceed
the server's 1000-character limit, the *mutation* gives way.

That is the same rule `lib/suno-styles.js` already established from the
user's own saved style batch: a variant that loses the descriptor is not
a variant of the source song, it is a different song.

So a source whose descriptor is `Balkan brass, African polyrhythms, 105 BPM`
and a `dub` mutation produce:

```
Balkan brass, African polyrhythms, 105 BPM, dub techno, tape delay, submerged basslines, cavernous reverb
```

### What is carried over, and what changes

| carried from the source | changed per variant |
|---|---|
| the style descriptor | the mutation's style text |
| the model (`chirp-hawk`) | the Audio Influence |
| the duration (198 s max mode) | the title (`<song> - <mutation>`) |
| the source clip being covered | |

---

## The built-in mutations

| slug | style | influence |
|---|---|---|
| `dub` | dub techno, tape delay, submerged basslines, cavernous reverb | 0.75 |
| `orchestral` | symphonic orchestra, cinematic strings, brass section, timpani | 0.60 |
| `lofi-tape` | lo-fi hip hop, cassette saturation, vinyl crackle, dusty drums | 0.80 |
| `afro-house` | afro house, log drum, shuffled percussion, warm sub bass | 0.70 |
| `ambient` | ambient drone, long reverb tails, soft pads, no percussion | 0.55 |
| `breaks` | broken beat, amen break, live drum breaks, vinyl swing | 0.78 |

Your own:

```bash
--mutation "name:influence:tag text"
--mutation "name:tag text"          # influence defaults to 0.7
--mutation dub                      # a built-in, by name
```

**Several mutations are separated by a SEMICOLON, not a comma** — a comma
belongs to the style text:

```bash
--mutation "dub;orchestral:0.6:symphonic strings, brass"
--mutation dub --mutation "orchestral:0.6:symphonic strings, brass"
```

The second field is read as an influence only when it is a number;
otherwise it is the style text (`--mutation "lofi:soft tape hiss"`).

---

## Two outputs

**`--save-styles`** writes each variant as a **saved style** in the
account, so it appears in the studio's own style picker.
`POST /api/prompts/v2` with `{ tags, id, title }` — `id: null` creates,
an existing id updates.

**The id is what decides create-vs-update, and it has to be sent.**
MEASURED 2026-11-01 (live): the tool looked the title up, logged
"style updated" — and sent `id: null` anyway. The server reads `null` as
"new" every time, so two runs left the account holding **twelve** styles
with **identical titles**: six pairs, each pair a duplicate of the other.
The log said "updated" while the write created.

The fix sends the existing style's id, so a re-run updates in place.
The title match is **exact** — two songs whose variant titles share a
prefix must not collide, or one song's variants would overwrite
another's.

There is no history endpoint (`/api/prompts/v2/history` answers 404), so
an update **replaces** the previous tags rather than keeping both. If
you re-run against a different variant of the same song, the style now
carries the newer variant's descriptor. Re-run the older one to put it
back.

To remove a style: `DELETE /api/prompts/v2/<id>` (answers 204).

**`--generate`** submits a **cover** of the source for each variant
(`POST /api/generate/v2-web/`, `task: "cover"`), and records the clip id.
The captcha is per-request, so each submission takes a fresh token.

Both write a manifest to `data/suno/mutator.json` (gitignored) recording
the source clip, the linked clip, the settings, every variant's tags and
influence, and the style/clip id each one got.

---

## The clip behind the link

A link can point at a **cover** of another clip. Mutating the cover
mutates the cover; "give me variants of this song" means the *source*.
So the mutator follows one hop: the link's clip, then the clip it was
made from, and that is what the variants cover.

The manifest records both, under names that say which is which:

```json
"source": {
  "clipId":    "<the clip to mutate>",
  "title":     "<its title>",
  "linkClipId": "<what the URL pointed at>",
  "linkTitle":  "<its title>",
  "coverClipId": "<the link's clip, when it was a cover>"
}
```

---

## Credentials and constraints

The cookie jar lives **outside** the repo, at `~/.suno-cookies.txt`
(gitignored, same precedent as `~/.midjourney-cookies.txt`). Without it
the tool refuses to start and says where to get one.

### Refreshing the jar: `npm run suno:login`

The session cookie is short-lived — MEASURED 2026-11-01, the jar's
`__session` expired within the hour — so a jar that worked in the
morning is dead by the afternoon. The failure is quiet: "the cookie jar
is probably expired or logged out", with no way forward.

```bash
npm run suno:login
```

It opens the Suno browser profile (headed, on the CDP port the tools
already use), waits while you sign in by hand, then exports the
browser's own cookies back to the jar and **verifies the result against
the live API**. The verification is a real request, not an inspection —
a jar can look perfect and still be refused.

Useful flags:

| flag | what it does |
|---|---|
| `--out <path>` | write the jar somewhere else |
| `--timeout <sec>` | wait longer for the sign-in (default 300) |
| `--keep-open` | leave the browser up afterwards |

Two things MEASURED on 2026-11-01, both of which shaped it:

- **An expired session sends the browser to GOOGLE's sign-in page**, not
  Suno's. So a "not on /auth/signin" check is not a sign-in test — the
  page can look like suno.com and still be a login screen. The positive
  signal is the Authorization header the SPA attaches; the URL is only
  ever used as a *negative* signal.
- **`document.cookie` cannot see `__session`** (it is HttpOnly), so a
  cookie probe can never confirm a sign-in.

The session cookie has also carried a per-user suffix
(`__session_Jnxw-muT`) rather than the plain `__session`, so the check
accepts either — and the real gate is the live API call, not the name.

Three constraints the repo already established, and this tool inherits:

1. **The browser must be HEADED.** suno.com loads Cloudflare Turnstile,
   and the generation captcha does not solve in headless Chrome
   (measured 2026-10-21: the widget renders, no token ever arrives, and
   the request dies at "captcha token timed out" after 45 s).
2. **`api.suno.ai` 503s and `auth.suno.com` 404s** from this network. The
   API the app actually calls is `studio-api-prod.suno.com`, and it
   demands the Bearer token the SPA attaches itself — so the token is
   read off a request the page made, never off the jar.
3. **A submitted clip is not a made track.** The submit call answers
   with an id whether or not the generation will ever render. Check the
   clip's verdict (`lib/suno-create.js` → `clipVerdict`) before treating
   a clip id as a finished track.

**MEASURED 2026-10-30:** on an account with 7 credits left, *every*
generation request comes back `status: "error"` with its audio URL
pointing at `studio-api.prod.suno.com/api/forbidden` — a 198 s max-mode
one, a 60 s simple one, with and without an explicit model. The balance
does not move, so nothing is spent. The body is not the problem: the
ACCOUNT refuses it, and the refusal only shows up on the clip.

So on that account, `--generate` will submit and then report that
nothing rendered. `--save-styles` is unaffected — it spends no credits.

---

## Tests

```bash
npm run test:suno-mutator   # 92 assertions — no browser, no account, no credits
```

The pure half is covered: the URL shapes and the refusals, the
short-link resolve, the source-behind-a-cover hop, the settings that are
inherited and the ones that are clamped, the composition rule (including
the trim that keeps the descriptor), the cover and style request bodies,
the manifest, the naming rule, and the command-line grammar.

**The command-line grammar was a bug found by running the tool, not by
the test.** The parser split mutations on a COMMA — so
`orchestral:0.6:symphonic strings, brass` came out as two mutations,
the second one named "brass". The separator is a semicolon; a comma
belongs to the style text. There is now a test for it.

---

## The scripts

| script | what it does |
|---|---|
| `lib/suno-mutator.js` | this tool |
| `lib/suno-web.js` | the authenticated studio client (`SunoClient`) |
| `lib/suno-run.js` | variants using the ten reference-lock PROTOCOLS |
| `lib/suno-styles.js` | the composition rule, and the protocol library |
| `lib/suno-create.js` | a song from a text brief |
| `lib/suno-fetch.js` | pull a finished clip's audio to disk |
