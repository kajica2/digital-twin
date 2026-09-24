# MJ Prompt Expansion Format — lyrics / idea → 5–10 Midjourney prompts

> Sprint 0.18. The Midjourney watcher (`lib/mj-watcher.js`)
> accepts `.md` files in `prompts-inbox/` and submits **every
> prompt in the file** to Discord/Midjourney, in order, via
> `lib/mj-submitter.js --all-prompts`. This document defines the
> file format that the watcher parses.

The convention is designed to be writable by:

1. **An AI in chat** — paste lyrics or an idea; the AI returns a
   `*.md` file with 5–10 distinct prompts and `--ar 16:9` appended
   to each.
2. **A human** — write a `.md` file with one bullet per prompt.
3. **A programmatic generator** — `lib/mj-prompt-generator.js`
   produces the same shape deterministically from lyrics (no LLM
   call needed).

## The shape

```markdown
# <song / project name> — <N> prompts (16:9)

> Source: <one-line summary of the lyrics / idea>

- <prompt 1> --ar 16:9
- <prompt 2> --ar 16:9
- <prompt 3> --ar 16:9
- <prompt 4> --ar 16:9
- <prompt 5> --ar 16:9
- <prompt 6> --ar 16:9
- <prompt 7> --ar 16:9
- <prompt 8> --ar 16:9
```

### Rules

- **One top-level bullet (`- `) per prompt.** Sub-bullets
  (indented under a top-level bullet) are continuations of the
  parent prompt, useful for wrapping a long prompt across lines.
- **`--ar 16:9` is mandatory.** The watcher defaults to 16:9 for
  the lyric-pack flow. Other ARs (`3:4`, `9:16`, `1:1`) are fine
  if you put them on each bullet. The submitter re-appends
  `--ar <value>` so don't double up.
- **5–10 prompts per file.** Default is 8. Below 5, you're not
  giving MJ enough variety; above 10, the file is probably
  multiple songs / ideas and should be split.
- **Frontmatter (`--- ... ---`) is ignored.** Use it for notes
  the watcher shouldn't see.
- **Blockquotes (`>`) are ignored.** Use them for the source
  summary line.
- **Code fences (```` ``` ````) are ignored.** Useful for
  embedding reference raw output inside the file.

## Where the file goes

Drop the `.md` into `prompts-inbox/`. The watcher:

1. Acquires a lockfile on the file.
2. Shells out to `node lib/mj-submitter.js --prompt-file <path>
   --all-prompts`.
3. The submitter extracts every prompt, submits each one to
   Discord/MJ in sequence, captures the 4-up grid, writes a
   per-prompt output dir at
   `mj-output/<basename>/prompt-NN/`, and moves the input to
   `prompts-inbox/processed/` only after every prompt in the file
   completes (or the timeout fires).

Each per-prompt output dir contains:

- `result.png` — the captured 4-up grid screenshot.
- `meta.json` — the full prompt text + the result CDN URL.
- `prompt.md` — the prompt as submitted (with appended MJ args).

## Examples

### AI-written expansion

```markdown
# Soft Lamp at the Window — 8 prompts (16:9)

> Source: A late-night R&B ballad about missing someone; the
> chorus is "soft lamp at the window, where you used to read."

- A softly-lit room at 3am with a single warm lamp on a side
  table by an open window, rain streaking the glass, an empty
  reading chair facing the lamp, muted blue-gray walls, intimate
  interior, photographed in 35mm grain, Wong Kar-wai palette --
  --ar 16:9
- Wide shot of an Art Deco apartment block at night, one window
  glowing warm yellow on the 14th floor, the rest dark, rainy
  city street below reflecting streetlights, cinematic, anamorphic
  --ar 16:9
...
```

### Programmatic expansion (no LLM)

```bash
node lib/mj-prompt-generator.js \
    --lyrics-file ~/path/to/song-lyrics.txt \
    --title "Soft Lamp at the Window" \
    --out prompts-inbox/soft-lamp.md
```

The generator counts lines (excluding blank lines + verses) to
pick a target prompt count in 5–10, and writes each prompt as a
deterministic rotation over the lyrics:

- Prompt 1: title + first 3 lyric lines + style flag
- Prompt 2: title + second 3 lyric lines + style flag
- ...

This is a fallback when the chat is unavailable. The AI-written
prompts are richer because the LLM can capture the song's mood;
the programmatic version is mechanical but always available.

## Watcher behavior on partial failure

If prompt 3 of 8 fails (Discord timeout, MJ error), the watcher:

- Logs `[fail]` for prompt 3.
- Continues with prompts 4–8.
- Moves the input to `prompts-inbox/processed/` only if all
  prompts succeeded. Otherwise leaves it in `prompts-inbox/` for
  manual re-run.
- Exit code reflects partial success: `0` = all succeeded,
  `2` = some failed.

## Per-prompt retry state (sprint 0.19)

When a re-run picks up the same file (manually, or after the
watcher re-tries), the submitter ships only the missing prompts:

- For each successful prompt, the submitter writes a sidecar
  marker `.mj-done-<N>` next to the prompt file in the inbox
  (alongside other in-flight files; markers don't collide).
- Marker shape (JSON):
  `{ "index": 0, "timestamp": "2026-09-23T…", "outputPath": "..." }`
- The watcher always passes `--skip-done`. The submitter reads
  the markers via `readDoneIndices(promptFile)` and skips indices
  already shipped.
- When the watcher moves the input to `processed/`, it deletes
  every `.mj-done-*` in the inbox so a future drop of a
  same-named file starts clean.

This means: drop a file, the watcher starts. If prompt 5 fails,
the watcher retries the whole file (5 min × 8 prompts = 40 min),
but prompts 1-4 and 6-8 are skipped — they only re-iterate if
their sidecar marker is missing. A real partial-completion run
takes only the time of the missing prompts.

## Limitations

- **Sidecar markers live in the inbox dir.** If you have two
  prompt files in flight at once, they share the `.mj-done-N`
  namespace; index 0 of file A and index 0 of file B would both
  write `.mj-done-0`. The watcher deletes ALL markers when it
  moves either file to `processed/`, so a stray marker from file
  A could wipe B's state mid-flight. In practice the watcher is
  serial (one prompt file at a time), so this is unlikely to
  bite; future enhancement is to namespace markers per file
  (`.mj-done-<basename>-<N>`).
- **Sequential, not parallel.** MJ rate-limits and the Discord
  flow prefer one-at-a-time. 8 prompts × ~45s each = ~6min wall.
- **No IG upload.** This is the same pre-publish-only ethos as
  the rest of the project.

## How this fits the rest of the system

- **Watcher test harness** (`lib/mj-watcher.test.js`) is
  unchanged in scope — it tests lockfile + listPending only.
- **MJ submitter** (`lib/mj-submitter.js`) gained
  `extractPrompts()`, `--all-prompts`, `--prompt-index`,
  `--prompts-only` CLI flags.
- **`lib/mj-prompt-generator.js`** (new, programmatic fallback)
  produces a file in this format.
- **AI in chat** is the primary path. The convention is just
  "give me a `.md` with N bullets, each ending in `--ar 16:9`."
- **No new LaunchAgent.** The MJ watcher is already wired from
  sprint 0.15; this is a watcher contract expansion, not a new
  service.