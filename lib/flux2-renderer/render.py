#!/usr/bin/env python3
# lib/flux2-renderer/render.py — local FLUX.2 renderer for the digital twin.
#
# Renders a prompt to PNG with FLUX.2 klein-4B (bf16) on Apple MPS.
# No CUDA assumptions: torch is installed with the CPU/MPS wheels; the
# script auto-selects mps / cpu and never requires an NVIDIA GPU.
#
# Model: black-forest-labs/FLUX.2-klein-4B (3.9GB safetensors, bf16) —
#   the -fp8 variants are NOT MPS-compatible (no fp8 dtype on Metal).
#   Pipeline class: diffusers.Flux2KleinPipeline (NOT the FLUX.1
#   FluxPipeline). Text encoder is a Qwen3ForCausalLM + Qwen2 tokenizer;
#   there is NO tokenizer_2 / second encoder in this repo.
#
# Usage:
#   lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/render.py \
#     --prompt "…" [--out assets/flux2/out.png] [--width 832] [--height 468] \
#     [--guidance 3.5] [--steps 20] [--seed 0] [--cfg 1.0] [--json]
#
# Exit 0 on success, 2 on usage error, 1 on runtime error.

import argparse
import json
import os
import sys
import time

# <repo>/lib/flux2-renderer → <repo>/assets/flux2/FLUX.2-klein-4B
# __file__ = <repo>/lib/flux2-renderer/render.py, so repo = dirname(dirname(dirname(__file__)))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MODEL = os.path.join(REPO, "assets", "flux2", "FLUX.2-klein-4B")


def resolve_model():
    return os.environ.get("FLUX2_MODEL_PATH") or DEFAULT_MODEL


def pick_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    ap = argparse.ArgumentParser(description="FLUX.2 klein-4B local renderer (MPS/CPU)")
    ap.add_argument("--prompt", required=True, help="text prompt")
    ap.add_argument("--out", default="assets/flux2/out.png", help="output PNG path")
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=468)
    ap.add_argument("--guidance", type=float, default=3.5)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--model", default=resolve_model(), help="diffusers model dir")
    ap.add_argument("--json", action="store_true", help="emit a JSON result line")
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        print(f"[flux2] model dir not found: {args.model}", file=sys.stderr)
        return 2

    device = pick_device()
    print(f"[flux2] loading {args.model} on {device} …", file=sys.stderr)
    t0 = time.time()

    import torch
    from diffusers import Flux2KleinPipeline

    if device == "mps":
        torch.mps.empty_cache()

    # fp16 is the safe inference dtype on Metal (bf16 is under-tested on MPS);
    # 4B fp16 fits comfortably in 24GB unified memory.
    pipe = Flux2KleinPipeline.from_pretrained(
        args.model,
        torch_dtype=torch.float16,
    ).to(device)

    # Attention slicing keeps MPS well under the 24GB ceiling.
    pipe.enable_attention_slicing()

    load_s = time.time() - t0
    print(f"[flux2] model loaded in {load_s:.1f}s", file=sys.stderr)

    gen = torch.Generator(device="cpu").manual_seed(args.seed)
    img = pipe(
        prompt=args.prompt,
        height=args.height,
        width=args.width,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        num_images_per_prompt=1,
        generator=gen,
    ).images[0]

    out_abs = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_abs) or ".", exist_ok=True)
    img.save(out_abs)
    render_s = time.time() - t0

    if args.json:
        print(json.dumps({
            "ok": True,
            "model": "FLUX.2-klein-4B",
            "device": device,
            "out": out_abs,
            "width": args.width,
            "height": args.height,
            "guidance": args.guidance,
            "steps": args.steps,
            "seed": args.seed,
            "loadSeconds": round(load_s, 1),
            "totalSeconds": round(render_s, 1),
        }))
    else:
        print(f"[flux2] wrote {out_abs} in {render_s:.1f}s (model load {load_s:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())