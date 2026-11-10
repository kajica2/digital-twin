#!/usr/bin/env python3
"""lib/subject/extract.py — cut the subject out of a picture.

The twin had RECOGNITION (CLIP, in the clip-interrogator venv) but no
EXTRACTION: nothing in the repo could take an object out of a frame and
hand back a transparent PNG. This is that half.

    python lib/subject/extract.py frame.jpg --out bunny.png
    python lib/subject/extract.py frame.jpg --out bunny.png \
        --prompt "a needle-felted wool rabbit" \
        --contrast "an empty studio backdrop"

What it does, in order:

  1. EXTRACT. rembg's u2net finds the salient subject and returns an
     alpha matte. This is the saliency model, not a prompt model: it
     answers "what stands out", not "what did you name".
  2. MEASURE. The matte's bounding box, its coverage and the crop it
     produced are computed from the pixels, not assumed.
  3. RECOGNIZE (only with --prompt). The EXTRACTED SUBJECT is scored
     against the prompt and against the contrast phrases by CLIP, over
     the JSON seam into the clip-interrogator venv — the only venv on
     this machine with torch + open_clip and the weights already
     cached. CLIP RANKs; it does not measure, so the report is a
     ranking and a margin, never a verdict. See docs/SUBJECT-EXTRACT.md.

The weights (176 MB for u2net) live in lib/subject/models/ — U2NET_HOME
points there, so a fresh clone downloads them once and nothing lands
in the user's home directory by surprise.

Exit codes:
  0  the subject was extracted (and, if asked for, scored)
  2  bad input: a missing file, an unknown flag, no subject in the picture
  3  the extraction worked and the CLIP check did not
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SUBJECT_DIR = Path(__file__).resolve().parent
MODELS_DIR = SUBJECT_DIR / "models"
CLIP_SCORE = REPO / "lib" / "story" / "clip_score.py"
CLIP_VENV = REPO / "lib" / "clip-interrogator" / ".venv" / "bin" / "python"

# A pixel is foreground at this alpha. rembg's matte is soft at the
# edge (a real feather), so the threshold is the middle of the ramp,
# not 0 (which would make the bbox the whole canvas) and not 255
# (which would drop the anti-aliased rim and shrink the cut).
ALPHA_FG = 128

MODELS = ("u2net", "isnet-general-use", "silueta")


# --------------------------------------------------------------------------
# the pure half: everything that can be measured without a model
# --------------------------------------------------------------------------

def alpha_channel(rgba):
    """the alpha channel as its own image."""
    return rgba.getchannel("A")


def subject_bbox(alpha, threshold=ALPHA_FG):
    """(x0, y0, x1, y1) of the foreground, or None when there is none.

    x1/y1 are EXCLUSIVE, the way a crop rectangle is. PIL's own getbbox()
    does the work: threshold the alpha, then ask for the box of what is
    left. No numpy, and no pixel loop.
    """
    mask = alpha.point(lambda a: 255 if a >= threshold else 0)
    box = mask.getbbox()
    return tuple(box) if box else None


def coverage(alpha, threshold=ALPHA_FG):
    """the fraction of the canvas that is foreground."""
    histogram = alpha.histogram()
    total = sum(histogram)
    if not total:
        return 0.0
    return sum(histogram[threshold:]) / total


def crop_box(bbox, width, height, pad=0):
    """the crop rectangle for a bbox, padded and clamped to the canvas."""
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(width, x1 + pad)
    y1 = min(height, y1 + pad)
    return (x0, y0, x1, y1)


def crop_to_subject(rgba, bbox, pad=0):
    """the cropped RGBA image."""
    return rgba.crop(crop_box(bbox, rgba.width, rgba.height, pad))


def rank_phrases(phrases, scores):
    """the ranking, as data: the winner, the runner-up and the margin.

    CLIP RANKs; it does not measure. So the report is never "this is a
    rabbit" — it is "this phrase matched best, by this much, over the
    next one". The margin is against the RUNNER-UP, not against the
    winner (which is how the first version reported a margin of 0.0
    every time the prompt won).
    """
    if not phrases or not scores:
        return {}
    pairs = list(zip(phrases, scores))
    pairs.sort(key=lambda p: p[1], reverse=True)
    best_phrase, best_score = pairs[0]
    out = {"best": best_phrase, "bestScore": round(float(best_score), 4)}
    if len(pairs) > 1:
        runner, runner_score = pairs[1]
        out["runnerUp"] = runner
        out["margin"] = round(float(best_score - runner_score), 4)
    return out


def sidecar(report, path):
    """the measurements, written next to the PNG."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


def parse_args(argv):
    """the flags, declared. An unknown flag is a mistake, not a no-op."""
    p = argparse.ArgumentParser(add_help=True, description=__doc__.split("\n")[0])
    p.add_argument("image", help="the picture to cut the subject out of")
    p.add_argument("--out", required=True, help="the transparent PNG to write")
    p.add_argument("--prompt", default=None,
                   help="name the object; CLIP scores the extracted subject against it")
    p.add_argument("--contrast", action="append", default=[],
                   help="a phrase the subject should NOT match (repeatable)")
    p.add_argument("--model", default="u2net", choices=MODELS,
                   help="the saliency model (default: u2net)")
    p.add_argument("--pad", type=int, default=8,
                   help="padding around the subject's box, in pixels (default: 8)")
    p.add_argument("--no-crop", action="store_true",
                   help="keep the original canvas; only the alpha changes")
    p.add_argument("--sidecar", default=None,
                   help="where to write the measurements (default: <out>.json)")
    p.add_argument("--composite", default=None,
                   help="also write a preview composited on this colour (#rrggbb)")
    p.add_argument("--json", action="store_true", help="print the measurements as JSON")
    args = p.parse_args(argv)
    if args.pad < 0:
        p.error("--pad cannot be negative")
    return args


