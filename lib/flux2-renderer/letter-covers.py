#!/usr/bin/env python3
"""Letter a batch of clean plates into readable covers. (TD-007)

    python3 lib/flux2-renderer/letter-covers.py \
        --manifest lib/flux2-renderer/manifests/covers-marketplace-12-plates.json \
        --plates   assets/flux2/covers-marketplace-plates \
        --out-dir  assets/marketplace/covers

Pairs each manifest entry with its plate by slug (render-many names files
`NN-<slug>.png`), then calls lettering.compose() to set the title in a real
font over the plate.

Pre-flight runs BEFORE any file is written: every entry must have a plate,
every entry must carry a title, and a usable font must exist. A batch that
cannot complete is refused up front rather than half-written — the repo rule
about validating before doing the work.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lettering import compose, family_for_slug, relpath_for_manifest, resolve_font  # noqa: E402

HOME = os.path.expanduser("~")


def _clean_record(res):
    """Strip the author's filesystem shape from a manifest record."""
    out = dict(res)
    for key in ("out", "plate", "font"):
        val = out.get(key)
        if val and (str(val).startswith(HOME + os.sep) or str(val).startswith("/Users/")):
            out[key] = relpath_for_manifest(val)
    return out


def find_plate(plates_dir, slug):
    """Match `NN-<slug>.png` (render-many naming) or `<slug>.png`."""
    for name in sorted(os.listdir(plates_dir)):
        if not name.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        stem = os.path.splitext(name)[0]
        if stem == slug or re.sub(r"^\d+[-_]", "", stem) == slug:
            return os.path.join(plates_dir, name)
    return None


def load_manifest(path):
    with open(os.path.expanduser(path), encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list) or not data:
        raise ValueError("manifest must be a non-empty JSON array")
    return data


def out_name(slug, ext):
    return re.sub(r"^\d+[-_]", "", str(slug)).replace("_", "-") + ext


def main():
    ap = argparse.ArgumentParser(description="Set real type over clean cover plates")
    ap.add_argument("--manifest", required=True, help="JSON array of {slug, title, prompt}")
    ap.add_argument("--plates", required=True, help="directory of rendered plates")
    ap.add_argument("--out-dir", required=True, help="where the lettered covers go")
    ap.add_argument("--out-format", choices=("jpg", "png"), default="jpg")
    ap.add_argument("--quality", type=int, default=88, help="JPEG quality")
    ap.add_argument("--font", default=None, help="explicit font path (else COVER_FONT / candidates)")
    ap.add_argument("--dry-run", action="store_true", help="pre-flight only, write nothing")
    args = ap.parse_args()

    try:
        entries = load_manifest(args.manifest)
    except (OSError, ValueError) as exc:
        print(f"[letter] cannot read manifest: {exc}", file=sys.stderr)
        return 2

    plates_dir = os.path.expanduser(args.plates)
    if not os.path.isdir(plates_dir):
        print(f"[letter] plates dir not found: {plates_dir}", file=sys.stderr)
        return 2

    # ---- pre-flight: refuse the whole batch if any entry cannot be done ----
    problems = []
    planned = []
    for i, e in enumerate(entries, 1):
        slug = e.get("slug") or f"render-{i:02d}"
        title = (e.get("title") or "").strip()
        if not title:
            problems.append(f"{slug}: no title")
            continue
        plate = find_plate(plates_dir, slug)
        if not plate:
            problems.append(f"{slug}: no plate in {plates_dir}")
            continue
        planned.append((slug, title, plate, family_for_slug(slug)))

    if problems:
        print(f"[letter] refusing batch — {len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 2

    try:
        font = resolve_font(args.font)
    except FileNotFoundError as exc:
        print(f"[letter] {exc}", file=sys.stderr)
        return 2

    ext = ".jpg" if args.out_format == "jpg" else ".png"
    out_dir = os.path.expanduser(args.out_dir)
    print(f"[letter] {len(planned)} covers -> {os.path.abspath(out_dir)}")
    print(f"[letter] font: {font}")
    if args.dry_run:
        for slug, title, plate, fam in planned:
            print(f"  would write {out_name(slug, ext):<28} [{fam:<10}] {title!r}")
        return 0

    os.makedirs(out_dir, exist_ok=True)
    results = []
    for n, (slug, title, plate, fam) in enumerate(planned, 1):
        out = os.path.join(out_dir, out_name(slug, ext))
        res = compose(plate, out, title, family=fam, font_path=args.font, quality=args.quality)
        results.append(_clean_record(res))
        print(f"  [{n}/{len(planned)}] {os.path.basename(out)}  {res['width']}x{res['height']}  {title!r}")

    payload = {"count": len(results), "font": relpath_for_manifest(font), "covers": results}

    # Belt and braces: a manifest that ships must never carry the home dir.
    blob = json.dumps(payload, indent=2)
    if HOME in blob:
        blob = blob.replace(HOME, "~")

    manifest_out = os.path.join(out_dir, "lettering-manifest.json")
    with open(manifest_out, "w", encoding="utf-8") as fh:
        fh.write(blob)
    print(f"[letter] wrote {len(results)} covers + {os.path.basename(manifest_out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
