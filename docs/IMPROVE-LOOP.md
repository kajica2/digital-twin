# The improvement loop — recurring failures become written lessons

`lib/improve-loop.js` watches the repo's own logs for failure
signatures this project has actually hit, and writes each recurring one
down as a **postmortem**, a **prevention rule** and a **tech-debt
item** — so the next agent reads the lesson instead of rediscovering
the bug.

```bash
node lib/improve-loop.js                  # run it (respects the 30-minute gate)
node lib/improve-loop.js --dry-run --json # what would it write? spend nothing
node lib/improve-loop.js --force          # ignore the interval gate
node lib/improve-loop.js --min 5          # raise the recurrence threshold
node lib/improve-loop.js --interval 60    # minutes between runs
```

---

## The one rule that matters

**The loop never edits product code.**

It writes three artefacts and stops:

|artefact|where|what it is|
|---|---|---|
|postmortem|`.kai/postmortems/<date>-<signature>.md`|what happened, the evidence, the lesson|
|prevention rule|`.kai/memory.yaml` → `active_prevention_rules`|the rule a future agent reads *before* it starts work|
|tech-debt item|`.kai/tech-debt/register.md` → `### TD-NNN`|the outstanding work, in the project's own register|

Applying a lesson is a **separate, deliberate act** by an agent. The
`/daily` ENOENT found by the loop on 2026-11-02 was fixed by hand in
`lib/daily-pipeline.js` — the loop only wrote the postmortem and the
rule that said "resolve paths from the repo root, never from
`process.cwd()`".

That separation is the point. An automated loop that edits source code
is a loop that will eventually edit the wrong thing at 3am.

---

## What it reads

Log files only, and only the tail of each:

|bound|default|why|
|---|---|---|
|tail bytes per file|64 KiB|a full log read is the thing that made the old rotation dangerous|
|log files per run|40|the repo has more log paths than any single run should touch|
|findings written per run|10|a run that writes fifty artefacts is not a lesson, it is noise|
|evidence lines kept per finding|5|five lines of evidence is enough to see the shape of the failure|

Every bound is a **ceiling, not a target**.

Files are discovered by walking the repo for `*.log` under the known
working directories; `.log` is the only extension it touches, so a
`.musicxml` or `.json` in the same directory is never at risk.

---

## The signatures

Seven failure shapes this repo has actually hit. Each carries a
`severity`, the `files` it usually implicates, and — importantly — the
**action** text, which is the body of the prevention rule. The action
is written to be read by a future agent before it starts work, so it
leads with the fix, not with the diagnosis.

|signature|severity|tripped by|the lesson in one line|
|---|---|---|---|
|`launchd-tcc`|P2|`Operation not permitted`|launchd grants access per binary — shim node in `~/Library/LaunchAgents/`, never `/bin/bash` into `~/Documents`|
|`api-rate-limit`|P3|`429`, `Too many requests`|reuse one browser session, prefer the singular route, treat a 429 as "wait", never as "empty"|
|`encrypted-media`|P3|`moov atom not found`|the bytes are encrypted at rest; no header unwraps them — decrypt with `lib/suno-mango.js` (Mango rights → AES-GCM unwrap → AES-CTR) and check the `ftyp` brand|
|`prompt-refusal`|P3|`banned_prompt_detected`, `softban`|a refusal is not a fact about the prompt until a known-good control passes through the same path|
|`stale-chrome-port`|P3|`Chrome failed to bind on port`|stale profile lock **or** a too-tight deadline — launch it by hand on the same port before blaming Chrome|
|`no-deadline`|P2|`timed out after …ms`|every hangable call gets a deadline; the in-page one must be shorter so it surfaces as a named `AbortError`|
|`missing-path`|P3|`ENOENT`|resolve from the repo root, never from `process.cwd()` — a launchd job's cwd is `/`|

A signature only fires when it **recurs**: the default threshold is 3
occurrences (`--min`). One stray `ENOENT` in a log is noise; three is a
pattern worth writing down.

---

## The interval gate

