#!/usr/bin/env python3
# lib/flux2-renderer/render-all-pending.py
# Loads FLUX.2 ONCE, then renders every pending manifest in sequence.
# Reuses the same MPS device throughout — no per-batch model reload.
#
# Usage:
#   lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/render-all-pending.py
#
# Known ARs baked into manifests per-entry (render-many reads e.width/e.height).
# Manifests with uniform AR get --width/--height; mixed-AR manifests carry
# per-entry dims and pass no override.

import argparse, json, os, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MODEL = os.path.join(REPO, "assets", "flux2", "FLUX.2-klein-4B")

# (manifest_slug, out_dir, width_override, height_override)
# width/height omitted = uniform 832x832 from render-many.py defaults
MANIFESTS = [
    # cinematic was already verified running; these follow
    ("morning-haunt",         "assets/flux2/morning-haunt",          None, None),
    ("brutalist-architecture","assets/flux2/brutalist-architecture", None, None),
    ("dream-sequence",         "assets/flux2/dream-sequence",          None, None),
    ("system-error",           "assets/flux2/system-error",           None, None),
    ("snc",                   "assets/flux2/swr-assets-neon-church-cinematic", None, None),
    ("mha",                   "assets/flux2/swr-assets-morning-haunt",          None, None),
    ("mhc",                   "assets/flux2/swr-assets-morning-haunt-cinematic",None, None),
    ("dsq",                   "assets/flux2/swr-assets-dream-sequence",         None, None),
    ("dsc",                   "assets/flux2/swr-assets-dream-sequence-cinematic",None, None),
    ("brg",                   "assets/flux2/swr-assets-brutalist-grid",        None, None),
    ("brc",                   "assets/flux2/swr-assets-brutalist-grid-cinematic",None,None),
    ("sec",                   "assets/flux2/swr-assets-system-error-cinematic", None, None),
    ("swrc",                  "assets/flux2/swr-pack-covers",                  None, None),
    ("swrc1",                 "assets/flux2/swr-pack-covers-1x1",              None, None),
    ("two-am",                "assets/flux2/two-am-infrastructure",             None, None),
    ("fap",                   "assets/flux2/four-am-platform",                 None, None),
    ("wgg",                   "assets/flux2/whats-gonna-be-groove",             None, None),
    ("swb",                   "assets/flux2/sunset-water-burst",               None, None),
    ("nwp",                   "assets/flux2/new-wave-poetic-7frames",           None, None),
    ("sfd",                   "assets/flux2/source-frames-10days",             None, None),
    ("ppt",                   "assets/flux2/poetic-patterns-tiles",            None, None),
    ("eslw",                  "assets/flux2/example-soft-lamp-at-the-window",   None, None),
    ("trib",                  "assets/flux2/tribalismo",                       None, None),
    ("tep",                   "assets/flux2/tribalismo-ethio-jazz-photos",     None, None),
    ("teg",                   "assets/flux2/tribalismo-ethio-jazz-graphics",   None, None),  # mixed-AR, per-entry dims in manifest
    ("covers-sainted",        "assets/flux2/covers-sainted",                     None, None),
    ("tuned-stills-v1",       "assets/flux2/tuned-stills-v1",                   None, None),
    ("missing-frames",         "assets/flux2/missing-frames",                   None, None),
    # covers-marketplace: done 12/30 — render the remaining 18
    ("covers-marketplace",     "assets/flux2/covers-marketplace",                 None, None),
]

# Check seed clash: same seed + same prompt = same image.
# We use seed-base 11000 and increment per batch (each batch gets a fresh seed range).

def pick_device():
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"

def main():
    ap = argparse.ArgumentParser(description="FLUX.2 — render all pending manifests, one model load")
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--guidance", type=float, default=3.5)
    ap.add_argument("--seed-base", type=int, default=11000)
    ap.add_argument("--model", default=os.environ.get("FLUX2_MODEL_PATH") or DEFAULT_MODEL)
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        print(f"[all-pending] model dir not found: {args.model}", file=sys.stderr)
        return 2

    manifest_dir = os.path.join(REPO, "lib", "flux2-renderer", "manifests")

    import torch
    from diffusers import Flux2KleinPipeline

    device = pick_device()
    print(f"[all-pending] loading {args.model} on {device} (once) …", file=sys.stderr)
    t0 = time.time()
    if device == "mps":
        torch.mps.empty_cache()
    pipe = Flux2KleinPipeline.from_pretrained(args.model, torch_dtype=torch.float16).to(device)
    pipe.enable_attention_slicing()
    print(f"[all-pending] model loaded in {time.time()-t0:.1f}s", file=sys.stderr)

    total_rendered = 0
    total_errors = 0
    seed = args.seed_base

    for slug, out_dir, w_override, h_override in MANIFESTS:
        mf_path = os.path.join(manifest_dir, f"{slug}.json")
        if not os.path.exists(mf_path):
            print(f"[all-pending] SKIP {slug}: manifest not found", file=sys.stderr)
            continue

        entries = json.load(open(mf_path))
        if not entries:
            print(f"[all-pending] SKIP {slug}: empty manifest", file=sys.stderr)
            continue

        # Check how many are already done
        existing = 0
        if os.path.isdir(out_dir):
            existing = len([f for f in os.listdir(out_dir) if f.endswith('.png')])
        remaining = len(entries) - existing
        if remaining <= 0:
            print(f"[all-pending] DONE {slug}: {existing}/{len(entries)} PNGs already exist — skipping", file=sys.stderr)
            continue

        print(f"[all-pending] {slug}: {remaining}/{len(entries)} to render …", file=sys.stderr)

        # Build render-many.py args inline — reuse its rendering logic
        os.makedirs(out_dir, exist_ok=True)
        ok = 0
        for idx, e in enumerate(entries):
            manifest_slug = e.get("slug") or f"render-{idx+1:02d}"
            # Skip already-rendered files
            out_file = os.path.join(out_dir, f"{idx+1:02d}-{manifest_slug}.png")
            if os.path.exists(out_file):
                continue

            prompt = e["prompt"]
            # Per-entry dimensions (for mixed-AR manifests like teg)
            w = int(e.get("width") or w_override or 832)
            h = int(e.get("height") or h_override or 832)
            gen = torch.Generator(device="cpu").manual_seed(seed + idx)
            img = pipe(
                prompt=prompt,
                height=h,
                width=w,
                num_inference_steps=args.steps,
                guidance_scale=args.guidance,
                num_images_per_prompt=1,
                generator=gen,
            ).images[0]
            img.save(out_file)
            ok += 1
            print(f"[all-pending]   {idx+1}/{len(entries)} {manifest_slug} -> {os.path.basename(out_dir)}/", flush=True)

        if ok:
            total_rendered += ok
            print(f"[all-pending]   {ok} rendered in {time.time()-t0:.1f}s total", file=sys.stderr)
        else:
            print(f"[all-pending]   nothing to do (all existed)", file=sys.stderr)

        # Advance seed so next batch uses a different range
        seed += 1000

    elapsed = time.time() - t0
    print(f"[all-pending] DONE — {total_rendered} images rendered, {total_errors} errors, {elapsed:.0f}s total", file=sys.stderr)
    return 0 if not total_errors else 1

if __name__ == "__main__":
    sys.exit(main())
