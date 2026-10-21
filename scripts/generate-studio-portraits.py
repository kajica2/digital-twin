#!/usr/bin/env python3
"""Generate 5 cohesive studio portraits with FLUX"""

import subprocess
import sys
from pathlib import Path

# Base prompt - keeps character consistent
BASE_CHARACTER = "a professional male model, 30s, sharp cheekbones, short dark hair, cinematic lighting, studio photography, Hasselblad medium format look"

# 5 different poses/environments but cohesive style
PROMPTS = [
    {
        "name": "studio-portrait-01",
        "pose": "standing confidently, hands in pockets, slight three-quarter turn",
        "environment": "minimal white cyclorama background, studio soft boxes"
    },
    {
        "name": "studio-portrait-02", 
        "pose": "seated on simple wooden stool, relaxed posture, arms relaxed",
        "environment": "dark gray seamless backdrop, overhead strip light"
    },
    {
        "name": "studio-portrait-03",
        "pose": "full length standing, athletic stance, looking toward camera",
        "environment": "concrete floor cyclorama, large soft key light from left"
    },
    {
        "name": "studio-portrait-04",
        "pose": "close-up portrait, shoulders visible, contemplative expression",
        "environment": "gradient backdrop from charcoal to black, Rembrandt lighting"
    },
    {
        "name": "studio-portrait-05",
        "pose": "leaning against wall, casual confident pose, one arm elevated",
        "environment": "textured gray wall backdrop, window light simulation"
    }
]

# Common style elements
STYLE = "professional fashion photography, 8k, film grain, retouched, coherent lighting across series, matching color grading"

def generate(prompt_config):
    """Generate a single image using FLUX"""
    prompt = f"{BASE_CHARACTER}, {prompt_config['pose']}, {prompt_config['environment']}, {STYLE}"
    
    output_name = prompt_config['name']
    output_path = f"data/flux/stills/{output_name}.png"
    
    cmd = [
        "python3", 
        "lib/flux2-renderer/render.py",
        "--prompt", prompt,
        "--out", output_path,
        "--seed", str(hash(output_name) % 10000)
    ]
    
    print(f"\n{'='*50}")
    print(f"Generating: {output_name}")
    print(f"Prompt: {prompt[:100]}...")
    print(f"{'='*50}")
    
    # Use the flux venv
    venv_python = Path("lib/flux2-renderer/.venv/bin/python")
    cmd[0] = str(venv_python)
    
    result = subprocess.run(cmd, cwd=Path.home() / "digital-twin")
    return result.returncode == 0

def main():
    print("Generating 5 cohesive studio portraits...")
    print(f"Character: {BASE_CHARACTER[:60]}...")
    print(f"Style: {STYLE}")
    
    success_count = 0
    for i, prompt_config in enumerate(PROMPTS, 1):
        print(f"\n[{i}/5] Generating {prompt_config['name']}...")
        if generate(prompt_config):
            success_count += 1
            print(f"✓ {prompt_config['name']} done")
        else:
            print(f"✗ {prompt_config['name']} failed")
    
    print(f"\n{'='*50}")
    print(f"Complete: {success_count}/5 images generated")
    print(f"{'='*50}")
    
    if success_count > 0:
        print("\nGenerated files:")
        for p in PROMPTS[:success_count]:
            print(f"  data/flux/stills/{p['name']}.png")

if __name__ == "__main__":
    main()