The loop keeps its own state in `.kai/state/improve-loop.json`:

```json
{ "lastRun": "2026-11-02T14:22:10.114Z", "lastFindings": 2, "written": ["missing-path"] }
```

`shouldRun(state)` returns true when there is no `lastRun`, when
`lastRun` is unparseable, or when at least `DEFAULT_INTERVAL_MINUTES`
(30) have passed. `--force` ignores the gate.

**The state field is `lastRun`.** Not `lastRunAt` — that name was wrong
once and the hub seam had to be corrected to match the module rather
than the other way round.

---

## Idempotency

A finding is *already recorded* when any of these match:

- its rule id appears in `.kai/memory.yaml`'s `active_prevention_rules`;
- its title appears in the tech-debt register;
- a postmortem file named `<date>-<signature>.md` exists for it.

So a second run over the same logs writes **nothing**. Verified: the
second `--force` run on 2026-11-02 reported `written: 0`.

The three writes are also atomic (temp file + rename), so a reader
never observes a half-written rule.

---

## The hub integration

The SWR agent hub ticks every five minutes under launchd, and the loop
rides that tick:

```bash
node lib/agent-hub/hub-launch.js improve   # run the loop on demand
node lib/agent-hub/hub-launch.js trim       # cap the hub's own logs
node lib/agent-hub/hub-launch.js status
node lib/agent-hub/hub-launch.js ensure     # default
```

In `lib/agent-hub/hub-launch.js`:

```js
function runImprovementLoop() {
    const { readState, shouldRun, run } = require('../improve-loop.js');
    const state = readState();
    if (!shouldRun(state)) return { ran: false, reason: 'not due' };
    return { ran: true, result: run() };
}
```

Three decisions worth naming:

- **The loop runs *before* the hub's early return.** A tick that starts
  no process is still a tick on which a recurring failure could be
  recorded; a tick that returns early has no chance to notice anything.
- **The seam calls `shouldRun()` itself.** The interval gate lives in
  the module's `main()`, so a caller that invokes `run()` directly
  would bypass it. The seam enforces the 30-minute floor itself.
- **A failing loop is non-fatal.** `.kai/` may be missing or
  unwritable; that must never take the swarm down. The failure is
  logged (`improvement loop failed: …`) and the hub proceeds.

`ensure()` takes `improveFn = runImprovementLoop` as an injectable
parameter, so the tests drive the whole decision with no process
spawned and no `.kai/` written.

---

## The 2026-11-02 live run

```bash
node lib/improve-loop.js --json --force
```

```
evidenceFiles: 35
findings: launchd-tcc (638 occurrences, known)
          missing-path (14 occurrences, fresh)
written: 1
```

It wrote:

- `.kai/postmortems/2026-11-02-missing-path.md` (1,948 B)
- rule `PM-2026-11-02-missing-path` in `.kai/memory.yaml`
- `### TD-009` in `.kai/tech-debt/register.md`

The YAML re-parsed valid with 14 active prevention rules afterwards.

`launchd-tcc` was reported as **known** and not re-written — it has
been in the register since 2026-10-25, and 638 occurrences is the
launchd TCC error repeating in logs that nothing has cleaned up yet.

---

## Tests

```bash
node lib/improve-loop.test.js     # 41 assertions, temp-dir fixtures
```

Nine sections: the tail reader, the file finder, the classifier and the
recurrence threshold, the dedupe across all three artefacts, the byte-surgical
YAML and markdown insertions, the atomic write, the state file and the
interval gate, and the `main()` argv handling.

No network, no browser, no `.kai/` writes — every fixture lives in a
temp directory that the suite removes.

---

## Open

- **`.kai/` is gitignored**, so the rules travel only on this machine.
  That is deliberate (the memory is local-first) but it means a fresh
  clone starts with an empty register.
- **The loop finds signatures; it does not fix them.** Every finding
  currently needs a human or an agent to apply the lesson.
- **Seven signatures cover the failures seen so far.** A new failure
  shape is a new entry in `SIGNATURES` — the loop cannot recognise a
  pattern it has not been told about.
