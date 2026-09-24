"""Business logic for the CLIP Interrogator port.

Deliberately free of gradio imports — this module is shared by the CLI
and the UI. It owns:

- ``repo_root()`` — resolves repo-relative paths without hardcoding any
  absolute filesystem location (hygiene: this repo never stores absolute
  paths; ``assets/`` paths are resolved by walking up to ``pages/``).
- ``ModelManager`` — the lazy model holder. ViT-L is the default and is
  loaded on first use; ViT-H is constructed only when selected. The BLIP
  captioner is shared between both interrogators (injected via the
  ``Config.caption_model`` / ``Config.caption_processor`` attrs that
  clip_interrogator 0.6.0 actually reads) unless ``shared_blip=False``,
  in which case each interrogator loads its own BLIP so the CLI never
  pulls a model the user didn't ask for. Construction is guarded by a
  lock so concurrent gradio events can't double-load the 1-2GB models.
- ``image_to_prompt`` / ``image_analysis`` — the two operations exposed
  by both the CLI and the UI.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .config import (
    BLIP_NUM_BEAMS,
    CACHE_PATH,
    CHUNK_SIZE,
    FLAVOR_INTERMEDIATE_COUNT,
    MODEL_IDS,
    MODES,
    OPENCLIP_NAMES,
)


class InputError(ValueError):
    """Bad user input (missing file, unknown model/mode, unreadable image)."""


class ModelError(RuntimeError):
    """A model failed to load or failed during inference."""


def repo_root() -> Path:
    """Walk up from this package until the repo root (the dir with pages/).

    Raises RuntimeError if the repo layout is not found above this file —
    callers should treat that as a broken install rather than guess.
    """
    current = Path(__file__).resolve().parent
    for candidate in (current, *current.parents):
        if (candidate / "pages").is_dir():
            return candidate
    raise ModelError(f"could not locate repo root (no pages/ above {current})")


def example_image(name: str = "example01.jpg") -> Path:
    """Repo-relative path to one of the shipped example images."""
    return repo_root() / "assets" / "clip-interrogator" / name


def normalize_model_id(model_id: str) -> str:
    """Accept a model id (``vit-l``) or display name; raise InputError otherwise."""
    if model_id in MODEL_IDS:
        return model_id
    from .config import DISPLAY_TO_ID  # local import to keep import graph flat

    if model_id in DISPLAY_TO_ID:
        return DISPLAY_TO_ID[model_id]
    raise InputError(
        f"unknown model {model_id!r} — expected one of {', '.join(MODEL_IDS)}"
    )


class ModelManager:
    """Lazy holder for the CLIP interrogators with CPU ping-pong activation.

    Upstream (pharma/CLIP-Interrogator) constructs both interrogators at
    module scope and shuffles them to/from CPU by hand. Here nothing is
    constructed at import time; the first request loads ViT-L and ViT-H
    only materialises when selected. A lock guards the construct-if-missing
    critical section so two concurrent gradio events can't both pay the
    1-2GB load.
    """

    def __init__(self, shared_blip: bool = True) -> None:
        self.shared_blip = shared_blip
        self._interrogators: dict[str, object] = {}
        # RLock (not Lock): the shared-BLIP branch calls self.interrogator()
        # for ViT-L inside the critical section, which would deadlock a
        # non-reentrant lock.
        self._lock = threading.RLock()

    def interrogator(self, model_id: str):
        """Return the Interrogator for a model id, constructing it if needed."""
        model_id = normalize_model_id(model_id)
        if model_id in self._interrogators:
            return self._interrogators[model_id]
        with self._lock:
            # Re-check under the lock: another event may have constructed it
            # while we waited.
            if model_id in self._interrogators:
                return self._interrogators[model_id]
            from clip_interrogator import Config, Interrogator

            # Device pin: clip_interrogator 0.6.0's Config.device auto-detects
            # MPS, but its LabelTable only casts the cached fp16 text embeddings
            # to fp32 on *cpu* — on MPS every rank/similarity op crashes with
            # "expected mat1 and mat2 to have the same dtype ... float != Half".
            # Pinning device="cpu" keeps the whole pipeline fp32 and deterministic.
            # cache_path is pinned to ~/.cache/clip-interrogator (upstream default
            # is the relative "cache" — would litter the repo root with safetensors).
            cfg = Config(
                clip_model_name=OPENCLIP_NAMES[model_id],
                device="cpu",
                cache_path=CACHE_PATH,
            )
            if self.shared_blip and model_id == "vit-h":
                # Reuse the BLIP captioner already loaded for ViT-L. The attrs
                # clip_interrogator 0.6.0 actually reads are
                # Config.caption_model / Config.caption_processor (shown in
                # load_caption_model: "self.caption_model = self.config.caption_model").
                # cfg.blip_model does NOT exist in the 0.6.0 wheel.
                vitl = self.interrogator("vit-l")
                cfg.caption_model = vitl.caption_model
                cfg.caption_processor = vitl.caption_processor
            try:
                ci = Interrogator(cfg)
            except Exception as exc:  # noqa: BLE001 — surface any load failure
                raise ModelError(f"failed to load {model_id}: {exc}") from exc
            # Park the freshly loaded CLIP on CPU until activated (upstream does
            # the same so the other model's VRAM isn't held at startup).
            ci.clip_model = ci.clip_model.to("cpu")
            self._interrogators[model_id] = ci
        return self._interrogators[model_id]

    def activate(self, model_id: str) -> None:
        """Move the selected CLIP model to its device, the rest to CPU."""
        model_id = normalize_model_id(model_id)
        for other_id, ci in self._interrogators.items():
            target = ci.device if other_id == model_id else "cpu"
            ci.clip_model = ci.clip_model.to(target)


def image_to_prompt(manager: ModelManager, image, model_id: str, mode: str) -> str:
    """Turn an image into a prompt. ``image`` is a PIL image (caller converts).

    ``mode`` is one of ``best | fast | classic | negative``.
    """
    model_id = normalize_model_id(model_id)
    if mode not in MODES:
        raise InputError(f"unknown mode {mode!r} — expected one of {', '.join(MODES)}")
    ci = manager.interrogator(model_id)
    manager.activate(model_id)
    try:
        # Tunables come from upstream app.py; they vary per selected model.
        ci.config.blip_num_beams = BLIP_NUM_BEAMS
        ci.config.chunk_size = CHUNK_SIZE
        ci.config.flavor_intermediate_count = FLAVOR_INTERMEDIATE_COUNT[model_id]

        image = image.convert("RGB")
        if mode == "best":
            return ci.interrogate(image)
        if mode == "classic":
            return ci.interrogate_classic(image)
        if mode == "fast":
            return ci.interrogate_fast(image)
        return ci.interrogate_negative(image)  # mode == "negative"
    except ModelError:
        raise
    except Exception as exc:  # noqa: BLE001 — inference failures are model errors
        raise ModelError(f"interrogation failed ({model_id}, {mode}): {exc}") from exc


def image_analysis(manager: ModelManager, image, model_id: str, top: int = 5) -> dict:
    """Rank an image against the five CLIP vocabularies.

    Returns {medium: {label: sim}, artist: {...}, movement: {...},
    trending: {...}, flavor: {...}} where sims are python floats in 0..1.
    """
    model_id = normalize_model_id(model_id)
    if top < 1:
        raise InputError("--top must be >= 1")
    ci = manager.interrogator(model_id)
    manager.activate(model_id)
    try:
        image = image.convert("RGB")
        features = ci.image_to_features(image)

        def ranked(collection) -> dict:
            labels = collection.rank(features, top)
            scores = ci.similarities(features, labels)
            return {label: float(score) for label, score in zip(labels, scores)}

        return {
            "medium": ranked(ci.mediums),
            "artist": ranked(ci.artists),
            "movement": ranked(ci.movements),
            "trending": ranked(ci.trendings),
            "flavor": ranked(ci.flavors),
        }
    except ModelError:
        raise
    except Exception as exc:  # noqa: BLE001 — inference failures are model errors
        raise ModelError(f"analysis failed ({model_id}): {exc}") from exc


__all__ = [
    "InputError",
    "ModelError",
    "ModelManager",
    "example_image",
    "image_analysis",
    "image_to_prompt",
    "normalize_model_id",
    "repo_root",
]