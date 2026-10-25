# SWR Harness — three agents, one board, no lost messages

The twin's agent runtime: **SWR-Ops** (orchestrator), **SWR-Twin**
(voice and focus) and **SWR-Check** (verifier), running as three live
processes that talk to each other through files.

The code is `lib/agent-hub/`. The fine detail lives in
`lib/agent-hub/README.md`; this page is the operator's view.

> **A note on the word "harness".** Every other `harness` string in
> this repo is a *test* harness (`lib/*.test.js`). This is the other
> kind: a runtime that keeps three agents alive and lets them
> coordinate.

---

## Run it

```bash
cd ~/Documents/digital_twin

# The check agent verifies files and claims in this repo
export SWR_REPO="$HOME/Documents/sainted-word-records"

bash lib/agent-hub/agent-hub.sh start     # 4 background processes
bash lib/agent-hub/agent-cli.sh status    # who is running
bash lib/agent-hub/agent-hub.sh logs twin # read an agent
bash lib/agent-hub/agent-hub.sh stop      # stop everything
```

`start` launches each agent in its own session (`setsid` where it
exists, python3's `os.setsid()` on macOS), so the agents outlive the
terminal. `status` is not proof of health — check with
`pgrep -fl 'swr-ops|swr-twin|swr-check|hub-coordinator'`, the way the
repo's launchd rule says.

### Start on login

The hub also comes up by itself. `com.kaidjuric.digital-twin.swr-hub`
(`RunAtLoad`, plus a five-minute `StartInterval`) runs
`lib/agent-hub/hub-launch.js ensure`, which starts only what is not
running — `start` is a clean restart that would otherwise kill a healthy
hub on every tick.

```bash
launchctl print gui/$UID/com.kaidjuric.digital-twin.swr-hub | grep -E 'runs|last exit'
node lib/agent-hub/hub-launch.js status     # the same view, without launchd
```

Two launchd facts this had to work around, both measured:

- **The job cannot exec a script under `$HOME`** (Sequoia, `Operation not
  permitted`), so the entry point is a shim in `~/Library/LaunchAgents`
  that resolves node — the same pattern as every watcher.
- **`/bin/bash` is not granted `~/Documents`.** The first version called
  `agent-hub.sh` from the shim and died with exit 126; node is granted
  it, which is why the launcher is JS. `agent-hub.sh ensure` now just
  `exec`s the node launcher, so there is one implementation.

**Requirements:** Node. Nothing else. No `claude` CLI, no provider key,
no network.

---

## The three roles

| Agent | File | Owns | Decides |
|---|---|---|---|
| **SWR-Ops** | `agents/ops/swr-ops.js` | the task board | what is in progress, what is done |
| **SWR-Twin** | `agents/twin/swr-twin.js` | the founder's voice and focus | `proceed` above 0.85, `escalate` below |
| **SWR-Check** | `agents/check/swr-check.js` | the verification ledger | PASS or FAIL, with evidence |

The brain of each agent is a separate pure module
(`lib/{ops,twin,check}-brain.js`), so the tested logic is the logic
that runs.

---

## The round trip

```
agent-cli.sh ops add "Write the liner notes for the lo-fi hip hop vinyl reissue in agents/TASKS.md"

  ops    Added: …                                    → board: In Progress
  twin   Plan for "…": proceed (85%) — lo-fi hip hop  → replies to ops
         Request from TWIN: file agents/TASKS.md     → asks check to verify
  check  File check: agents/TASKS.md → EXISTS        → replies to ops
         file:agents/TASKS.md → PASS
  ops    Completed: Write the liner notes …          → board: Done
```

Two things this shape is deliberate about:

- **A task the twin cannot place is escalated, not pushed through.** It
  stays on the board for the human. A task outside the twin's focus
  ("Fix the payroll spreadsheet") is a correct outcome, not a bug.
- **A check never reports a PASS it cannot evidence.** A bare task
  sentence is refused outright — "a task is not a claim — name a file
  to check it, or a claim to look for" — instead of being grepped for
  one word. (An earlier version word-split the request and passed a
  task on a `node_modules/…/RELEASENOTES.md` match. It moved a task to
  Done that was never done.)

---

## The message protocol

One envelope, one line:

```
[FROM→TO] body
```

A sender writes to the **recipient's** inbox; the recipient drains its
own. **One file per message**, never a shared file two writers append
to:

```
<hub root>/<agent>/inbox/<timestamp>-<pid>-<seq>-<rand>.msg
<hub root>/<agent>/commands/<timestamp>-<pid>-<rand>.msg
```

A shared `inbox.txt` is a read-modify-write: any append landing
between the reader's read and its rename is destroyed, silently. In a
300-message race the shared-file version lost **23**; the one-file
version loses none. The command queue had the same bug twice, so it is
a directory too.

One trap survives that shape, and it is worth knowing about because the
temp file looks exactly like a message: a writer creates
`.tmp-<name>.msg`, writes into it, then renames it into place. A reader
that accepts anything ending in `.msg` claims the temp file, which makes
the **writer's** rename fail and kills it mid-batch — measured at **3
of 300 messages surviving**. So only a file that is neither a
`.tmp-…` nor an already-claimed `.claimed-…` is readable, and the
writers take a fresh name and retry rather than dying with the message.

The **monitor** (`hub-coordinator.js`) only watches — it prints each
agent's state, inbox depth and the board counts every five seconds. It
does not route: an earlier router re-appended each message and then
unlinked the sender's copy, destroying everything it touched. The
router was deleted, not demoted.

---

## Several harnesses at once

`SWR_HUB_ROOT` points a whole instance at a different directory. Pids,
logs, inboxes, command queues, task board and memory all derive from
the root, so two instances never interfere:

```bash
SWR_HUB_ROOT=/tmp/hub-b bash lib/agent-hub/agent-hub.sh start
SWR_HUB_ROOT=/tmp/hub-b bash lib/agent-hub/agent-cli.sh status
```

The one global is `SWR_REPO` — the repo the check agent verifies
against.

---

## The board

`lib/agent-hub/tasks/swr-ops-tasks.md` — three lists (Blocked / In
Progress / Done), written as markdown so a human can read it without
the agents running.

The task's **own text** is what moves to Done. The check agent reports
what it *verified* (a file path, a claim), which is a pointer, not the
task — so the board matches on containment and keeps the board's
wording.

Note: ops loads the board once at start and rewrites the whole file on
every change. To reset it, **stop the hub, edit the file, start the
hub** — editing it while ops runs is overwritten by the in-memory copy.

---

## Verification ledger

`lib/agent-hub/check/verifications.md` — every check, with its type,
its target and its evidence. A failure is as useful as a pass here: it
is the record that the harness did not rubber-stamp.

---

## Tests

```bash
node lib/agent-hub/hub.test.js     # or: npm run test:agent-hub
```

Plain Node, no framework, no processes, no network — temp directories
only. It covers the envelope parser, the inbox and command channels,
the race regression and its temp-file trap, the three brains and a full
round trip. **114 assertions.**

**The race regression** is the important one: it spawns a writer and a
reader concurrently and asserts that all 300 messages survive. It was
verified to fail against the shared-file implementation — and, later,
against the version that let a reader claim a writer's temp file.

**The temp-file trap** has its own deterministic tests, because the
race alone only catches it when the timing lines up: they provoke a
half-written `.tmp-…` in both channels and assert the reader leaves it
alone, and they steal a writer's temp file to prove the writer retries
instead of dying.

---

## Limits

- **No model calls.** The agents reason over rules (focus areas, voice
  rules, confidence), not over an LLM. `lib/lm-client.js` exists for a
  provider-backed path, but no provider key is configured, so nothing
  in the live loop uses it.
- **The check agent is read-only over `$SWR_REPO`.** It greps the repo's
  markdown for a claim and checks that a file exists. It does not run
  the repo's test suite on a live check — `check test` exists, but the
  round trip never issues it.
- **The twin's memory is a file** (`memory/`), not a vector store.
- **A task escalates rather than proceeding** whenever the twin cannot
  place it. The focus list is the twin's; widen it in
  `lib/twin-brain.js` if the twin is too strict.
