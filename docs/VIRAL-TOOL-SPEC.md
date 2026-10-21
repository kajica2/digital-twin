# Feature Spec: Viral Optimization Suite

## Overview

Add a **Viral Optimization Suite** to SWR — a standalone tool page that analyzes exported videos, researches trending patterns, and generates optimized tags, descriptions, and titles for maximum social media reach.

## User Flow

1. User exports an MP4 from the engine
2. User opens `/viral-tool.html` 
3. Drops the MP4 (or selects from recent exports)
4. Tool analyzes: audio genre/mood, visual themes, text on screen
5. Tool researches: fetches trending hashtags, analyzes competitor captions
6. Tool outputs: optimized title, description, 5-10 hashtags, posting time suggestions
7. User copies to clipboard → posts to IG/Reels/TikTok/YouTube Shorts

## Architecture

```
viral-tool.html (standalone page)
    ├── audio-analysis.js      (Web Audio API — genre, BPM, mood)
    ├── video-analysis.js      (Canvas frame sampling — colors, text OCR)
    ├── trend-researcher.js    (Mock trend API / hashtag aggregator)
    ├── copy-generator.js      (Prompt FLUX.2 or use templates)
    └── clipboard-utils.js    (Copy to clipboard with formatting)
```

## Research Strategy

### 1. Trend Analysis (Mock for v1)
- Pre-built hashtag sets per genre (electronic, hip-hop, jazz, classical)
- Time-of-day posting effectiveness by genre
- Caption length patterns (shorter for Reels, longer for YouTube)

### 2. Content Analysis
- **Audio**: genre classification, BPM detection, mood (happy/energetic/calm/sad)
- **Visual**: dominant colors, motion intensity, text detection
- **Metadata**: filename heuristics for title suggestions

### 3. Generation Templates
```
Title: "{genre} {mood} visualizer" / "{BPM} BPM {genre} vibes"
Description: "Created with @saintedwordrecords engine. {genre} visualizer."
Hashtags: #{genre} #{mood} #visualizer #musicvideo #newmusic #{artist-style}
```

## UI Design

Single-page app in the SWR house style (Fraunces + Geist, dark theme).

### Sections
1. **Drop Zone** — Drag MP4 or click to browse
2. **Analysis Panel** — Shows detected: genre, BPM, mood, colors, duration
3. **Research Panel** — Trending hashtags, best posting times
4. **Generated Panel** — Title, description, hashtags with "Copy" buttons
5. **History** — Last 10 analyzed videos (localStorage)

## Data Flow

```
MP4 → Web Audio (genre/mood) + Canvas (visual) → 
  → Trend API (hashtags) → 
    → Template Engine (title/desc/hashtags) →
      → User copies → posts
```

## Files to Create

| File | Purpose |
|------|---------|
| `pages/viral-tool.html` | Main tool page |
| `lib/viral/audio-analysis.js` | Genre/mood/BPM from audio |
| `lib/viral/video-analysis.js` | Frame sampling, color extraction |
| `lib/viral/trend-researcher.js` | Hashtag + timing data |
| `lib/viral/copy-generator.js` | Prompt building + templates |
| `lib/viral/clipboard-utils.js` | Copy with formatting |

## Integration Points

- **From engine**: Export includes "Optimize for social" button → opens `/viral-tool.html?video=<filepath>`
- **Marketplace**: Template cards show "Viral score" badge
- **Recent exports**: Stored in localStorage, reuseable in viral tool

## v1 Scope

- MP4 analysis only (no batch)
- Mock trend data (real API needs Instagram Graph API access)
- Copy-paste workflow (no direct posting)
- LocalStorage for history (no cloud sync)

## Success Metrics

- Time to generate optimized copy < 5 seconds
- 3/4 generated hashtags match user's genre
- "Copy" button clicked > 1x per session
