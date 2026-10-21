#!/usr/bin/env python3
# lib/flux2-renderer/style-portraits.py — likeness-preserving style transfer
# for a folder of portraits.
#
# FLUX.2-klein's pipeline exposes `image=` directly, which is image-
# conditioned generation (not legacy denoise-strength img2img). The photo
# is a structural reference; the prompt repaints it. Likeness preserved by
# design; style painted by prompt.
#
# Usage:
#   lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/style-portraits.py \
#     --inputs assets/face-refs \
#     --prompt "cinematic, anamorphic widescreen, golden hour, film grain" \
#     --outdir assets/flux2/face-styles
#
# All inputs are processed; manifest.json records per-output provenance.

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

# PIL is required by the module-level fit_and_crop() helper. It's a
# cheap import and supports preflight without loading torch/diffusers.
from PIL import Image

REPO = Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = REPO / "assets" / "flux2" / "FLUX.2-klein-4B"


def resolve_model():
    return os.environ.get("FLUX2_MODEL_PATH") or str(DEFAULT_MODEL)


def pick_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def discover_inputs(inputs_dir: Path):
    if not inputs_dir.is_dir():
        return []
    files = [p for p in sorted(inputs_dir.iterdir())
             if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
             and not p.name.startswith(".")]
    return files


def slugify(text: str, maxlen: int = 32) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return s[:maxlen].rstrip("-") or "untitled"


def fit_snap16(src_w: int, src_h: int, long_side: int):
    """Aspect-preserving resize to a square-ish target, snapped to /16.

    Returns (target_w, target_h) preserving source aspect, with the
    longer side equal to `long_side` and both dimensions divisible by 16.

    FLUX.2-klein requires /16 dims (sprint 0.38.b), so this snaps rather
    than letting diffusers silently resize. Prefer even-pixel rounding
    over truncation: 468 -> 464 (closer to source) rather than 480."""
    if src_w >= src_h:
        target_w = long_side - (long_side % 16)
        target_h = int(round(target_w * src_h / src_w))
        target_h -= target_h % 16
    else:
        target_h = long_side - (long_side % 16)
        target_w = int(round(target_h * src_w / src_h))
        target_w -= target_w % 16
    return target_w, target_h


def fit_and_crop(img, target_w: int, target_h: int):
    """Aspect-preserving resize + center crop to (target_w, target_h).

    Avoids the face-stretching that Image.resize((w,h)) causes when the
    source aspect doesn't match the target."""
    src_aspect = img.width / img.height
    target_aspect = target_w / target_h
    if src_aspect > target_aspect:
        new_h = target_h
        new_w = int(round(new_h * src_aspect))
    else:
        new_w = target_w
        new_h = int(round(new_w / src_aspect))
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def preflight(args, files):
    """Validate everything we can BEFORE loading the 22GB model.

    Returns the resolved outdir or None to signal abort."""
    if not files:
        print("[style-portraits] no inputs found "
              f"(supported: {sorted(SUPPORTED_EXTS)})", file=sys.stderr)
        return None

    if not args.prompt.strip():
        print("[style-portraits] --prompt must be non-empty", file=sys.stderr)
        return None

    if not Path(args.model).exists():
        print(f"[style-portraits] model not found: {args.model}",
              file=sys.stderr)
        return None

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # HEIC support requires pillow-heif; check lazy.
    needs_heif = any(p.suffix.lower() in {".heic", ".heif"} for p in files)
    if needs_heif:
        try:
            import pillow_heif  # noqa: F401
        except ImportError:
            print("[style-portraits] HEIC inputs detected but pillow-heif "
                  "is not installed. Convert to JPG first.", file=sys.stderr)
            return None

    return outdir


