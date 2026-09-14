#!/usr/bin/env python3
"""Generate the og:image for pages/cognitive-twin.html.

1200×630 PNG. Uses the same warm-cream / copper / forest palette as the
kai-systems design tokens. Hand-rolled with stdlib only (no Pillow needed
beyond what's already installed). Falls back to a simple text layout.

Layout:
  - Top band (1/3): "The Cognitive Twin" + tagline
  - Middle (1/2): four layer cards in a row with arrows between
  - Bottom band (1/6): "kajica2.github.io/digital-twin"
"""
import os
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "cognitive-twin-og.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow not installed; using fallback (no-op image). Install with: pip3 install Pillow", file=sys.stderr)
    sys.exit(0)

W, H = 1200, 630
# kai-systems warm palette
BG = (250, 250, 249)        # cream
INK = (28, 25, 23)           # near-black
MUTED = (120, 113, 108)      # warm gray
ACCENT = (180, 83, 9)        # copper-700
LAYER_COLORS = [
    (14, 165, 233),          # scanner — sky-500
    (16, 185, 129),          # model — emerald-500
    (245, 158, 11),          # reasoner — amber-500
    (239, 68, 68),           # orchestrator — red-500
]

img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)

# Try to load a serif-ish and a sans font
def load_font(size, weight="regular"):
    candidates = [
        f"/System/Library/Fonts/Supplemental/{weight.title()}.ttf" if weight != "mono" else "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if weight == "bold" else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()

font_h1 = load_font(64, "bold")
font_sub = load_font(22, "regular")
font_card = load_font(20, "bold")
font_role = load_font(15, "regular")
font_url = load_font(16, "regular")

# Top band — title
draw.text((60, 60), "The Cognitive Twin", fill=INK, font=font_h1)
draw.text((60, 140), "A map of everything. Working.", fill=MUTED, font=font_sub)

# Thin accent rule under header
draw.rectangle([(60, 195), (1140, 198)], fill=ACCENT)

# Layer cards — 4 cards in a row, with arrows between
LAYER_NAMES = ["Scanner", "Model", "Reasoner", "Orchestrator"]
LAYER_ROLES = ["Index the\nenvironment", "Persist as\nmemory", "Match work\nto tools", "Run the\nwork"]

card_w = 200
card_h = 220
gap = 35
total_w = 4 * card_w + 3 * gap
start_x = (W - total_w) // 2
card_y = 250

for i in range(4):
    x = start_x + i * (card_w + gap)
    # Card background
    draw.rectangle([(x, card_y), (x + card_w, card_y + card_h)], fill=(255, 255, 255), outline=LAYER_COLORS[i], width=3)
    # Color band at top
    draw.rectangle([(x, card_y), (x + card_w, card_y + 6)], fill=LAYER_COLORS[i])
    # Layer name
    bbox = draw.textbbox((0, 0), LAYER_NAMES[i], font=font_card)
    text_w = bbox[2] - bbox[0]
    draw.text((x + (card_w - text_w) // 2, card_y + 50), LAYER_NAMES[i], fill=INK, font=font_card)
    # Role text (multi-line)
    role_lines = LAYER_ROLES[i].split("\n")
    for j, line in enumerate(role_lines):
        bbox = draw.textbbox((0, 0), line, font=font_role)
        line_w = bbox[2] - bbox[0]
        draw.text((x + (card_w - line_w) // 2, card_y + 100 + j * 22), line, fill=MUTED, font=font_role)
    # Section number badge
    badge = f"0{i+1}"
    bbox = draw.textbbox((0, 0), badge, font=font_role)
    badge_w = bbox[2] - bbox[0]
    badge_x = x + card_w - badge_w - 16
    draw.text((badge_x, card_y + card_h - 32), badge, fill=LAYER_COLORS[i], font=font_role)
    # Arrow between cards (triangle, font-glyph-free so it renders everywhere)
    if i < 3:
        arrow_cx = x + card_w + gap // 2
        arrow_cy = card_y + card_h // 2
        size = 10
        draw.polygon([
            (arrow_cx - size, arrow_cy - size),
            (arrow_cx + size, arrow_cy),
            (arrow_cx - size, arrow_cy + size),
        ], fill=MUTED)

# Bottom band — URL
draw.rectangle([(0, H - 50), (W, H)], fill=INK)
draw.text((60, H - 38), "kajica2.github.io/digital-twin", fill=(212, 197, 167), font=font_url)
draw.text((W - 220, H - 38), "kai-systems", fill=(212, 197, 167), font=font_url)

img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")