# Automation & Automix — Full Scope

> One document covering the two automation systems on this machine:
> **Part 1 — the automix FX engine** (audio-reactive mixing inside the SWR
> engine, `sainted-word-records/`) and **Part 2 — the automation/media
> pipeline** (content production → licensing → selling, spanning
> `sainted-word-records/` and the sibling `digital_twin/` repo).
>
> Status: live as of 2026-10-01. Both systems are working; the MJ web
> submission path has one known failure (Part 2, §7).

---

# Part 1 — Automix FX Engine

## 1. What it is

Automix is the audio-reactive FX mixer inside the SWR engine. It reads real
audio features every few hundred milliseconds and blends between a map of
curated FX "anchors", writing the result into `window.SWR._fxOverride` which
the GLSL FX pipeline renders **in the same frame**. The result: the visuals
follow the music — loud choruses push toward high-energy FX, quiet intros
pull back — with no user touching sliders.

## 2. Pipeline (canonical data flow)

```
Audio.feat (bass / mid / treb / beat [+ rms, centroid, onset, bpm, key])
  → SWR_ANCHOR_EMBED.featuresToCoords       → (warmth, intensity) 2D coord
  → SWR_ANCHOR_MAP.neighbours(coords, N)    → N nearest anchor presets
  → blendAnchors()                          → weighted-average fx_state (14 fields)
  → drift(beat-scaled)                      → ±0.005..0.015 random walk per beat
  → window.SWR._fxOverride                  → FX.setPersona() reads it
  → GLSL render consumes FX.state each frame
```

## 3. Components (all in `client/`)

| File | Global | Job |
|---|---|---|
| `client/automix.client.js` | `window.SWR_AUTOMIX` | v1 core: features→coords→neighbours→blend→drift→override, 2000ms tick, toggle |
| `client/automix-runtime.client.js` | `window.SWR_AUTOMIX_RUNTIME` | v2 wiring: `{ automix, version, ui: { wire, unwire } }`; auto-wires when loaded, manual `ui.wire()` for custom builds |
| `client/automix-arc.client.js` | `window.SWR_AUTOMIX_ARC` | Arc displacement engine: picks anchor candidates **≥ ARC_MIN_DISPLACEMENT (0.25)** from the previous act so consecutive visuals never snap to near-identical FX |
| `client/automix-composition.client.js` | — | Templates for building automix presets (the "composition" of anchors + arcs) |
| `client/automix-session-store.client.js` | — | Persists `swr.automix.lastMix.v1` (debounced 1s); restores the last blend on reload |
| `client/preset-anchor-map.client.js` | `window.SWR_ANCHOR_MAP` | The anchor catalog: curated fx_state presets positioned in (warmth, intensity) space |
| `lib/media-feat.client.js` | `SWR_MEDIA_FEAT` | Canonical 12-field audio feature extraction from any media element; feeds automix on tape + the real rendered experience |

## 4. The FX surface it drives

- `FX.setPersona()` consumes exactly **14 fields**: `temp, mut, mutAlgo, posterize,
  vignette, chroma, grain, sepia, glow, grayscale, blur, liquid, pearl, glitch`.
- Preset `fx_state` blocks carry **15 keys** — those 14 plus compositor-only
  `bloom`, which the shader path deliberately drops.
- `swr.fx.intensity` (0–1) is the master multiplier (`lib/intensity-slider.client.js`);
  it is render-time only, never written into state.

## 5. Wiring & surfaces

- **17** per-variant automix configs (`variants/*.automix.json`), inlined into
  the matching `versions/<name>.html` at build time by `inline-automix-config`.
- **16 enabled; `echo-manifold` is the sole `enabled: false`** — it has no FX
  surface (its visuals are its own generative canvas; nothing to drive).
- **24** pages load automix runtime code; toggle = `#automix-toggle` button or
  the **A** key. Persistence: `localStorage.swr.automix.enabled` +
  `swr.automix.lastMix.v1`.
- The arc system was added for "act" coherence: `verify:automix-arc-displacement`
  and `check:automix-arc-{unit,smoke}` gate it.

## 6. Gates

| Gate | What it proves |
|---|---|
| `check:automix-unit` | features→coords, neighbours, blend math |
| `check:automix-arc-unit` | arc picks, displacement ≥ 0.25, act transitions |
| `check:automix-session-unit` | last-mix persistence round-trip |
| `check:automix-smoke` | real browser, 16 variants, 90 assertions (retried once in CI) |
| `check:automix-arc-smoke` | arc live across variants |
| `verify:automix` | on-demand e2e blend evolution over 5s |
| `verify:automix-cross-surface` | automix consistency across surfaces |
| `verify:automix-arc-displacement` | consecutive acts never snap within 0.25 |

