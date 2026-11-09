# The visualizer — seven lines that breathe with the song

`lib/story/wave_bands.py` + `lib/story/waveform.py` draw seven 1px
waveform lines across the lower band of a music video: they fade in,
each one pulses on its own band's hits, and each one is a different
frequency band of the track.

```bash
# 1. the analysis (numpy + scipy, in lib/story's venv)
lib/story/.venv/bin/python lib/story/wave_bands.py \
  --track song.wav --fps 30 --lines 7 --window 400 --out /tmp/bands.json

# 2. the lines over the film
lib/story/.venv/bin/python lib/story/waveform.py \
  --track song.wav --videos film.mp4 --out-prefix out/ \
  --lines 7 --band 240 --fade 5 --pulse 0.5 --bands /tmp/bands.json
```

## What each piece does

**`wave_bands.py`** (numpy + scipy) — the STFT of the track, split into
seven log-spaced bands from 40 Hz to 8 kHz. Two things come out:

- the **levels** — each band's loudness per frame in decibels, normalised
  against its OWN peak, so a quiet band still draws. These drive the
  lines' brightness and their pulse.
- the **waveforms** — each band FILTERED (a Butterworth band-pass) and
  reduced to an envelope, so the seven lines are seven different SHAPES:
  the bass line swells where the bass does, the hiss line flickers where
  the hiss does. Seven copies of one waveform would be seven rules; this
  is a spectrum. They are written as raw float32 (frames x bands x
  window) because they are 16 MB of numbers and JSON would be ten times
  that.

**`waveform.py`** — draws the lines and streams them into ffmpeg as raw
RGBA. The overlay depends only on the audio, so it is drawn once and
laid over every film of a set.

- each line is a **column stroke**: one vertical stroke per column,
  whose height follows that band's waveform;
- the strokes **fade in** — the alpha ramps up over `--fade` seconds;
- the band **pulses** on the beat — a fast-attack, slow-decay follower
  of the track's dB hits drives the alpha and the reach, gently;
- the colour is the house **copper**, and the beat flashes it toward
  cream. The lines were cream first and were invisible: the picture
  behind them is cream as often as it is dark.

## The libraries that made this possible

| library | what it bought | version |
|---|---|---|
| **numpy** | the STFT and the band filters — 1.8 s for the whole track, against minutes in pure Python | 1.26.4 |
| **scipy** | `signal.butter` + `signal.sosfilt` — the band-pass that makes each line a different shape | 1.17.1 |
| **librosa** | proper beat and onset tracking (the stdlib fallback in `director.py` finds the pulse, not the downbeat) | 0.11.0 |
| **Pillow** | drawing the lines far faster than bytearray slicing | 13.0.0 |
| **numba** | compiling the per-frame column maths | 0.68.1 |
| **PyAV** | frame-accurate decode and encode in process, with numpy interop | 19.0.2 |
| **opencv-python** | optical flow — a pan that follows the picture instead of sliding over it | 4.11.0 |
| **moderngl** | the overlay on the GPU, for a live preview | 5.13.0 |
| **sounddevice** | live audio input, so the same code can react to a room | 0.5.6 |

They live in `lib/story`'s own uv project (`uv sync --project lib/story`).
The driver stays stdlib-only; the heavy work is spoken to over
stdin/stdout as JSON or a raw file, the same shape as the CLIP scorer.

**PyAV's own README says** that if the ffmpeg command does the job
without bending over backwards, PyAV is more likely a hindrance than a
help — so it is installed for the frame-accurate work, not as a
replacement for the CLI.
