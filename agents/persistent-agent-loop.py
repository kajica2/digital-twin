#!/usr/bin/env python3
"""
persistent_agent.py — a resumable agent loop that never loses track.

The design in one sentence:
    the agent's ENTIRE mental state lives in one JSON file, and the loop
    checkpoints that file BEFORE and AFTER every step. A crash, a reboot,
    a Ctrl-C or a full context window can never lose more than the one
    step that was in flight.

Run it:
    python persistent_agent.py run --goal "ship the billing refactor" \
        --plan "map the current code;;extract invoice model;;add tests;;cut over"

    # work on it for an hour, then Ctrl-C, then go home. Tomorrow:
    python persistent_agent.py run          # resumes mid-step, same goal
    python persistent_agent.py status       # where am I?
    python persistent_agent.py dashboard    # writes dashboard.html
    python persistent_agent.py reset        # wipe and start over

Wire in a real model with no SDK at all (any CLI that reads stdin):
    python persistent_agent.py run --cmd "llm -m gpt-4o"
    python persistent_agent.py run --cmd "ollama run llama3"
    python persistent_agent.py run --cmd "claude -p"

--------------------------------------------------------------------------------
DECISION CONTRACT
--------------------------------------------------------------------------------
Each turn the model receives a context block on stdin (goal, active step, plan,
memory, recent log) and must print ONE JSON object:

    {"thought": "why I'm doing this", "action": "<name>", "args": {...}}

    complete  {"result": "..."}        finish the ACTIVE step
    fail      {"reason": "..."}        abandon the ACTIVE step
    plan      {"steps": ["a", "b"]}    append new steps
    remember  {"key": "k", "value": "v"}
    note      {"text": "..."}          free-form scratch note
    finish    {"summary": "..."}       the goal is met
    blocked   {"reason": "..."}        needs a human / can't proceed

The loop owns the state machine; the model only ever picks one of these verbs.
That split is why it can't drift: it physically cannot forget the plan, because
the plan is not in its context window — it's on disk.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

STATE_VERSION = 1

# --- context / safety knobs -------------------------------------------------
LOG_KEEP = 120           # log entries retained inside the state file
LOG_TRIM_TO = 80         # archive down to this when LOG_KEEP is exceeded
CTX_LOG_TAIL = 12        # recent entries injected into the prompt
CTX_CHARS = 8000         # rough character budget for the context block
MAX_TURNS_PER_STEP = 6   # stuck detection: give up on a step after this many
MAX_STEP_ATTEMPTS = 3    # total activations allowed for one step

STATUS_MARK = {"pending": "[ ]", "active": "[~]", "done": "[x]", "failed": "[!]"}


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Step:
    id: int
    text: str
    status: str = "pending"   # pending | active | done | failed
    result: str = ""
    attempts: int = 0


@dataclass
class State:
    goal: str
    plan: list[Step] = field(default_factory=list)
    log: list[dict] = field(default_factory=list)
    memory: dict[str, str] = field(default_factory=dict)
    iteration: int = 0
    turns_on_step: int = 0
    status: str = "running"   # running | paused | done | blocked | failed
    consecutive_failures: int = 0
    last_error: str | None = None
    created_at: str = ""
    updated_at: str = ""

    # -- construction -------------------------------------------------------
    @classmethod
    def new(cls, goal: str, steps: list[str]) -> "State":
        st = cls(goal=goal, created_at=now_iso())
        st.log_event("start", f"goal: {goal}")
        for i, text in enumerate(steps, 1):
            st.plan.append(Step(id=i, text=text))
        return st

    # -- serialization ------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "version": STATE_VERSION,
            "goal": self.goal,
            "plan": [s.__dict__ for s in self.plan],
            "log": self.log,
            "memory": self.memory,
            "iteration": self.iteration,
            "turns_on_step": self.turns_on_step,
            "status": self.status,
            "consecutive_failures": self.consecutive_failures,
            "last_error": self.last_error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "State":
        st = cls(goal=d.get("goal", ""))
        keys = {"id", "text", "status", "result", "attempts"}
        st.plan = [Step(**{k: v for k, v in s.items() if k in keys})
                   for s in d.get("plan", [])]
        st.log = list(d.get("log", []))
        st.memory = dict(d.get("memory", {}))
        st.iteration = int(d.get("iteration", 0))
        st.turns_on_step = int(d.get("turns_on_step", 0))
        st.status = d.get("status", "running")
        st.consecutive_failures = int(d.get("consecutive_failures", 0))
        st.last_error = d.get("last_error")
        st.created_at = d.get("created_at", "")
        st.updated_at = d.get("updated_at", "")
        return st

    # -- io -----------------------------------------------------------------
    @classmethod
    def load(cls, path: Path) -> "State":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def save(self, path: Path) -> None:
        """Atomically checkpoint, spilling old log entries to journal.jsonl."""
        self.updated_at = now_iso()
        if len(self.log) > LOG_KEEP:
            cut = len(self.log) - LOG_TRIM_TO
            old, self.log = self.log[:cut], self.log[cut:]
            with open(path.with_name("journal.jsonl"), "a", encoding="utf-8") as fh:
                for entry in old:
                    fh.write(json.dumps(entry) + "\n")
        _atomic_write(path, json.dumps(self.to_dict(), indent=2))

    # -- helpers ------------------------------------------------------------
    def log_event(self, kind: str, text: str) -> None:
        self.log.append({"t": now_iso(), "kind": kind, "text": str(text)[:600]})

    def active(self) -> Step | None:
        return next((s for s in self.plan if s.status == "active"), None)


def _atomic_write(path: Path, text: str) -> None:
    """Write via temp file + fsync + rename: never leaves a half-written state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".agent-tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# context assembly — bounded so the window can never quietly overflow
