# SWR Multi-Agent Loop — Complete Automation Setup

## Overview

This document describes how to wire the **SWR-Twin** (operating from `digital_twin/`) as a multi-agent loop that automates the entire **Sainted Word Records** content pipeline:

- 🎨 **Asset Generation** — FLUX.2 image rendering, Midjourney prompt packs
- 🎬 **Video Creation** — Loopable Video Segmenter, Reel production
- 📱 **Social Publishing** — Instagram auto-posting, thumbnail generation
- 📺 **YouTube Pipeline** — Batch uploads, metadata, thumbnails
- 🧪 **Testing** — Puppeteer e2e specs, unit tests
- 🔄 **Watchers** — Auto-processing on file drops

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SAINTED WORD RECORDS AUTO-LOOP                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│   │   SWR-Ops    │    │  SWR-Twin    │    │ SWR-Check   │               │
│   │  (Orchestr.) │◄──►│ (Digital Twin)│◄──►│ (Verifier)  │               │
│   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘               │
│          │                    │                    │                        │
│          ▼                    ▼                    ▼                        │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│   │  TASKS.md    │    │   drafts/     │    │ npm test     │               │
│   │  lessons.md   │    │   voice/      │    │ e2e specs    │               │
│   └──────────────┘    └──────────────┘    └──────────────┘               │
│                                                                             │
│   ═══════════════════════════════════════════════════════════════════════   │
│                              AUTOMATION LAYER                                │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│   │ ig-watcher  │  │yt-watcher   │  │mj-watcher   │  │reel-watcher│     │
│   │ (Instagram) │  │(YouTube)    │  │(Midjourney) │  │ (Reels)    │     │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│          │                 │                 │                 │            │
│          ▼                 ▼                 ▼                 ▼            │
│   ┌─────────────────────────────────────────────────────────────────┐     │
│   │                     LAUNCHAGENTS (macOS)                         │     │
│   │  com.kaidjuric.digital-twin.ig-watcher.plist                   │     │
│   │  com.kaidjuric.digital-twin.chart-watcher.plist                │     │
│   │  com.kaidjuric.digital-twin.reel-watcher.plist                  │     │
│   │  com.kaidjuric.digital-twin.mj-watcher.plist                    │     │
│   └─────────────────────────────────────────────────────────────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Folder Structure

```
parent/
├── sainted-word-records/                    ← Main project (you "open")
│   ├── agents/
│   │   ├── roles/
│   │   │   ├── ops.md                       # SWR-Ops system prompt
│   │   │   └── check.md                     # SWR-Check system prompt
│   │   ├── team.config.json                  # Wiring configuration
│   │   └── start-team.sh                    # Launcher script
│   ├── tasks/
│   │   ├── TASKS.md                         # Work queue
│   │   ├── lessons.md                        # Self-improvement log
│   │   └── .logs/                           # Agent logs
│   ├── drafts/                               # Generated content
│   ├── .vscode/
│   │   └── tasks.json                        # Auto-start on folder open
│   └── ... (existing repo)
│
└── digital_twin/                            ← SWR-Twin home
    ├── agents/
    │   └── twin.md                          # Twin system prompt
    ├── voice/                                # Training data
    │   ├── samples/                           # Writing samples
    │   ├── decisions.md                       # Decision log
    │   ├── never-list.md                     # Things to avoid
    │   └── brand-pillars.md                  # Brand guidelines
    ├── lib/                                  # Automation scripts
    │   ├── ig-watcher.js                     # Instagram auto-post
    │   ├── ig-poster.js                      # Instagram poster
    │   ├── youtube-batch.js                   # YouTube batch upload
    │   ├── mj-watcher.js                    # Midjourney submitter
    │   ├── mj-submitter.js                   # Midjourney web/API
    │   ├── reel-watcher.js                   # Reel processor
    │   ├── chart-watcher.js                  # MusicXML → PDF/MP3
    │   ├── songs-indexer.js                   # Audio catalog
    │   ├── songs-watcher.js                   # Audio file watcher
    │   ├── musicxml-to-pdf.js                 # PDF renderer
    │   ├── flux2-renderer/                    # Local FLUX.2 rendering
    │   ├── sr-color-animator.js              # Color sequence generator
    │   └── ...
    ├── youtube-inbox/                         # YouTube upload queue
    │   ├── upload-metadata.json               # All video metadata
    │   └── uploaded/                          # Processed videos + thumbs
    ├── prompts-inbox/                         # MJ prompt packs
    ├── reel-inbox/                           # Reel source videos
    ├── audio-inbox/                          # Audio for indexing
    ├── chart-inbox/                          # MusicXML scores
    ├── pages/
    │   ├── cognitive-twin.html               # Twin dashboard
    │   ├── temple-of-control.html            # Visual controller
    │   └── ...
    └── LaunchAgents/                          # macOS auto-starters
```

