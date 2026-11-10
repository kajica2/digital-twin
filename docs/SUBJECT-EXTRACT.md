# Subject extract — cut the object out of a picture

> The twin had **recognition** (CLIP) and no **extraction**. This is the
> extraction half: a saliency matte, an alpha PNG, and — when you name the
> object — a CLIP check that what came out is the thing you asked for.
>
> Written 2026-11-10, when the Felt Bunny release needed its subject as a
> reusable sprite and nothing in the repo could take an object out of a
> frame.

---

## What it does, in order

```
1. EXTRACT     u2net finds the salient subject -> an alpha matte
2. MEASURE     the box, the coverage and the crop, computed from the pixels
3. RECOGNIZE   (only with --prompt) CLIP scores the EXTRACTED SUBJECT
```

The order matters. **The recognition scores the crop, not the picture** —
the crop is tight, so the score is about the thing that was actually cut
out rather than about the whole frame.

## The commands

```bash
# the setup (uv project, ~363 MB of venv; the weights are 176 MB more)
uv sync --project lib/subject

# cut the subject out
npm run subject:extract -- frame.jpg --out bunny.png

# name it, and see whether the cut-out is the thing you named
npm run subject:extract -- frame.jpg --out bunny.png \
    --prompt "a needle-felted wool rabbit toy" \
    --contrast "an empty plain studio backdrop"

# the measurements as JSON
npm run subject:extract -- frame.jpg --out bunny.png --json
```

### The flags

| flag | what it does |
|---|---|
| `--out` | the transparent PNG to write (required) |
| `--prompt` | name the object; CLIP scores the extracted subject against it |
| `--contrast` | a phrase the subject should NOT match (repeatable) |
| `--model` | `u2net` (default), `isnet-general-use`, `silueta` |
| `--pad` | padding around the subject's box, in pixels (default 8) |
| `--no-crop` | keep the original canvas; only the alpha changes |
| `--sidecar` | where to write the measurements (default `<out>.json`) |
| `--composite` | also write a preview composited on this colour (`#rrggbb`) |
| `--json` | print the measurements as JSON |

**An unknown flag is refused with exit 2.** A CLI that quietly ignores what
it does not understand is a CLI that lies about what it did.

## The sidecar

Every run writes the measurements next to the PNG: the source, the engine,
the matte's seconds, the coverage, the subject's box, the crop, and — when
`--prompt` was given — the CLIP ranking. The sidecar is the evidence; the
PNG is the artefact.

```json
{
  "engine": "u2net",
  "matteSeconds": 2.29,
  "coveragePct": 34.27,
  "subjectBox": [187, 71, 689, 1192],
  "crop": [175, 59, 701, 1204],
  "clip": {
    "model": "ViT-H-14",
    "scores": [0.2907, 0.0586],
    "best": "a needle-felted wool rabbit toy",
    "runnerUp": "an empty plain studio backdrop",
    "margin": 0.2321
  }
}
```

## The two things that are MEASURED, not assumed

**The foreground threshold.** A pixel is foreground at alpha **128**. Not 0
(which makes the box the whole canvas, because the matte's transparent
background is still a pixel) and not 255 (which drops the anti-aliased rim
and shrinks the cut). 128 is the middle of rembg's feather.

**The CLIP margin is against the RUNNER-UP.** The first version compared the
winner against the prompt — which is the winner, whenever the prompt wins —
and reported a margin of **0.0** every single time. A margin that is
always zero is not a measurement.

## CLIP RANKS; IT DOES NOT MEASURE

This is the repo's own rule (`docs/STORY-DIRECTOR.md`) and it is why the
report is a **ranking and a margin**, never a verdict. The tool says:

```
the best match is 'a needle-felted wool rabbit toy', 0.2321 ahead of
'an empty plain studio backdrop' — a ranking, not a verdict
```

It does not say "this is a rabbit". A cosine similarity of 0.29 is not a
probability, and a threshold on it would be a made-up number.

The score is computed by `lib/story/clip_score.py`, over the JSON seam into
the **clip-interrogator venv** — the only environment on this machine with
torch + open_clip and the ViT-H weights already cached. The subject
extractor's own venv does not duplicate 2 GB of torch to do the same job.

## The weights live with the tool

`U2NET_HOME` points at `lib/subject/`, so the 176 MB `u2net.onnx` lands in
`lib/subject/models/u2net/` — inside the project, gitignored — instead of
appearing in the user's home directory by surprise.

**The path convention is rembg's, not ours:** the model path is
`<U2NET_HOME>/models/<name>/<file>`. The first version pointed
`U2NET_HOME` at `lib/subject/models/`, and rembg dutifully created
`lib/subject/models/models/u2net/u2net.onnx` and **downloaded the whole
176 MB again** — the network here is slow enough that this cost eight
minutes and a half.

## The decision layer is Pillow-only

`subject_bbox` and `coverage` use PIL's own `getbbox()` and `histogram()`
rather than numpy. Two reasons: the tests then need nothing but Pillow
(and no 300 MB venv), and the measurement runs at C speed instead of in a
Python loop.

## The tests

```bash
npm run test:subject
```

**26 checks, no model, no network, no weights.** The box, the threshold,
the crop, the sidecar, the colour parser, the ranking, and the flag table
(an unknown flag is refused, a missing file is refused, a negative pad is
refused).

## What it does NOT do

- **It is not promptable.** u2net is a *saliency* segmenter: it answers
  "what stands out", not "what did you name". The prompt is a **check**,
  not an instruction. A picture with two salient objects gives you the
  more salient one, and the CLIP check is how you find out.
- **It has no inpainting.** The removed background is transparent, not
  filled.
- **The edge is a feather, not a hairline.** rembg's matte is soft; a hard
  threshold on the PNG's alpha will show it.

## Where it is used

`assets/releases/felt-bunny/subject/` — the bunny cut out of both release
frames, with the preview and the sidecar. The measurements are recorded in
the release manifest under `subject`.

Measured on the two frames:

| frame | box | coverage | CLIP margin |
|---|---|---|---|
| 01 ALONE | `[187, 71, 689, 1192]` | 34.27% | 0.2321 over the backdrop |
| 02 THE BOAT | `[204, 101, 680, 1220]` | 32.05% | 0.2832 over the backdrop |
