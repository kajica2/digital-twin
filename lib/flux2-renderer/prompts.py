"""Prompt-pack parsing for the FLUX.2 renderer.

Pure stdlib — no torch, no diffusers. Kept separate from render.py so the
parsing rules are unit-testable without loading a 22 GB model.

Reads the repo's prompt-pack convention (see
assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md):

  - one top-level bullet per prompt (`- ` or `* `)
  - YAML frontmatter (--- fenced) is skipped
  - blockquotes (>) and code fences (```) are skipped
  - a trailing `--ar WxH` is stripped from the prompt text and surfaced as
    the aspect ratio, so the prompt body stays clean for the model

Any non-bullet prose outside those regions is ignored: a pack may carry a
title, a header comment, or a style note without becoming a prompt.
"""

from __future__ import annotations

import re

__all__ = ["extract_prompts", "parse_aspect", "format_for_render", "slugify"]

_AR_RE = re.compile(r"\s*--ar\s+(\d{1,4}):(\d{1,4})\s*$", re.IGNORECASE)
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.*\S)\s*$")


def parse_aspect(ar):
    """`'16:9'` -> (16, 9). Returns None for anything not a sane ratio."""
    if not ar:
        return None
    if isinstance(ar, (tuple, list)) and len(ar) == 2:
        w, h = ar
    else:
        m = re.match(r"^\s*(\d{1,4})\s*:\s*(\d{1,4})\s*$", str(ar))
        if not m:
            return None
        w, h = int(m.group(1)), int(m.group(2))
    try:
        w, h = int(w), int(h)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return (w, h)


def extract_prompts(text):
    """Parse a prompt pack into `[{"text": str, "ar": str | None}, ...]`.

    Bullet order is preserved. Empty bullets are dropped. A bullet whose
    body is only flags yields no prompt.
    """
    if not text:
        return []

    out = []
    in_frontmatter = False
    in_fence = False
    saw_content = False

    for raw_line in str(text).splitlines():
        line = raw_line.rstrip("\n")
        stripped = line.strip()

        # YAML frontmatter: only counts at the very top of the file.
        if stripped == "---" and not saw_content:
            in_frontmatter = not in_frontmatter
            continue
        if in_frontmatter:
            continue

        # Code fences toggle; their contents are never prompts.
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        # Blockquotes and blank lines are commentary.
        if not stripped or stripped.startswith(">"):
            continue

        saw_content = True

        m = _BULLET_RE.match(line)
        if not m:
            continue

        body = m.group(1)
        ar = None
        ar_m = _AR_RE.search(body)
        if ar_m:
            ar = f"{ar_m.group(1)}:{ar_m.group(2)}"
            body = body[: ar_m.start()].strip()

        if body:
            out.append({"text": body, "ar": ar})

    return out


def format_for_render(entry, default_width=832, default_height=468):
    """`{"text", "ar"}` -> `{"prompt", "width", "height"}` for the pipeline.

    The aspect only picks the shape; it is never applied by multiplying a
    ratio into a number the model cannot use.

    Dimensions are snapped to EVEN pixels, not to multiples of 16. That is
    the constraint the evidence supports: the proven-working default is
    832x468, and 468 is neither a multiple of 16 nor of 8 — so rounding to
    /16 would have been an invented rule that also reshapes the default.
    Even pixels is what image encoders actually need.
    """
    entry = entry or {}
    prompt = str(entry.get("text", "")).strip()
    pair = parse_aspect(entry.get("ar"))
    if pair:
        rw, rh = pair
        # Scale the ratio to the default area so a 1:1 pack does not come
        # out at 832x832 (twice the pixels of 832x468) by accident.
        area = float(default_width) * float(default_height)
        scale = (area / (float(rw) * float(rh))) ** 0.5
        w = int(rw * scale) // 2 * 2
        h = int(rh * scale) // 2 * 2
    else:
        w, h = int(default_width), int(default_height)

    # Never let a bad ratio collapse to zero.
    w = max(2, w)
    h = max(2, h)
    return {"prompt": prompt, "width": w, "height": h}


_SLUG_DROP = re.compile(r"[^a-z0-9]+")


def slugify(text, max_len=40):
    """`'A window at night, chipped mug'` -> `'a-window-at-night-chipped-mug'`.

    Used for batch output filenames. ASCII-only, lowercase, hyphen-joined.
    A prompt that slugs to nothing falls back to `'frame'` so a filename is
    never empty. `max_len` truncates on a word boundary where possible.
    """
    s = _SLUG_DROP.sub("-", str(text or "").lower()).strip("-")
    if not s:
        return "frame"
    if len(s) <= max_len:
        return s
    cut = s[:max_len]
    # Prefer ending on a whole word rather than mid-token.
    if "-" in cut[max_len // 2:]:
        cut = cut[: cut.rfind("-", max_len // 2)]
    return cut.rstrip("-") or "frame"
