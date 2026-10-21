#!/usr/bin/env python3
# lib/watermark-extractor.py — Extract logos as single-color transparent PNGs.
#
# Usage:
#   python3 lib/watermark-extractor.py input.png --output logo.png
#   python3 lib/watermark-extractor.py input.png --white-on-black   # white logo, black bg
#   python3 lib/watermark-extractor.py input.png --black-on-white   # black logo, white bg
#   python3 lib/watermark-extractor.py input.png --extract-grid --cols 4 --rows 2

import sys
import argparse
from pathlib import Path
from PIL import Image, ImageOps

def extract_as_alpha(input_path, output_path, threshold=240, invert=False):
    """Extract bright/dark areas as alpha transparency."""
    img = Image.open(input_path)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    pixels = img.load()
    width, height = img.size
    alpha = Image.new('L', img.size, 0)
    alpha_pixels = alpha.load()
    
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            brightness = (r + g + b) / 3
            
            if invert:
                alpha_val = 255 if brightness < threshold else 0
            else:
                alpha_val = 255 if brightness > threshold else 0
            
            alpha_pixels[x, y] = alpha_val
    
    img.putalpha(alpha)
    return img

def make_single_color(img, color, bg_color):
    """Convert to single color with optional background."""
    # Create new image with background color
    if bg_color == 'black':
        bg = (0, 0, 0, 255)
    elif bg_color == 'white':
        bg = (255, 255, 255, 255)
    else:  # transparent
        bg = (0, 0, 0, 0)
    
    # Create output
    output = Image.new('RGBA', img.size, bg)
    
    # Paste the alpha mask
    if color == 'white':
        # White logo
        output.paste((255, 255, 255, 255), (0, 0), img.split()[3])
    else:
        # Black logo
        output.paste((0, 0, 0, 255), (0, 0), img.split()[3])
    
    return output

def extract_from_grid(input_path, output_dir, cols=4, rows=2, threshold=240):
    """Extract individual logos from a grid image."""
    img = Image.open(input_path)
    width, height = img.size
    
    cell_w = width // cols
    cell_h = height // rows
    
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    count = 0
    for row in range(rows):
        for col in range(cols):
            left = col * cell_w
            top = row * cell_h
            right = left + cell_w
            bottom = top + cell_h
            
            # Crop cell
            cell = img.crop((left, top, right, bottom))
            
            # Extract as alpha (bright areas)
            cell_alpha = extract_as_alpha(cell, None, threshold=threshold, invert=False)
            
            # Save both versions
            base_name = f"logo_{row}_{col}"
            
            # White on transparent
            white_img = make_single_color(cell_alpha, 'white', 'transparent')
            white_img.save(output_dir / f"{base_name}_white.png")
            
            # Black on transparent  
            black_img = make_single_color(cell_alpha, 'black', 'transparent')
            black_img.save(output_dir / f"{base_name}_black.png")
            
            count += 1
    
    print(f"[grid] Extracted {count} logos to {output_dir}")
    return count

def main():
    parser = argparse.ArgumentParser(description="Extract logos as single-color transparent PNGs")
    parser.add_argument("input", help="Input image file")
    parser.add_argument("--output", "-out", "-o", help="Output PNG file")
    parser.add_argument("--threshold", "-t", type=int, default=240, help="Brightness threshold 0-255")
    parser.add_argument("--invert", "-i", action="store_true", help="Invert: extract dark areas")
    
    # Single color options
    parser.add_argument("--white-on-black", action="store_true", help="White logo on black background")
    parser.add_argument("--black-on-white", action="store_true", help="Black logo on white background")
    parser.add_argument("--white", action="store_true", help="White logo on transparent")
    parser.add_argument("--black", action="store_true", help="Black logo on transparent")
    
    # Grid extraction
    parser.add_argument("--extract-grid", action="store_true", help="Extract from grid layout")
    parser.add_argument("--cols", type=int, default=4, help="Columns in grid")
    parser.add_argument("--rows", type=int, default=2, help="Rows in grid")
    parser.add_argument("--output-dir", default="logos-extracted", help="Output directory for grid extraction")
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"[watermark] Error: File not found: {input_path}", file=sys.stderr)
        return 1
    
    # Grid extraction mode
    if args.extract_grid:
        extract_from_grid(input_path, args.output_dir, args.cols, args.rows, args.threshold)
        return 0
    
    # Single image mode
    # Determine colors
    if args.white_on_black:
        color, bg = 'white', 'black'
    elif args.black_on_white:
        color, bg = 'black', 'white'
    elif args.white:
        color, bg = 'white', 'transparent'
    elif args.black:
        color, bg = 'black', 'transparent'
    else:
        # Default: just extract alpha
        color, bg = None, None
    
    # Extract alpha
    img = extract_as_alpha(input_path, None, args.threshold, args.invert)
    
    # Apply color if specified
    if color:
        img = make_single_color(img, color, bg)
    
    # Determine output path
    if args.output:
        output_path = Path(args.output)
    else:
        suffix = f"_{color}" if color else "_alpha"
        output_path = input_path.with_suffix(f"{suffix}.png")
    
    img.save(output_path)
    print(f"[watermark] Saved: {output_path}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
