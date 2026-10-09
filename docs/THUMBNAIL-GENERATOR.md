# Thumbnail Prompt Generator

Generates viral thumbnail prompts from asset pipeline metadata.

## What it does

1. Reads `.json` metadata from asset pipeline output
2. Generates 4 style variants per asset (Bold, Minimal, Typography, Photo)
3. Creates MJ-optimized prompts with viral traits
4. Outputs ready-to-use prompts for Midjourney or Draw Things

## Usage

```bash
# From a single metadata file
node lib/thumbnail-prompt-generator.js path/to/file.json

# From pipeline output directory
node lib/thumbnail-prompt-generator.js --from-pipeline ./export-ready --output ./thumbnails

# With Draw Things format
node lib/thumbnail-prompt-generator.js --from-pipeline ./export-ready --drawthings
```

## Output

Each source generates 4 style variants:

```
thumbnails/
├── system-error-01-bold.txt
├── system-error-01_minimal.txt
├── system-error-01_typography.txt
├── system-error-01_photo.txt
├── system-error-02-bold.txt
... (40 files from 10 sources × 4 styles)
├── all-prompts.json
└── batch-prompts.md
```

## Prompt Structure

```
Bold typography thumbnail, [mood modifier], [keywords], [viral trait], [suffix], high quality, 4k --ar 9:16 --style raw --s 250
```

### Styles

| Style | Best For |
|-------|----------|
| Bold | Energy, music, sports |
| Minimal | Fashion, lifestyle, tech |
| Typography | Quotes, messages, announcements |
| Photo | Portraits, products, real content |

### Mood Modifiers

- **energetic** → dynamic, vibrant, movement
- **dreamy** → soft, ethereal, light
- **moody** → dark, dramatic, intense
- **intense** → powerful, bold, striking
- **neutral** → balanced, clean, modern

## Draw Things Integration

The script generates prompts compatible with Draw Things. Load the script at:
`lib/drawthings-viral-thumbnail.js`

In Draw Things:
1. Open Scripts
2. Load the script
3. Enter your generated prompt
4. Generate thumbnails

## Workflow

```
Asset Pipeline → MP4s + JSON → Thumbnail Generator → MJ/Draw Things → Viral Thumbnails
```

1. Run asset pipeline on images
2. Run thumbnail prompt generator on output
3. Copy prompts to MJ or use Draw Things script
4. Upload with your MP4s
