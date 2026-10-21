#!/usr/bin/env python3
# lib/flux-loop-pipeline/pipeline.py — Orchestrates FLUX still → I2V → loopable segmenter.
#
# Full pipeline:
#   1. Generate still with FLUX.2
#   2. Animate with I2V
#   3. Post-process with loopable-video-segmenter
#
# Usage:
#   lib/flux-loop-pipeline/.venv/bin/python lib/flux-loop-pipeline/pipeline.py \
#     --prompt "ambient abstract loop, soft light" \
#     --out data/flux/loops-final/loop-001.mp4
#
# Or from a prompt file:
#   lib/flux-loop-pipeline/.venv/bin/python lib/flux-loop-pipeline/pipeline.py \
#     --prompt-file prompts-inbox/processed/thumbnail-prompts.md \
#     --outdir data/flux/loops-final/

import argparse
import os
import sys
import json
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

REPO = Path(__file__).resolve().parent.parent.parent
STILLS_DIR = REPO / "data" / "flux" / "stills"
LOOPS_RAW_DIR = REPO / "data" / "flux" / "loops-raw"
LOOPS_FINAL_DIR = REPO / "data" / "flux" / "loops-final"

# FLUX2 renderer path
FLUX2_RENDER = REPO / "lib" / "flux2-renderer" / "render.py"
FLUX2_VENV = REPO / "lib" / "flux2-renderer" / ".venv" / "bin" / "python"

# I2V script
I2V_SCRIPT = REPO / "lib" / "flux-i2v" / "animate.py"
I2V_VENV = REPO / "lib" / "flux-i2v" / ".venv" / "bin" / "python"

# Loopable video segmenter
LVS_CMD = ["npm", "run", "lvs:segment", "--"]


def slugify(text: str, max_len: int = 40) -> str:
    """Create a filename-safe slug."""
    import re
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', '-', text)
    text = text.strip('-')
    return text[:max_len]


def timestamp() -> str:
    """Generate timestamp prefix."""
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def run_cmd(cmd: List[str], cwd: Optional[Path] = None, capture: bool = True) -> subprocess.CompletedProcess:
    """Run a command and return result."""
    print(f"[pipeline] Running: {' '.join(str(c) for c in cmd)}")
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=capture,
        text=True,
    )


def phase1_flux_still(prompt: str, width: int = 1280, height: int = 720,
                      seed: int = 0) -> Path:
    """Phase 1: Generate FLUX still."""
    print(f"\n=== Phase 1: FLUX Still ===")
    print(f"Prompt: {prompt}")

    # Ensure output directory exists
    STILLS_DIR.mkdir(parents=True, exist_ok=True)

    # Generate filename
    slug = slugify(prompt)
    ts = timestamp()
    output_name = f"{ts}-{slug}.png"
    output_path = STILLS_DIR / output_name

    # Run FLUX2 renderer
    cmd = [
        str(FLUX2_VENV),
        str(FLUX2_RENDER),
        "--prompt", prompt,
        "--out", str(output_path),
        "--width", str(width),
        "--height", str(height),
        "--seed", str(seed),
    ]

    result = run_cmd(cmd)
    if result.returncode != 0:
        print(f"[pipeline] FLUX error: {result.stderr}", file=sys.stderr)
        raise RuntimeError(f"FLUX still generation failed: {result.stderr}")

    print(f"[pipeline] Still saved: {output_path}")
    return output_path


def phase2_i2v_animate(input_path: Path, duration: float = 4,
                       loop: bool = True, prompt: Optional[str] = None,
                       backend: str = "dgenerate") -> Path:
    """Phase 2: Animate still to video."""
    print(f"\n=== Phase 2: I2V Animation ===")
    print(f"Input: {input_path}")
    print(f"Duration: {duration}s")
    print(f"Loop: {loop}")
    print(f"Backend: {backend}")

    # Ensure output directory exists
    LOOPS_RAW_DIR.mkdir(parents=True, exist_ok=True)

    # Generate output filename
    slug = input_path.stem
    ts = timestamp()
    output_name = f"{ts}-{slug}.mp4"
    output_path = LOOPS_RAW_DIR / output_name

    # Build I2V command (placeholder for now)
    # TODO: Replace with actual I2V call when backend is ready
    print(f"[pipeline] I2V animation not yet implemented")
    print(f"[pipeline] Would animate: {input_path} -> {output_path}")

    # For now, create a placeholder - copy the still as a "video"
    # This allows testing the pipeline flow
    import shutil
    print(f"[pipeline] Creating placeholder video (copy still)")
    # Note: This won't be a real video - just for pipeline testing
    # When I2V is ready, this will be replaced with actual animation

    # Create a dummy file to continue pipeline
    output_path.write_text("PLACEHOLDER")
    print(f"[pipeline] Placeholder created: {output_path}")

    return output_path


