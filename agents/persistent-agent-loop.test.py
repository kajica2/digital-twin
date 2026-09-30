#!/usr/bin/env python3
"""
agents/persistent-agent-loop.test.py — tests for the served-dashboard hook.

The feature under test: `run` refreshes the SERVED dashboard (the page
`pages/cognitive-twin.html` iframes) on pause/exit, and every
DASHBOARD_REFRESH_EVERY iterations while it works, so the human view
stops going stale. The rule with teeth: discovery walks UP from the
state file, never the CWD, so a throwaway run in a scratch dir must
write NOTHING — no stray `pages/` tree, no litter.

Pure stdlib, no network, no model. Uses the built-in demo model.

    python3 agents/persistent-agent-loop.test.py
"""

from __future__ import annotations

import importlib.util
import io
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE = HERE / "persistent-agent-loop.py"

# the filename carries a hyphen, so import it by path
_spec = importlib.util.spec_from_file_location("persistent_agent_loop", MODULE)
pal = importlib.util.module_from_spec(_spec)
# py3.9 dataclasses resolve type hints through sys.modules[cls.__module__],
# so the module has to be registered before it executes
sys.modules["persistent_agent_loop"] = pal
_spec.loader.exec_module(pal)

passed = 0
failed = 0
failures = []


def assert_eq(label, actual, expected):
    global passed, failed
    if actual == expected:
        passed += 1
        print(f"  \u2713 {label}")
    else:
        failed += 1
        failures.append((label, expected, actual))
        print(f"  \u2717 {label}")
        print(f"      expected: {expected!r}")
        print(f"      got:      {actual!r}")


