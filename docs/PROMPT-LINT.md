# Prompt lint — no prompt may name the subject's race

> 2026-10-22. A standing rule from Kai, encoded as a guard rather
> than left as prose. `npm run prompt:check` fails the build when a
> prompt pack describes a person's race or ethnicity.

---

## The rule

**Do not state the subject's race or ethnicity in a prompt.**

The reason is operational, not ideological. These prompts exist so a
**reference photo** can be attached and the model gives back what the
photo shows. A prompt that says *"a young Black man in a grey puffer
jacket"* overrides the photo — the model renders a person of the
named ethnicity whatever the reference actually contains, and the
reference stops being authoritative. The photo is supposed to be the
source of truth for who appears in the frame.

So describe the **scene**:

- light, lens, medium, film stock
- time of day, weather, setting
- wardrobe, gesture, posture, expression
- era, palette, production format

Age, build and face come with the reference photo.

```text
✗  a young Black man in a grey quilted puffer jacket on the steps
✓  a young man in a grey quilted puffer jacket on the steps
```

## What counts as a finding

A **demographic adjective directly modifying a person noun**:

> a black man · an Asian woman · a young Black man · an
> African-American saxophonist · a person of color · of African
> descent

Roughly 75 race/ethnicity terms and 55 person nouns are recognised,
including multi-word forms (`african american`, `native american`,
`first nations`, `mixed race`, `east asian`, `middle eastern`,
`african descent`, `arab descent`).

## What deliberately does **not** fire

Photographic treatments, clothing, food, objects and places are not
personhood:

```text
a black-and-white photograph      ✓
a framed black-and-white portrait  ✓
a woman in a black coat            ✓
a black piano                      ✓
white wine                         ✓
the Black Sea                      ✓
a black metal guitar               ✓
Mexican cuisine                    ✓
an Asian market                    ✓
an African sunset                  ✓
a Mexican mural                    ✓
```

Two guards handle the "black and white" compound specifically: a
match that *is* the compound is skipped, and a `white…` match
preceded by `black and` within 24 characters is skipped. Without
them, *"a black-and-white portrait of a man"* would be a finding —
which is why `portrait` was also removed from the person-noun list
(a portrait is an image tone, not a person).

## How it reads a pack

`lib/prompt-lint.js` **does not re-implement prompt parsing**. It
imports `extractPrompts` from `lib/mj-submitter.js`, so the lint
checks exactly what the watcher would submit and the two can never
disagree about what a prompt is. Frontmatter, blockquotes and code
fences are skipped — same as the watcher skips them.

A file with no top-level bullets is not a pack and is skipped
(`skipped: 'not a prompt pack (no top-level bullets)'`).

## Running it

```bash
npm run prompt:check                      # the tracked packs
node lib/prompt-lint.js <file>…           # specific files
npm run test:prompt-lint                  # the test suite
```

Exit codes: **0** clean · **1** violations found · **2** bad input.

Default scan: `assets/mural-prompts/` and `prompts-inbox/`,
recursively, skipping dotfiles and `processed/` (history, not
pending work).

Current state: **46 packs, 465 prompts, 0 violations.**

Output on a violation:

```text
assets/mural-prompts/some-pack.md:21: prompt 3 specifies the subject's
race/ethnicity — "A young Black man in a grey quilted puffer jacket…"
```

## Where it is enforced

| Where | How |
|---|---|
| `npm run test:all` | `test:prompt-lint` then `prompt:check` |
| CI (`.github/workflows/pages-test.yml`) | its own step, `node lib/prompt-lint.js` |
| The rule itself | `assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md` § "The subject's identity" |
| Standing context | `AGENTS.md` § "Things to remember" |

The CI step is its own because CI runs the **e2e specs**, not
`test:all` — without a dedicated step the lint would never gate a
deploy.

## History

Two genuine violations were found and fixed when the lint landed,
both the same subject line in two packs
(`mv-transitions-plate-19.md` and the in-flight
`mv-transitions-plate-19-mj.md`): *"A young Black man in a grey
quilted puffer jacket and a lemon-coloured fur trapper hat"* →
*"A young man in…"*.

## Files

- `lib/prompt-lint.js` — the lint (`findViolations`, `scanFile`,
  `scanPaths`, `defaultTargets`, `looksLikePack`, `RACE_TERMS`,
  `PERSON_NOUNS`).
- `lib/prompt-lint.test.js` — 46 assertions: real cases, the
  non-cases above, pack detection, and agreement with the
  submitter's parser.
