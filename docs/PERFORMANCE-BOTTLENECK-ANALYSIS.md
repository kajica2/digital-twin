# Performance Bottleneck Analysis

> Source: vendored from the claude-flow skill docs, 2026-10-09.
> Reference doc for the `mcp__claude-flow__task_results` tool,
> **not wired into this repo**. For current agent coordination in
> digital_twin, see `CLAUDE.md` (ruflo) and the per-watcher docs.

## Purpose

Identify and resolve performance bottlenecks in the development
workflow. The generic framework below comes from claude-flow;
the "Actual bottlenecks in this repo" section that follows is
the load-bearing part for digital_twin.

## Automated Analysis

### 1. Real-time Detection
A post-task hook (in claude-flow, not here) automatically analyzes:
- Execution time vs. complexity
- Agent utilization rates
- Resource constraints
- Operation patterns

### 2. Common Bottlenecks

**Time Bottlenecks:**
- Tasks taking > 5 minutes
- Sequential operations that could parallelize
- Redundant file operations

**Coordination Bottlenecks:**
- Single agent for complex task
- Unbalanced agent workloads
- Poor topology selection

**Resource Bottlenecks:**
- High operation count (> 100)
- Memory constraints
- I/O limitations

### 3. Improvement Suggestions

Example output from `mcp__claude-flow__task_results` (claude-flow MCP,
not configured in this repo):

```json
{
  "bottlenecks": [
    {
      "type": "coordination",
      "severity": "high",
      "description": "Single agent used for complex task",
      "recommendation": "Spawn specialized agents for parallel work"
    }
  ],
  "improvements": [
    {
      "area": "execution_time",
      "suggestion": "Use parallel task execution",
      "expectedImprovement": "30-50% time reduction"
    }
  ]
}
```

The percentages and severities above are placeholders. For
load-bearing recommendations on this repo, see the next section.

## Actual bottlenecks in this repo

These are the hot paths, with measured wall times from the
current LaunchAgent fleet. Five places to look first when a
sprint feels slow.

### 1. `mj-watcher` is the dominant wall-time sink

Midjourney rate-limits to ~30-60s per prompt and the watcher
processes serially. A 4-prompt pack is 2-4 minutes wall; a
10-prompt pack is 5-10 minutes. The `--skip-done` flag (sprint
0.24) means partial-completion retries don't re-submit
finished prompts, but a fresh full pack still pays full cost.

Parallelism ceiling: the `mj-watcher.js` retries are
in-process and the Discord submitter holds one prompt at a
time. There is no fan-out. The fix is a worker pool with N
submitters, but the MJ API itself is the constraint, not the
watcher.

### 2. `chart-watcher` serializes 1 file at a time

`lib/chart-watcher.js` acquires a single lockfile and processes
files FIFO. Each chart is ~10s (mscore PDF render + ffmpeg MP3 +
multi-track MIDI + ffprobe). A backlog of 12 charts is 2 minutes
wall; 50 charts is ~8 minutes.

Note: `lib/musicxml-to-pdf.js` (the standalone tool, not the
watcher) has a `--jobs` flag for parallel mscore renders, and
measured 3-3.5x speedup at `--jobs 4` on the 12-file fixture.
The watcher doesn't use it.

### 3. `reel-watcher` is ffmpeg-bound, not CPU-bound

Per-file wall ~0.5s on M-series Macs (1080x1920 H.264, 6 Mbps,
30fps, audio fade). I/O dominates, not the transcode. A
50-reel drop is ~25s. No parallelism ceiling matters here.

### 4. e2e specs run serially in CI

`npm run verify` shells out to three Puppeteer specs
(`landing.spec.mjs`, `twin-os.spec.mjs`, `twin-os-songs.spec.mjs`)
in sequence. The full run is ~30s wall on the dev server. The
specs are independent and could run in parallel for a ~3x
speedup, but the `e2e/artifacts/` writes are not isolated
per-process today, so concurrent runs would step on each other.
Tracked as a pre-flight risk for any future parallelism.

### 5. The 12 e2e suites share a single port

Every `*.spec.mjs` boots its own `python3 -m http.server 5180
--directory .` (or relies on the launchd server on :5173).
Suite-startup overlap is ~3-5s each. `npm run test:all` runs
13 suites serially: ~1 minute wall. Parallelizing them needs
a port-allocation scheme (5180, 5181, 5182, ...) and
`puppeteer.launch({ args: ['--remote-debugging-port=...'] })`
per suite. Not done.

## Continuous Optimization

Real signals to watch, and what each implies:

| Signal | Threshold | Implication |
|---|---|---|
| `npm run verify` wall | > 60s | An e2e spec added a real render (e.g., WebCodecs init) that should be in a manual smoke, not the gate |
| `mj-output/` disk usage | > 50 GB | Old runs not pruned. `lib/mj-watcher.js` has no rotation. |
| `chart-watcher.log` `[fail]` rate | > 1% | Either mscore is hitting bad input or the well-formedness guard has a hole |
| `reel-watcher.log` time-per-file | > 2s on a Mac | ffmpeg regressed, or `--vf scale=...:flags=lanczos` chain grew |
| kpac-archive retry count | > 5 per snapshot | Wayback connection-pool thrash; lower the parallel prefetch count |

These are the levers a developer should reach for before
shipping a new watcher or a new pipeline. The original
claude-flow doc's "the system learns" hand-wave is replaced
by "the system measures" here: each sprint's watcher log
is the source of truth, not an in-process optimizer.

## See also

- `CLAUDE.md` — ruflo project rules, the actual agent coordination
- `docs/MJ-WATCHER.md` — Midjourney watcher setup + per-prompt retry
- `docs/REEL-WATCHER.md` — reel pipeline + sibling-audio pairing
- `docs/CHART-WATCHER.md` — chart pipeline + lockfile / retry
- `docs/SONGS-WATCHER.md` — songs indexer + LaunchAgent-aware tests
- `docs/AUTOMATION-SCOPE.md` — what the watchers do and do not own