def assert_true(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  \u2713 {label}")
    else:
        failed += 1
        failures.append((label, "true", f"false  {detail}".rstrip()))
        print(f"  \u2717 {label}")
        if detail:
            print(f"      {detail}")


TMP = Path(tempfile.mkdtemp(prefix="agent-loop-test-"))
PLACEHOLDER = "<!-- placeholder marker -->"
print("\n[agent-loop.test]\n")


def fake_repo(name="repo"):
    """A repo-shaped temp dir with the served dashboard in place."""
    root = TMP / name
    (root / ".agent").mkdir(parents=True, exist_ok=True)
    (root / "pages").mkdir(parents=True, exist_ok=True)
    (root / "pages" / "agent-dashboard.html").write_text(PLACEHOLDER, encoding="utf-8")
    return root


def served(root):
    return (root / "pages" / "agent-dashboard.html").read_text(encoding="utf-8")


def run_loop(argv):
    """Run the CLI in-process; returns (exit_code, stdout_text)."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        try:
            code = pal.main(argv)
        except SystemExit as exc:          # argparse usage errors
            code = exc.code or 0
    return code, buf.getvalue()


# ---------------------------------------------------------------------------
print("1. discovery walks up from the state file, not the CWD")
root = fake_repo("disc")
state = root / ".agent" / "state.json"
state.write_text("{}", encoding="utf-8")
assert_eq("finds pages/ next to .agent/",
          pal.find_served_dashboard(state), root / "pages" / "agent-dashboard.html")

deep = root / "runs" / "one"
deep.mkdir(parents=True, exist_ok=True)
deep_state = deep / "state.json"
deep_state.write_text("{}", encoding="utf-8")
assert_eq("finds it from a nested state file",
          pal.find_served_dashboard(deep_state), root / "pages" / "agent-dashboard.html")

scratch = TMP / "scratch" / ".agent"
scratch.mkdir(parents=True, exist_ok=True)
scratch_state = scratch / "state.json"
scratch_state.write_text("{}", encoding="utf-8")
assert_eq("scratch dir with no served page -> None",
          pal.find_served_dashboard(scratch_state), None)

# relative state path: discovery must still work off the state file
cwd = os.getcwd()
try:
    os.chdir(str(root))
    assert_eq("relative .agent/state.json resolves from the state file's own tree",
              pal.find_served_dashboard(Path(".agent/state.json")),
              Path("pages/agent-dashboard.html"))
finally:
    os.chdir(cwd)

# ---------------------------------------------------------------------------
print("\n2. render_dashboard")
st = pal.State.new("ship <the> & thing", ["step one", "step two"])
st.memory["key"] = "value"
st.log_event("note", "hello")
doc = pal.render_dashboard(st)
assert_true("renders the goal", "ship &lt;the&gt; &amp; thing" in doc)
assert_true("HTML-escapes the goal (no raw angle brackets)",
            "ship <the>" not in doc)
assert_true("renders plan rows", "step one" in doc and "step two" in doc)
assert_true("renders memory", "key" in doc and "value" in doc)
assert_true("renders journal entries", "hello" in doc)
assert_true("renders status badge", "running" in doc)

st.plan[0].status = "done"
assert_true("reflects step state changes", "done" in pal.render_dashboard(st))

# ---------------------------------------------------------------------------
print("\n3. write_dashboard creates parents and writes atomically")
out = TMP / "deep" / "nested" / "view.html"
pal.write_dashboard(st, out)
assert_true("creates missing parent dirs", out.exists())
assert_true("writes the rendered doc", "ship" in out.read_text(encoding="utf-8"))
leftovers = [p for p in out.parent.iterdir() if p.name.startswith(".agent-tmp-")]
assert_eq("no temp files left behind", leftovers, [])

# ---------------------------------------------------------------------------
print("\n4. refresh_dashboard is total (never raises, returns the target)")
explicit = TMP / "explicit.html"
assert_eq("explicit out -> that path",
          pal.refresh_dashboard(st, scratch_state, explicit), explicit)
assert_true("explicit out was written", explicit.exists())

assert_eq("no target, no out -> None (writes nothing)",
          pal.refresh_dashboard(st, scratch_state, None), None)
assert_eq("scratch dir still has no pages/ tree",
          (TMP / "scratch" / "pages").exists(), False)

# an unwritable target must not raise
blocker = TMP / "blocker"
blocker.write_text("i am a file, not a directory", encoding="utf-8")
with redirect_stdout(io.StringIO()):          # the failure line is expected here
    unwritable = pal.refresh_dashboard(st, scratch_state, blocker / "sub" / "x.html")
assert_eq("unwritable target -> None, no exception", unwritable, None)

# ---------------------------------------------------------------------------
print("\n5. run() auto-refreshes the served dashboard on exit")
repo = fake_repo("auto")
rc, out_txt = run_loop(["run", "--goal", "demo goal", "--plan", "one step",
                        "--state", str(repo / ".agent" / "state.json")])
assert_eq("run finishes (demo model)", rc, 0)
text = served(repo)
assert_true("served dashboard rewritten with live goal",
            "demo goal" in text, text[:60])
assert_true("placeholder replaced", PLACEHOLDER not in text)
assert_true("run does not clobber the local .agent/dashboard.html",
            not (repo / ".agent" / "dashboard.html").exists())
assert_true("reports the refresh", "served dashboard refreshed" in out_txt, out_txt)

# ---------------------------------------------------------------------------
print("\n6. --no-dashboard leaves the served page alone")
repo = fake_repo("quiet")
rc, _ = run_loop(["run", "--goal", "second goal", "--plan", "a step",
                  "--state", str(repo / ".agent" / "state.json"), "--no-dashboard"])
assert_eq("run still finishes", rc, 0)
assert_eq("--no-dashboard preserves the file", served(repo), PLACEHOLDER)

# ---------------------------------------------------------------------------
print("\n7. --dashboard-out targets a path discovery would never find")
repo = fake_repo("explicit-run")
target = TMP / "nowhere" / "live.html"
rc, out_txt = run_loop(["run", "--goal", "third goal", "--plan", "a step",
                        "--state", str(repo / ".agent" / "state.json"),
                        "--dashboard-out", str(target)])
assert_eq("run finishes", rc, 0)
assert_true("explicit target written", target.exists())
assert_true("explicit target has the goal", "third goal" in target.read_text(encoding="utf-8"))
assert_eq("discovered page untouched", served(repo), PLACEHOLDER)

# ---------------------------------------------------------------------------
print("\n8. the in-loop periodic refresh fires (not just the exit refresh)")
repo = fake_repo("periodic")
calls = []
real_refresh = pal.refresh_dashboard


def counting_refresh(st_, path_, out_=None):
    calls.append(st_.iteration)
    return real_refresh(st_, path_, out_)


pal.refresh_dashboard = counting_refresh
try:
    rc, _ = run_loop(["run", "--goal", "long goal",
                      "--plan", ";;".join(f"step {i}" for i in range(1, 7)),
                      "--state", str(repo / ".agent" / "state.json")])
finally:
    pal.refresh_dashboard = real_refresh

assert_eq("run finishes", rc, 0)
assert_true(f"refreshed more than once ({len(calls)} calls)", len(calls) >= 2,
            str(len(calls)))
assert_true("a periodic refresh happened mid-run (iteration < final)",
            any(i < max(calls) for i in calls), str(calls))

# ---------------------------------------------------------------------------
print("\n9. the explicit dashboard command still works")
repo = fake_repo("cmd")
pal.State.new("cmd goal", ["x"]).save(repo / ".agent" / "state.json")
rc, out_txt = run_loop(["dashboard", "--state", str(repo / ".agent" / "state.json"),
                        "--out", str(TMP / "cmd-out" / "d.html")])
assert_eq("dashboard exits 0", rc, 0)
assert_true("wrote the requested file", (TMP / "cmd-out" / "d.html").exists())
assert_true("says what it wrote", "wrote" in out_txt, out_txt)

rc, _ = run_loop(["dashboard", "--state", str(TMP / "absent" / "state.json")])
assert_eq("missing state -> exit 1", rc, 1)

# ---------------------------------------------------------------------------
try:
    shutil.rmtree(TMP, ignore_errors=True)
except Exception:
    pass

print(f"\n[agent-loop.test] passed: {passed}, failed: {failed}")
if failed:
    for label, expected, actual in failures:
        print(f"  FAILED: {label}\n    expected: {expected!r}\n    got:      {actual!r}")
sys.exit(0 if failed == 0 else 1)
