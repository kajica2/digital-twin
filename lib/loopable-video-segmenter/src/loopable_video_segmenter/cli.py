"""Headless CLI for the Loopable Video Segmenter.

Verbs:
  segment <video.mp4> [--segments N] [--no-loopable] [--out zip] [--json]
  check --self-check
Exit codes: 0 ok, 2 bad input, 3 runtime/model error.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import zipfile

from .core import create_loopable_segments

try:
    import ffmpeg  # noqa: F401  (only used to probe binary presence via shutil)
except ImportError:
    pass


def _ffmpeg_info():
    path = shutil.which("ffmpeg")
    if not path:
        return None
    return path


def _self_check() -> int:
    print("lvs-segment self-check")
    try:
        import gradio
        import librosa
        import moviepy
        import numpy
        import soundfile
        print(f"  import gradio        : ok   ({gradio.__version__})")
        print(f"  import librosa       : ok   ({librosa.__version__})")
        print(f"  import moviepy       : ok   ({moviepy.__version__})")
        print(f"  import numpy         : ok   ({numpy.__version__})")
        print(f"  import soundfile     : ok   ({soundfile.__version__})")
    except Exception as exc:
        print(f"  import failed: {exc}")
        return 3
    ff = _ffmpeg_info()
    if ff:
        print(f"  ffmpeg binary        : ok   ({ff})")
    else:
        print("  ffmpeg binary        : MISSING (brew install ffmpeg — required for render)")
    print("  result               : imports ok, deps ok")
    return 0


def _run_segment(args) -> int:
    if not os.path.isfile(args.input):
        print(f"error: input not found: {args.input}", file=sys.stderr)
        return 2

    try:
        zip_path, message = create_loopable_segments(
            args.input, args.segments, make_loopable=not args.no_loopable
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    if zip_path is None:
        print(f"error: {message}", file=sys.stderr)
        return 2

    if args.out:
        out = args.out
        if out.endswith(".zip"):
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            shutil.move(zip_path, out)
            zip_path = out
        else:
            os.makedirs(out, exist_ok=True)
            dest = os.path.join(out, os.path.basename(zip_path))
            shutil.move(zip_path, dest)
            zip_path = dest

    if args.json:
        payload = {
            "status": "ok",
            "message": message,
            "zip": zip_path,
            "segments": len(zipfile.ZipFile(zip_path).namelist()),
            "loopable": not args.no_loopable,
        }
        print(json.dumps(payload))
    else:
        print(message)
        print(f"zip: {zip_path}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="lvs-segment",
        description="Split an MP4 into beat-aligned mirror-loopable clips (zip).",
    )
    sub = parser.add_subparsers(dest="verb", required=True)

    seg = sub.add_parser("segment", help="split a video into loopable segments")
    seg.add_argument("input", help="path to the MP4")
    seg.add_argument("--segments", type=int, default=4, help="number of segments (1-20, default 4)")
    seg.add_argument("--no-loopable", action="store_true", help="plain cuts, no forward+reverse mirror")
    seg.add_argument("--out", default=None, help="output zip path or directory")
    seg.add_argument("--json", action="store_true", help="machine-readable output")

    chk = sub.add_parser("check", help="self-check imports + deps + ffmpeg")
    chk.add_argument("--self-check", action="store_true", help="run the self-check (no weights/models)")

    args = parser.parse_args(argv)
    if args.verb == "check":
        return _self_check()
    return _run_segment(args)


if __name__ == "__main__":
    sys.exit(main())