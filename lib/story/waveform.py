#!/usr/bin/env python3
"""lib/story/waveform.py — seven fluid waveform lines over the film.

A lyric video wants the music IN the picture. This draws seven 1px
waveform lines across a band of the frame:

  * each line is a waveform — one vertical stroke per column, whose height
    follows the audio at that instant;
  * the strokes FADE IN — the alpha ramps up over the first seconds, so
    the lines arrive rather than appear;
  * the band PULSES on the beat — a fast-attack, slow-decay follower of
    the track's dB hits drives the lines' brightness and their reach,
    gently.

The lines are drawn here, in pure stdlib, and streamed to ffmpeg as raw
RGBA: no intermediate images, no image library, no dependency.

    python3 lib/story/waveform.py --track song.wav \
      --videos v1.mp4 v2.mp4 v3.mp4 --out-prefix with-lines/

The overlay depends only on the AUDIO, so it is drawn once and laid over
every film.
"""

import argparse
import math
import os
import subprocess
import sys
from array import array

# The house palette. The lines are COPPER, not cream: the picture behind
# them is cream and pink as often as it is dark, and a cream line on a
# cream picture is invisible. The beat flashes them toward cream.
COPPER = (201, 123, 63)
CREAM = (247, 245, 240)

HOP_MS = 10
DB_FLOOR = -60.0


def decode_audio(track, sample_rate=44100):
    """The track as mono 16-bit PCM."""
    result = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', track,
         '-ac', '1', '-ar', str(sample_rate), '-f', 's16le', '-'],
        capture_output=True, timeout=600,
    )
    samples = array('h')
    samples.frombytes(result.stdout[:len(result.stdout) - (len(result.stdout) % 2)])
    return samples, sample_rate


def envelope_db(samples, sample_rate, hop_ms=HOP_MS):
    """The track's loudness over time, in decibels, one value per hop."""
    hop = max(1, int(sample_rate * hop_ms / 1000.0))
    out = []
    for index in range(0, max(0, len(samples) - hop), hop):
        chunk = samples[index:index + hop]
        total = 0
        for value in chunk:
            total += value * value
        rms = (total / float(len(chunk))) ** 0.5
        db = 20.0 * math.log10(max(rms / 32768.0, 1e-6))
        out.append(max(DB_FLOOR, db))
    return out


def pulse_curve(levels, fps, attack=0.12, release=0.45):
    """A fast-attack, slow-decay follower of the dB hits, per video frame.

    A hit is a loud moment; the curve jumps to it quickly and falls away
    slowly, so the lines breathe with the music instead of flickering on
    every transient. The value runs from 0 (silence) to 1 (the loudest
    hit in the track).
    """
    if not levels:
        return []
    peak = max(levels)
    floor = DB_FLOOR
    span = max(1.0, peak - floor)
    curve = []
    value = 0.0
    index = 0
    for frame in range(int(len(levels) * HOP_MS / 1000.0 * fps) + 2):
        now = frame / float(fps)
        while index + 1 < len(levels) and (index + 1) * HOP_MS / 1000.0 <= now:
            index += 1
        level = max(0.0, (levels[index] - floor) / span)
        hit = level ** 3
        if hit > value:
            value += (hit - value) * attack
        else:
            value += (hit - value) * (1.0 - release)
        curve.append(min(1.0, value))
    return curve