---

## Automation Tools Reference

### 📱 Instagram Pipeline

| Script | Purpose | Command |
|--------|---------|---------|
| `ig-watcher.js` | Monitors `instagram-inbox/`, auto-posts | `npm run ig:watch` |
| `ig-poster.js` | Posts single image/video to Instagram | `node lib/ig-poster.js --file <path>` |

**Inbox:** `~/Documents/digital_twin/instagram-inbox/`  
**Output:** Posts to Instagram automatically  
**Config:** `lib/ig-config.json`

### 📺 YouTube Pipeline

| Script | Purpose | Command |
|--------|---------|---------|
| `youtube-batch.js` | Batch upload with metadata | `node lib/youtube-batch.js` |
| `youtube-batch.js --repair-thumbnails` | Generate missing thumbnails | `node lib/youtube-batch.js --repair` |
| `youtube-poster.js` | Single video uploader | `node lib/youtube-poster.js --file <mp4>` |

**Inbox:** `~/Downloads/mp4s/swr_vids/`  
**Output:** `youtube-inbox/uploaded/` with thumbnails  
**Metadata:** `youtube-inbox/upload-metadata.json`

### 🎨 Midjourney Pipeline

| Script | Purpose | Command |
|--------|---------|---------|
| `mj-watcher.js` | Monitors `prompts-inbox/`, auto-submits | `npm run mj:watch` |
| `mj-submitter.js` | Submits prompts via web/API | `node lib/mj-submitter.js --prompt "..."` |
| `mj-prompt-generator.js` | Generates prompt packs from lyrics | `node lib/mj-prompt-generator.js --idea "..."` |

**Inbox:** `prompts-inbox/` (markdown prompt packs)  
**Output:** `mj-output/` with task IDs  
**Config:** `lib/mj-config.json`

### 🎬 Reel Production

| Script | Purpose | Command |
|--------|---------|---------|
| `reel-watcher.js` | Monitors `reel-inbox/`, creates 9:16 | `npm run reel:watch` |
| `loopable-video-segmenter/` | Splits video into beat-aligned loops | `npm run lvs:segment --video <file>` |

**Inbox:** `reel-inbox/` (MP4 files)  
**Output:** 1080×1920 vertical videos + cover images  
**Metadata:** `POST.md` with captions + hashtags

### 📄 Chart Processing

| Script | Purpose | Command |
|--------|---------|---------|
| `chart-watcher.js` | Monitors `chart-inbox/`, exports PDF/MP3/MIDI | `npm run chart:watch` |
| `chart-export.js` | Full chart pipeline | `npm run export-all -- <musicxml>` |
| `musicxml-to-pdf.js` | Renders MusicXML to PDF | `npm run musicxml-pdf -- <file>` |

**Inbox:** `chart-inbox/` (MusicXML files)  
**Output:** `Full_Score.pdf`, part PDFs, Demo.mp3, MIDI

### 🎵 Audio Catalog

| Script | Purpose | Command |
|--------|---------|---------|
| `songs-indexer.js` | Indexes audio files | `npm run index-songs` |
| `songs-watcher.js` | Auto-indexes new audio | `npm run songs:watch` |
| `jazz-solos-indexer.js` | Jazz corpus catalog | `npm run index-jazz-solos` |

**Config:** `lib/sources.config.json`

### 🖼️ Image Generation

| Script | Purpose | Command |
|--------|---------|---------|
| `flux2-renderer/` | Local FLUX.2 image generation | `npm run flux2:render --prompt "..."` |
| `clip-interrogator/` | Image-to-prompt | `npm run clip:ui` |
| `sr-color-animator.js` | Color sequence animation | `node lib/sr-color-animator.js` |

