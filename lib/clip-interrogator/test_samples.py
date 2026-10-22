#!/usr/bin/env python3
"""Unit tests for the CLIP tool's sample catalog (samples.py).

Pure stdlib — no torch, no gradio, no model download, no image. Run:

    python3 lib/clip-interrogator/test_samples.py

Exits 0 when every check passes, 1 otherwise. Mirrors the plain-script
test convention used by lib/*.test.js and lib/flux2-renderer/test_*.py
in this repo (no test framework).

Why this file exists
--------------------
`samples.py` is the WRITE side of the CLIP tool's sample strip: it
merges an interrogation result into `data/clip/samples.json`, which the
page fetches and renders. It was written with care — atomic writes, a
backup of a corrupt catalog, idempotency per image — and with no test
at all. The file-I/O half of a pipeline is exactly the half that
matters most and is easiest to break, and a broken catalog shows up as
a page silently showing the wrong sample.

The behaviours pinned here:
  - the entry's shape, and that the label defaults to the image stem
  - the merge creates the file and its parents when missing
  - the merge is IDEMPOTENT per image: re-running replaces, never
    duplicates (the indexer is re-runnable by design)
  - a corrupt catalog is backed up, not raised — a broken catalog must
    not kill an interrogation run, and the evidence is never destroyed
  - a catalog that is valid JSON but the WRONG SHAPE is treated as empty
  - the write is atomic: no temp file is left behind
  - the written catalog never carries an absolute filesystem path
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from clip_interrogator_app.samples import (  # noqa: E402
    SCHEMA,
    _atomic_write,
    entry_for,
    merge_samples,
    now_iso,
)

_failures = []
_count = 0


def check(cond, label):
    """Record one check.

    The condition is evaluated inside a try, so a check that RAISES is
    reported as a failure instead of aborting the whole run. Without
    this, one broken behaviour would hide every check after it — and a
    suite that stops early is a suite that says less than it looks like
    it says.
    """
    global _count
    _count += 1
    try:
        ok = bool(cond)
        detail = ""
    except Exception as exc:  # noqa: BLE001 — a raise IS a failure here
        ok = False
        detail = " (%s: %s)" % (type(exc).__name__, exc)
    if ok:
        print("  ✓ %s" % label)
    else:
        _failures.append(label)
        print("  ✗ %s%s" % (label, detail))


def section(title):
    print("\n%s" % title)


def tmpdir():
    return Path(tempfile.mkdtemp(prefix="clip-samples-test-"))


# ------------------------------------------------------------------------
section("1. entry_for — the shape of one entry")

e = entry_for("assets/clip-interrogator/example01.jpg", "vit-l", "best", "a prompt")
check(set(e.keys()) == {"image", "label", "model", "mode", "prompt"},
      "the entry has exactly the schema's keys")
check(e["image"] == "assets/clip-interrogator/example01.jpg",
      "the image path is kept verbatim")
check(e["label"] == "example01", "the label defaults to the image stem")
check(e["model"] == "vit-l" and e["mode"] == "best", "model and mode are kept")
check(e["prompt"] == "a prompt", "the prompt is kept")

e2 = entry_for("assets/clip-interrogator/example02.jpg", "vit-h", "fast", "p", label="custom")
check(e2["label"] == "custom", "an explicit label wins over the stem")

# The module documents that `image` must be repo-relative — the page has
# to fetch it. entry_for does not sanitise it; the CLI does, via
# _display_path. This test pins that the module passes it through, so
# the contract stays where it is rather than drifting.
e3 = entry_for("/abs/path/img.jpg", "vit-l", "best", "p")
check(e3["image"] == "/abs/path/img.jpg",
      "entry_for does not rewrite the image path (the CLI owns that rule)")

check(set(SCHEMA["samples"][0].keys()) == set(e.keys()),
      "the declared schema matches what entry_for produces")

# ------------------------------------------------------------------------
section("2. now_iso — the timestamp")

ts = now_iso()
try:
    parsed = datetime.fromisoformat(ts)
    ok = parsed is not None
except ValueError:
    ok = False
check(ok, "now_iso parses as an ISO-8601 timestamp")
check(ts.endswith("+00:00"), "now_iso is UTC")

# ------------------------------------------------------------------------
section("3. merge_samples — creating a catalog")

root = tmpdir()
try:
    target = root / "nested" / "deeper" / "samples.json"
    catalog = merge_samples(target, entry_for("a/one.jpg", "vit-l", "best", "p1"))

    check(target.exists(), "the catalog is created when missing")
    check(target.parent.exists(), "the parent directories are created")
    check(len(catalog["samples"]) == 1, "the merged catalog has one entry")
    check(catalog["samples"][0]["prompt"] == "p1", "the entry is in the catalog")
    check(catalog["generatedAt"] != "", "generatedAt is set")

    on_disk = json.loads(target.read_text(encoding="utf-8"))
    check(on_disk["samples"][0]["prompt"] == "p1", "the file on disk holds the entry")
    check(on_disk["generatedAt"] == catalog["generatedAt"],
          "the returned catalog matches what was written")

    # Atomic write: the temp file must not survive.
    leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith(".samples-tmp-")]
    check(not leftovers, "no temp file is left behind after the write")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
section("4. merge_samples — idempotency per image")

root = tmpdir()
try:
    target = root / "samples.json"
    merge_samples(target, entry_for("a/one.jpg", "vit-l", "best", "first prompt"))
    catalog = merge_samples(target, entry_for("a/one.jpg", "vit-l", "best", "second prompt"))

    check(len(catalog["samples"]) == 1,
          "re-running the same image replaces rather than duplicates")
    check(catalog["samples"][0]["prompt"] == "second prompt",
          "the latest prompt wins")

    catalog = merge_samples(target, entry_for("a/two.jpg", "vit-l", "best", "other image"))
    check(len(catalog["samples"]) == 2, "a different image appends")

    # Keying is on `image`, so the same image under a different mode is
    # still the same image — one entry per image, not per (image, mode).
    catalog = merge_samples(target, entry_for("a/one.jpg", "vit-h", "fast", "new mode"))
    check(len(catalog["samples"]) == 2, "the key is the image, not the mode")
    check(catalog["samples"][-1]["mode"] == "fast",
          "the re-run entry carries the new mode")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
section("5. merge_samples — a broken catalog must not kill the run")


def merge_guarded(target, entry):
    """Merge, but never raise: a merge that blows up is a FAILED check,
    not an aborted suite. Returns (catalog, error)."""
    try:
        return merge_samples(target, entry), None
    except Exception as exc:  # noqa: BLE001
        return None, exc


root = tmpdir()
try:
    target = root / "samples.json"
    target.write_text("{ this is not json", encoding="utf-8")

    catalog, err = merge_guarded(target, entry_for("a/one.jpg", "vit-l", "best", "p"))

    check(err is None, "a corrupt catalog does not raise")
    check(catalog is not None and len(catalog["samples"]) == 1,
          "a corrupt catalog is replaced, not raised")
    check((root / "samples.json.corrupt").exists(),
          "the corrupt file is kept as .corrupt — the evidence is never destroyed")
    check(target.exists() and json.loads(target.read_text(encoding="utf-8"))["samples"][0]["prompt"] == "p",
          "the new catalog is valid JSON holding the entry")
finally:
    shutil.rmtree(root, ignore_errors=True)

# Valid JSON, wrong shape.
for bad, label in [("[]", "a JSON list"), ('{"samples": "nope"}', "samples that is not a list"),
                    ('{"samples": null}', "samples that is null"), ("42", "a bare number")]:
    root = tmpdir()
    try:
        target = root / "samples.json"
        target.write_text(bad, encoding="utf-8")
        catalog, err = merge_guarded(target, entry_for("a/one.jpg", "vit-l", "best", "p"))
        check(err is None, "%s does not raise" % label)
        check(catalog is not None and len(catalog["samples"]) == 1,
              "%s is treated as an empty catalog" % label)
    finally:
        shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
section("6. merge_samples — unrelated keys survive")

root = tmpdir()
try:
    target = root / "samples.json"
    target.write_text(json.dumps({"generatedAt": "x", "samples": [], "note": "keep me"}),
                      encoding="utf-8")
    merge_samples(target, entry_for("a/one.jpg", "vit-l", "best", "p"))
    on_disk = json.loads(target.read_text(encoding="utf-8"))
    check(on_disk.get("note") == "keep me", "an unrelated top-level key survives the merge")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
section("7. hygiene — the written catalog carries no absolute path")

root = tmpdir()
try:
    target = root / "samples.json"
    merge_samples(target, entry_for("assets/clip-interrogator/example01.jpg",
                                     "vit-l", "best", "p"))
    text = target.read_text(encoding="utf-8")
    check(str(root) not in text, "the catalog does not leak the filesystem path it was written to")
    check("/Users/" not in text and "/home/" not in text,
          "the catalog carries no absolute home path")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
section("8. _atomic_write")

root = tmpdir()
try:
    target = root / "a" / "b" / "out.txt"
    _atomic_write(target, "hello")
    check(target.read_text(encoding="utf-8") == "hello", "the file is written")
    check(target.parent.exists(), "the parents are created")
    leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith(".samples-tmp-")]
    check(not leftovers, "no temp file is left behind")
finally:
    shutil.rmtree(root, ignore_errors=True)

# ------------------------------------------------------------------------
print("\n[clip-samples.test] passed: %d, failed: %d" % (_count, len(_failures)))
if _failures:
    for f in _failures:
        print("  FAILED: %s" % f)
    sys.exit(1)
