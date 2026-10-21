"""Lettering-in-layout for covers — real type over generated plates.

Why this exists
---------------
A diffusion model PAINTS letter-shaped marks; it does not compose glyphs.
Ask FLUX for "Chrome Heart" and you get "CHIOME HEART". See TD-007.

So a cover that has to *read* is a two-part artefact:

    1. a CLEAN PLATE  — rendered with the subject only, explicitly no text
    2. a LETTERING PASS — real type set over it, from a real font

This module is part 2. It is deliberately split into:

    plan()   pure: plate size + strings -> a list of draw commands
    compose() impure: executes a plan against an image with PIL

`plan()` carries the exact strings that will be drawn, so the tests can
assert "the right letters reach the renderer" without OCR.

No torch, no diffusers here. PIL only.
"""

from __future__ import annotations

import os
import re

__all__ = ["plan", "compose", "wrap_text", "split_units", "fit_font_size", "resolve_font",
           "family_for_slug", "scrim_gradient", "relpath_for_manifest", "FAMILIES"]

# Fonts are resolved at run time, never bundled: committing a typeface means
# checking its licence, and a system font is always present on the target
# machine. Override with COVER_FONT / COVER_FONT_ALT.
DEFAULT_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/Library/Fonts/Arial Black.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)

# Per-family lettering treatments. `placement` is where the title block sits;
# `align` is the anchor used for the type. Scrim is a translucent band behind
# the type — legibility is a design decision, not something to leave to the
# plate's contrast.
FAMILIES = {
    "neon-pulse": {
        "placement": "bottom",
        "fill": (235, 250, 255),
        "scrim": (6, 4, 22, 150),
        "glow": (0, 220, 255),
        "tracking": 0.04,
    },
    "smoke": {
        "placement": "top",
        "fill": (255, 252, 246),
        "scrim": (14, 10, 8, 140),
        "glow": None,
        "tracking": 0.02,
    },
    "type-loud": {
        "placement": "center",
        "fill": (12, 12, 14),
        "scrim": (246, 244, 238, 120),
        "glow": None,
        "tracking": -0.01,
    },
}

_DEFAULT_FAMILY = "smoke"


def resolve_font(preferred=None):
    """Return the first usable font path.

    Order: explicit argument -> COVER_FONT env -> the candidate list.
    Raises FileNotFoundError when nothing loads, rather than silently
    falling back to PIL's bitmap default, which is unshippable at cover size.
    """
    import os as _os

    tried = []
    candidates = []
    if preferred:
        candidates.append(preferred)
    env = _os.environ.get("COVER_FONT")
    if env:
        candidates.append(_os.path.expanduser(env))
    candidates.extend(DEFAULT_FONT_CANDIDATES)

    for path in candidates:
        path = _os.path.expanduser(path)
        if not path:
            continue
        tried.append(path)
        if _os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "no usable cover font; tried: " + ", ".join(tried)
    )


def split_units(text):
    """Split into wrap units, keeping a separator attached to what follows.

    `str.split()` alone makes `:` a free-standing token, so "TYPE : LOUD"
    can break into `TYPE / : / LOUD` — a colon dangling on its own line is
    a typographic error, not a wrap. Merging each pure-separator token with
    the word after it means the unit `: LOUD` travels together.
    """
    raw = str(text).split()
    units, i = [], 0
    while i < len(raw):
        tok = raw[i]
        if _is_separator(tok) and i + 1 < len(raw):
            units.append(f"{tok} {raw[i + 1]}")
            i += 2
        else:
            units.append(tok)
            i += 1
    return units


_SEPARATORS = set(":;,.\u2014\u2013-\u00b7|/\u2026!?")


def _is_separator(token):
    return bool(token) and all(ch in _SEPARATORS for ch in token)


def wrap_text(text, font, max_width, draw):
    """Greedy-wrap `text` to lines that fit `max_width` at `font`.

    Wraps on `split_units`, so separators never strand. A single unit longer
    than the box is put on its own line rather than dropped — a title never
    vanishes because it is long.
    """
    words = split_units(text)
    if not words:
        return []
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if _width(trial, font, draw) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def fit_font_size(text, font_path, box_w, box_h, draw, max_size, min_size=12,
                  max_lines=4, prefer_single_line=True, single_ratio=0.5):
    """Largest size whose wrapped title fits; short titles stay on one line.

    Returns (size, lines). Never below `min_size`.

    Rather than an arbitrary "wrap below N% of max" rule, the choice is a
    legibility trade-off: find the largest size that fits as multi-line, and
    the largest that fits on one line, then take the single line only when it
    costs no more than `single_ratio` of the multi-line size. That is what
    avoids `TYPE :` / `LOUD` without making a short title tiny.

    The loop MUST be able to terminate when even `min_size` does not fit.
    An earlier version did `size = max(min_size, size - 2)` inside a
    `while size >= min_size` guard, which pins `size` at `min_size` and
    spins forever on an over-long title in a small box. Hence the explicit
    break at the floor.
    """
    floor = int(min_size)
    top = max(floor, int(max_size))

    best_multi = None   # largest size that fits at all
    best_single = None  # largest size that fits on ONE line
    size = top
    while True:
        font = _load(font_path, size)
        lines = wrap_text(text, font, box_w, draw)
        if lines and len(lines) <= max_lines:
            line_h = _line_height(font, draw)
            if line_h * len(lines) <= box_h:
                if best_multi is None:
                    best_multi = (size, list(lines))
                if len(lines) == 1:
                    best_single = (size, list(lines))
                    break  # descending, so this is the largest single line
        if size <= floor:
            break
        size = max(floor, size - 2)

    if best_multi is None:
        font = _load(font_path, floor)
        return floor, wrap_text(text, font, box_w, draw)

    if prefer_single_line and best_single is not None:
        if best_single[0] >= best_multi[0] * single_ratio:
            return best_single
    return best_multi