# ---------------------------------------------------------------------------
def build_context(st: State, budget: int = CTX_CHARS) -> str:
    tail = st.log[-CTX_LOG_TAIL:]
    mem_clip = 200
    while True:
        block = _render(st, tail, mem_clip)
        if len(block) <= budget:
            return block
        if len(tail) > 1:
            tail = tail[1:]
        elif mem_clip > 40:
            mem_clip -= 40
        else:
            return block[:budget] + "\n…(context truncated)"


def _render(st: State, tail: list[dict], mem_clip: int) -> str:
    plan = "\n".join(
        f"  {STATUS_MARK.get(s.status, '?')} #{s.id} {s.text}"
        + (f"\n        -> {s.result[:200]}" if s.result else "")
        for s in st.plan
    ) or "  (no plan yet — emit a `plan` action)"

    mem = "\n".join(f"  {k}: {v[:mem_clip]}" for k, v in st.memory.items()) or "  (empty)"
    recent = "\n".join(
        f"  [{e['kind']}] {e['text'][:240]}" for e in tail
    ) or "  (empty)"

    a = st.active()
    active = (f"#{a.id} {a.text}  (turn {st.turns_on_step} on this step, "
              f"attempt {a.attempts})" if a
              else "NONE — either `plan` more steps or call `finish`/`blocked`")

    return f"""GOAL
{st.goal}

ACTIVE STEP
{active}

PLAN
{plan}

MEMORY
{mem}

RECENT LOG
{recent}

Reply with ONE JSON object:
{{"thought": "...", "action": "complete|fail|plan|remember|note|finish|blocked", "args": {{...}}}}"""


def extract_json(text: str) -> dict:
    """Pull the first balanced JSON object out of a model reply."""
    start = text.find("{")
    if start < 0:
        raise ValueError("model reply contained no JSON object")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("unbalanced JSON in model reply")


# ---------------------------------------------------------------------------
# the deterministic state machine
# ---------------------------------------------------------------------------
def ensure_active(st: State) -> None:
    """Guarantee the loop is always pointed at one concrete step."""
    if st.active() is not None:
        return
    nxt = next((s for s in st.plan if s.status == "pending"), None)
    if nxt is None:
        return
    nxt.status = "active"
    nxt.attempts += 1
    st.turns_on_step = 0
    st.log_event("step", f"#{nxt.id} start (attempt {nxt.attempts}): {nxt.text}")


