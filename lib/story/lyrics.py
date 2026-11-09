#!/usr/bin/env python3
"""lib/story/lyrics.py — the words, on the picture.

The director cuts FRAMES into a music video. It knows which lyric line each
shot carries. Until now that knowledge stopped at the cut list: the words
were an INPUT to CLIP, never an OUTPUT to the screen.

This puts them on. A lyric line is drawn over its own shot, fades in when
the shot arrives, and fades out when it leaves.

    python3 lib/story/lyrics.py --cutlist cut.json --video film.mp4 \\
        --out film-with-lyrics.mp4

WHY PILLow AND NOT drawtext
---------------------------
`drawtext` is the obvious way to put text in a video and it is NOT
available: the ffmpeg on this machine's PATH is a Homebrew build without
libfreetype, so `ffmpeg -filters | grep drawtext` returns nothing. (A
bundled ffmpeg elsewhere on the box DOES have it — but the repo's tools all
invoke the PATH ffmpeg, and a tool that only works when a different binary
happens to be first on PATH is a tool that breaks quietly.)

So the text is DRAWN, not typeset by ffmpeg: Pillow renders it to an RGBA
overlay, and the overlay is streamed into ffmpeg's `overlay` filter. This
is the same shape lib/story/waveform.py already uses for the waveform
lines — proven, and it needs no special ffmpeg build.

Pillow runs in this project's venv (`uv sync --project lib/story`); the
module falls back to the system Python's Pillow if it is there, and says
so plainly if neither is available.

Pure stdlib apart from Pillow and ffmpeg.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The house palette (assets/skins/house.css): warm cream on near-black,
# copper for the brand voice. These are the DARK-theme ink and the copper.
CREAM = (244, 239, 226)
COPPER = (201, 123, 63)

# The fonts, in order of preference. All of them carry the Serbian Cyrillic
# and the Latin Extended-A the lyrics are written in — a font that cannot
# render "Ne može biti to" renders boxes, and a lyric video full of boxes
# is worse than no lyric video. The list is checked at runtime and the
# first one that loads wins.
FONT_CANDIDATES = [
    ('/System/Library/Fonts/Supplemental/Georgia.ttf', False),
    ('/System/Library/Fonts/Supplemental/Georgia Bold.ttf', False),
    ('/System/Library/Fonts/Supplemental/Futura.ttc', False),
    ('/System/Library/Fonts/Supplemental/Avenir Next.ttc', False),
    ('/System/Library/Fonts/Supplemental/Didot.ttc', False),
]

# The lyric sits in the lower third: the picture's subject is usually in
# the upper two thirds, and text over a face is text nobody reads.
BOTTOM_MARGIN = 0.10          # fraction of the height from the bottom
MAX_WIDTH = 0.78             # the text wraps at this fraction of the width
LINE_SPACING = 1.28
DEFAULT_SIZE = 0.045         # fraction of the height


def log(msg):
    sys.stderr.write('[lyrics] %s\n' % msg)


# --------------------------------------------------------------------------
# the pillow
# --------------------------------------------------------------------------

def _pillow():
    """Pillow, wherever it lives. Returns (Image, ImageDraw, ImageFont)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        return Image, ImageDraw, ImageFont
    except ImportError:
        return None, None, None


def load_font(size, bold=False):
    """The first font that loads. None when Pillow is absent."""
    _, _, ImageFont = _pillow()
    if ImageFont is None:
        return None
    for path, is_bold in FONT_CANDIDATES:
        if bold and not is_bold:
            continue
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    # A font that carries the Cyrillic matters more than the exact face, so
    # the bold list is tried last but never skipped silently.
    if bold:
        return load_font(size, bold=False)
    return None


def font_missing_glyphs(font, text):
    """The characters a font cannot draw. Empty when it can draw them all."""
    if font is None:
        return set(text)
    missing = set()
    for char in set(text):
        if char in ' \n\t':
            continue
        try:
            if font.getmask(char).getbbox() is None:
                missing.add(char)
        except Exception:
            missing.add(char)
    return missing


# --------------------------------------------------------------------------
# the text
# --------------------------------------------------------------------------

