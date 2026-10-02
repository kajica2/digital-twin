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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompts import extract_prompts, format_for_render, slugify  # noqa: E402

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
    ap.add_argument("--prompt", default=None, help="text prompt (single render)")
    ap.add_argument("--prompt-file", default=None,
                    help="prompt pack — one top-level bullet per prompt (batch mode)")
    ap.add_argument("--out", default="assets/flux2/out.png", help="output PNG path (single render)")
    ap.add_argument("--outdir", default="assets/flux2/out",
                    help="output directory (batch mode)")
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=468)
    ap.add_argument("--guidance", type=float, default=3.5)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0,
                    help="base seed; batch renders use seed+index")
    ap.add_argument("--model", default=resolve_model(), help="diffusers model dir")
    ap.add_argument("--json", action="store_true", help="emit a JSON result line")
    args = ap.parse_args()

    if bool(args.prompt) == bool(args.prompt_file):
        print("[flux2] pass exactly one of --prompt or --prompt-file", file=sys.stderr)
        return 2

    # Build the job list before touching the model: a bad prompt file should
    # fail in milliseconds, not after a 22 GB load. (See the repo rule about
    # validating before invoking an expensive renderer.)
    if args.prompt_file:
        path = os.path.expanduser(args.prompt_file)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as exc:
            print(f"[flux2] cannot read prompt file: {exc}", file=sys.stderr)
            return 2
        entries = extract_prompts(raw)
        if not entries:
            print(f"[flux2] no prompts in {path} — need top-level bullets "
                  f"(see assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md)", file=sys.stderr)
            return 2
    else:
        entries = [{"text": args.prompt, "ar": None}]

    jobs = []
    for i, entry in enumerate(entries):
        shaped = format_for_render(entry, args.width, args.height)
        name = f"{i:02d}-{slugify(shaped['prompt'])}.png"
        jobs.append({
            "prompt": shaped["prompt"],
            "width": shaped["width"],
            "height": shaped["height"],
            "seed": args.seed + i,
            "out": os.path.join(args.outdir, name) if args.prompt_file else args.out,
            "ar": entry.get("ar"),
        })

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

    results = []
    render_t0 = time.time()
    for n, job in enumerate(jobs, 1):
        gen = torch.Generator(device="cpu").manual_seed(job["seed"])
        img = pipe(
            prompt=job["prompt"],
            height=job["height"],
            width=job["width"],
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            num_images_per_prompt=1,
            generator=gen,
        ).images[0]

        out_abs = os.path.abspath(job["out"])
        os.makedirs(os.path.dirname(out_abs) or ".", exist_ok=True)
        img.save(out_abs)

        rec = {
            "ok": True,
            "out": out_abs,
            "prompt": job["prompt"],
            "ar": job["ar"],
            "width": job["width"],
            "height": job["height"],
            "seed": job["seed"],
        }
        results.append(rec)
        if len(jobs) > 1:
            print(f"[flux2] [{n}/{len(jobs)}] {os.path.basename(out_abs)} "
                  f"{job['width']}x{job['height']} seed={job['seed']}", file=sys.stderr)

    render_s = time.time() - render_t0
    total_s = time.time() - t0

    # Batch runs leave machine-checkable evidence, matching the MJ pipeline's
    # meta.json convention: one manifest maps every file back to its prompt.
    manifest = None
    if args.prompt_file:
        manifest = os.path.abspath(os.path.join(args.outdir, "manifest.json"))
        try:
            with open(manifest, "w", encoding="utf-8") as fh:
                json.dump({
                    "model": "FLUX.2-klein-4B",
                    "device": device,
                    "promptFile": os.path.abspath(os.path.expanduser(args.prompt_file)),
                    "steps": args.steps,
                    "guidance": args.guidance,
                    "baseSeed": args.seed,
                    "count": len(results),
                    "images": results,
                }, fh, indent=2)
        except OSError as exc:
            print(f"[flux2] could not write manifest: {exc}", file=sys.stderr)
            manifest = None

    if args.json:
        payload = {
            "ok": True,
            "model": "FLUX.2-klein-4B",
            "device": device,
            "steps": args.steps,
            "guidance": args.guidance,
            "loadSeconds": round(load_s, 1),
            "renderSeconds": round(render_s, 1),
            "totalSeconds": round(total_s, 1),
            "count": len(results),
            "images": results,
        }
        if manifest:
            payload["manifest"] = manifest
        if len(results) == 1:
            # Single render keeps the original flat shape for existing callers.
            payload.update(results[0])
            payload["out"] = results[0]["out"]
        print(json.dumps(payload))
    else:
        if len(results) == 1:
            print(f"[flux2] wrote {results[0]['out']} in {total_s:.1f}s "
                  f"(model load {load_s:.1f}s)")
        else:
            print(f"[flux2] wrote {len(results)} images to "
                  f"{os.path.abspath(args.outdir)} in {total_s:.1f}s "
                  f"(model load {load_s:.1f}s, render {render_s:.1f}s)")
            if manifest:
                print(f"[flux2] manifest -> {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())