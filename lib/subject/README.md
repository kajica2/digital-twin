# lib/subject — cut the subject out of a picture

The twin had recognition (CLIP) but no extraction. This is the extraction
half: a saliency matte, an alpha PNG, and — when you name the object — a
CLIP check that what came out is the thing you asked for.

```bash
uv sync --project lib/subject

# cut the subject out
python lib/subject/extract.py frame.jpg --out bunny.png

# name it, and prove it is the thing you named
python lib/subject/extract.py frame.jpg --out bunny.png \
    --prompt "a needle-felted wool rabbit" \
    --contrast "an empty studio backdrop"

# the measurements, as JSON
python lib/subject/extract.py frame.jpg --out bunny.png --json
```

The weights (176 MB for u2net) live in `models/` — `U2NET_HOME` points
there, so a fresh clone downloads them once and nothing appears in the
user's home directory by surprise.

Tests — the decisions, with no model and no network:

```bash
npm run test:subject
```

The reference is [`docs/SUBJECT-EXTRACT.md`](../../docs/SUBJECT-EXTRACT.md).