---

## Configuration

### `agents/team.config.json`

```json
{
  "team": "Sainted Word Records",
  "root": ".",
  "twin_root": "../digital_twin",
  "agents": {
    "SWR-Ops": {
      "role": "orchestrator",
      "prompt": "agents/roles/ops.md",
      "cwd": ".",
      "writes": ["tasks/TASKS.md", "tasks/lessons.md"],
      "tools": [
        "ig-watcher", "yt-watcher", "mj-watcher", 
        "reel-watcher", "chart-watcher", "songs-watcher"
      ]
    },
    "SWR-Twin": {
      "role": "digital-twin",
      "prompt": "../digital_twin/agents/twin.md",
      "cwd": "../digital_twin",
      "reads": ["voice/", "cognitive-twin.html"],
      "writes": ["../sainted-word-records/drafts/"],
      "tools": [
        "flux2", "clip", "mj-prompt-generator",
        "youtube-batch", "sr-color-animator"
      ]
    },
    "SWR-Check": {
      "role": "verifier",
      "prompt": "agents/roles/check.md",
      "cwd": ".",
      "readonly": true,
      "runs": [
        "npm run test:all",
        "npm run verify",
        "npm run e2e:landing",
        "npm run e2e:twin-os"
      ]
    }
  },
  "gates": {
    "twin_confidence_threshold": 0.85,
    "require_evidence": true,
    "block_on_test_failure": true,
    "require_thumbnail": true,
    "require_metadata": true
  },
  "watchers": {
    "instagram": {
      "inbox": "../digital_twin/instagram-inbox/",
      "script": "../digital_twin/lib/ig-watcher.js",
      "enabled": true
    },
    "youtube": {
      "inbox": "../digital_twin/youtube-inbox/",
      "script": "../digital_twin/lib/youtube-batch.js",
      "enabled": true
    },
    "midjourney": {
      "inbox": "../digital_twin/prompts-inbox/",
      "script": "../digital_twin/lib/mj-watcher.js",
      "enabled": true
    },
    "reel": {
      "inbox": "../digital_twin/reel-inbox/",
      "script": "../digital_twin/lib/reel-watcher.js",
      "enabled": true
    },
    "chart": {
      "inbox": "../digital_twin/chart-inbox/",
      "script": "../digital_twin/lib/chart-watcher.js",
      "enabled": true
    },
    "songs": {
      "inbox": "../digital_twin/audio-inbox/",
      "script": "../digital_twin/lib/songs-watcher.js",
      "enabled": true
    }
  }
}
```

### `agents/start-team.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/agents/team.config.json"
LOG_DIR="$REPO_ROOT/tasks/.logs"
mkdir -p "$LOG_DIR"

echo "▶ Starting Sainted Word Records Auto-Loop Team..."

# Check if watchers are running
check_watcher() {
    pgrep -f "$1" > /dev/null && echo "  ✓ $2 running" || echo "  ✗ $2 NOT running"
}

echo "  Watcher Status:"
check_watcher "ig-watcher" "Instagram"
check_watcher "youtube-batch" "YouTube"  
check_watcher "mj-watcher" "Midjourney"
check_watcher "reel-watcher" "Reel"
check_watcher "chart-watcher" "Chart"
check_watcher "songs-watcher" "Songs"

# Agent 1: SWR-Ops (orchestrator)
( cd "$REPO_ROOT" && \
  claude --prompt agents/roles/ops.md \
         --context "$CONFIG" \
         --name "SWR-Ops" \
  2>&1 | tee "$LOG_DIR/swr-ops-$(date +%Y%m%d).log" ) &

# Agent 2: SWR-Twin (digital twin)
( cd "$REPO_ROOT/../digital_twin" && \
  claude --prompt agents/twin.md \
         --context "$REPO_ROOT/agents/team.config.json" \
         --name "SWR-Twin" \
  2>&1 | tee "$LOG_DIR/swr-twin-$(date +%Y%m%d).log" ) &

