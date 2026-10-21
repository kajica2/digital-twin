# FLUX Loop Pipeline

> FLUX still → I2V animation → Loopable video segmenter

## Status

**In Progress** — Phase 1 (FLUX still) works, Phases 2-3 need I2V backend setup.

## Pipeline Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐
│  Phase 1        │    │  Phase 2        │    │  Phase 3            │
│  FLUX Still     │───▶│  I2V Animation  │───▶│  Loopable Segmenter │
│  (flux2-render) │    │  (flux-i2v)     │    │  (loopable-video-   │
│                 │    │                 │    │   segmenter)        │
└─────────────────┘    └─────────────────┘    └─────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
  data/flux/stills/    data/flux/loops-raw/    data/flux/loops-final/
```

## Quick Start

```bash
# Single prompt
python lib/flux-loop-pipeline/pipeline.py \
  --prompt "ambient abstract loop, soft light, cinematic wide angle" \
  --out data/flux/loops-final/loop-001.mp4

# From prompt file (16:9 wide angle prompts)
python lib/flux-loop-pipeline/pipeline.py \
  --prompt-file assets/mural-prompts/whats-gonna-be-groove.md \
  --outdir data/flux/loops-final/

# JSON output
python lib/flux-loop-pipeline/pipeline.py \
  --prompt "your prompt" \
  --json
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--prompt` | - | Single prompt |
| `--prompt-file` | - | File with prompts |
| `--out` | - | Output file (single) |
| `--outdir` | - | Output dir (batch) |
| `--width` | 1280 | Still width |
| `--height` | 720 | Still height |
| `--duration` | 4 | Video duration (seconds) |
| `--segments` | 4 | Loop segments |
| `--backend` | dgenerate | I2V backend |
| `--json` | false | JSON output |

## Prerequisites

1. **FLUX2 renderer** — `lib/flux2-renderer/` (already set up)
2. **I2V backend** — Choose one:
   - WanVideo 2.1 + ComfyUI
   - dgenerate CLI
   - Minimax I2V API
3. **Loopable Video Segmenter** — `lib/loopable-video-segmenter/` (already set up)
4. **ffmpeg** — Required by segmenter

```bash
# Verify setup
npm run lvs:check
```

## Output

- **Stills**: `data/flux/stills/<timestamp>-<slug>.png`
- **Raw loops**: `data/flux/loops-raw/<timestamp>-<slug>.mp4`
- **Final loops**: `data/flux/loops-final/<timestamp>-<slug>.mp4`

## npm Scripts

```bash
npm run flux:pipeline    # Run full pipeline
npm run flux:still      # Generate FLUX still only
npm run flux:i2v        # Animate to video only
npm run flux:segment    # Segment video only
```
