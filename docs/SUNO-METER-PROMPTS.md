# Suno meter prompts — the uncommon meters

Five Suno prompts in rare meters, and the machinery to roll them.

A prompt here is **two fields**, not one:

- the **style box** — what the track sounds like
- the **lyrics field** — the section tags that carry the meter and the arrangement

They are not the same field and they are not interchangeable. The style
box is global (Suno weights it far more heavily); the lyrics field is
section-by-section reinforcement.

## The five

| prompt | meter | ensemble | style box | lyrics field |
|---|---|---|---|---|
| Seven Bells | 7/8 | Nordic modern jazz big band | 266 ch | 275 ch |
| Five of a Kind | 5/4 | Nordic modern jazz big band | 205 ch | 232 ch |
| Thirteen Windows | 13/8 | Nordic avant jazz big band | 183 ch | 224 ch |
| Ledger | 4/4 ↔ 7/8 | Nordic modern jazz big band | 193 ch | 203 ch |
| Salt Cathedral | 11/8 | Nordic chamber jazz ensemble | 185 ch | 177 ch |

The meter cheat sheet, from the house:

| meter | feel | how to word it |
|---|---|---|
| 7/8 | uneven, propulsive | `7/8 time, 2+2+3 pattern` |
| 5/4 | asymmetric ballad | `5/4 time, uneven bars` |
| 13/8 | rolling, restless | `13/8 time, 3+3+3+2+2` |
| 11/8 | lopsided, limping | `11/8 time, 3+3+3+2` |
| 4/4 ↔ 7/8 | conversational | `alternating 4/4 and 7/8 phrases` |

## Why covers, and not plain generations

**MEASURED 2026-11-02 on this account:**

- A plain text generation is **REFUSED**. The submit answers with a
  clip id, the balance does not move (7 → 7), and the clip's audio URL
  points at `studio-api.prod.suno.com/api/forbidden`.
- A **cover** of an existing track **renders**, and costs nothing.

So these are made as covers. That is not a workaround — it is how the
house already works: the workspace at `/create?wid=8fccfe6f-…`
("kais_style new", 593 clips) is entirely made of covers. Every clip on
its first page is `task: cover`.

## Why the style box replaces the descriptor

On a cover, `override_fields: ['prompt','tags']` means the style box
takes the source's place.

**MEASURED** on the workspace's own clips: they carry the meter style
("Nordic modern jazz big band with 16-piece ensemble…"), **not** the
source's "Dark jazz electronica", while the lyrics travel in the prompt
field.

So the meter style is **not** composed with the source descriptor — it
replaces it. That is the opposite of `lib/suno-mutator.js`'s rule
(descriptor + mutation), and deliberately so: a meter prompt is a whole
style, not an amendment.

**MEASURED** on a real roll: Suno rewrites the style box into its own
prose. It kept the ensemble, the 7/8 pattern, the instruments and the
hall reverb — and rephrased the wording. The **lyrics field comes back
verbatim**. So the section tags are the part that is safe to rely on.

## Why four rolls each

Meter tags are probability weights, not commands. Suno approximates
rather than counts — 13/8 often lands as 7/8 with extra weight, and 7/8
straightens into 4/4 the moment density drops.

So: generate four, keep the one where the bars actually line up.

## Running it

```bash
# the plan — nothing submitted
npm run suno:meters -- --workspace <wid> --source <clipId>

# one prompt only
npm run suno:meters -- --workspace <wid> --source <clipId> --only seven-bells

# submit
npm run suno:meters -- --workspace <wid> --source <clipId> --roll 4 --apply

# print the prompts
npm run suno:meters:list
npm run suno:meters:list salt-cathedral
```

The captcha is per-request, so every roll takes a fresh token.

## The house rules these prompts bake in

- **Instrumental by default.** Every style box says `no vocals`, every
  lyrics field is made of section tags. Suno invents a singer otherwise.
- **All instructions in square brackets.** Parentheses are sung, never
  directives — `(softly)` will be vocalised as a lyric.
- **Blank lines between sections.** Cheap, and it measurably improves
  how Suno reads structure.
- **Negative tags last.** They close the style box. On Pro/Premier,
  move them into *Exclude Styles* under Advanced Options.
- **Front-load.** The first ~200 characters dominate. Genre and mood
  first, then instruments, then production. Eight to fifteen tags
  total; past that Suno starts dropping from the middle.
- **Meter goes in the style box.** It is a global property and it is
  weighted far more heavily there than inside a lyrics tag.

## Files

| file | what it is |
|---|---|
| `lib/suno-meter-prompts.json` | the five prompts — style box, lyrics field, meter, production note |
| `lib/suno-meter-roll.js` | the loader, the cover body, the roll plan |
| `lib/suno-meter-roll.test.js` | 77 assertions |
| `lib/suno-meter-run.js` | the runner — submits the rolls, checks each verdict |

## Tests

```bash
npm run test:suno-meter-roll
```

The tests pin the house rules (every style box forbids vocals, every
lyrics field is made of section tags, the meter is in the style box),
the cover body's shape (the style box replaces the descriptor, the
lyrics travel in the prompt), and the roll plan (four per prompt,
distinct titles).
