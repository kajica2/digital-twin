#!/usr/bin/env python3
"""Sample catalog helpers for the CLIP tool page. Pure stdlib — no torch,
no gradio, so this module is testable in any python3.

The page (`pages/clip-interrogator.html`) fetches `data/clip/samples.json`
and renders every entry; when the file is absent (gitignored, so absent on
deploy) it falls back to a baked-in recorded sample. `merge_samples` is the
write side: re-running the indexer is idempotent per image.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = {
    "generatedAt": "ISO-8601 UTC timestamp of the last merge",
    "samples": [
        {
            "image": "repo-relative path the page can fetch (e.g. assets/clip-interrogator/example01.jpg)",
            "label": "short display name (image stem)",
            "model": "vit-l | vit-h",
            "mode": "best | fast | classic | negative",
            "prompt": "the interrogated prompt",
        }
    ],
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def entry_for(image: str, model: str, mode: str, prompt: str,
              label: str | None = None) -> dict:
    """One catalog entry. `image` must be a repo-relative path the page
    can fetch — never an absolute filesystem path (hygiene rule)."""
    return {
        "image": image,
        "label": label or Path(image).stem,
        "model": model,
        "mode": mode,
        "prompt": prompt,
    }


def merge_samples(path: Path, entry: dict) -> dict:
    """Merge one interrogation result into a sample catalog.

    Keys on `image`: re-running replaces the existing entry, so the
    indexer is idempotent. Creates the file + parents when missing.
    Corrupt JSON is backed up as `<file>.corrupt` and replaced rather
    than raised — a broken catalog must not kill an interrogation run.
    Writes atomically (temp + rename) so a served file is never seen
    half-written.
    """
    catalog: dict = {"generatedAt": "", "samples": []}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("samples"), list):
                catalog = raw
        except (json.JSONDecodeError, OSError):
            backup = path.with_name(path.name + ".corrupt")
            try:
                path.replace(backup)                     # never destroy the evidence
            except OSError:
                pass
            catalog = {"generatedAt": "", "samples": []}

    image = entry.get("image", "")
    catalog["samples"] = [
        s for s in catalog["samples"] if s.get("image") != image
    ]
    catalog["samples"].append(entry)
    catalog["generatedAt"] = now_iso()
    _atomic_write(path, json.dumps(catalog, indent=2, ensure_ascii=False))
    return catalog


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".samples-tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise