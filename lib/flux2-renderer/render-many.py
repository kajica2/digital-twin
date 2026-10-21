#!/usr/bin/env python3
# lib/flux2-renderer/render-many.py — batch render for the FLUX.2 local pipeline.
# Loads the model ONCE, then renders every entry in a JSON manifest to PNG,
# rotating the seed. Reuses render.py's exact pipeline wiring (MPS, fp16,
# attention slicing). No per-image model reload.
#
# Usage:
#   lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/render-many.py \
#     --manifest covers.json --out-dir free-output/covers \
#     --width 832 --height 832 [--steps 12] [--seed-base 9000]
#
# Manifest JSON: [{"slug": "neon-pulse-01", "prompt": "..."}, ...]

import argparse
import json
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MODEL = os.path.join(REPO, "assets", "flux2", "FLUX.2-klein-4B")

def pick_device():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"

def main():
    ap = argparse.ArgumentParser(description="FLUX.2 klein-4B batch renderer")
    ap.add_argument("--manifest", required=True, help="JSON array of {slug, prompt}")
    ap.add_argument("--out-dir", required=True, help="output directory")
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=832)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--guidance", type=float, default=3.5)
    ap.add_argument("--seed-base", type=int, default=9000)
    ap.add_argument("--model", default=os.environ.get("FLUX2_MODEL_PATH") or DEFAULT_MODEL)
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        print(f"[flux2-many] model dir not found: {args.model}", file=sys.stderr)
        return 2
    with open(args.manifest, encoding="utf-8") as fh:
        entries = json.load(fh)
    if not isinstance(entries, list) or not entries:
        print("[flux2-many] manifest must be a non-empty array", file=sys.stderr)
        return 2

    import torch
    from diffusers import Flux2KleinPipeline

    device = pick_device()
    print(f"[flux2-many] loading {args.model} on {device} (once) …", file=sys.stderr)
    t0 = time.time()
    if device == "mps":
        torch.mps.empty_cache()
    pipe = Flux2KleinPipeline.from_pretrained(args.model, torch_dtype=torch.float16).to(device)
    pipe.enable_attention_slicing()
    print(f"[flux2-many] model loaded in {time.time()-t0:.1f}s", file=sys.stderr)

    os.makedirs(args.out_dir, exist_ok=True)
    ok = 0
    for idx, e in enumerate(entries):
        slug = e.get("slug") or f"render-{idx+1:02d}"
        prompt = e["prompt"]
        # Per-entry dimensions let one manifest carry mixed aspect ratios
        # (e.g. a 16:9, a 21:9, and a 1:1 tuned-still in the same batch).
        w = int(e.get("width") or args.width)
        h = int(e.get("height") or args.height)
        gen = torch.Generator(device="cpu").manual_seed(args.seed_base + idx)
        img = pipe(
            prompt=prompt,
            height=h,
            width=w,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            num_images_per_prompt=1,
            generator=gen,
        ).images[0]
        out = os.path.join(args.out_dir, f"{idx+1:02d}-{slug}.png")
        img.save(out)
        ok += 1
        print(f"[flux2-many] {idx+1}/{len(entries)} {slug} -> {out}", flush=True)

    print(f"[flux2-many] DONE {ok}/{len(entries)} in {time.time()-t0:.1f}s")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())