def phase3_loopable_segment(input_path: Path, segments: int = 4,
                            loopable: bool = True) -> List[Path]:
    """Phase 3: Post-process with loopable-video-segmenter."""
    print(f"\n=== Phase 3: Loopable Segmenter ===")
    print(f"Input: {input_path}")
    print(f"Segments: {segments}")
    print(f"Loopable: {loopable}")

    # Ensure output directory exists
    LOOPS_FINAL_DIR.mkdir(parents=True, exist_ok=True)

    # Run loopable-video-segmenter
    cmd = LVS_CMD + [
        str(input_path),
        "--segments", str(segments),
    ]
    if not loopable:
        cmd.append("--no-loopable")

    # Add output to our final directory
    output_base = LOOPS_FINAL_DIR / input_path.stem

    result = run_cmd(cmd)

    # The segmenter outputs to a temp dir - we need to find the output
    # For now, let's check what the segmenter actually does
    # TODO: Parse the segmenter output and move files to final dir

    print(f"[pipeline] Segmenter output: {result.stdout}")

    # Return the input as "final" for now (placeholder)
    # When segmenter is working, this will return the actual segmented clips
    return [input_path]


def run_pipeline(prompt: str, width: int = 1280, height: int = 720,
                duration: float = 4, segments: int = 4,
                seed: int = 0, backend: str = "dgenerate",
                output: Optional[Path] = None, outdir: Optional[Path] = None,
                json_output: bool = False) -> Dict[str, Any]:
    """Run the full FLUX → I2V → Loopable pipeline."""

    results = {
        "prompt": prompt,
        "still": None,
        "video_raw": None,
        "loops_final": [],
        "status": "starting",
    }

    try:
        # Phase 1: FLUX still
        still_path = phase1_flux_still(prompt, width, height, seed)
        results["still"] = str(still_path)

        # Phase 2: I2V animation
        video_path = phase2_i2v_animate(
            still_path,
            duration=duration,
            loop=True,
            backend=backend,
        )
        results["video_raw"] = str(video_path)

        # Phase 3: Loopable segmenter
        final_paths = phase3_loopable_segment(video_path, segments=segments)
        results["loops_final"] = [str(p) for p in final_paths]

        results["status"] = "success"

    except Exception as e:
        results["status"] = "failed"
        results["error"] = str(e)
        print(f"[pipeline] Error: {e}", file=sys.stderr)

    if json_output:
        print(json.dumps(results, indent=2))

    return results


def main():
    parser = argparse.ArgumentParser(description="FLUX Loop Pipeline")
    parser.add_argument("--prompt", help="Single prompt to render")
    parser.add_argument("--prompt-file", help="File with prompts (one per line)")
    parser.add_argument("--out", help="Output file (single prompt mode)")
    parser.add_argument("--outdir", help="Output directory (batch mode)")
    parser.add_argument("--width", type=int, default=1280, help="Still width")
    parser.add_argument("--height", type=int, default=720, help="Still height")
    parser.add_argument("--duration", type=float, default=4, help="Video duration (seconds)")
    parser.add_argument("--segments", type=int, default=4, help="Loop segments")
    parser.add_argument("--seed", type=int, default=0, help="Random seed")
    parser.add_argument("--backend", default="dgenerate", help="I2V backend")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    # Validate inputs
    if bool(args.prompt) == bool(args.prompt_file):
        print("[pipeline] Pass exactly one of --prompt or --prompt-file", file=sys.stderr)
        return 2

    # Ensure output directory exists
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    if args.outdir:
        Path(args.outdir).mkdir(parents=True, exist_ok=True)

    # Single prompt mode
    if args.prompt:
        result = run_pipeline(
            prompt=args.prompt,
            width=args.width,
            height=args.height,
            duration=args.duration,
            segments=args.segments,
            seed=args.seed,
            backend=args.backend,
            output=Path(args.out) if args.out else None,
            json_output=args.json,
        )
        return 0 if result["status"] == "success" else 1

    # Batch mode from file
    if args.prompt_file:
        prompts = Path(args.prompt_file).read_text().strip().split("\n")
        prompts = [p.strip() for p in prompts if p.strip() and not p.startswith("#")]

        print(f"[pipeline] Processing {len(prompts)} prompts from {args.prompt_file}")

        for i, prompt in enumerate(prompts):
            print(f"\n{'='*50}")
            print(f"[pipeline] Prompt {i+1}/{len(prompts)}: {prompt[:60]}...")
            result = run_pipeline(
                prompt=prompt,
                width=args.width,
                height=args.height,
                duration=args.duration,
                segments=args.segments,
                seed=args.seed + i,
                backend=args.backend,
                json_output=args.json,
            )

        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