def main():
    parser = argparse.ArgumentParser(
        description="FLUX.2 likeness-preserving style transfer over a "
                    "folder of portraits.")
    parser.add_argument("--inputs", required=True,
                        help="Directory of source portraits")
    parser.add_argument("--prompt", required=True,
                        help="Style repaint prompt (the photo is the "
                             "structural reference; the prompt repaints it)")
    parser.add_argument("--outdir", required=True,
                        help="Output directory (manifest.json + one PNG "
                             "per input)")
    parser.add_argument("--width", type=int, default=1024,
                        help="Default target width for landscape sources")
    parser.add_argument("--height", type=int, default=1024,
                        help="Default target height; overwritten per-input "
                             "to preserve aspect ratio")
    parser.add_argument("--long-side", type=int, default=1024,
                        help="Per-input longer side in pixels (snapped to "
                             "/16). Use this for portrait/landscape variety.")
    parser.add_argument("--steps", type=int, default=15,
                        help="FLUX.2-klein is step-wise distilled; values "
                             "12-25 all work. Default 15 balances speed "
                             "and detail.")
    parser.add_argument("--seed", type=int, default=0,
                        help="Base seed; per-input seed = base + index")
    parser.add_argument("--model", default=resolve_model())
    parser.add_argument("--json", action="store_true",
                        help="Emit final JSON summary to stdout")
    args = parser.parse_args()

    inputs_dir = Path(args.inputs)
    outdir = preflight(args, discover_inputs(inputs_dir))
    if outdir is None:
        return 2

    files = discover_inputs(inputs_dir)
    device = pick_device()
    print(f"[style-portraits] {len(files)} input(s), device={device}",
          file=sys.stderr)
    print(f"[style-portraits] prompt: {args.prompt}", file=sys.stderr)
    print(f"[style-portraits] outdir: {outdir}", file=sys.stderr)
    print(f"[style-portraits] loading FLUX.2 ({device})...", file=sys.stderr)

    import torch
    from diffusers import Flux2KleinPipeline

    t0 = time.time()
    if device == "mps":
        torch.mps.empty_cache()
    pipe = Flux2KleinPipeline.from_pretrained(
        args.model,
        torch_dtype=torch.float16,
    ).to(device)
    pipe.enable_attention_slicing()
    print(f"[style-portraits] model loaded in {time.time()-t0:.1f}s",
          file=sys.stderr)

    prompt_slug = slugify(args.prompt)
    manifest = {
        "prompt": args.prompt,
        "model": Path(args.model).name,
        "device": device,
        "width": args.width,
        "height": args.height,
        "steps": args.steps,
        "baseSeed": args.seed,
        "count": 0,
        "items": [],
    }

    # Per-input render
    for i, src in enumerate(files, start=1):
        seed = args.seed + i
        init_src = Image.open(src).convert("RGB")
        # Per-input target preserves source aspect ratio; snaps to /16.
        target_w, target_h = fit_snap16(init_src.width, init_src.height,
                                        args.long_side)
        init = fit_and_crop(init_src, target_w, target_h)
        out_path = outdir / f"{i:02d}-{src.stem}-{prompt_slug}.png"

        print(f"[style-portraits] [{i}/{len(files)}] {src.name} "
              f"-> {out_path.name} (seed {seed})", file=sys.stderr)

        gen = torch.Generator(device="cpu").manual_seed(seed)
        t1 = time.time()
        result = pipe(
            prompt=args.prompt,
            image=init,
            height=args.height,
            width=args.width,
            num_inference_steps=args.steps,
            guidance_scale=3.5,
            num_images_per_prompt=1,
            generator=gen,
        )
        img = result.images[0]
        img.save(out_path)
        # Release MPS-allocated intermediates before the next image.
        # Without this, diffusers/MPS accumulate buffers across calls
        # and the Nth image often hangs (sprint 0.42 followup).
        if device == "mps":
            import torch
            torch.mps.empty_cache()
        elapsed = time.time() - t1

        manifest["items"].append({
            "index": i,
            "input": src.name,
            "output": out_path.name,
            "seed": seed,
            "srcW": init_src.size[0],
            "srcH": init_src.size[1],
            "width": target_w,
            "height": target_h,
            "elapsed_s": round(elapsed, 1),
        })
        manifest["count"] += 1

    manifest_path = outdir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"[style-portraits] wrote {manifest_path}", file=sys.stderr)
    print(f"[style-portraits] done: {manifest['count']}/{len(files)}",
          file=sys.stderr)

    if args.json:
        print(json.dumps({"ok": True, "count": manifest["count"],
                          "outdir": str(outdir),
                          "manifest": str(manifest_path)}))

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