def apply_decision(st: State, d: dict) -> None:
    action = str(d.get("action", "note")).strip().lower()
    args = d.get("args") or {}
    if not isinstance(args, dict):
        args = {"text": str(args)}
    thought = (d.get("thought") or "").strip()
    if thought:
        st.log_event("thought", thought)

    a = st.active()

    if action == "complete":
        if a is None:
            raise ValueError("`complete` with no active step")
        a.status = "done"
        a.result = str(args.get("result", ""))[:500]
        st.log_event("result", f"#{a.id} done: {a.result}")
        st.turns_on_step = 0

    elif action == "fail":
        target = a or next((s for s in st.plan if s.status == "pending"), None)
        if target is None:
            raise ValueError("`fail` with nothing to fail")
        target.status = "failed"
        target.result = str(args.get("reason", ""))[:500]
        st.log_event("fail", f"#{target.id} abandoned: {target.result}")
        st.turns_on_step = 0

    elif action == "plan":
        steps = args.get("steps") or []
        if isinstance(steps, str):
            steps = [steps]
        nid = max((s.id for s in st.plan), default=0)
        for t in steps:
            nid += 1
            st.plan.append(Step(id=nid, text=str(t)[:400]))
        st.log_event("plan", f"added {len(steps)} step(s): " + "; ".join(map(str, steps))[:300])

    elif action == "remember":
        st.memory[str(args.get("key", "?"))[:80]] = str(args.get("value", ""))[:600]
        st.log_event("memory", f"{args.get('key')} = {str(args.get('value'))[:120]}")

    elif action == "note":
        st.log_event("note", str(args.get("text", "")))

    elif action == "finish":
        st.status = "done"
        st.log_event("done", str(args.get("summary", "goal complete")))

    elif action == "blocked":
        st.status = "blocked"
        st.log_event("blocked", str(args.get("reason", "needs a human")))

    else:
        st.log_event("note", f"unknown action {action!r} ignored")


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------
DEMO_PLAN = [
    "Scope the goal and define what done looks like",
    "Do the heavy lifting",
    "Verify the result and write it down",
]


def demo_model(prompt: str, st: State) -> str:
    """Deterministic stand-in so the loop runs end-to-end with no API key."""
    if not st.plan:
        return json.dumps({"thought": "No plan yet, lay one out.",
                           "action": "plan", "args": {"steps": DEMO_PLAN}})
    a = st.active()
    if a is None:
        return json.dumps({"thought": "Plan exhausted.",
                           "action": "finish",
                           "args": {"summary": "all demo steps complete"}})
    if st.turns_on_step <= 1:
        return json.dumps({"thought": f"Thinking about #{a.id}",
                           "action": "note",
                           "args": {"text": f"sketching an approach for: {a.text}"}})
    return json.dumps({"thought": f"{a.text} is handled.",
                       "action": "complete",
                       "args": {"result": f"completed: {a.text}"}})


def make_model(args):
    if not args.cmd:
        return demo_model

    def subprocess_model(prompt: str, st: State) -> str:
        p = subprocess.run(args.cmd, shell=True, input=prompt, text=True,
                           capture_output=True, timeout=args.timeout)
        if p.returncode != 0:
            raise RuntimeError(
                f"model command exited {p.returncode}: {p.stderr.strip()[:400]}")
        return p.stdout

    return subprocess_model


# ---------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------
def show(st: State) -> None:
    done = sum(1 for s in st.plan if s.status == "done")
    a = st.active()
    tail = f"active #{a.id} {a.text[:52]}" if a else f"status={st.status}"
    print(f"  i{st.iteration:<4} [{done}/{len(st.plan)}] {tail}")


