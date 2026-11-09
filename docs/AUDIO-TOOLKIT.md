# The Python Audio Processing Toolkit

A local **reference** for the plain reading of audio DSP: waveform,
spectrogram, FFT, and the live amplitude / magnitude analysers.

    https://github.com/Matin-python/Python-Audio-Processing-Toolkit  (MIT)

## What it is, and what it is not

The toolkit is a handful of standalone scripts, each of which records
from a microphone, plots something with matplotlib, and ends. It is
**not** a library — there is nothing to import.

The twin already has a better visualiser, in `lib/story/`:

| | the toolkit | `lib/story/` |
|---|---|---|
| bands | one spectrum | **seven**, 40 Hz → 8 kHz, each its own Butterworth filter |
| output | a matplotlib window | **raw RGBA streamed into the video** |
| draw | matplotlib | Pillow, 1 px strokes |
| use | listening to a room | the film's own picture |

What the toolkit is good for is the **plain** version of each thing —
a one-file answer to "what does this sound like", with no pipeline
around it. That is why it is installed here.

## Install

```bash
bash bin/install-audio-toolkit.sh
```

It clones the repo to `lib/python-audio-toolkit/`, makes a uv venv
(Python 3.12), installs `requirements.txt` — PyAudio 0.2.14, numpy
2.1.3, scipy 1.18.0, matplotlib 3.11.0 — and runs the check.

**PortAudio is a system dependency** (`brew install portaudio`). It was
already on this machine; PyAudio will not build without it.

The clone lands **local and gitignored**. It is another project's code
with its own `.git`, and the twin's rule is that vendored trees and
their paths do not travel in the public repo. What travels is the
check.

## Check

```bash
npm run test:audio-toolkit
```

`tools/check-audio-toolkit.py` proves the install actually works —
15 checks, all green:

1. **the imports** — pyaudio, numpy, scipy, matplotlib
2. **PyAudio sees the machine** — a host API, devices, and at least
   one input device
3. **the toolkit's own maths on a real WAV** — it writes a three-second
   WAV, reads it back, and runs the toolkit's own waveform plot,
   spectrogram and FFT. The FFT's peak comes back at the 220 Hz tone
   that was put in.
4. **the microphone opens** — one 1024-frame chunk

### Two mistakes the check itself made

Both were caught by running it, not by reading it:

- **scipy's `butter()` wants normalised frequencies** unless it is
  given `fs=`. Passing `[200, 240]` Hz without it raises. The check
  now says `fs=sr`.
- **PyAudio counts FRAMES, and `paInt16` is two bytes a frame.** So
  1024 frames come back as 2048 bytes. The check compares frames.

## The toolkit's own scripts

They need a microphone and open a matplotlib window:

```bash
lib/python-audio-toolkit/.venv/bin/python \
  lib/python-audio-toolkit/processing/voice_processing.py

lib/python-audio-toolkit/.venv/bin/python \
  lib/python-audio-toolkit/recording/fixed_time_recorder.py

lib/python-audio-toolkit/.venv/bin/python \
  lib/python-audio-toolkit/recording/voice_activity_recorder.py

ls lib/python-audio-toolkit/realtime/
```

## See also

- `docs/STORY-VISUALIZER.md` — the twin's own visualiser, and the one
  to actually use.
- `lib/story/wave_bands.py` — the seven bands.
- `lib/story/waveform.py` — the drawing.
