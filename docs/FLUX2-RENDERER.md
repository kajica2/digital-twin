# FLUX2 Renderer — local text-to-image for the twin

Renders a prompt to PNG with **FLUX.2 klein-4B** entirely on this machine,
on Apple Silicon's Metal backend (MPS) — **no CUDA, no cloud, no API key**.
It is the local text-to-image backend that sits beside the Midjourney watcher
(which still owns the Discord/web route for shared prompts).

> This is a local-first renderer. A render never leaves the machine; the model
> weights are downloaded once and live under `assets/flux2/FLUX.2-klein-4B`
> (gitignored).

---

## Why klein-4B (MPS), not the others

- **`-fp8` variants are not MPS-compatible.** Metal has no fp8 dtype, so the
  compressed quantizations fail to even load on a Mac. **bf16 klein-4B is the
  pick** for this machine.
- **klein-4B is step-wise distilled**, so the pipeline ignores
  `guidance_scale` (the flag is accepted and forwarded, but has no effect —
  expected).
- Pipeline class is **`diffusers.Flux2KleinPipeline`** (NOT the FLUX.1
  `FluxPipeline`). This repo uses a single Qwen3 text encoder — there is no
  `tokenizer_2` / second encoder, so don't pattern-match against FLUX.1
  examples.

Verified locally on the M4 Pro: a 512×288 test and an 832×468 16:9 platform
render both produced valid PNGs.

---

## Setup

```bash
npm run flux2:setup
```

This creates `lib/flux2-renderer/.venv` (CPython 3.12) and installs the
deps from `lib/flux2-renderer/requirements.txt`.

One manual step remains — **torch comes from the CPU/MPS wheel index**, not
PyPI, because there is intentionally no CUDA on this Mac:

```bash
uv pip install --python lib/flux2-renderer/.venv/bin/python \
  torch torchvision \
  --index-url https://download.pytorch.org/whl/cpu
```

The model download (~3.9 GB safetensors, bf16) happens transparently on the
first run if `assets/flux2/FLUX.2-klein-4B` is empty. Full bf16 repo is
~22 GB and is gitignored.

---

## Render

```bash
npm run render:flux2 -- --prompt "your prompt here"
```

`render:flux2` sets `PYTORCH_ENABLE_MPS_FALLBACK=1` (some ops fall back to
CPU on Metal) and invokes the renderer. The default output is
`assets/flux2/out.png`.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--prompt` | — | the text prompt (single render) |
| `--prompt-file` | — | prompt pack, one top-level bullet per prompt (**batch**) |
| `--out` | `assets/flux2/out.png` | output PNG path (single render) |
| `--outdir` | `assets/flux2/out` | output directory (batch) |
| `--width` / `--height` | `832` / `468` | default output size; a bullet's `--ar` overrides the shape |
| `--guidance` | `3.5` | accepted but **ignored** by klein-4B (distilled) |
| `--steps` | `20` | inference steps |
| `--seed` | `0` | base seed — batch renders use `seed + index` |
| `--model` | `assets/flux2/FLUX.2-klein-4B` | model dir (`FLUX2_MODEL_PATH` env overrides) |
| `--json` | off | emit a single JSON result line |

Pass **exactly one** of `--prompt` or `--prompt-file`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | rendered and wrote the PNG(s) |
| `2` | usage error, unreadable/empty prompt file, or model dir not found |
| `1` | runtime error |

Usage and prompt-file errors are detected **before** the model loads, so a
bad call returns in ~30 ms rather than after a 22 GB load.

### JSON output

```json
{
  "ok": true,
  "model": "FLUX.2-klein-4B",
  "device": "mps",
  "out": "/abs/path/assets/flux2/out.png",
  "width": 832, "height": 468,
  "guidance": 3.5, "steps": 20, "seed": 0,
  "loadSeconds": 12.3,
  "totalSeconds": 18.9
}
```

Use `--json` when scripting or chaining into the MJ prompt packs — the model
loading banner stays on stderr so the payload parses clean.

---

## Batch mode

The point of batch mode is that the **model loads once** and renders N
prompts. Calling `--prompt` in a loop would pay the ~12 s model load every
single time.

```bash
npm run render:flux2 -- \
  --prompt-file assets/mural-prompts/two-am-infrastructure-30.md \
  --outdir assets/flux2/two-am-infrastructure-30
```

Input is the repo's existing prompt-pack convention (see
`assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md`) — the same files the MJ
watcher consumes. One top-level bullet per prompt; frontmatter, blockquotes
and code fences are ignored.

- A trailing `--ar WxH` on a bullet is stripped from the prompt text and
  used to shape the output. It is scaled to the **default area** (832×468),
  so a 1:1 bullet does not accidentally render at 832×832 — twice the
  pixels. Bullets without `--ar` fall back to the default 16:9.
- Output names are `NN-<slug>.png`, index-first so the pack order survives
  sorting. `slugify()` falls back to `frame` rather than emit an empty
  filename.
- Seeds are `--seed + index`, so a batch is reproducible and two prompts
  never share a seed.
- A `manifest.json` is written beside the images mapping every filename
  back to its prompt, size, seed and aspect. This is the machine-checkable
  evidence trail, matching the MJ pipeline's `meta.json` convention.

Batch `--json` emits `{ok, model, device, steps, guidance, loadSeconds,
renderSeconds, totalSeconds, count, manifest, images: [...]}`. A single
render keeps the original flat shape so existing callers are unaffected.

### Prompt parsing is a pure module

`lib/flux2-renderer/prompts.py` holds `extract_prompts`, `parse_aspect`,
`format_for_render` and `slugify` — **no torch, no diffusers**. It is unit
tested by `lib/flux2-renderer/test_prompts.py` (stdlib only):

```bash
npm run test:flux2
```

That separation is deliberate: the parsing rules change far more often than
the model does, and testing them must not require a 22 GB pipeline.

### Sizing note (corrected)

An earlier draft of `format_for_render` snapped dimensions to multiples of
16, claiming diffusers' latent math requires it. **That was wrong and the
shipped default disproves it** — the proven-working 832×468 is not a
multiple of 16 (nor of 8). Dimensions are snapped to **even** pixels, which
is the constraint the evidence actually supports.

### Device selection

`pick_device()` auto-selects `mps` when `torch.backends.mps.is_available()`
(the M4 Pro/Metal path), else `cpu`. The pipeline uses **fp16** inference
dtype on Metal (bf16 is under-tested on MPS) and enables **attention slicing**
to stay comfortably under the 24 GB unified-memory ceiling.

---

## Reference
- Script: `lib/flux2-renderer/render.py`
- Prompt parsing (pure, tested): `lib/flux2-renderer/prompts.py`
- Tests: `lib/flux2-renderer/test_prompts.py`
- Deps: `lib/flux2-renderer/requirements.txt`
- npm: `flux2:setup`, `render:flux2`, `test:flux2`

## Follow-ups (flagged, not done)
- ~~No unit test yet.~~ **Done** — `prompts.py` is a pure module and
  `test_prompts.py` covers it (39 checks, stdlib only, no model). The
  original reasoning was that the CLI glue was too thin to test; adding
  batch mode introduced real branching (pack parsing, aspect shaping,
  filename slugging), which is exactly the condition the note said should
  trigger a revisit.
- No `docs` mention on how-to as a numbered section (the how-to page has a
  strict 9-section e2e contract). A Requirements bullet was the non-breaking
  way to surface it.
- Batch renders are serial and single-image. A `--images-per-prompt` flag
  for 4-up variants would match the MJ mental model; not needed yet.