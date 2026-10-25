# SWR Agent Hub

Three persistent agents that coordinate and keep things moving, plus a
monitor that watches them.

The agents are plain Node processes — no framework, no `claude` CLI, no
provider key. They are started detached, so they survive the terminal
that started them.

## Quick Start

```bash
cd ~/Documents/digital_twin

# The check agent verifies files and claims in this repo
export SWR_REPO="$HOME/Documents/sainted-word-records"

# Start the hub (four background processes: three agents + the monitor)
bash lib/agent-hub/agent-hub.sh start

# What is running
bash lib/agent-hub/agent-hub.sh status

# Send a command
bash lib/agent-hub/agent-cli.sh ops add "Write the liner notes in agents/TASKS.md"

# Read an agent's log
bash lib/agent-hub/agent-hub.sh logs twin

# Start what is down, leave what is up (what launchd calls)
bash lib/agent-hub/agent-hub.sh ensure

# Stop everything
bash lib/agent-hub/agent-hub.sh stop
```

`status` and `logs` are also available as `list` and `logs <agent>`.

## The Three Agents

### SWR-Ops (Orchestrator) — `agents/ops/swr-ops.js`
- Owns the task board (`tasks/swr-ops-tasks.md`)
- Sends new tasks to the twin, verdicts back to the board

**Commands** (`agent-cli.sh ops …`):
```
add <task>     - Add a task (it lands in In Progress)
done           - Move the first In Progress task to Done
block          - Move the first In Progress task to Blocked
status         - Print the board counts
twin <msg>     - Send a message to the twin
check <msg>    - Send a message to the check agent
```

### SWR-Twin (Digital Twin) — `agents/twin/swr-twin.js`
- Embodies the founder's voice and focus
- Plans a task: `proceed` above the confidence threshold, `escalate` below it
- Confidence threshold: **0.85**

**Commands** (`agent-cli.sh twin …`):
```
decide <opt1, opt2, opt3> | <context>  - Make a decision
remember <key> | <value>               - Store in memory
recall <key>                            - Retrieve from memory
voice                                   - Show the voice rules
```

### SWR-Check (Verifier) — `agents/check/swr-check.js`
- Read-only. Verifies and reports evidence.
- Every check is written to `check/verifications.md`

**Commands** (`agent-cli.sh check …`):
```
file <path>             - Verify a file exists (in $SWR_REPO)
diff <pattern>          - Check the git diff
test                    - Run the project's tests
claim <statement>       - Look for a statement in the repo's markdown
```

A check **never reports a PASS it cannot evidence**. A bare task is
refused ("a task is not a claim — name a file to check it, or a claim
to look for") rather than grepped for one word.

## The Round Trip

```
agent-cli.sh ops add "<task>"
  → ops      board: In Progress
  → twin     plan: proceed (85%) — <focus>  →  replies to ops
  → check    file <path> → PASS / FAIL      →  replies to ops
  → ops      PASS → the task moves to Done
```

A task the twin cannot place in its focus is **escalated** and stays on
the board for the human. That is the intended outcome, not a failure.

The board is the record: the task's own text moves to Done, and only the
verification subject (the file path, the claim) is what the check agent
reported.

## Agent Communication

Agents talk through files, and every message is **one file per
message** — never a shared file that two writers append to:

```
<hub root>/<agent>/inbox/<timestamp>-<pid>-<seq>-<rand>.msg
<hub root>/<agent>/commands/<timestamp>-<pid>-<rand>.msg
```

The envelope is one line: `[FROM→TO] body`. A sender writes to the
**recipient's** inbox; the recipient drains its own.

Why one file per item: a shared `inbox.txt` is a read-modify-write. Any
append that lands between the reader's read and its rename is
destroyed — silently. Under a 300-message race the shared-file version
lost 23 messages; the one-file-per-message version loses none. The
command queue had the same bug twice, so it is a directory too.

**A file is only readable when it is complete.** A writer creates
`.tmp-<name>.msg`, writes into it, then renames it into place. The temp
file *also* ends in `.msg`, so a reader that accepted anything with
that suffix would claim it — which makes the writer's own rename fail
and kills the writer mid-batch. Measured: 3 of 300 messages survived.
So a candidate is a file that is **neither** a `.tmp-…` **nor** an
already-claimed `.claimed-…`; the writers also take a fresh name and
retry rather than dying when their temp file vanishes.

### The monitor

`hub-coordinator.js` **watches** — it prints each agent's state, its
inbox depth and the board counts every five seconds. It does **not**
route messages: an earlier router re-appended each message to the
recipient and then unlinked the sender's copy, which destroyed
everything it touched. Each agent polls its own inbox.

## Runtime layout

```
lib/agent-hub/
├── agent-hub.sh          start / ensure / stop / status / logs
├── hub-launch.js         the login entry point (launchd runs this)
├── agent-cli.sh          send a command to an agent
├── hub-coordinator.js    the monitor (read-only)
├── hub.test.js           the unit suite (plain node, no framework)
├── agents/{ops,twin,check}/swr-*.js
├── lib/                  the pure logic — hub-runtime, the three brains
├── <agent>/inbox/        one file per message
├── <agent>/commands/     one file per command
├── <agent>/logs.txt      the agent's own log
├── pids/                 pid files + stdout capture
├── tasks/                the task board
├── memory/               the twin's memory
└── check/verifications.md the verification ledger
```

The runtime state (pids, logs, inboxes, commands) churns on every cycle
and is **gitignored**; the source is tracked.

## Running more than one hub

`SWR_HUB_ROOT` points a whole hub instance at a different directory —
pids, logs, inboxes, command queues, task board and memory all derive
from the root, so two instances do not interfere:

```bash
SWR_HUB_ROOT=/tmp/hub-b bash lib/agent-hub/agent-hub.sh start
```

The one thing that is global is `SWR_REPO` — the repo the check agent
verifies against.

## Tests

```bash
node lib/agent-hub/hub.test.js    # or: npm run test:agent-hub
```

Plain Node, no framework, no processes, no network. Temp directories
only.

## Integration with Obsidian

```bash
cd ~/Documents/digital_twin/lib/obsidian-integration
node twin-agent.js post "Agent hub started" --tag "system"
```
