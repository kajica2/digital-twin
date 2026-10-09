# Asset Pipeline

Batch convert images/GIFs to vertical MP4s with viral-optimized metadata.

## What it does

1. **Convert** → Images/GIFs → 1080×1920 vertical MP4 (5s loops)
2. **Analyze** → Extract colors, detect mood, keywords from filename
3. **Tag** → Generate hashtags, description, proper naming
4. **Export** → Organized folder ready for social upload

## Usage

```bash
# Single file
node lib/asset-pipeline.js ./image.jpg --analyze --output ./export

# Batch folder
node lib/asset-pipeline.js ./assets/marketplace/system-error --batch --analyze --output ./export-ready

# Dry run (no files created)
node lib/asset-pipeline.js ./folder --dry-run --analyze
```

## Options

| Flag | Description |
|------|-------------|
| `--output, -o <dir>` | Output directory (default: export-ready/) |
| `--batch, -b` | Batch mode - process all files |
| `--analyze, -a` | Analyze colors/mood/keywords |
| `--dry-run` | Show what would happen, don't create files |

## Output

Each conversion produces:
- `*.mp4` - Vertical 9:16 video, 5s, H.264
- `*.json` - Metadata with hashtags, description, keywords
- `README.md` - Overview with all files

## Metadata JSON

```json
{
  "source": "image.jpg",
  "output": "family-01-energetic-mixed.mp4",
  "family": "system-error",
  "mood": "energetic",
  "keywords": ["neon", "pulse"],
  "colors": ["#ff00ff", "#00ffff"],
  "hashtags": ["#AIArt", "#DigitalArt", ...],
  "description": "Created with #SaintedWordRecords...",
  "duration": 5,
  "resolution": "1080x1920"
}
```

## Config

Edit `lib/asset-pipeline-config.json`:
- Resolution (default 1080×1920)
- Duration (default 5s)
- FPS (default 30)
- Hashtag count
- Naming pattern
