#!/usr/bin/env python3
# lib/self-improve/auditor.py
# On-demand project quality auditor.
# Three axes: image quality, prompt structure, text freshness.
#
# Usage:
#   python3 lib/self-improve/auditor.py [--days 14] [--clip-model vit-l]
#   python3 lib/self-improve/auditor.py --report-json
#
# Output: logs/self-improve/YYYY-MM-DD-report.{json,md}

import argparse, base64, json, os, re, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).parent.parent.parent.resolve()
LOG_DIR = REPO / "logs" / "self-improve"
CLIP_VENV = REPO / "lib" / "clip-interrogator" / ".venv" / "bin" / "python"
CLIP_MODULE = "clip_interrogator_app.cli"

TODAY = datetime.now(timezone.utc).date()
DAYS_DEFAULT = 14


# ─── 1. IMAGE QUALITY ───────────────────────────────────────────────────────────

def analyze_images(clip_model=None):
    """Audit rendered images: technical specs + optional CLIP interrogation.

    CLIP is opt-in (--clip flag) because it loads the model fresh per call
    (~60s overhead each time). Pass clip_model="vit-l" to enable.
    """
    flux2_dir = REPO / "assets" / "flux2"
    if not flux2_dir.exists():
        return {"error": f"assets/flux2/ not found at {flux2_dir}"}

    clip_available = CLIP_VENV.exists() if clip_model else False
    if clip_model and not clip_available:
        print("[auditor] CLIP venv not found — skipping visual quality check", file=sys.stderr)

    results = []
    for pack_dir in sorted(flux2_dir.iterdir()):
        if not pack_dir.is_dir() or pack_dir.name == "FLUX.2-klein-4B":
            continue
        pngs = sorted(pack_dir.glob("*.png"))
        if not pngs:
            continue

        # Sample: 1 representative image per pack (first), unless CLIP is on
        # in which case sample 3 so at least one is likely visually clean
        if clip_model:
            sample = pngs if len(pngs) <= 3 else [pngs[0], pngs[len(pngs)//2], pngs[-1]]
        else:
            sample = [pngs[0]] if pngs else []

        for png in pngs:
            sips = _sips_info(png)
            clip_desc = None
            if clip_available and png in sample:
                clip_desc = _clip_interrogate(png, model=clip_model)
            results.append({
                "path": str(png.relative_to(REPO)),
                "size_bytes": sips["size_bytes"],
                "width": sips["width"],
                "height": sips["height"],
                "color_space": sips["color_space"],
                "bit_depth": sips["bit_depth"],
                "clip_description": clip_desc,
                "_clip_sampled": png in sample,
            })

    return results


def _sips_info(png):
    try:
        out = subprocess.check_output(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "colorSpace", "-g", "depth", str(png)],
            stderr=subprocess.DEVNULL, text=True
        )
        info = {}
        for line in out.splitlines():
            if ": " in line:
                key, val = line.split(": ", 1)
                info[key.strip()] = val.strip()
        size = os.path.getsize(png)
        return {
            "width": int(info.get("pixelWidth", 0)),
            "height": int(info.get("pixelHeight", 0)),
            "color_space": info.get("colorSpace", "unknown"),
            "bit_depth": info.get("depth", "unknown"),
            "size_bytes": size,
        }
    except Exception as e:
        return {"width": 0, "height": 0, "color_space": "unknown", "bit_depth": "unknown", "size_bytes": 0, "error": str(e)}


def _clip_interrogate(png_path, model="vit-l", mode="best"):
    """Run CLIP Interrogator on one image, return description text."""
    if not CLIP_VENV.exists():
        return None  # CLIP not set up; skip silently

    try:
        result = subprocess.run(
            [str(CLIP_VENV), "-m", CLIP_MODULE, "interrogate",
             str(png_path), "--model", model, "--mode", mode, "--json"],
            capture_output=True, text=True, timeout=120, cwd=str(REPO)
        )
        if result.returncode == 0:
            # Banner prints to stderr; parse the last JSON object from stdout
            lines = [l for l in result.stdout.strip().splitlines() if l.startswith("{")]
            if lines:
                data = json.loads(lines[-1])
                # The prompt is the description
                return data.get("prompt", data.get("description", ""))[:500]
        return None
    except Exception:
        return None


# ─── 2. PROMPT STRUCTURAL AUDIT ────────────────────────────────────────────────

# Files that are reference/convention docs, not renderable prompt packs
_EXCLUDED_PACKS = {
    "PROMPT-EXPANSION-FORMAT.md",   # format spec, not prompts
    "STYLE-PRESETS.md",             # style reference list, not prompts
    "south-america-street-graffiti.md",  # zero bullets confirmed
}


def _extract_bullets(text):
    """Extract bullet lines from markdown, joining continuation lines.

    A bullet starts with '- '. Subsequent lines indented with 2+ spaces
    are continuations of the same bullet. Continuation lines do NOT start
    new bullets.
    """
    lines = text.splitlines()
    bullets = []
    current = []
    for line in lines:
        if line.startswith('- '):
            if current:
                bullets.append(' '.join(current))
            current = [line[len('- '):].strip()]
        elif line.startswith('  ') and current:
            # Continuation line (indented with spaces)
            current.append(line.strip())
        else:
            if current:
                bullets.append(' '.join(current))
                current = []
    if current:
        bullets.append(' '.join(current))
    return bullets


def audit_prompts():
    """Scan all .md prompt packs for structural issues."""
    prompts_dir = REPO / "assets" / "mural-prompts"
    if not prompts_dir.exists():
        return {"error": f"mural-prompts/ not found at {prompts_dir}"}

    findings = []
    pack_summaries = []

    for pack in sorted(prompts_dir.glob("*.md")):
        if pack.name in _EXCLUDED_PACKS:
            continue
        text = pack.read_text(encoding="utf-8")
        # Strip frontmatter
        text = re.sub(r"^---.*?---\n", "", text, flags=re.DOTALL)
        bullets = _extract_bullets(text)
        if not bullets:
            continue

        pack_issues = []
        subjects = []

        for i, bullet in enumerate(bullets, 1):
            # ---ar flag checks
            ar_matches = re.findall(r"--ar\s+(\S+)", bullet)
            if len(ar_matches) > 1:
                pack_issues.append({
                    "bullet": i, "type": "duplicate_ar",
                    "detail": f"--ar appears {len(ar_matches)} times: {' '.join(ar_matches)}"
                })

            # Missing --ar
            if not re.search(r"--ar\s+\d+:\d+", bullet):
                pack_issues.append({
                    "bullet": i, "type": "missing_ar",
                    "detail": "no --ar flag found"
                })

            # Style flag checks
            style_raw_count = len(re.findall(r"--style\s+raw", bullet))
            s_count = len(re.findall(r"\s-s\s+\d+", bullet))
            if style_raw_count > 1:
                pack_issues.append({
                    "bullet": i, "type": "duplicate_style_raw",
                    "detail": f'"--style raw" appears {style_raw_count} times'
                })

            # Extract subject (first 60 chars of prompt, before style clauses)
            prompt_part = re.sub(r"\s+--\S+.*$", "", bullet).strip()
            if prompt_part:
                subjects.append(prompt_part[:60])

        # Shared prefix collapse risk (sprint 0.32)
        if len(subjects) >= 3:
            first_words = [s.split(",")[0].split(" ")[0] for s in subjects]
            if len(set(first_words)) == 1:
                pack_issues.append({
                    "bullet": 0, "type": "shared_prefix_collapse",
                    "detail": f'All prompts start with "{first_words[0]}" — MJ acceptance matcher will collapse these'
                })

        # Check for bare style clauses at subject position (style before subject)
        for i, bullet in enumerate(bullets, 1):
            stripped = bullet.strip()
            if stripped.startswith("--") or stripped.startswith(","):
                pack_issues.append({
                    "bullet": i, "type": "subject_not_first",
                    "detail": f"Prompt starts with a flag/separator, not a subject: {stripped[:50]}"
                })

        pack_summaries.append({
            "pack": pack.name,
            "bullet_count": len(bullets),
            "issues": pack_issues,
        })
        findings.extend(pack_issues)

    return {
        "total_issues": len(findings),
        "packs": pack_summaries,
        "issue_types": _count_by_type(findings),
    }


def _count_by_type(findings):
    counts = {}
    for f in findings:
        t = f["type"]
        counts[t] = counts.get(t, 0) + 1
    return counts


# ─── 3. TEXT FRESHNESS ─────────────────────────────────────────────────────────

def scan_freshness(days=14):
    """Scan docs for staleness; return changes since N days ago."""
    cutoff = datetime.now(timezone.utc).timestamp() - (days * 86400)
    docs_dir = REPO / "docs"
    pages_dir = REPO / "pages"

    stale_docs = []
    recent_changes = []

    # Docs
    if docs_dir.exists():
        for doc in sorted(docs_dir.glob("*.md")):
            mtime = doc.stat().st_mtime
            age_days = (time.time() - mtime) / 86400
            if mtime < cutoff:
                stale_docs.append({
                    "path": str(doc.relative_to(REPO)),
                    "age_days": round(age_days, 1),
                    "mtime": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                })

    # Pages HTML
    if pages_dir.exists():
        for page in sorted(pages_dir.glob("*.html")):
            mtime = page.stat().st_mtime
            age_days = (time.time() - mtime) / 86400
            if mtime < cutoff:
                stale_docs.append({
                    "path": str(page.relative_to(REPO)),
                    "age_days": round(age_days, 1),
                    "mtime": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                })

    # Recent git commits (last N days)
    try:
        result = subprocess.run(
            ["git", "log", f"--since={days} days ago", "--oneline", "--stat=120"],
            capture_output=True, text=True, cwd=str(REPO), timeout=10
        )
        commit_lines = []
        for line in result.stdout.splitlines():
            if line.startswith("commit "):
                commit_lines = []
            commit_lines.append(line)
            if len(commit_lines) > 200:
                commit_lines = commit_lines[-200:]
        recent_git = result.stdout.strip()
    except Exception as e:
        recent_git = f"git log failed: {e}"

    # AGENTS.md sprint log check
    agents_path = REPO / "AGENTS.md"
    last_sprint_date = None
    if agents_path.exists():
        matches = re.findall(r"### (\d{4}-\d{2}-\d{2}) — sprint", agents_path.read_text())
        if matches:
            last_sprint_date = matches[-1]

    return {
        "stale_docs_count": len(stale_docs),
        "stale_docs": stale_docs[:20],  # cap for readability
        "recent_git": recent_git[:3000],  # cap
        "last_sprint_date": last_sprint_date,
        "scan_date": TODAY.isoformat(),
        "days": days,
    }


# ─── 4. RECOMMENDATIONS ───────────────────────────────────────────────────────

def make_recommendations(images, prompts, freshness):
    """Turn raw findings into actionable recommendations."""
    recs = []

    # Image quality
    if isinstance(images, dict) and "error" in images:
        recs.append({"priority": "info", "area": "images", "text": f"Image scan skipped: {images['error']}"})
    elif isinstance(images, list):
        bad_size = [r for r in images if r.get("size_bytes", 0) < 10_000]
        if bad_size:
            recs.append({
                "priority": "high",
                "area": "images",
                "text": f"{len(bad_size)} images are suspiciously small (<10 KB) — likely broken renders",
                "examples": [r["path"] for r in bad_size[:5]],
            })
        wrong_res = [r for r in images if r.get("width", 0) not in (0, 832, 624, 416)]
        if wrong_res:
            recs.append({
                "priority": "medium",
                "area": "images",
                "text": f"{len(wrong_res)} images are non-standard resolution",
                "examples": [f'{r["path"]} ({r["width"]}x{r["height"]})' for r in wrong_res[:5]],
            })

    # Prompts
    pt = prompts.get("issue_types", {})
    total = sum(pt.values())
    if total > 0:
        recs.append({
            "priority": "high" if pt.get("duplicate_ar", 0) else "medium",
            "area": "prompts",
            "text": f"{total} prompt structural issues found across {len(prompts.get('packs', []))} packs",
            "breakdown": pt,
        })
    if pt.get("shared_prefix_collapse"):
        packs = [p["pack"] for p in prompts.get("packs", []) if any(i["type"] == "shared_prefix_collapse" for i in p["issues"])]
        recs.append({
            "priority": "high",
            "area": "prompts",
            "text": f"SHARED PREFIX COLLAPSE risk in: {', '.join(packs)} — all prompts start with the same word; MJ acceptance matcher will misattribute",
        })
    if pt.get("missing_ar"):
        packs = [p["pack"] for p in prompts.get("packs", []) if any(i["type"] == "missing_ar" for i in p["issues"])]
        recs.append({
            "priority": "medium",
            "area": "prompts",
            "text": f"Missing --ar flag in: {', '.join(packs)} — renders will use the model default, likely wrong aspect",
        })

    # Freshness
    if freshness.get("stale_docs_count", 0) > 0:
        recs.append({
            "priority": "low",
            "area": "freshness",
            "text": f"{freshness['stale_docs_count']} docs/pages older than {freshness['days']} days",
            "examples": [d["path"] for d in freshness.get("stale_docs", [])[:5]],
        })
    last_sprint = freshness.get("last_sprint_date")
    if last_sprint:
        days_since = (TODAY - datetime.fromisoformat(last_sprint).date()).days
        if days_since > 14:
            recs.append({
                "priority": "medium",
                "area": "freshness",
                "text": f"Last sprint logged {days_since} days ago ({last_sprint}) — sprint log may need updating",
            })

    return recs


# ─── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Project quality auditor — on demand")
    ap.add_argument("--days", type=int, default=DAYS_DEFAULT, help="Days for freshness scan")
    ap.add_argument("--clip", dest="clip_model", nargs="?", const="vit-l", default=None,
                    choices=["vit-l", "vit-h"],
                    help="Enable CLIP visual quality check (slow: loads model per call). "
                         "Defaults to vit-l. Use --clip vit-h for the higher-capacity model.")
    ap.add_argument("--report-json", action="store_true", help="Output JSON report path and exit")
    ap.add_argument("--report-md", action="store_true", help="Output markdown report and exit")
    args = ap.parse_args()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    report_date = TODAY.isoformat()
    json_path = LOG_DIR / f"{report_date}-report.json"

    print(f"[auditor] scanning image quality …", file=sys.stderr)
    images = analyze_images(clip_model=args.clip_model)

    print(f"[auditor] auditing prompt structure …", file=sys.stderr)
    prompts = audit_prompts()

    print(f"[auditor] scanning text freshness ({args.days} days) …", file=sys.stderr)
    freshness = scan_freshness(args.days)

    print(f"[auditor] building recommendations …", file=sys.stderr)
    recommendations = make_recommendations(images, prompts, freshness)

    report = {
        "date": report_date,
        "days": args.days,
        "images": images,
        "prompts": prompts,
        "freshness": freshness,
        "recommendations": recommendations,
    }

    # Write JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)

    # Write markdown summary
    md_path = LOG_DIR / f"{report_date}-report.md"
    _write_markdown(report, md_path)

    if args.report_json:
        print(str(json_path))
        return 0
    if args.report_md:
        print(str(md_path))
        return 0

    # Human-readable summary
    print(f"\n=== Auditor report — {report_date} ===\n")
    for rec in recommendations:
        icon = {"high": "(!)", "medium": "(?)", "low": "(ok)", "info": "(--)"}.get(rec["priority"], "   ")
        print(f"{icon} [{rec['area']}] {rec['text']}")
        if "examples" in rec:
            for ex in rec["examples"]:
                print(f"       → {ex}")
        if "breakdown" in rec:
            for k, v in rec["breakdown"].items():
                print(f"       {k}: {v}")

    print(f"\nFull report: {json_path}")
    print(f"Markdown:     {md_path}")
    return 0 if not any(r["priority"] == "high" for r in recommendations) else 1


def _write_markdown(report, path):
    lines = [
        f"# Quality Auditor Report — {report['date']}",
        "",
        "## Recommendations",
        "",
    ]
    for rec in report.get("recommendations", []):
        icon = {"high": "⚠️", "medium": "❓", "low": "ℹ️", "info": "—"}.get(rec["priority"], "•")
        lines.append(f"### {icon} [{rec['area'].upper()}] {rec['text']}")
        if "examples" in rec:
            for ex in rec["examples"]:
                lines.append(f"- `{ex}`")
        if "breakdown" in rec:
            for k, v in rec["breakdown"].items():
                lines.append(f"  - `{k}`: {v}")
        lines.append("")

    images = report.get("images", [])
    if isinstance(images, list) and images:
        lines += ["## Image Summary", "", f"| Pack | File | Size | Res | Color |", "|---|---|---|---|---|"]
        for img in images[:30]:
            path_str = img.get("path", "")
            size_kb = img.get("size_bytes", 0) // 1024
            w, h = img.get("width", "?"), img.get("height", "?")
            cs = img.get("color_space", "?")
            lines.append(f"| {Path(path_str).parent.name} | {Path(path_str).name} | {size_kb}KB | {w}×{h} | {cs} |")

    freshness = report.get("freshness", {})
    if freshness.get("last_sprint_date"):
        lines += ["", "## Project State", "", f"- Last sprint logged: **{freshness['last_sprint_date']}**"]
    if freshness.get("stale_docs_count"):
        lines.append(f"- {freshness['stale_docs_count']} docs older than {freshness['days']} days")

    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