All wired into `npm run check:full` (automix-arc-smoke has no retry — one flake
surfaced 2026-09-30 as "execution context destroyed", deterministically green
on re-run).

---

# Part 2 — Automation / Media Pipeline

> Spans two repos: the media-pack producer + server ledger live in
> `sainted-word-records/`; the image/video generation (FLUX.2 + Midjourney)
> lives in the sibling `digital_twin/` repo at `~/Documents/digital_twin`.

## 1. What it is

The end-to-end flow that turns raw video clips + a song into a sellable
**pack**: render/normalize clips → auto-start `.swr-set` documents → zips →
marketplace import that automaps media into a user's library → a server-side
slot ledger + upgrade codes that monetize registration.

```
clips (mp4/webm) + song (wav/mp3)
  → generate-media-pack.mjs   → per-pack: swr-set + cover + anim + preview +
                                license + NFT metadata, all zipped
  → marketplace .zip drop     → unzip → install sets → Library.addFiles automap
  → PT panel / slots ledger   → register videos (10/30/50) against paid slots
  → upgrade codes (batch CLI) → swr-XXXXX-XXXXX-XXXXX per email
  → NFT-ready metadata        → cover-anim (HyperFrames), authors, licence, price tiers
```

## 2. Media-pack generator — `scripts/generate-media-pack.mjs` (SWR repo)

Per chosen pack (id from `packs/manifest.json` **or** a user `--clips-dir` of
webm/mp4 shots):

| Artifact | How |
|---|---|
| `<pack>.mp4` | audio-reactive render (`scripts/render-full-song.mjs`, Puppeteer + ffmpeg) — skipped with `--skip-render` / clips mode |
| `<pack>.swr-set.json` | schema v2, audio + video layers embedded as dataUrls (auto-start) |
| `cover.webp` | **`--cover-backend frame`** (default: first video frame) or **`--cover-backend flux2`** (fresh diffusion cover, Part 2 §5) |
| `cover-anim.html` | 10s HyperFrames cover animation (zero-dep RAF timeline, deterministic) with pack params baked |
| `preview.mp3` | 15s audio preview (`ffmpeg -t 15`) |
| `LICENSE.txt` | repo MIT + media line |
| `nft-metadata.json` | ERC-721/1155-style: image, animation_url, authors, licence, price tier |
| `media-pack-<id>.zip` | all of the above, flat |

Clips mode: `--clips-dir` + `--webm-only` skips the render entirely —
**`--clip-max` (default 15)** auto-crops longer clips to ≤15s (VP9+Opus,
audio intact); shorter clips pass through untouched.

## 3. Zip import + automap to user library

- `lib/zip-reader.client.js` — zero-dep browser ZIP reader (`window.ZIP_READER`),
  central-directory parse, stored+deflate, **rejects `../` traversal**, CRC-verified.
- `swr-sets.js` — `importSetWithMedia(jsonString, mediaByName)` hydrates a set's
  audio/layer assets from zip sidecar Files (falls back to dataUrl decode).
- `marketplace.html` — accepts `.zip`; drop → unzip → find `*.swr-set.json` →
  import + `saveInstalled` → **`Library.addFiles` automap** → toast
  "Installed <name> (N media files added to your library)".

## 4. Server-side slot ledger + upgrade codes (SWR repo)

- **`api/slots/grant.js`** (admin) — grant 10/30/50 slots to an email; ledger rows in
  `slots/grants/<userId>/…`, state in `slots/state/<userId>.json`, `paid:false`
  with a documented flip when Stripe lands.
- **`api/slots/[userId].js`** — GET state+grants; **PUT register** enforces the
  quota **server-side under `withLock`** (trial mode until Stripe).
- **`api/slots/index.js`** — `GET /api/slots` PT-panel sync payload
  (`{ email, totalSlots, granted, registered, remaining, grants }`).
- **`slots-admin.html` / `slots-admin.client.js`** — operator grant UI (unlisted
  `/slots-admin`).
- **`scripts/grant-invite.mjs batch`** — one `XXXXX-XXXXX-XXXXX` upgrade code per
  email from a comma/newline list; `--dry-run`; idempotent re-runs (reuses the
  email→code index in `api/_lib/kv.js`).
