#!/usr/bin/env python3
"""lib/story/wave_bands.py — the track as seven bands, with seven waveforms.

Runs inside the story project's venv: that is where numpy and scipy
already live, and the STFT and the band filters are the heavy part. The
driver (`lib/story/waveform.py`) stays stdlib-only and reads what this
writes ✓ — the same shape as the CLIP scorer ✓ ✓.

    python3 wave_bands.py --track song.wav --fps 30 --lines 7 --out bands.json

Two things come out:

  * **the levels** — each band's loudness per frame, in decibels and
    normalised against its own peak ✓. These drive the lines' brightness
    and their pulse ✓.
  * **the waveforms** — each band FILTERED (a Butterworth band-pass ✓ ✓)
    and reduced to an envelope ✓, so the seven lines are seven different
    SHAPES ✓ ✓: the bass line swells where the bass does, the hiss line
    flickers where the hiss does ✓ ✓. Seven copies of one waveform
    would be seven rules; this is a spectrum ✓.

The waveforms are written as raw float32 (frames x bands x window ✓ ✓)
because they are 16 MB of numbers and JSON would be ten times that ✓.
"""

import argparse
import json
import subprocess
import sys

import numpy as np
from scipy import signal

HOP_MS = 10
DB_FLOOR = -60.0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--track', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--lines', type=int, default=7)
    parser.add_argument('--nfft', type=int, default=2048)
    parser.add_argument('--top-hz', type=float, default=8000.0)
    parser.add_argument('--window', type=int, default=120,
                        help='envelope samples each frame keeps (10 ms each, '
                             'so 120 = 1.2 s of history)')
    args = parser.parse_args()

    rate = 44100
    raw = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', args.track,
         '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-'],
        capture_output=True, timeout=600,
    ).stdout
    audio = np.frombuffer(raw, dtype='<f4')
    if audio.size == 0:
        sys.stderr.write('[wave-bands] could not read the track\n')
        return 2

    hop = max(1, int(rate * HOP_MS / 1000.0))
    window = np.hanning(args.nfft).astype(np.float32)
    gain = max(1e-9, float(window.sum()))

    # 1. The spectrum, frame by frame -> each band's level in decibels.
    spectra = []
    for start in range(0, max(1, audio.size - args.nfft), hop):
        chunk = audio[start:start + args.nfft]
        if chunk.size < args.nfft:
            chunk = np.pad(chunk, (0, args.nfft - chunk.size))
        spectra.append(np.abs(np.fft.rfft(chunk * window)) / gain)
    if not spectra:
        sys.stderr.write('[wave-bands] the track is too short\n')
        return 2

    freqs = np.fft.rfftfreq(args.nfft, d=1.0 / rate)
    top = np.searchsorted(freqs, args.top_hz) + 1
    low = np.searchsorted(freqs, 40.0)
    edges = np.unique(np.geomspace(low, max(low + 1, top), args.lines + 1).astype(int))

    levels = []
    for spectrum in spectra:
        row = []
        for index in range(len(edges) - 1):
            band = spectrum[edges[index]:max(edges[index] + 1, edges[index + 1])]
            rms = float(np.sqrt(np.mean(band ** 2))) if band.size else 0.0
            db = 20.0 * np.log10(max(rms, 1e-7))
            row.append(max(DB_FLOOR, min(0.0, db)))
        levels.append(row)

    # 2. Each band's own filtered waveform, as an envelope.
    sos_filters = []
    for index in range(len(edges) - 1):
        low_hz = max(30.0, float(freqs[edges[index]]))
        high_hz = min(args.top_hz, max(low_hz * 1.5,
                                       float(freqs[min(edges[index + 1], len(freqs) - 1)])))
        sos_filters.append(signal.butter(4, [low_hz, high_hz], btype='band',
                                          output='sos', fs=rate))

    frames = len(levels)
    waveforms = np.zeros((frames, args.lines, args.window), dtype=np.float32)
    for band_index, sos in enumerate(sos_filters):
        filtered = signal.sosfilt(sos, audio)
        for frame in range(frames):
            start = frame * hop
            end = min(filtered.size, start + hop)
            chunk = filtered[start:end]
            if chunk.size == 0:
                continue
            buckets = np.array_split(chunk, args.window)
            waveforms[frame, band_index] = [float(np.abs(b).max()) if b.size else 0.0
                                            for b in buckets]

    # 3. The levels, normalised against each band's own peak.
    peaks = []
    for index in range(len(edges) - 1):
        column = [row[index] for row in levels]
        peaks.append(max(column) if column else DB_FLOOR)
    normalised = [[max(0.0, min(1.0, (row[i] - (peaks[i] - 60.0)) / 60.0))
                   for i in range(len(edges) - 1)] for row in levels]

    # 4. Out.
    raw_path = args.out.rsplit('.', 1)[0] + '.waveforms.f32'
    waveforms.tofile(raw_path)
    payload = {
        'fps': args.fps,
        'lines': args.lines,
        'window': args.window,
        'peakDb': round(float(max(max(row) for row in levels)), 3),
        'bandPeaksDb': [round(float(v), 3) for v in peaks],
        'bands': normalised,
        'bandsDb': [[round(v, 3) for v in row] for row in levels],
        'waveforms': raw_path,
    }
    with open(args.out, 'w') as handle:
        json.dump(payload, handle)
    sys.stderr.write('[wave-bands] %d frame(s) x %d band(s) → %s (peak %.1f dB)\n'
                     % (frames, args.lines, args.out, payload['peakDb']))
    sys.stderr.write('[wave-bands] the band waveforms → %s\n' % raw_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