def draw_frame(width, height, lines, columns, alpha, colour, reach_scale):
    """One frame of the overlay as raw RGBA bytes.

    `columns` is one array of values PER LINE (each a waveform across the
    picture's width), and `alpha` and `colour` are per line too — so each
    band of the music gets its own line, its own brightness and its own
    pulse.

    The strokes are drawn COLUMN-WISE: a column's pixels are `width`
    apart in memory, so filling them as one slice wrote over the wrong
    rows and turned the seven lines into solid bands. numpy fills them
    correctly (and quickly); the stdlib path fills them pixel by pixel.
    """
    try:
        import numpy as np
    except ImportError:
        np = None

    if np is not None:
        buffer = np.zeros((height, width, 4), dtype=np.uint8)
        rows = np.arange(height)[:, None]
        for line in range(lines):
            baseline = int(height * (line + 1) / float(lines + 1))
            reach = max(1, int(reach_scale * (height / float(lines)) * 0.30))
            values = np.asarray(columns[line], dtype=np.float32)
            extent = (values * reach).astype(np.int32)
            top = np.clip(baseline - extent, 0, height - 1)
            bottom = np.clip(baseline + extent, 0, height - 1)
            cover = (rows >= top[None, :]) & (rows <= bottom[None, :])
            line_alpha = alpha[line] if isinstance(alpha, list) else alpha
            line_colour = colour[line] if isinstance(colour[0], tuple) else colour
            buffer[cover] = (line_colour[0], line_colour[1], line_colour[2], line_alpha)
        return buffer.tobytes()

    buffer = bytearray(width * height * 4)
    for line in range(lines):
        baseline = int(height * (line + 1) / float(lines + 1))
        reach = max(1, int(reach_scale * (height / float(lines)) * 0.30))
        line_columns = columns[line] if isinstance(columns[0], list) else columns
        line_alpha = alpha[line] if isinstance(alpha, list) else alpha
        line_colour = colour[line] if isinstance(colour[0], tuple) else colour
        for column in range(width):
            value = line_columns[column]
            top = baseline - int(value * reach)
            bottom = baseline + int(value * reach)
            if top < 0:
                top = 0
            if bottom >= height:
                bottom = height - 1
            if bottom < top:
                bottom = top
            # a column's pixels are `width` apart: fill them one by one
            for row in range(top, bottom + 1):
                at = (row * width + column) * 4
                buffer[at:at + 4] = bytes((line_colour[0], line_colour[1],
                                           line_colour[2], line_alpha))
    return bytes(buffer)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--track', required=True, help='the audio')
    parser.add_argument('--videos', nargs='+', required=True, help='the films')
    parser.add_argument('--out-prefix', required=True, help='the films get this prefix')
    parser.add_argument('--lines', type=int, default=7)
    parser.add_argument('--band', type=int, default=240, help='the height of the overlay band')
    parser.add_argument('--fade', type=float, default=5.0, help='seconds to fade in')
    parser.add_argument('--pulse', type=float, default=0.45, help='how hard the beat hits')
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--bands', default=None,
                        help='the band analysis (lib/story/wave_bands.py); one line per band')
    parser.add_argument('--window', type=float, default=1.2,
                        help='seconds of music that flow across one line')
    args = parser.parse_args()

    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height',
         '-of', 'default=nw=1:nk=1', args.videos[0]],
        capture_output=True, timeout=60,
    ).stdout.decode('utf8', 'replace').split()
    if len(probe) < 2:
        sys.stderr.write('[waveform] could not read the video\n')
        return 2
    width, height = int(probe[0]), int(probe[1])

    samples, rate = decode_audio(args.track)
    levels = envelope_db(samples, rate)
    curve = pulse_curve(levels, args.fps)
    seconds = len(samples) / float(rate)

    band = min(args.band, height)
    top = height - band

    bands = None
    waveforms = None
    if args.bands:
        import json
        from array import array as _array
        with open(args.bands) as handle:
            payload = json.load(handle)
        bands = payload['bands']
        raw_path = payload.get('waveforms')
        if raw_path and os.path.exists(raw_path):
            raw = _array('f')
            with open(raw_path, 'rb') as handle:
                raw.frombytes(handle.read())
            lines_count = payload['lines']
            window = payload['window']
            count = len(raw) // (lines_count * window)
            # each band's own peak, so a quiet band still draws
            peaks = []
            for band_index in range(lines_count):
                best = 0.0
                for frame in range(0, count, 37):        # a sample, not every frame
                    base = (frame * lines_count + band_index) * window
                    for bucket in range(window):
                        value = raw[base + bucket]
                        if value > best:
                            best = value
                peaks.append(best or 1.0)
            waveforms = (count, lines_count, window, raw, peaks)

    frames = int(seconds * args.fps) + 1

    def overlay_frames():
        """The overlay, frame by frame — the lines drawn over the picture."""
        for number in range(frames):
            now = number / float(args.fps)
            per_column = seconds / float(width) if width else 1.0
            columns = []
            for column in range(width):
                start = column * per_column
                lo = int(start / (HOP_MS / 1000.0))
                hi = int((start + per_column) / (HOP_MS / 1000.0)) + 1
                window = levels[lo:hi] if lo < len(levels) else []
                columns.append(max(window) if window else DB_FLOOR)
            beat = curve[number] if number < len(curve) else 0.0
            fade = min(1.0, now / args.fade) if args.fade > 0 else 1.0
            reach = 0.35 + 0.65 * beat * args.pulse

            if bands:
                # One line per band: the band's own history flows across
                # the picture's width, and the line pulses on ITS hits.
                per_line = []
                alphas = []
                colours = []
                span = max(1, int(args.window * args.fps))
                for band_index in range(args.lines):
                    row = []
                    if waveforms:
                        # The band's OWN filtered waveform: the shape along
                        # the line is that band's shape ✓ ✓ — the bass line
                        # swells where the bass does ✓.
                        count, lines_count, window, raw, peaks = waveforms
                        step = 100.0 / args.fps        # the analysis runs at 100 Hz
                        here = int(number * step)
                        peak = peaks[band_index]
                        for column in range(width):
                            bucket = int(column * window / float(width))
                            at = here - (window - 1) + bucket
                            at = max(0, min(count - 1, at))
                            base = (at * lines_count + band_index) * window
                            row.append(min(1.0, raw[base + bucket] / peak))
                    else:
                        for column in range(width):
                            at = number - span + int(column * span / float(width))
                            at = max(0, min(len(bands) - 1, at))
                            row.append(bands[at][band_index])
                    per_line.append(row)
                    level = bands[min(number, len(bands) - 1)][band_index]
                    alphas.append(int(max(0, min(255, fade * (150 + 105 * level * args.pulse)))))
                    colours.append((
                        int(COPPER[0] + (CREAM[0] - COPPER[0]) * level * args.pulse),
                        int(COPPER[1] + (CREAM[1] - COPPER[1]) * level * args.pulse),
                        int(COPPER[2] + (CREAM[2] - COPPER[2]) * level * args.pulse),
                    ))
                yield draw_frame(width, band, args.lines, per_line, alphas, colours, reach)
                continue

            alpha = int(max(0, min(255, fade * (150 + 105 * beat * args.pulse))))
            colour = (
                int(COPPER[0] + (CREAM[0] - COPPER[0]) * beat * args.pulse),
                int(COPPER[1] + (CREAM[1] - COPPER[1]) * beat * args.pulse),
                int(COPPER[2] + (CREAM[2] - COPPER[2]) * beat * args.pulse),
            )
            yield draw_frame(width, band, args.lines, columns, alpha, colour, reach)

    for video in args.videos:
        stem = os.path.splitext(os.path.basename(video))[0]
        out = os.path.join(args.out_prefix, stem + '-lines.mp4')
        os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
        # The lines are STREAMED into ffmpeg as raw RGBA. Writing them to
        # a file first meant 8.8 GB of scratch on a disk that is 99% full
        # — and the file was truncated there, which is how the first pass
        # came out 240 pixels tall.
        ffmpeg = subprocess.Popen(
            ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
             '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '%dx%d' % (width, band),
             '-r', str(args.fps), '-i', 'pipe:0',
             '-i', video,
             '-filter_complex', '[1:v][0:v]overlay=x=0:y=%d:format=auto[v]' % top,
             '-map', '[v]', '-map', '1:a?',
             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
             '-pix_fmt', 'yuv420p', '-color_range', 'tv',
             '-c:a', 'copy', '-shortest', out],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        for chunk in overlay_frames():
            ffmpeg.stdin.write(chunk)
        ffmpeg.stdin.close()
        code = ffmpeg.wait()
        if code != 0:
            sys.stderr.write(ffmpeg.stderr.read().decode('utf8', 'replace')[-800:] + '\n')
            return code or 2
        sys.stderr.write('[waveform] %s → %s\n' % (os.path.basename(video), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
