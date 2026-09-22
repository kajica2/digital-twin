# CLIP Interrogator (port)

Local CLIP Interrogator for the digital-twin — turn an image into a
prompt, or into artist / medium / movement / trending / flavor ranks.

```bash
uv sync --project lib/clip-interrogator            # or: npm run clip:setup
npm run clip:ui                                    # gradio app on http://127.0.0.1:7860
npm run clip:interrogate                           # real run against assets/clip-interrogator/example01.jpg
npm run clip:check                                 # self-check (no model download)
```

Full docs: [`docs/CLIP-INTERROGATOR.md`](../../docs/CLIP-INTERROGATOR.md).
Upstream: [`pharma/CLIP-Interrogator`](https://huggingface.co/spaces/pharma/CLIP-Interrogator)
by pharmapsychotic.