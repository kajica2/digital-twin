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
| `--prompt` | *(required)* | the text prompt |
| `--out` | `assets/flux2/out.png` | output PNG path |
| `--width` / `--height` | `832` / `468` | output size (16:9 by default) |
| `--guidance` | `3.5` | accepted but **ignored** by klein-4B (distilled) |
| `--steps` | `20` | inference steps |
| `--seed` | `0` | CPU generator seed — reproducible renders |
| `--model` | `assets/flux2/FLUX.2-klein-4B` | model dir (`FLUX2_MODEL_PATH` env overrides) |
| `--json` | off | emit a single JSON result line |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | rendered and wrote the PNG |
| `2` | usage error, or model dir not found |
| `1` | runtime error |

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

### Device selection

`pick_device()` auto-selects `mps` when `torch.backends.mps.is_available()`
(the M4 Pro/Metal path), else `cpu`. The pipeline uses **fp16** inference
dtype on Metal (bf16 is under-tested on MPS) and enables **attention slicing**
to stay comfortably under the 24 GB unified-memory ceiling.

---

## Reference
- Script: `lib/flux2-renderer/render.py`
- Deps: `lib/flux2-renderer/requirements.txt`
- npm: `flux2:setup`, `render:flux2`

## Follow-ups (flagged, not done)
- No unit test yet. `render.py` lazy-imports `torch`/`diffusers` inside
  `main()` so the CLI glue is thin; a meaningful synthetic test would require
  sys.modules mocking of a 3.9 GB pipeline — low value for a personal tool.
  Revisit only if the renderer grows real branching logic.
- No `docs` mention on how-to as a numbered section (the how-to page has a
  strict 9-section e2e contract). A Requirements bullet was the non-breaking
  way to surface it.