def cmd_run(args) -> int:
    path = Path(args.state)
    if args.reset and path.exists():
        path.unlink()
        print(f"reset {path}")

    if path.exists():
        st = State.load(path)
        if args.goal and args.goal != st.goal:
            print(f"! {path} already tracks a different goal: {st.goal!r}")
            print("  use --reset to start over.")
            return 1
        print(f"resuming: iteration {st.iteration}, status {st.status}")
        print(f"goal: {st.goal}")
        if st.status == "done":
            print("already done — use --reset to run again.")
            return 0
        if st.status in ("paused", "blocked", "failed"):
            st.status = "running"
            st.log_event("note", "resumed by user")
            st.save(path)
    else:
        if not args.goal:
            print("a new run needs --goal")
            return 2
        steps = [s.strip() for s in (args.plan or "").split(";;") if s.strip()]
        st = State.new(args.goal, steps)
        st.save(path)
        print(f"new run: {st.goal}")

    model = make_model(args)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    try:
        while st.status == "running":
            if st.iteration >= args.max_iterations:
                st.status = "paused"
                st.log_event("note", f"hit --max-iterations ({args.max_iterations})")
                break

            st.iteration += 1
            ensure_active(st)
            st.turns_on_step += 1

            # (1) checkpoint BEFORE acting: the counter is committed even if we die
            st.save(path)

            # stuck detection: this step is not moving
            if st.turns_on_step > MAX_TURNS_PER_STEP:
                a = st.active()
                if a is not None:
                    a.status = "failed"
                    a.result = f"no progress after {MAX_TURNS_PER_STEP} turns"
                    st.log_event("stuck", f"#{a.id} force-failed: {a.result}")
                    st.turns_on_step = 0
                else:
                    st.status = "blocked"
                    st.log_event("stuck", "no active step and no progress")
                st.save(path)
                show(st)
                continue

            try:
                raw = model(build_context(st), st)
                decision = extract_json(raw)
                st.consecutive_failures = 0
            except Exception as exc:                      # model/parse failure
                st.consecutive_failures += 1
                st.last_error = f"{type(exc).__name__}: {exc}"
                st.log_event("error", st.last_error)
                st.save(path)
                show(st)
                if st.consecutive_failures > args.max_failures:
                    st.status = "blocked"
                    st.log_event("blocked", f"gave up after {st.consecutive_failures} errors")
                    break
                delay = min(2 ** st.consecutive_failures, 30)
                print(f"  ! {st.last_error} — retrying in {delay}s")
                time.sleep(delay)
                continue

            try:
                apply_decision(st, decision)
            except ValueError as exc:
                st.log_event("error", f"bad decision: {exc}")
                st.save(path)
                continue

            # (2) checkpoint AFTER acting
            st.save(path)
            show(st)

    except KeyboardInterrupt:
        st.status = "paused"
        st.log_event("note", "interrupted — checkpointed, safe to resume")
        st.save(path)
        print("\ninterrupted. state saved; rerun the same command to continue.")

    print(f"\nstatus: {st.status}  |  iteration {st.iteration}  |  {path}")
    if st.status == "done":
        print(f"goal met: {st.goal}")
    return 0 if st.status == "done" else 1


# ---------------------------------------------------------------------------
# inspection
# ---------------------------------------------------------------------------
def cmd_status(args) -> int:
    path = Path(args.state)
    if not path.exists():
        print(f"no state at {path}")
        return 1
    st = State.load(path)
    a = st.active()
    print(f"goal      : {st.goal}")
    print(f"status    : {st.status}   iteration {st.iteration}   "
          f"updated {st.updated_at}")
    print(f"active    : " + (f"#{a.id} {a.text}" if a else "none"))
    print("plan:")
    for s in st.plan:
        print(f"  {STATUS_MARK.get(s.status, '?')} #{s.id} {s.text}"
              + (f"  ->  {s.result[:80]}" if s.result else ""))
    if st.memory:
        print("memory:")
        for k, v in st.memory.items():
            print(f"  {k}: {v[:100]}")
    print("last 8 log entries:")
    for e in st.log[-8:]:
        print(f"  [{e['kind']}] {e['text'][:110]}")
    return 0