# --------------------------------------------------------------------------
# the engines
# --------------------------------------------------------------------------

def matte(image, model="u2net"):
    """the alpha matte for the image — rembg's u2net, or a sibling."""
    # U2NET_HOME must be set BEFORE the session is built. rembg's
    # convention is `<U2NET_HOME>/models/<name>/<file>`, so the HOME is
    # the PROJECT directory and the weights land in lib/subject/models/
    # — not in the user's home directory by surprise, and not in a
    # doubled models/models/ path.
    os.environ.setdefault("U2NET_HOME", str(SUBJECT_DIR))
    from rembg import new_session, remove
    session = new_session(model)
    return remove(image, session=session)


def score_with_clip(images, phrases, timeout=900):
    """CLIP over the JSON seam into the clip-interrogator venv.

    Returns the matrix (images x phrases). Raises RuntimeError when the
    scorer is not there — the caller decides whether that is fatal.
    """
    if not CLIP_VENV.exists():
        raise RuntimeError(
            "the CLIP scorer needs the clip-interrogator venv: "
            "uv sync --project lib/clip-interrogator")
    job = json.dumps({"images": [str(p) for p in images], "lines": list(phrases)})
    proc = subprocess.run(
        [str(CLIP_VENV), str(CLIP_SCORE)],
        input=job, capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "the CLIP scorer failed: " + (proc.stderr.strip().splitlines() or ["?"])[-1])
    return json.loads(proc.stdout)


# --------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------

def extract(args, report):
    """the extraction itself. Returns the RGBA image."""
    from PIL import Image

    src = Path(args.image)
    if not src.exists():
        raise FileNotFoundError(f"no such file: {src}")
    image = Image.open(src).convert("RGB")
    report["source"] = str(src)
    report["sourceSize"] = [image.width, image.height]

    started = time.time()
    cut = matte(image, args.model)
    report["engine"] = args.model
    report["matteSeconds"] = round(time.time() - started, 2)

    alpha = alpha_channel(cut)
    report["coveragePct"] = round(coverage(alpha) * 100, 2)
    bbox = subject_bbox(alpha)
    if bbox is None:
        raise RuntimeError("no subject found — the matte is empty")
    report["subjectBox"] = list(bbox)

    if args.no_crop:
        out = cut
        report["crop"] = None
    else:
        box = crop_box(bbox, cut.width, cut.height, args.pad)
        out = cut.crop(box)
        report["crop"] = list(box)
    report["outputSize"] = [out.width, out.height]

    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest)
    report["output"] = str(dest)

    if args.composite:
        preview = Path(args.out).with_suffix(".preview.jpg")
        canvas = Image.new("RGBA", out.size, _hex_rgba(args.composite))
        canvas.alpha_composite(out)
        canvas.convert("RGB").save(preview, quality=90)
        report["preview"] = str(preview)
    return out


def _hex_rgba(value):
    """#rrggbb (or #rrggbbaa) as an RGBA tuple."""
    v = value.lstrip("#")
    if len(v) == 6:
        v += "ff"
    if len(v) != 8:
        raise ValueError(f"not a colour: {value}")
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4, 6))


def recognize(args, report):
    """CLIP scores the EXTRACTED SUBJECT against the prompt.

    The subject is scored, not the whole picture: the crop is tight, so
    the score is about the thing that was cut out. CLIP ranks; the
    report is a ranking and a margin, never a verdict.
    """
    phrases = [args.prompt] + list(args.contrast)
    images = [Path(args.out)]
    started = time.time()
    payload = score_with_clip(images, phrases)
    matrix = payload.get("matrix") or []
    scores = matrix[0] if matrix else []
    report["clip"] = {
        "model": payload.get("model"),
        "phrases": phrases,
        "scores": [round(float(s), 4) for s in scores],
        "seconds": round(time.time() - started, 2),
    }
    report["clip"].update(rank_phrases(phrases, scores))
    return report


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    report = {
        "tool": "subject-extract",
        "prompt": args.prompt,
        "pad": args.pad,
        "noCrop": bool(args.no_crop),
        "contrasts": args.contrast,
    }
    try:
        extract(args, report)
    except FileNotFoundError as exc:
        print(f"[subject-extract] {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"[subject-extract] {exc}", file=sys.stderr)
        return 2

    exit_code = 0
    if args.prompt:
        try:
            recognize(args, report)
        except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            print(f"[subject-extract] the extraction worked but the CLIP check did not: {exc}",
                  file=sys.stderr)
            exit_code = 3

    dest = Path(args.sidecar) if args.sidecar else Path(args.out).with_suffix(".json")
    sidecar(report, dest)
    report["sidecar"] = str(dest)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"[subject-extract] {args.out} "
              f"{report.get('outputSize')} · box {report.get('subjectBox')} "
              f"· {report.get('coveragePct')}% of the frame")
        if "clip" in report:
            c = report["clip"]
            line = " · ".join(f"{p} {s}" for p, s in zip(c["phrases"], c["scores"]))
            print(f"[subject-extract] CLIP ({c['model']}): {line}")
            if "best" in c:
                if "runnerUp" in c:
                    print(f"[subject-extract] the best match is {c['best']!r}, "
                          f"{c['margin']} ahead of {c['runnerUp']!r} "
                          f"— a ranking, not a verdict")
                else:
                    print(f"[subject-extract] the best match is {c['best']!r} "
                          f"— a ranking, not a verdict")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