def scrim_gradient(w, h, box, fill, placement="bottom"):
    """An RGBA band that is opaque at the outer edge and fades inward.

    A hard-edged rectangle reads as a UI panel pasted over the art. A ramp
    reads as light falling off, which is what a cover actually wants.

    - `bottom` : opaque at the bottom edge, fading up
    - `top`    : opaque at the top edge, fading down
    - `center` : opaque through the middle, fading to both edges
    """
    from PIL import Image

    l, t, r, b = box
    band_h = max(1, int(b) - int(t))
    band_w = max(1, int(r) - int(l))
    r_, g_, bl_, a_ = fill
    strip = Image.new("RGBA", (1, band_h), (0, 0, 0, 0))
    px = strip.load()
    span = float(max(1, band_h - 1))
    for y in range(band_h):
        if placement == "bottom":
            alpha = a_ * (y / span)
        elif placement == "top":
            alpha = a_ * (1.0 - y / span)
        else:
            mid = span / 2.0
            alpha = a_ * (1.0 - abs(y - mid) / (mid if mid else 1.0))
        px[0, y] = (int(r_), int(g_), int(bl_), max(0, min(255, int(alpha))))
    return strip.resize((band_w, band_h), Image.NEAREST)


def plan(plate_w, plate_h, title, subtitle=None, family=_DEFAULT_FAMILY,
         font_path=None, max_lines=4):
    """Pure: describe every draw command for a cover.

    Returns a dict with the strings that will be painted and where:

        {
          "family": str,
          "font": str | None,
          "scrim": {"box": (l, t, r, b), "fill": (r, g, b, a)} | None,
          "title":  {"lines": [str], "size": int, "fill": (r,g,b),
                     "anchor_xy": (x, y), "anchor": str, "tracking": float},
          "subtitle": {...} | None,
        }

    Nothing here touches an image, so tests can assert the exact characters
    that reach the renderer.
    """
    fam = FAMILIES.get(family) or FAMILIES[_DEFAULT_FAMILY]

    margin_x = int(plate_w * 0.075)
    if fam["placement"] == "bottom":
        band_h = int(plate_h * 0.34)
        band_top = plate_h - band_h
    elif fam["placement"] == "top":
        band_h = int(plate_h * 0.30)
        band_top = 0
    else:
        band_h = int(plate_h * 0.62)
        band_top = int((plate_h - band_h) / 2)

    box_w = plate_w - (margin_x * 2)
    box_h = band_h - int(plate_h * 0.10)

    # Title sizing needs a font; when none is available the plan still
    # carries the strings so callers can fail loudly at compose time.
    size, lines = 0, [str(title)]
    fp = None
    if font_path or _any_font_available():
        try:
            fp = resolve_font(font_path)
        except FileNotFoundError:
            fp = None
    if fp:
        import PIL.ImageDraw as _D
        import PIL.Image as _I

        probe = _D.Draw(_I.new("RGB", (4, 4)))
        max_size = int(plate_h * (0.30 if fam["placement"] == "center" else 0.155))
        size, lines = fit_font_size(
            str(title), fp, box_w, box_h, probe, max_size=max_size, max_lines=max_lines
        )

    anchor_y = band_top + int(band_h * (0.5 if fam["placement"] == "center" else 0.52))
    anchor_x = plate_w // 2

    sub_plan = None
    if subtitle:
        sub_plan = {
            "lines": [str(subtitle)],
            "size": max(12, int(size * 0.34)),
            "fill": fam["fill"],
            "anchor_xy": (anchor_x, anchor_y + int(size * 1.25)),
            "anchor": "mm",
            "tracking": fam["tracking"] * 2,
        }

    return {
        "family": family if family in FAMILIES else _DEFAULT_FAMILY,
        "font": fp,
        "scrim": {
            "box": (0, band_top, plate_w, band_top + band_h),
            "fill": fam["scrim"],
            "placement": fam["placement"],
        },
        "title": {
            "lines": lines,
            "size": size,
            "fill": fam["fill"],
            "anchor_xy": (anchor_x, anchor_y),
            "anchor": "mm",
            "tracking": fam["tracking"],
            "glow": fam["glow"],
        },
        "subtitle": sub_plan,
    }


