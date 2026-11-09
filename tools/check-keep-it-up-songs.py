"""Measure the four KEEP IT UP songs.

Only the first one was ever checked for dead air. A generator that
writes a file can still write a file that is a hum, a click, or
twenty minutes of nothing with a fade at each end — and the file
passes every existence check.

So: for each song, the duration, the peak, the RMS, the longest
stretch of near-silence, and the spectral centroid. A song with a
longest silence over a couple of seconds is a generation that gave
up partway.

Run:  python3 tools/check-keep-it-up-songs.py
"""

import os
import subprocess
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SONGS = [
    ("keep-it-up", "KEEP IT UP"),
    ("needle-drop-healer", "NEEDLE DROP HEALER"),
    ("slip-between-the-beats", "SLIP BETWEEN THE BEATS"),
    ("it-aint-what-it-is", "IT AIN'T WHAT IT IS"),
]

FAIL = []


def decode(path, rate=22050):
    """Decode to mono float32 via ffmpeg — the same path the visualiser uses."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1",
         "-ar", str(rate), "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32), rate


def check(cond, msg, detail=""):
    print(("  OK   " if cond else "  FAIL ") + msg + (f"  ({detail})" if detail else ""))
    if not cond:
        FAIL.append(msg)


for stem, title in SONGS:
    path = os.path.join(ROOT, "assets", "keep-it-up", "audio", stem + ".mp3")
    print(f"\n{title}  ({stem}.mp3)")
    if not os.path.exists(path):
        check(False, "the file exists")
        continue
    size = os.path.getsize(path)
    check(size > 500_000, "the file is a real size", f"{size/1048576:.1f} MB")

    x, rate = decode(path)
    dur = len(x) / rate
    check(dur > 60, "it is longer than a minute", f"{dur:.1f}s")

    peak = float(np.abs(x).max())
    rms = float(np.sqrt(np.mean(x ** 2)))
    db = lambda v: 20 * np.log10(max(v, 1e-12))
    check(peak > 0.05, "it is not silence", f"peak {db(peak):+.1f} dBFS")
    check(rms > 0.01, "it has body", f"rms {db(rms):+.1f} dBFS")

    # CLIPPING, measured properly.
    #
    # `peak < 1.02` was the old assertion and it was wrong twice over:
    # it allowed a sixth of a dB over full scale, and it said nothing
    # about whether the peaks are FLAT — which is the thing that makes
    # clipping audible. The generated songs peaked at +3 dBFS with
    # flat-topped runs, and every one of them passed.
    at_fs = int((np.abs(x) >= 0.999).sum())
    over = int((np.abs(x) > 1.0).sum())
    signs = np.sign(x)
    flat = int(((signs[1:] == signs[:-1]) & (np.abs(x[1:]) >= 0.95)).sum())
    check(over == 0, "nothing is over full scale", f"{over} samples over 0 dBFS")
    check(flat == 0, "the peaks are not flat-topped", f"{flat} samples in flat runs")
    # The ceiling, with the tolerance the measurement actually has:
    # the peak is reported to two decimals, and −1.00 dBFS is 0.8913.
    check(peak <= 0.9, "it sits under the ceiling", f"peak {db(peak):+.1f} dBFS")

    # The longest stretch of near-silence — the thing that proves a
    # generator gave up partway.
    win = int(0.25 * rate)
    if len(x) >= win:
        frames = x[:len(x) // win * win].reshape(-1, win)
        energy = np.sqrt((frames ** 2).mean(axis=1))
        thr = max(10 ** (-45 / 20), rms * 0.02)
        quiet = energy < thr
        longest = run = 0
        for q in quiet:
            run = run + 1 if q else 0
            longest = max(longest, run)
        gap = longest * 0.25
        check(gap < 3.0, "no dead stretch longer than 3s", f"longest {gap:.2f}s")

        # A generation that gave up would leave the whole tail silent.
        tail = x[-int(min(dur, 20) * rate):]
        head = x[:int(min(dur, 20) * rate)]
        check(np.sqrt((tail ** 2).mean()) > rms * 0.25,
              "the tail is alive", f"tail rms {db(np.sqrt((tail**2).mean())):.1f} dBFS "
                                  f"vs whole {db(rms):.1f} dBFS")
        check(np.sqrt((head ** 2).mean()) > rms * 0.25,
              "the head is alive", f"head rms {db(np.sqrt((head**2).mean())):.1f} dBFS")

    # The spectral centroid — a hum has one, a song does not.
    n = min(len(x), rate * 60)
    spec = np.abs(np.fft.rfft(x[:n] * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, 1 / rate)
    centroid = float((spec * freqs).sum() / max(spec.sum(), 1e-12))
    check(150 < centroid < 4000, "the spectrum is a song, not a hum",
          f"centroid {centroid:.0f} Hz")

    # The variation: a real performance moves.
    win2 = int(0.5 * rate)
    frames2 = x[:len(x) // win2 * win2].reshape(-1, win2)
    env = np.sqrt((frames2 ** 2).mean(axis=1))
    variation = float(env.std() / max(env.mean(), 1e-12))
    check(variation > 0.05, "the level moves", f"variation {variation:.3f}")

print(f"\nkeep-it-up songs: {'PASS' if not FAIL else str(len(FAIL)) + ' FAILURE(S)'}")
sys.exit(0 if not FAIL else 1)