- **PT video registration** — `pt.client.js` tier slots (solo 10 / band 30 /
  label 50), `registerVideos()` batches 10/30/50; `pt-panel.client.js` register
  buttons + best-effort server sync (silent local fallback).

## 5. Local FLUX.2 renderer (digital_twin repo)

- `lib/flux2-renderer/render.py` — `Flux2KleinPipeline` (black-forest-labs
  `FLUX.2-klein-4B`, bf16) on Apple **MPS**; fp16 inference, attention slicing,
  `--seed/--guidance/--steps/--width/--height/--json`; 16:9-safe defaults.
- `lib/flux2-renderer/requirements.txt` + `flux2:setup` / `render:flux2` npm scripts.
- Model: ~3.9GB weights → ~22GB on disk (bf16 + fp16 conversion copies);
  gitignored. **The `-fp8` FLUX.2 variants do NOT run on MPS** (no fp8 dtype on
  Metal) — klein-4B bf16 is the correct model for this machine.
- Used by the SWR generator via `--cover-backend flux2` (`FLUX2_RENDERER` /
  `FLUX2_PYTHON` env, defaults point at the sibling digital_twin install).

## 6. Midjourney submission stack (digital_twin repo)

| File | Role |
|---|---|
| `lib/mj-web.js` | **web backend** (default `engine: "web"`): drives midjourney.com/imagine with a **headed** Chrome (Cloudflare blocks headless), cookie jar from `~/.midjourney-cookies.txt` |
| `lib/mj-submitter.js` | legacy Discord backend (needs logged-in Discord session); configurable via `mj-config.json` |
| `lib/mj-watcher.js` | polls `prompts-inbox/*.md`, submits each bullet prompt, moves to `processed/` |
| `lib/mj-prompt-generator.js` | composes prompts (pure-text bullets; `--ar 16:9`, `--s 70` defaults per the artist's dust-pass rule) |
| `lib/mj-cookies.js` | cookie jar export/parse; `__Host-` cookies must not carry a Domain |
| `bin/mj-watcher.sh` | LaunchAgent wrapper (absolute paths, multi-candidate node) |

### ⚠️ Known failure (2026-10-01)
A real 7-prompt batch through `mj-web.js` ended **`DONE. 0/7 submitted`** —
every prompt hit "no task card carrying this prompt appeared within 75s (after
reconciliation + 1 retry)". The session authenticated and opened the composer,
but no task cards ever landed. The seen-task exclusion regression test
(`lib/mj-web.test.js`) passes 27/27, so this is a *live-site acceptance* issue,
not the matcher. **Root cause not yet fixed** — the likely suspects are the
composer not delivering the text, or the feed not exposing the new task to the
scraped DOM within the window.

## 7. Gates (both repos)

| Repo | Gate | Status |
|---|---|---|
| SWR | `check:webm-clips-unit` | green (parse/validate/normalize, mocked exec) |
| SWR | `check:zip-reader-unit` | green (16 checks: stored/deflate/traversal/CRC) |
| SWR | `check:grant-invite-batch-unit` | green (7 checks) |
| SWR | `check:pt-unit` | green (8 checks) |
| SWR | `check:slots-unit` + `check:slots-api-smoke` | green (15 + 19) |
| SWR | `verify:engine-boot` | green 8/8 (transport row) |
| twin | `test:mj`, `test:mj-cookies`, `test:mj-web`, `test:mj-submitter`, `test:mj-prompt-generator`, `test:ai-all` | green (agent-loop 37/37) |
| twin | `e2e:landing`, `e2e:twin-os` | green (PWA shell contract) |

## 8. Known open items

1. **MJ web acceptance** — 0/7 batch failure (Part 2 §6). Highest-value fix.
2. **Stripe flip** — slots grants carry `paid:false` + `trial:true`; the
   registration gate must require paid grants once payments are wired. Marked
   with `TOGGLE` comments in `api/_lib/slots.js`.
3. **FLUX.2 daemon** — the generator spawns a fresh renderer process per pack
   (model reload ~90s each). A long-lived denoising daemon
   (`--flux2-daemon`) would cut batch cover time; the sibling twin just landed
   a single-load batch renderer (`bdb02e2`) that this could reuse.
4. **Perf** — renders on MPS take ~1.5–5 min per 832×468 cover; the 32B
   FLUX.2-dev is out of reach on 24GB (klien-4B is the ceiling here).
5. **`output.md` / `free-output/`** — ad-hoc agent experiment artifacts;
   gitignored, left on disk.