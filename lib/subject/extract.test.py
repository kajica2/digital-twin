#!/usr/bin/env python3
"""lib/subject/extract.test.py — the extractor's decisions, with no model.

The extraction engine needs 176 MB of weights; the DECISIONS do not. Every
pure function here — the box, the coverage, the crop, the sidecar, the flag
table — is measured on a synthetic image, so the suite is fast, offline and
needs no weights on the machine.

    python3 lib/subject/extract.test.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract  # noqa: E402

from PIL import Image  # noqa: E402
import numpy as np  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


def synthetic(width=200, height=300, box=(60, 80, 140, 240)):
    """a matte: transparent background, one opaque rectangle on it.

    The background is TRANSPARENT, because that is what a matte is — the
    subject is the opaque part. (A fixture with an opaque background
    makes "the foreground" the whole canvas, which is exactly what the
    first version of this fixture did.)
    """
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    arr[:, :, 0] = 240
    arr[:, :, 1] = 230
    arr[:, :, 2] = 210
    arr[:, :, 3] = 0
    x0, y0, x1, y1 = box
    arr[y0:y1, x0:x1, 0] = 30
    arr[y0:y1, x0:x1, 1] = 60
    arr[y0:y1, x0:x1, 2] = 120
    arr[y0:y1, x0:x1, 3] = 255
    return Image.fromarray(arr, "RGBA")


def section(title):
    print(f"\n{title}")


# --------------------------------------------------------------------------
section("1. the foreground box")
img = synthetic()
alpha = extract.alpha_channel(img)
bbox = extract.subject_bbox(alpha)
check("the box is the opaque rectangle", bbox == (60, 80, 140, 240), f"got {bbox}")
check("x1/y1 are exclusive", bbox[2] == 140 and bbox[3] == 240)
check("the coverage is the rectangle's share",
      abs(extract.coverage(alpha) - ((140 - 60) * (240 - 80)) / (200 * 300)) < 1e-6)

empty = Image.new("L", (10, 10), 0)
check("an empty matte has no box", extract.subject_bbox(empty) is None)
check("an empty matte has no coverage", extract.coverage(empty) == 0.0)

# --------------------------------------------------------------------------
section("2. the threshold")
half = Image.new("L", (10, 10), 0)
half.paste(128, (2, 2, 8, 8))
half.paste(127, (0, 0, 2, 2))
box = extract.subject_bbox(half)
check("alpha 128 counts as foreground", box == (2, 2, 8, 8), f"got {box}")

# --------------------------------------------------------------------------
section("3. the crop")
img = synthetic()
bbox = extract.subject_bbox(extract.alpha_channel(img))
check("pad 0 crops exactly to the box",
      extract.crop_box(bbox, 200, 300, 0) == (60, 80, 140, 240))
check("pad 4 grows the box by 4 on each side",
      extract.crop_box(bbox, 200, 300, 4) == (56, 76, 144, 244))
check("the crop is clamped to the canvas",
      extract.crop_box((0, 0, 10, 10), 200, 300, 50) == (0, 0, 60, 60))
cropped = extract.crop_to_subject(img, bbox, 0)
check("the cropped image is the box's size", cropped.size == (80, 160), f"got {cropped.size}")
check("the cropped image keeps its alpha", cropped.mode == "RGBA")

# --------------------------------------------------------------------------
section("4. the sidecar")
with tempfile.TemporaryDirectory() as tmp:
    dest = Path(tmp) / "nested" / "out.json"
    extract.sidecar({"tool": "subject-extract", "n": 1}, dest)
    check("the sidecar is written", dest.exists())
    payload = json.loads(dest.read_text())
    check("the sidecar is the report", payload["n"] == 1)
    check("the sidecar creates its directory", dest.parent.is_dir())

# --------------------------------------------------------------------------
section("5. the ranking")
r = extract.rank_phrases(["a rabbit", "a backdrop", "a chair"], [0.29, 0.06, 0.03])
check("the best phrase wins", r["best"] == "a rabbit", f"got {r}")
check("the runner-up is named", r["runnerUp"] == "an empty backdrop" or r["runnerUp"] == "a backdrop", f"got {r}")
check("the margin is against the runner-up",
      abs(r["margin"] - (0.29 - 0.06)) < 1e-9, f"got {r}")
r = extract.rank_phrases(["a rabbit"], [0.29])
check("one phrase has no runner-up", "runnerUp" not in r and r["best"] == "a rabbit")
check("no phrases is no ranking", extract.rank_phrases([], []) == {})
r = extract.rank_phrases(["low", "high"], [0.1, 0.9])
check("the ranking is not the argument order", r["best"] == "high", f"got {r}")

# --------------------------------------------------------------------------
section("6. the colours")
check("#rrggbb is opaque", extract._hex_rgba("#1c2842") == (28, 40, 66, 255))
check("#rrggbbaa keeps its alpha", extract._hex_rgba("#1c284280") == (28, 40, 66, 128))
try:
    extract._hex_rgba("#fff")
    check("a bad colour is refused", False, "no error")
except ValueError:
    check("a bad colour is refused", True)

# --------------------------------------------------------------------------
section("7. the flag table")
args = extract.parse_args(["a.jpg", "--out", "b.png"])
check("the image and the output are required", args.image == "a.jpg" and args.out == "b.png")
check("the default model is u2net", args.model == "u2net")
check("the default pad is 8", args.pad == 8)
args = extract.parse_args(["a.jpg", "--out", "b.png", "--contrast", "x", "--contrast", "y"])
check("--contrast repeats", args.contrast == ["x", "y"])
args = extract.parse_args(["a.jpg", "--out", "b.png", "--no-crop"])
check("--no-crop is a flag", args.no_crop is True)


def cli(argv):
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "extract.py")] + argv,
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


code, out = cli(["a.jpg", "--out", "b.png", "--not-a-flag"])
check("an unknown flag is refused", code == 2, f"got {code}")
check("the refusal names the flag", "not-a-flag" in out, out[:200])
code, out = cli(["/definitely/not/here.jpg", "--out", "b.png"])
check("a missing file is refused", code == 2, f"got {code}")
check("the refusal says which file", "no such file" in out, out[:200])
code, out = cli(["a.jpg", "--out", "b.png", "--pad", "-4"])
check("a negative pad is refused", code == 2, f"got {code}")

# --------------------------------------------------------------------------
print()
if FAILURES:
    print(f"subject-extract: {len(FAILURES)} FAILED -> {FAILURES}")
    sys.exit(1)
print("subject-extract: all checks passed")
