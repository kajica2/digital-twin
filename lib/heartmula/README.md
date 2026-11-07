# heartmula-twin

HeartMuLa — the open-source, Apache-2.0, Suno-like music model — as a twin
tool: lyrics + style tags in, a song out.

    uv sync --project lib/heartmula
    uv run --project lib/heartmula heartmula check
    uv run --project lib/heartmula heartmula generate \
        --lyrics lib/heartmula/assets/lyrics/flames-dont-warm-me.txt \
        --tags "modal jazz, trumpet, sparse, warm" \
        --out data/heartmula/flames.mp3

See `docs/HEARTMULA.md` in the repo root.
