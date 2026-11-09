# lib/story — the twin's visualizer

The tools that turn a song and a pile of frames into a music video.

| file | what it does |
|---|---|
| `director.py` | the artistic director: measures the frames, cuts the ones that don't fit, matches the rest to the lyric, plans the cut (the shot lengths, the camera move, the look) and makes three versions — the last one the character's evolution |
| `wave_bands.py` | the track as seven frequency bands, per frame (numpy + scipy, in this project's venv) |
| `waveform.py` | draws the seven 1px waveform lines, fading in, pulsing on the beat (stdlib; runs the band analysis through this venv when it is asked for) |
| `clip_score.py` | the images × lines similarity matrix (torch + open_clip, in the clip-interrogator venv) |

Setup:

```bash
uv sync --project lib/story
```

The band analysis needs numpy and scipy; the drawing and the director are
stdlib-only and run on the system Python.
