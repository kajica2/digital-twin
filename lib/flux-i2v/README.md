# FLUX I2V — Image-to-Video Animation

> Animate FLUX stills into video loops.

## Status

**Placeholder** — requires I2V backend setup (WanVideo, dgenerate, or Minimax).

## Backends

| Backend | Status | Notes |
|---------|--------|-------|
| wanvideo | 🔧 Not implemented | Requires ComfyUI with WanVideo nodes |
| dgenerate | 🔧 Not implemented | CLI not installed |
| minimax | 🔧 Not implemented | Requires API key |

## Quick Start

```bash
# Install (when backend is ready)
npm run flux-i2v:setup

# Check status
npm run flux-i2v:check

# Animate a still
lib/flux-i2v/.venv/bin/python lib/flux-i2v/animate.py \
  --input data/flux/stills/loop-001.png \
  --duration 4 \
  --loop \
  --out data/flux/loops-raw/loop-001.mp4
```

## For Seamless Loops

Use `--loop` flag to generate start+end with the same frame:

```bash
--loop --prompt "seamless loop, cyclical ambient motion"
```

## Output

- Format: MP4 (H.264)
- Duration: 3-5 seconds
- Naming: `data/flux/loops-raw/<timestamp>-<slug>.mp4`