def wrap_text(draw, text, font, max_width):
    """Wrap a line to a pixel width. Long words are broken, not overflowed.

    A lyric line that runs off the edge of the picture is worse than one
    that wraps: the reader loses the END of the sentence, which is the part
    that lands.
    """
    words = str(text).split()
    if not words:
        return []
    lines = []
    current = ''
    for word in words:
        # A single word longer than the line is broken by character. This
        # check is per word, NOT per candidate: a lyric line that is ONE
        # very long word never reaches the candidate branch below, and it
        # ran off the edge of the picture.
        if draw.textlength(word, font=font) > max_width:
            if current:
                lines.append(current)
                current = ''
            piece = ''
            for char in word:
                if piece and draw.textlength(piece + char, font=font) > max_width:
                    lines.append(piece)
                    piece = char
                else:
                    piece += char
            current = piece
            continue
        candidate = word if not current else current + ' ' + word
        if draw.textlength(candidate, font=font) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def layout(text, width, height, size=None, max_width=None, bottom_margin=None):
    """Where the text goes, and in how many lines.

    Pure-ish: it needs a Pillow draw object to measure with, but it returns
    plain data, so the arithmetic can be tested without a font.
    """
    Image, ImageDraw, _ = _pillow()
    font_size = int(round((size if size is not None else DEFAULT_SIZE) * height))
    font = load_font(font_size)
    if font is None:
        return None
    # A 1x1 image is enough to MEASURE with — the draw object is where
    # textlength lives, and it needs an image to draw on, not a real one.
    draw = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    limit = int(round((max_width if max_width is not None else MAX_WIDTH) * width))
    lines = wrap_text(draw, text, font, limit)
    if not lines:
        return None
    line_height = int(round(font_size * LINE_SPACING))
    block_height = line_height * len(lines)
    bottom = int(round(height * (1.0 - (bottom_margin if bottom_margin is not None else BOTTOM_MARGIN))))
    top = bottom - block_height
    return {
        'lines': lines,
        'font': font,
        'font_size': font_size,
        'line_height': line_height,
        'top': max(0, top),
        'bottom': min(height, bottom),
        'block_height': block_height,
        'width': width,
        'height': height,
    }


def render_overlay(text, width, height, alpha=255, colour=CREAM, size=None,
                   max_width=None, bottom_margin=None, shadow=True):
    """One frame of the lyric as raw RGBA bytes.

    The text is drawn with a dark shadow behind it. The picture behind a
    lyric is a still from a music video — it can be black or it can be
    cream, and cream text on a cream picture is invisible. The shadow is
    what makes the text legible on ANY picture, which is why it is on by
    default.
    """
    Image, ImageDraw, _ = _pillow()
    if Image is None:
        return None
    plan = layout(text, width, height, size=size, max_width=max_width,
                  bottom_margin=bottom_margin)
    if plan is None:
        return None

    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(plan['lines']):
        y = plan['top'] + i * plan['line_height']
        line_width = draw.textlength(line, font=plan['font'])
        x = (width - line_width) / 2.0
        if shadow:
            # A soft dark halo: three offsets, so the glyph has a dark edge
            # on every side rather than one hard shadow.
            for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2)):
                draw.text((x + dx, y + dy), line, font=plan['font'],
                          fill=(12, 14, 20, min(255, alpha)))
        draw.text((x, y), line, font=plan['font'], fill=colour + (alpha,))
    return image.tobytes()


# --------------------------------------------------------------------------
# the timeline
# --------------------------------------------------------------------------

