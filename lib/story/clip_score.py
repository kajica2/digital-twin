#!/usr/bin/env python3
"""lib/story/clip_score.py — a similarity matrix between images and lines.

Runs inside the clip-interrogator venv (the only one on this machine with
torch + open_clip and the ViT-H weights already cached). The director talks
to it over stdin/stdout as JSON so the director itself stays stdlib-only.

    echo '{"images": ["a.jpg"], "lines": ["a doorway"]}' | python clip_score.py

-> {"matrix": [[0.24]], "embeddings": [[...]], "model": "ViT-H-14", "seconds": 3.1}

The embeddings are the normalised image vectors. They are what the
director's EVOLUTION ordering walks through: the shot order that moves
through the character's states one small step at a time.

The numbers are CLIP cosine similarities: 1.0 is identical, 0.0 is unrelated.
They RANK; they do not measure. A director that treats a similarity as a
verdict is wrong — see docs/STORY-DIRECTOR.md.
"""

import json
import sys
import time


def load_model(name):
    import open_clip
    import torch

    model, _, preprocess = open_clip.create_model_and_transforms(
        name, pretrained='laion2b_s32b_b79k',
        cache_dir='/Users/kaidejuricmasscmbook/.cache/clip-interrogator',
    )
    model.eval()
    return model, preprocess, torch, open_clip


def main():
    job = json.load(sys.stdin)
    images = job.get('images') or []
    lines = job.get('lines') or []
    model_name = job.get('model') or 'ViT-H-14'
    if not images or not lines:
        print(json.dumps({'matrix': [], 'model': model_name, 'seconds': 0.0}))
        return 0

    import torch
    from PIL import Image

    model, preprocess, _, open_clip = load_model(model_name)
    started = time.time()

    with torch.no_grad():
        if images:
            batch = torch.stack([preprocess(Image.open(p).convert('RGB')) for p in images])
            feats = model.encode_image(batch)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        else:
            feats = None
        tokens = open_clip.tokenize(lines)
        text = model.encode_text(tokens)
        text = text / text.norm(dim=-1, keepdim=True)

        if feats is None:
            matrix = [[0.0 for _ in lines] for _ in images]
        else:
            matrix = (feats @ text.T).tolist()

    print(json.dumps({
        'matrix': matrix,
        'embeddings': [[round(float(v), 6) for v in row] for row in (feats.tolist() if feats is not None else [])],
        'model': model_name,
        'seconds': round(time.time() - started, 2),
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
