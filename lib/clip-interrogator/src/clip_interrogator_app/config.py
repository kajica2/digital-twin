"""Registry of CLIP models and tunables for the CLIP Interrogator port.

Single source of truth for model ids, display names, open-clip names and
the per-model tunables that upstream (pharma/CLIP-Interrogator) hardcodes
inside its app.py. No imports from gradio or clip_interrogator here so
the registry is pure data.
"""

from __future__ import annotations

import os

# Machine-facing ids used by the CLI and the ModelManager.
MODEL_IDS = ("vit-l", "vit-h")

# Human-facing names shown in the gradio dropdown and on the static page.
MODEL_DISPLAY_NAMES = {
    "vit-l": "ViT-L (best for Stable Diffusion 1.*)",
    "vit-h": "ViT-H (best for Stable Diffusion 2.*)",
}

# open-clip model identifiers passed to Config(clip_model_name=...).
OPENCLIP_NAMES = {
    "vit-l": "ViT-L-14/openai",
    "vit-h": "ViT-H-14/laion2b_s32b_b79k",
}

# Default model for the UI dropdown and the CLI when --model is omitted.
MODEL_DEFAULT = "vit-l"

# Interrogation modes (upstream order preserved).
MODES = ("best", "fast", "classic", "negative")

# Tunables applied before each interrogation (upstream app.py values).
BLIP_NUM_BEAMS = 64
CHUNK_SIZE = 2048
FLAVOR_INTERMEDIATE_COUNT = {"vit-l": 2048, "vit-h": 1024}

# Where clip_interrogator's LabelTable caches its text-embedding safetensors.
# Upstream Config() defaults cache_path to the *relative* path "cache", which
# drops ~164M of binaries into the CWD — the repo root when the CLI is run
# from there. Pin it to a user-level cache dir so the working tree stays clean.
CACHE_PATH = os.path.join(os.path.expanduser("~"), ".cache", "clip-interrogator")

# Reverse lookup for the gradio dropdown (display name -> model id).
DISPLAY_TO_ID = {display: model_id for model_id, display in MODEL_DISPLAY_NAMES.items()}


def display_names() -> list[str]:
    """Dropdown choices in canonical order."""
    return [MODEL_DISPLAY_NAMES[model_id] for model_id in MODEL_IDS]