def shot_windows(cutlist, fade=None):
    """Each shot's start and end on the finished film, in seconds.

    The renderer JOINS the shots, and with a crossfade they OVERLAP: the
    xfade offset is `sum(durations before it) - i * fade`, so the second
    shot starts before the first one ends. A lyric timed as if the shots
    were back to back lands on the wrong picture — measured against the
    real renderer, the 4s+4s/fade-1 case puts the second shot's transition
    at 3.000s, not at 4.000s.

    So the window is the shot's DOMINANT span: from the moment it starts
    to take over to the moment the next one does. With a crossfade that is
    the midpoint of each dissolve, which is exactly where the picture
    crosses half-and-half — and it keeps the windows from overlapping, so
    two lyrics are never on the screen at once.

    The arithmetic is the renderer's own: `lib/render/plan.mjs` computes
    the join offset as `sum(segments before) - i * fade`, and the film's
    total as `sum(durations) - (n - 1) * fade`.
    """
    shots = cutlist.get('shots') or []
    durations = cutlist.get('durations') or []
    if not shots:
        return []
    if len(durations) != len(shots):
        durations = [float(s.get('duration') or 0.0) for s in shots]
    durations = [float(d) for d in durations]

    transition = cutlist.get('transition') or 'none'
    fade_value = float(cutlist.get('fade', 0.6) if fade is None else fade)
    # A dissolve cannot be longer than half the shortest shot it joins —
    # the renderer's rule, and the lyrics must use the SAME fade or they
    # drift from the picture.
    if transition == 'crossfade' and len(shots) > 1 and durations:
        fade_value = min(fade_value, min(durations) * 0.5)
    elif transition != 'crossfade':
        fade_value = 0.0

    count = len(shots)
    total = sum(durations) - (count - 1) * fade_value

    def start_of(index):
        """When shot `index` starts to take over the picture."""
        if index == 0:
            return 0.0
        # The join before this shot sits at sum(before) - index*fade; the
        # picture crosses half-and-half a half-dissolve later.
        return sum(durations[:index]) - index * fade_value + fade_value / 2.0

    def end_of(index):
        """When shot `index` stops being the dominant picture."""
        if index == count - 1:
            return total
        return sum(durations[:index + 1]) - (index + 1) * fade_value + fade_value / 2.0

    windows = []
    for i, shot in enumerate(shots):
        windows.append({
            'index': i,
            'line': shot.get('line') or '',
            'start': start_of(i),
            'end': end_of(i),
            'duration': durations[i] if i < len(durations) else 0.0,
        })
    return windows


def alpha_at(window, now, fade_in=0.4, fade_out=0.4):
    """The lyric's opacity at a moment in the film. 0 = invisible."""
    if now < window['start'] or now > window['end']:
        return 0.0
    since = now - window['start']
    until = window['end'] - now
    if fade_in > 0:
        since = min(since, fade_in)
    else:
        since = 1.0
    if fade_out > 0:
        until = min(until, fade_out)
    else:
        until = 1.0
    return max(0.0, min(1.0, min(since, until) / max(fade_in, fade_out, 0.001)))


# --------------------------------------------------------------------------
# the overlay
# --------------------------------------------------------------------------

def build_ffmpeg_command(ffmpeg, video, out_path, width, height, fps):
    """The ffmpeg argv for the overlay.

    Split out so the ORDER can be asserted in a test. The order is not a
    detail: the overlay is input 0 and the film is input 1, so
    `[1:v][0:v]overlay` lays the text ON the film. The other way round
    paints the opaque film on top of the text, and the text disappears —
    the first run wrote 180 frames and changed ZERO pixels, and exited 0.
    """
    return [
        ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
        # INPUT 0 — the overlay, streamed in as raw RGBA.
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', '%dx%d' % (width, height),
        '-r', str(fps), '-i', 'pipe:0',
        # INPUT 1 — the film.
        '-i', video,
        # So: the film is the BASE, the overlay goes on top.
        '-filter_complex', '[1:v][0:v]overlay=0:0:format=auto[v]',
        '-map', '[v]',
        # The film's own audio is the music — it is mapped and copied, not
        # dropped. A lyric video without the song is a silent video.
        '-map', '1:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-color_range', 'tv',
        '-c:a', 'copy', '-shortest',
        '-movflags', '+faststart',
        out_path,
    ]


