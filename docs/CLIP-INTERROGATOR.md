# CLIP Interrogator (local port)

A local port of [pharma/CLIP-Interrogator](https://huggingface.co/spaces/pharma/CLIP-Interrogator)
by pharmapsychotic, packaged for the digital-twin under `lib/clip-interrogator/`.

Turn any image into a prompt, or rank it against five CLIP vocabularies
(medium / artist / movement / trending / flavor). Local-first: models download
once into the Hugging Face cache (`~/.cache/huggingface`), everything runs in
an uv-managed venv with CPython 3.12.

## Install

```bash
uv sync --project lib/clip-interrogator    # or: npm run clip:setup
```

Creates `lib/clip-interrogator/.venv/` (gitignored) and commits `uv.lock`.
Requires uv (`~/.local/bin/uv`). Note: the first `uv sync` can hit a stale
uv cache for the editable self-install — if `clip-interrogate` reports
`No module named 'clip_interrogator_app'`, re-run with
`uv sync --project lib/clip-interrogator --reinstall --no-cache`.

## Self-check (no weights)

```bash
npm run clip:check
# uv run --project lib/clip-interrogator clip-interrogate check --self-check
```

Imports, reports device (cuda / mps / cpu), prints the model registry.
Downloads nothing. Exit `0` = ok, `3` = import/model failure.

## CLI

```bash
# image → prompt (defaults: example01.jpg, vit-l, best)
uv run --project lib/clip-interrogator clip-interrogate interrogate assets/clip-interrogator/example01.jpg --mode best
uv run --project lib/clip-interrogator clip-interrogate interrogate <image> --model vit-h --mode negative --json

# image → top-5 ranks per vocabulary
uv run --project lib/clip-interrogator clip-interrogate analyze <image> --model vit-l --top 5 --json
```

Exit codes: `0` ok · `2` bad input (missing file, unknown model/mode,
unreadable image) · `3` model error (load or inference failure). The CLI
loads **only** the requested model (no shared-BLIP chain).

## UI (gradio)

```bash
npm run clip:ui
# uv run --project lib/clip-interrogator python -m clip_interrogator_app.ui
```

Serves on `http://127.0.0.1:7860` (`server_name="127.0.0.1"`,
`show_api=False`). Two tabs:

- **Prompt** — image + model (ViT-L / ViT-H) + mode (best / fast / classic /
  negative). Button `api_name="image-to-prompt"`.
- **Analyze** — image + model → five `gr.Label(label=...)` outputs
  (medium, artist, movement, trending, flavor). Button
  `api_name="image-analysis"`.

The UI path defaults to ViT-L (constructed on first use, not preloaded);
BLIP is shared into ViT-H via the `Config.caption_model` /
`Config.caption_processor` attrs that clip_interrogator 0.6.0 actually
reads (the often-cited `cfg.blip_model` attribute does NOT exist in the
0.6.0 wheel — verified by grepping the installed source). Nothing
constructs models at import time.

## Port-time pins (both deliberate)

- **`device="cpu"`** — clip_interrogator 0.6.0's `Config.device` auto-detects
  MPS, but its `LabelTable` only casts cached fp16 vocab embeddings to fp32 on
  *cpu*. On MPS every rank/similarity op crashes with "expected mat1 and mat2
  to have the same dtype ... float != Half". Pinning `device="cpu"` keeps the
  whole pipeline fp32 and deterministic (verified failure → fix).
- **`cache_path=~/.cache/clip-interrogator`** — upstream `Config()` defaults
  to the *relative* path `"cache"`, which drops ~164M of vocab safetensors
  into the CWD when the CLI runs from the repo root. Pinning it to a
  user-level cache dir keeps the working tree clean; `clip:check` downloads
  nothing either way.

## Gradio modernization notes (vs upstream app.py)

- Plain `gr.Label(label=...)` outputs — gradio 5.x removed both
  `num_top_classes` (upstream) and `num_classes`; a plain `gr.Label` renders
  the `{label: score}` dict with score-ordered bars.
- `api_name` lives on the `.click()` events, not the Button constructors
  (`gr.Button(api_name=...)` is not a gradio 5.x API — reproduced TypeError).
- Model dropdown lookups use `.get()` + `raise gr.Error(...)` for unknown
  display names (the raw `DISPLAY_TO_ID[...]` could KeyError via the API).
- `gr.Examples` without `run_on_click` / `cache_examples` (both removed) and
  without the `ex.dataset.headers = [""]` line. Examples fill inputs only.
- Share-to-community button, HF "duplicate space" badge and Colab boilerplate
  dropped.
- `analyze_tab()` bug fixed: all components are built inside one
  `build_gradio_app()` Blocks context and every handler receives its
  components as explicit parameters — no globals defined after use.

## npm scripts

| Script | Command |
| --- | --- |
| `clip:setup` | `uv sync --project lib/clip-interrogator` |
| `clip:ui` | `uv run --project lib/clip-interrogator python -m clip_interrogator_app.ui` |
| `clip:interrogate` | `uv run --project lib/clip-interrogator clip-interrogate interrogate assets/clip-interrogator/example01.jpg --mode best` |
| `clip:check` | `uv run --project lib/clip-interrogator clip-interrogate check --self-check` |
| `e2e:clip` | `cd e2e && CHROME_PATH="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" PORT=5180 node clip-interrogator.spec.mjs` |

## Static page + e2e

`pages/clip-interrogator.html` documents the tool (kai-systems house style,
paired light/dark, `<theme-toggle>` persisted under `ci-theme`). The sample
strip (`[data-sample-output]`) carries a real CLI run against
`example01.jpg` — never fabricated.

`e2e/clip-interrogator.spec.mjs` asserts the page contract (hero, theme
toggle persistence, mode/model tables, example images load, attribution,
sample-output presence) and the twin-os `data-tool-clip` link. It runs
**without** Python deps:

```bash
python3 -m http.server 5180 --directory pages &
npm run e2e:clip
```

URL convention: deployed → `${BASE}/pages/clip-interrogator.html`, local
(`--directory pages`) → `${BASE}/clip-interrogator.html`.

## Attribution

- Upstream: [pharma/CLIP-Interrogator](https://huggingface.co/spaces/pharma/CLIP-Interrogator)
  by [pharmapsychotic](https://twitter.com/pharmapsychotic).
- Example images: Pixabay — ["Layers"](https://pixabay.com/illustrations/watercolour-painting-art-effect-4799014/)
  and ["Lin Tong"](https://pixabay.com/illustrations/animal-painting-cat-feline-pet-7154059/).
- MIT, matching the kai-systems series.