def cmd_dashboard(args) -> int:
    path = Path(args.state)
    if not path.exists():
        print(f"no state at {path}")
        return 1
    st = State.load(path)
    rows = "".join(
        f"<tr class='{s.status}'><td>{s.id}</td><td>{html.escape(s.text)}</td>"
        f"<td>{s.status}</td><td>{s.attempts}</td>"
        f"<td>{html.escape(s.result[:200])}</td></tr>" for s in st.plan)
    mem = "".join(f"<tr><td>{html.escape(k)}</td><td>{html.escape(v[:300])}</td></tr>"
                  for k, v in st.memory.items()) or "<tr><td colspan=2>(empty)</td></tr>"
    feed = "".join(
        f"<div class='e {e['kind']}'><span>{html.escape(e['t'])}</span>"
        f"<b>{e['kind']}</b>{html.escape(e['text'][:400])}</div>"
        for e in reversed(st.log[-200:]))
    doc = f"""<!doctype html><meta charset="utf-8">
<title>agent · {html.escape(st.goal[:60])}</title>
<style>
 body{{font:14px/1.5 ui-sans-serif,system-ui;margin:0;padding:32px;background:#0f1117;color:#e6e8ee}}
 h1{{font-size:20px;margin:0 0 4px}} .meta{{color:#8b93a7;margin-bottom:24px}}
 h2{{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8b93a7;margin:28px 0 8px}}
 table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:7px 10px;border-bottom:1px solid #22252f}}
 th{{color:#8b93a7;font-size:12px;text-transform:uppercase}}
 tr.done td:first-child{{color:#4ade80}} tr.active td:first-child{{color:#facc15}}
 tr.failed td:first-child{{color:#f87171}}
 .badge{{display:inline-block;padding:2px 10px;border-radius:99px;background:#1c2434;font-size:12px}}
 .e{{display:grid;grid-template-columns:150px 90px 1fr;gap:10px;padding:5px 0;border-bottom:1px solid #1b1e27}}
 .e span{{color:#5f6779;font-size:12px}} .e b{{font-size:11px;text-transform:uppercase;color:#8b93a7}}
 .e.error b,.e.fail b,.e.stuck b,.e.blocked b{{color:#f87171}}
 .e.done b,.e.result b{{color:#4ade80}}
</style>
<h1>{html.escape(st.goal)}</h1>
<div class="meta">status <span class="badge">{st.status}</span> ·
 iteration {st.iteration} · updated {st.updated_at} · created {st.created_at}</div>
<h2>Plan</h2><table><tr><th>#</th><th>Step</th><th>State</th><th>Tries</th><th>Result</th></tr>{rows}</table>
<h2>Memory</h2><table>{mem}</table>
<h2>Journal</h2>{feed}
"""
    out = path.with_name("dashboard.html")
    out.write_text(doc, encoding="utf-8")
    print(f"wrote {out}")
    return 0


def cmd_reset(args) -> int:
    path = Path(args.state)
    for p in (path, path.with_name("journal.jsonl"), path.with_name("dashboard.html")):
        if p.exists():
            p.unlink()
            print(f"removed {p}")
    return 0


# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in {"run", "status", "dashboard", "reset"}:
        argv = ["run"] + argv

    p = argparse.ArgumentParser(description="A persistent, resumable agent loop.")
    sub = p.add_subparsers(dest="command", required=True)

    for name in ("run", "status", "dashboard", "reset"):
        sp = sub.add_parser(name)
        sp.add_argument("--state", default=".agent/state.json",
                        help="where the agent's brain lives (default: .agent/state.json)")
        if name == "run":
            sp.add_argument("--goal", help="what the agent is trying to achieve")
            sp.add_argument("--plan", help="initial steps, separated by ';;'")
            sp.add_argument("--cmd", help="shell command that reads the context on "
                                          "stdin and prints a JSON decision")
            sp.add_argument("--max-iterations", type=int, default=200)
            sp.add_argument("--max-failures", type=int, default=3,
                            help="consecutive model/parse failures before blocking")
            sp.add_argument("--timeout", type=int, default=180,
                            help="seconds to wait for the model command")
            sp.add_argument("--reset", action="store_true", help="start over")

    args = p.parse_args(argv)
    return {"run": cmd_run, "status": cmd_status,
            "dashboard": cmd_dashboard, "reset": cmd_reset}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