def apply_lyrics(cutlist, video, out_path, size=None, max_width=None,
                  bottom_margin=None, fade_in=0.4, fade_out=0.4,
                  colour=CREAM, timeout=3600):
    """Burn the lyrics into a film. Returns the number of frames written."""
    Image, _, _ = _pillow()
    if Image is None:
        raise RuntimeError('Pillow is not available — run: uv sync --project lib/story')

    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is not on PATH')
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        raise RuntimeError('ffprobe is not on PATH')

    width, height = probe_size(ffprobe, video)
    windows = shot_windows(cutlist)
    if not windows:
        raise ValueError('the cut list holds no shots')

    duration = probe_duration(ffprobe, video)
    if duration <= 0:
        raise ValueError('the film has no readable duration')
    fps = 30

    # The overlay is drawn once per output frame and streamed, exactly as
    # waveform.py streams its lines. Writing it to a file first would be a
    # 1920x1080x4 byte file per frame — gigabytes for a long film — and the
    # disk was 99% full the last time that was tried.
    command = build_ffmpeg_command(ffmpeg, video, out_path, width, height, fps)

    frames = int(round(duration * fps))
    process = subprocess.Popen(command, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in range(frames):
            now = frame / float(fps)
            alpha = 0
            line = ''
            for window in windows:
                value = alpha_at(window, now, fade_in, fade_out)
                if value > alpha:
                    alpha = value
                    line = window['line']
            if alpha <= 0.0 or not line.strip():
                frame_bytes = b'\x00' * (width * height * 4)
            else:
                frame_bytes = render_overlay(line, width, height,
                                             alpha=int(round(alpha * 255)),
                                             colour=colour, size=size,
                                             max_width=max_width,
                                             bottom_margin=bottom_margin)
                if frame_bytes is None:
                    frame_bytes = b'\x00' * (width * height * 4)
            process.stdin.write(frame_bytes)
        process.stdin.close()
    except BrokenPipeError:
        pass
    code = process.wait(timeout=timeout)
    if code != 0:
        detail = process.stderr.read().decode('utf8', 'replace').strip().splitlines()
        raise RuntimeError(detail[-1] if detail else 'ffmpeg failed')
    return frames


def probe_size(ffprobe, video):
    result = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video],
        capture_output=True, timeout=60)
    if result.returncode != 0:
        raise ValueError('the film has no readable video stream')
    text = result.stdout.decode('utf8', 'replace').strip()
    parts = text.split(',')
    if len(parts) < 2:
        raise ValueError('the film has no readable video stream')
    return int(parts[0]), int(parts[1])


def probe_duration(ffprobe, video):
    result = subprocess.run(
        [ffprobe, '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', video],
        capture_output=True, timeout=60)
    if result.returncode != 0:
        return 0.0
    try:
        return float(result.stdout.decode('utf8', 'replace').strip())
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--cutlist', required=True, help='the cut list the director wrote')
    parser.add_argument('--video', required=True, help='the film to put the words on')
    parser.add_argument('--out', required=True, help='where the film with words goes')
    parser.add_argument('--size', type=float, default=None,
                        help='the type size, as a fraction of the height (default 0.045)')
    parser.add_argument('--max-width', type=float, default=None,
                        help='the wrap width, as a fraction of the picture (default 0.78)')
    parser.add_argument('--bottom', type=float, default=None,
                        help='the baseline, as a fraction up from the bottom (default 0.10)')
    parser.add_argument('--fade-in', type=float, default=0.4, help='seconds to fade in')
    parser.add_argument('--fade-out', type=float, default=0.4, help='seconds to fade out')
    parser.add_argument('--dry-run', action='store_true',
                        help='print the plan, run nothing')
    args = parser.parse_args()

    try:
        with open(args.cutlist) as handle:
            cutlist = json.load(handle)
    except (OSError, ValueError) as exc:
        log('the cut list is unreadable: %s' % exc)
        return 2

    windows = shot_windows(cutlist)
    if not windows:
        log('the cut list holds no shots')
        return 2

    if args.dry_run:
        print('%d shot(s) -> %s' % (len(windows), args.out))
        for window in windows:
            print('  %6.2fs -> %6.2fs  %s'
                  % (window['start'], window['end'], window['line'][:60]))
        return 0

    try:
        frames = apply_lyrics(cutlist, args.video, args.out, size=args.size,
                               max_width=args.max_width, bottom_margin=args.bottom,
                               fade_in=args.fade_in, fade_out=args.fade_out)
    except ValueError as exc:
        log(str(exc))
        return 2
    except RuntimeError as exc:
        log(str(exc))
        return 3
    except OSError as exc:
        log(str(exc))
        return 3

    print('%d frames -> %s' % (frames, os.path.abspath(args.out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