def compose(plate_path, out_path, title, subtitle=None, family=_DEFAULT_FAMILY,
            font_path=None, quality=88):
    """Execute a plan against a plate and write the composited cover.

    Returns a manifest-style dict describing what was written.
    """
    from PIL import Image, ImageDraw, ImageFont

    plate_path = os.path.expanduser(plate_path)
    out_path = os.path.expanduser(out_path)
    img = Image.open(plate_path).convert("RGBA")
    w, h = img.size

    p = plan(w, h, title, subtitle=subtitle, family=family, font_path=font_path)
    if not p["font"]:
        raise FileNotFoundError(
            "no usable cover font; set COVER_FONT or install Arial Black"
        )

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    box = p["scrim"]["box"]
    band = scrim_gradient(w, h, box, p["scrim"]["fill"],
                          p["scrim"].get("placement", "bottom"))
    overlay.paste(band, (int(box[0]), int(box[1])))
    draw = ImageDraw.Draw(overlay)

    def _paint(spec, font):
        x, y = spec["anchor_xy"]
        lines = spec["lines"] or [""]
        line_h = _line_height(font, draw)
        total = line_h * len(lines)
        cy = y - total // 2 + line_h // 2
        for line in lines:
            if spec.get("glow"):
                gx, gy = spec["anchor_xy"]
                for dx in (-2, 2):
                    for dy in (-2, 2):
                        draw.text((gx + dx, cy + dy), line, font=font,
                                  fill=spec["glow"] + (150,), anchor="mm")
            draw.text((x, cy), line, font=font, fill=spec["fill"], anchor="mm")
            cy += line_h

    title_font = ImageFont.truetype(p["font"], max(1, int(p["title"]["size"]) or 48))
    _paint(p["title"], title_font)
    if p["subtitle"]:
        sub_font = ImageFont.truetype(p["font"], max(1, int(p["subtitle"]["size"])))
        _paint(p["subtitle"], sub_font)

    img = Image.alpha_composite(img, overlay).convert("RGB")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    if out_path.lower().endswith((".jpg", ".jpeg")):
        img.save(out_path, "JPEG", quality=quality)
    else:
        img.save(out_path)

    return {
        "ok": True,
        "out": os.path.abspath(out_path),
        "plate": os.path.abspath(plate_path),
        "width": w,
        "height": h,
        "family": p["family"],
        "title": title,
        "titleLines": p["title"]["lines"],
        "titleSize": p["title"]["size"],
        "font": p["font"],
    }


def family_for_slug(slug, default=_DEFAULT_FAMILY):
    """`'neon_pulse-03'` -> `'neon-pulse'`; `'01-type_loud-02'` -> `'type-loud'`.

    Slugs come from the manifest and may carry a render-order prefix and
    either separator. Unknown slugs fall back rather than raise, so one bad
    entry cannot stop a batch of covers from being lettered.
    """
    s = re.sub(r"^\d+[-_]", "", str(slug or "").lower()).replace("_", "-")
    for key in sorted(FAMILIES, key=len, reverse=True):
        if s.startswith(key):
            return key
    return default


def relpath_for_manifest(path, root=None):
    """A path safe to write into a shipped manifest.

    Absolute paths leak the author's home directory into a public repo
    (repo rule: strip them by default, `--keep-abspath` for debugging). A
    path under `root` becomes root-relative; a path under the home
    directory becomes `~/...`; anything else keeps only its basename so no
    filesystem shape travels with the artefact.
    """
    p = os.path.expanduser(str(path or ""))
    if not p:
        return ""
    root = os.path.abspath(os.path.expanduser(root)) if root else os.getcwd()
    try:
        rel = os.path.relpath(os.path.abspath(p), root)
        if not rel.startswith(".."):
            return rel.replace(os.sep, "/")
    except ValueError:
        pass
    home = os.path.expanduser("~")
    if p.startswith(home + os.sep):
        return "~/" + p[len(home) + 1:].replace(os.sep, "/")
    return os.path.basename(p)


# ---------------------------------------------------------------- helpers

def _any_font_available():
    try:
        resolve_font()
        return True
    except FileNotFoundError:
        return False


def _load(path, size):
    from PIL import ImageFont

    return ImageFont.truetype(path, int(size))


def _width(text, font, draw):
    try:
        return draw.textlength(str(text), font=font)
    except Exception:
        bbox = draw.textbbox((0, 0), str(text), font=font)
        return bbox[2] - bbox[0]


def _line_height(font, draw):
    try:
        bbox = draw.textbbox((0, 0), "Ag", font=font)
        return max(1, int((bbox[3] - bbox[1]) * 1.22))
    except Exception:
        return max(1, int(getattr(font, "size", 16) * 1.22))
