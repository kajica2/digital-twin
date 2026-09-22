#!/usr/bin/env python3
"""Command-line interface for the CLIP Interrogator port.

Usage:
    clip-interrogate interrogate <image> [--model vit-l|vit-h] [--mode best|fast|classic|negative] [--json]
    clip-interrogate analyze    <image> [--model vit-l|vit-h] [--top 5] [--json]
    clip-interrogate check --self-check

Exit codes:
    0  ok
    2  bad input (missing file, unknown model/mode, unreadable image)
    3  model error (load or inference failure)
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from . import config
from .core import (
    InputError,
    ModelError,
    ModelManager,
    example_image,
    image_analysis,
    image_to_prompt,
    normalize_model_id,
)

EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_MODEL_ERROR = 3

# clip_interrogator prints "Loading caption model..." / "Loading CLIP
# model..." / "Loaded CLIP model and data in X seconds." to stdout from
# print() calls inside the library. For --json we must not let those pollute
# the parseable payload, so the whole load+inference is redirected to stderr.
def _silence_stdout():
    return contextlib.redirect_stdout(sys.stderr)


def _load_image(path: str) -> Image.Image:
    """Open an image, raising InputError for anything the user got wrong."""
    image_path = Path(path)
    if not image_path.exists():
        raise InputError(f"image not found: {image_path}")
    if not image_path.is_file():
        raise InputError(f"not a file: {image_path}")
    try:
        with Image.open(image_path) as im:
            return im.convert("RGB")
    except UnidentifiedImageError as exc:
        raise InputError(f"not a readable image: {image_path}") from exc
    except OSError as exc:
        raise InputError(f"could not read image {image_path}: {exc}") from exc


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clip-interrogate",
        description="CLIP Interrogator — turn an image into a prompt, "
        "or rank it against artist / medium / movement / trending / flavor.",
    )
    subs = parser.add_subparsers(dest="verb", required=True)

    interrogate = subs.add_parser("interrogate", help="Turn an image into a prompt")
    interrogate.add_argument(
        "image",
        nargs="?",
        default=None,
        help="Path to an image (default: assets/clip-interrogator/example01.jpg)",
    )
    interrogate.add_argument(
        "--model",
        choices=config.MODEL_IDS,
        default=config.MODEL_DEFAULT,
        help="CLIP model (default: %(default)s)",
    )
    interrogate.add_argument(
        "--mode",
        choices=config.MODES,
        default="best",
        help="Interrogation mode (default: %(default)s)",
    )
    interrogate.add_argument("--json", action="store_true", help="Emit JSON")

    analyze = subs.add_parser(
        "analyze", help="Rank an image against the CLIP vocabularies"
    )
    analyze.add_argument(
        "image",
        nargs="?",
        default=None,
        help="Path to an image (default: assets/clip-interrogator/example01.jpg)",
    )
    analyze.add_argument(
        "--model",
        choices=config.MODEL_IDS,
        default=config.MODEL_DEFAULT,
        help="CLIP model (default: %(default)s)",
    )
    analyze.add_argument("--top", type=int, default=5, help="Rankings per vocabulary (default: 5)")
    analyze.add_argument("--json", action="store_true", help="Emit JSON")

    check = subs.add_parser(
        "check", help="Self-check: import, device, registry. Downloads no weights."
    )
    check.add_argument(
        "--self-check", action="store_true", help="Run the no-weights self-check"
    )
    return parser


def _run_check(_args: argparse.Namespace) -> int:
    """Import + device + registry, without touching model weights."""
    try:
        import torch
        import clip_interrogator  # noqa: F401
        from clip_interrogator import Config, Interrogator  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        print(f"CHECK FAIL: clip_interrogator import failed: {exc}", file=sys.stderr)
        return EXIT_MODEL_ERROR

    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    ci_version = getattr(clip_interrogator, "__version__", "?")
    print(
        f"CHECK OK: clip_interrogator {ci_version} | "
        f"torch {torch.__version__} | device {device}"
    )
    print(
        f"inference device: cpu (pinned in core.py; {device} available "
        "as accelerator)"
    )
    print(f"gradio schema: {config.MODEL_IDS}")
    for model_id in config.MODEL_IDS:
        print(
            f"  {model_id:<6} {config.OPENCLIP_NAMES[model_id]!r:<42} "
            f"{config.MODEL_DISPLAY_NAMES[model_id]}"
        )
    if not _args.self_check:
        print("note: check --self-check is the intended invocation", file=sys.stderr)
    return EXIT_OK


def _run_interrogate(manager: ModelManager, args: argparse.Namespace) -> int:
    image_path = _resolve_default_image(args.image)
    image = _load_image(image_path)
    try:
        # Library banner prints must not pollute the JSON payload.
        with _silence_stdout() if args.json else contextlib.nullcontext():
            prompt = image_to_prompt(manager, image, args.model, args.mode)
    except InputError as exc:
        raise
    if args.json:
        print(
            json.dumps(
                {
                    "image": str(Path(image_path).resolve()),
                    "model": normalize_model_id(args.model),
                    "mode": args.mode,
                    "prompt": prompt,
                },
                indent=2,
            )
        )
    else:
        print(prompt)
    return EXIT_OK


def _run_analyze(manager: ModelManager, args: argparse.Namespace) -> int:
    image_path = _resolve_default_image(args.image)
    image = _load_image(image_path)
    # Library banner prints must not pollute the JSON payload.
    with _silence_stdout() if args.json else contextlib.nullcontext():
        ranks = image_analysis(manager, image, args.model, top=args.top)
    if args.json:
        print(
            json.dumps(
                {
                    "image": str(Path(image_path).resolve()),
                    "model": normalize_model_id(args.model),
                    "ranks": ranks,
                },
                indent=2,
            )
        )
    else:
        for group, ranked in ranks.items():
            print(f"{group}:")
            for label, score in ranked.items():
                print(f"  {score:.3f}  {label}")
    return EXIT_OK


def _resolve_default_image(image_arg: str | None) -> str:
    """Substitute the repo-relative default (resolved lazily, not at
    parser-build time, so a broken install routes through the ModelError
    handler instead of a raw traceback)."""
    return image_arg if image_arg else str(example_image("example01.jpg"))


def main(argv: list[str] | None = None) -> int:
    try:
        args = _build_parser().parse_args(argv)
    except Exception as exc:  # noqa: BLE001 — parser failures are bad input
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    if args.verb == "check":
        try:
            return _run_check(args)
        except Exception as exc:  # noqa: BLE001
            print(f"CHECK FAIL: {exc}", file=sys.stderr)
            return EXIT_MODEL_ERROR

    # CLI loads only the requested model's weights (no shared-BLIP chain).
    manager = ModelManager(shared_blip=False)
    try:
        if args.verb == "interrogate":
            return _run_interrogate(manager, args)
        if args.verb == "analyze":
            return _run_analyze(manager, args)
        raise InputError(f"unknown verb: {args.verb}")
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except ModelError as exc:
        print(f"model error: {exc}", file=sys.stderr)
        return EXIT_MODEL_ERROR
    except Exception as exc:  # noqa: BLE001
        print(f"model error: {exc}", file=sys.stderr)
        return EXIT_MODEL_ERROR


if __name__ == "__main__":
    sys.exit(main())