# Agent 3: SWR-Check (verifier)
( cd "$REPO_ROOT" && \
  claude --prompt agents/roles/check.md \
         --context "$CONFIG" \
         --name "SWR-Check" \
         --readonly \
  2>&1 | tee "$LOG_DIR/swr-check-$(date +%Y%m%d).log" ) &

echo "✓ Team launched. Logs: $LOG_DIR"
echo ""
echo "Available automation commands (from digital_twin/):"
echo "  npm run ig:watch        # Instagram auto-post"
echo "  node lib/youtube-batch.js  # YouTube batch upload"
echo "  npm run mj:watch       # Midjourney auto-submit"
echo "  npm run reel:watch     # Reel processor"
echo "  npm run chart:watch    # Chart pipeline"
echo "  npm run songs:watch    # Audio catalog"
wait
```

---

## NPM Scripts Reference

Run from `digital_twin/`:

```bash
# Core testing
npm run test:all              # All unit tests
npm run verify               # Landing + Twin OS e2e

# Watchers (auto-processing)
npm run ig:watch             # Instagram watcher
npm run mj:watch             # Midjourney watcher
npm run reel:watch           # Reel processor
npm run chart:watch          # MusicXML processor
npm run songs:watch          # Audio indexer

# Generation
npm run flux2:render -- --prompt "..."   # FLUX.2 images
npm run lvs:ui              # Loopable Video Segmenter UI
npm run lvs:segment -- <video>  # Segment video into loops
npm run clip:ui             # CLIP Interrogator UI

# YouTube
node lib/youtube-batch.js                 # Batch upload
node lib/youtube-batch.js --repair-thumbnails  # Fix thumbs

# Export
npm run export-all -- <musicxml>          # Full chart pipeline
npm run musicxml-pdf -- <file>            # PDF only

# Indexing
npm run index-songs                       # Audio catalog
npm run index-jazz-solos                  # Jazz corpus
```

---

## Handoff Contract

### Task Format (TASKS.md)

```markdown
## 2026-10-09

### [OPEN] Generate 10 MJ prompts for new ambient track
- **Owner**: SWR-Twin
- **Acceptance**: 10 prompts in prompts-inbox/new-ambient.md
- **Evidence**: manifest.json with 10 entries
- **Status**: → IN PROGRESS
```

### Evidence Requirements

| Task Type | Required Evidence |
|-----------|------------------|
| MJ prompts | `prompts-inbox/*.md` + `mj-output/*/manifest.json` |
| YouTube upload | `youtube-inbox/upload-metadata.json` updated |
| Reel | `reel-inbox/processed/*.mp4` + `POST.md` |
| Chart | `chart-inbox/processed/*/Full_Score.pdf` |
| Test | `npm run test:all` passes |

---

## LaunchAgent Status

Current auto-starters (macOS):

```bash
# Check status
launchctl list | grep digital-twin

# Manual restart
launchctl kickstart -k gui/501/com.kaidjuric.digital-twin.ig-watcher
launchctl kickstart -k gui/501/com.kaidjuric.digital-twin.chart-watcher
launchctl kickstart -k gui/501/com.kaidjuric.digital-twin.reel-watcher
launchctl kickstart -k gui/501/com.kaidjuric.digital-twin.mj-watcher
```

---

## Quick Start

```bash
# 1. Create folder structure in sainted-word-records/
mkdir -p agents/roles tasks .vscode drafts

# 2. Copy config files
# (create team.config.json, start-team.sh, tasks.json, ops.md, check.md)

# 3. Ensure digital_twin has agent files
ls digital_twin/agents/
ls digital_twin/voice/

# 4. Make launcher executable
chmod +x agents/start-team.sh

# 5. Open in VS Code — team auto-starts
# OR run manually:
./agents/start-team.sh
```

---

## Integration Points

| SWR-Twin Action | Output Location | Next Step |
|-----------------|-----------------|-----------|
| Generate MJ prompts | `prompts-inbox/` | `mj-watcher` submits |
| Render FLUX.2 images | `assets/flux2/` | Manual selection |
| Create Reel | `reel-inbox/processed/` | Manual upload to IG |
| Process Chart | `chart-inbox/processed/` | YouTube upload |
| Index Audio | `data/songs/catalog.json` | Songs panel updates |
| YouTube batch | `youtube-inbox/uploaded/` | Manual drag-drop |
