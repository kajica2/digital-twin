# Agent plan — routing work through `copilot`

> **Kai agent = the `copilot` CLI, bound to this repo's `AGENTS.md` and `CLAUDE.md`.**
> The CLI auto-discovers both files as instructions (per `copilot instruction list`),
> so the established conventions, sprint-log rule, hygiene rules, and repo
> layout are loaded into every session with no extra wiring.
>
> `copilot` is the **executor** in the twin's model. This plan is the routing
> table — which model handles which kind of work — and the invocation
> patterns to run it. `AGENTS.md` defines *what* the agent does; this
> doc defines *which model* does it.

## Roles and model routing

The twin already names its agents in `AGENTS.md` ("Mavis, future-Coder,
future-Reviewer, human collaborator"). The roles below map those names to
concrete `copilot` invocations and the model that fits the work.

| Role | Work it owns | Model | Why this model |
|---|---|---|---|
| **Mavis** (orchestrator) | Plan, route, summarise, commit decisions | `auto` (or `gpt-5.4`) | The session is already running; new work is triaged here first, then handed off. |
| **Coder** | File edits, scaffolding, routine refactors, test fixes | `gpt-5.4` | Fast at structured code edits; good enough for 90% of the work. |
| **Coder — hard** | Multi-file refactors, tricky parsers, design with constraints | `claude-sonnet-4.6` | Better at holding the full constraint surface in mind; fewer "I forgot the other file" misses. |
| **Reviewer** | Read a diff, run the test suite, flag risk, write the PR body | `claude-opus-4.8` (reasoning `xhigh`) | Best at spotting subtle contract breaks; reviews benefit from max reasoning. |
| **Quick** | One-shot: format, rename, generate a commit message, answer a factual question | `gpt-5.4-mini` or `claude-haiku-4.5` | Cheap and quick; reserve the big models for work that needs them. |
| **Reasoning** | Architecture, hard debugging ("why is this 3.5s not 2.0s?"), design across modules | `claude-opus-5.5` (reasoning `max`) | When the answer is not obvious, pay the latency for the reasoning. |
| **Visual** | Image / video / cover art | **local FLUX.2** (not Copilot) | `lib/flux2-renderer/` is the established pipeline; no reason to pay for a hosted image model. |
| **MIDI / audio** | Audio analysis, format conversion | **local** (`lib/ingest.js`, `ffmpeg`/`ffprobe`) | Local tools beat a hosted model on a 4 MB file. |
| **DeepSeek** (optional) | Coding, reasoning — OpenAI-compatible API | `deepseek-chat` (default) or `deepseek-reasoner` | Cheap, strong. **Requires `DEEPSEEK_API_KEY` from `platform.deepseek.com`** — the `chat.deepseek.com` web session cookies do NOT authenticate the API. Module: `lib/deepseek.js` (20 checks, no real key needed to ship). |

The plan defaults to the cheapest model that can do the job and escalates
when the work demands it. The orchestrator (Mavis / this session) chooses
the route; the human can override per invocation with `--model`.

## Invocation patterns

All invocations are from the repo root unless noted. `copilot` reads
`AGENTS.md` + `CLAUDE.md` automatically — no `--instruction` flag needed.

### Coder (routine)

```bash
copilot -p "add the test for lib/ingest.js and wire it into test:all" \
  --model gpt-5.4
```

### Coder — hard (multi-file / tricky)

```bash
copilot -p "refactor the chart-export pipeline to use lib/smf.js instead of \
the inlined parser; update the test fixtures; run test:all" \
  --model claude-sonnet-4.6
```

### Reviewer

```bash
# review a diff (never pushes; just reports)
git diff main..HEAD | copilot -p "review this diff as the Reviewer. \
Flag contract breaks, missing tests, hygiene violations. Cite the file \
and line. Do not modify anything." --model claude-opus-4.8 \
  --reasoning-effort xhigh
```

### Quick (one-shot)

```bash
# commit message draft
git diff --staged | copilot -p "write a conventional-commit message for \
this diff" --model gpt-5.4-mini -s
```

### Reasoning

```bash
copilot -p "the indexer rebuild writes 130 ms longer after the dedup \
change. Walk me through the call graph and identify the regressions." \
  --model claude-opus-5.5 --reasoning-effort max
```

### Fleet (parallel subagents)

For "investigate N independent things at once" (e.g., profile each
watcher, or audit each page's e2e spec):

```bash
copilot -p "profile the songs-watcher and report the top 3 hot spots" \
  --fleet --model gpt-5.4
```

`--fleet` spins up isolated subagents in parallel; useful when the work
is naturally independent and you want all the answers at once.

## Setup (one-time)

```bash
# 1. authenticate (web flow opens a browser; the device-code flow works
#    over SSH and headless):
copilot login

# 2. confirm AGENTS.md and CLAUDE.md are picked up:
copilot instruction list
# expect: AGENTS.md + CLAUDE.md both shown as repository instructions.

# 3. (optional) set a repo-default model in .github/copilot/settings.json.
#    Leave it at "auto" for most work; override per task with --model.
#    .github/copilot/settings.json:
#      { "model": "auto" }

# 4. (optional) DeepSeek — export the API key in your shell:
#    export DEEPSEEK_API_KEY=sk-...    # from https://platform.deepseek.com
#    npm run test:deepseek               # 20 checks, no network to the real API
#    Use --model deepseek-chat / deepseek-reasoner on copilot invocations,
#    or call lib/deepseek.js directly. The chat.deepseek.com web session
#    cookies do NOT authenticate the API — that is a separate account.
```

That's it. No `copilot init` needed — the repo's existing `AGENTS.md` is
already the instruction source.

## Workflows (reusable task templates)

Stored under `.github/copilot/workflows/` as Markdown with frontmatter.
Each is invoked with `copilot workflow run <name>`. Keep the set small
at first; add a workflow when the same multi-step task comes up three
times.

The shapes this repo will likely want (none committed yet — add when
the trigger fires):

- **`fix-e2e`** — read the failing spec, read the page, patch the page
  (not the spec), run the spec, commit. The single most common sprint
  closer in this repo.
- **`render-pack`** — `lib/flux2-renderer/render-many.py` against a
  new prompt pack, verify the manifest, commit the pack + the
  manifest (NOT the images — they're gitignored).
- **`sprint-log`** — append a sprint entry to `AGENTS.md` in the
  established format. Takes the commit hashes, the gate result, and
  the decisions.
- **`pr-body`** — given a branch, draft a PR title and body in the
  repo's house style (What / Why / Verified / Open / Next), using
  the diff + the e2e result.

Each workflow is a `SKILL.md`-style doc the orchestrator can hand to
`copilot -p` with the workflow's instructions pasted in, OR register
via `copilot workflow register <name> <path>` and run with
`copilot workflow run <name>`.

## What Copilot should NOT do

- **No image generation.** FLUX.2 (local) is free, fast, and already
  integrated. Paying for a hosted image model is a regression.
- **No audio transcription.** The MIDI/audio pipelines in
  `lib/ingest.js` + `ffprobe` cover what we need; a hosted ASR model
  is overkill for "give me the BPM and key."
- **No PR creation without confirmation.** `copilot` can `gh pr
  create`; the plan does not give it that authority. PRs are the
  orchestrator's call after a human review.
- **No destructive git without confirmation.** `--force`, `reset
  --hard`, branch deletion on remote — all require a human "go".

These limits are also encoded in the workflow templates (each one
names what it is and is not allowed to do) and in `AGENTS.md` under
the "calm, not chatty" rule.
