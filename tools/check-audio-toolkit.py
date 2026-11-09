"""Check the Python Audio Processing Toolkit install.

The toolkit's own scripts all record from a microphone and open a
matplotlib window, so they cannot run headlessly as they are. What CAN
be verified is everything underneath them:

  1. the four imports resolve (pyaudio, numpy, scipy, matplotlib)
  2. PyAudio sees a host API and can open an input stream
  3. the toolkit's OWN maths runs on a real WAV — the same waveform
     plot, spectrogram and FFT that processing/voice_processing.py
     does on a recorded buffer
  4. the figures actually come out

Run:  lib/python-audio-toolkit/.venv/bin/python tools/check-audio-toolkit.py
"""

import os
import sys
import wave

import matplotlib
matplotlib.use("Agg")          # headless: no window
import matplotlib.pyplot as plt
import numpy as np
import pyaudio
import scipy
from scipy import signal

FAILURES = []


def check(cond, msg, detail=""):
    if cond:
        print(f"  OK   {msg}" + (f"  ({detail})" if detail else ""))
    else:
        print(f"  FAIL {msg}" + (f"  ({detail})" if detail else ""))
        FAILURES.append(msg)


print("\n1. the imports")
check(pyaudio.__version__ is not None, "pyaudio imports", f"v{pyaudio.__version__}")
check(np.__version__ is not None, "numpy imports", f"v{np.__version__}")
check(scipy.__version__ is not None, "scipy imports", f"v{scipy.__version__}")
check(matplotlib.__version__ is not None, "matplotlib imports", f"v{matplotlib.__version__}")

print("\n2. PyAudio sees the machine")
p = pyaudio.PyAudio()
apis = p.get_host_api_count()
check(apis > 0, "at least one host API", f"{apis}")
devices = p.get_device_count()
check(devices > 0, "at least one audio device", f"{devices}")
inputs = [d for d in range(devices)
          if p.get_device_info_by_index(d).get("maxInputChannels", 0) > 0]
check(len(inputs) > 0, "at least one input device (a microphone)", f"{len(inputs)}")

print("\n3. the toolkit's maths on a real WAV")
# A real WAV: three seconds of a tone with a beat, written to disk and
# read back — the same path the toolkit's own recorder uses.
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_check.wav")
sr = 16000
dur = 3.0
frames = np.zeros(int(sr * dur), dtype=np.int16)
for i in range(len(frames)):
    t = i / sr
    env = 0.35 + 0.65 * abs(np.sin(np.pi * t / dur))
    tone = np.sin(2 * np.pi * 220 * t) + 0.4 * np.sin(2 * np.pi * 660 * t)
    frames[i] = int(12000 * env * tone / 1.4)
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(frames.tobytes())
check(os.path.getsize(path) > 1000, "a WAV was written", f"{os.path.getsize(path)} bytes")

with wave.open(path, "rb") as w:
    n = w.getnframes()
    rate = w.getframerate()
    data = np.frombuffer(w.readframes(n), dtype=np.int16)
check(len(data) == int(sr * dur), "the WAV reads back", f"{len(data)} frames at {rate} Hz")

# The toolkit's waveform plot.
fig, ax = plt.subplots()
ax.plot(data)
fig.savefig(path.replace(".wav", "-waveform.png"))
plt.close(fig)
check(os.path.getsize(path.replace(".wav", "-waveform.png")) > 1000,
      "the waveform figure came out")

# The toolkit's spectrogram.
fig, ax = plt.subplots()
ax.specgram(data, Fs=rate)
fig.savefig(path.replace(".wav", "-spectrogram.png"))
plt.close(fig)
check(os.path.getsize(path.replace(".wav", "-spectrogram.png")) > 1000,
      "the spectrogram figure came out")

# The toolkit's FFT.
out_fft = np.fft.fft(data)
out_fft = out_fft[0:rate // 2]
out_fft = np.abs(out_fft)
check(len(out_fft) == rate // 2, "the FFT is half the spectrum", f"{len(out_fft)} bins")
peak = int(np.argmax(out_fft))
peak_hz = peak * rate / len(data)
check(abs(peak_hz - 220) < 20, "the FFT peak is the 220 Hz tone", f"{peak_hz:.1f} Hz")

# And scipy — the band-pass the twin's visualiser uses. The
# frequencies are in HERTZ here, so scipy needs to be told the sample
# rate; without `fs` it expects them normalised to 0..1 and refuses.
sos = signal.butter(4, [200, 240], btype="band", output="sos", fs=sr)
filtered = signal.sosfilt(sos, data.astype(float))
check(np.abs(filtered).max() > 100, "the scipy band-pass passes the tone",
      f"peak {np.abs(filtered).max():.0f}")

print("\n4. the microphone opens")
try:
    stream = p.open(format=pyaudio.paInt16, channels=1, rate=sr,
                     input=True, frames_per_buffer=1024)
    chunk = stream.read(1024)
    stream.stop_stream()
    stream.close()
    # PyAudio counts FRAMES, and paInt16 is two bytes a frame — so
    # 1024 frames come back as 2048 bytes.
    check(len(chunk) == 1024 * 2, "an input stream reads 1024 frames",
          f"{len(chunk)} bytes = {len(chunk) // 2} frames")
except Exception as exc:                       # noqa: BLE001 - report it, do not crash
    check(False, "an input stream reads 1024 frames", str(exc))

p.terminate()

for f in (path, path.replace(".wav", "-waveform.png"), path.replace(".wav", "-spectrogram.png")):
    try:
        os.remove(f)
    except OSError:
        pass

print(f"\naudio-toolkit check: {'PASS' if not FAILURES else str(len(FAILURES)) + ' FAILURE(S)'}")
sys.exit(0 if not FAILURES else 1)
