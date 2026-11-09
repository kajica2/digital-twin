#!/usr/bin/env python3
"""lib/story/media.py — the twin's media library: a shelf of the clips it owns.

The director cuts FRAMES into a music video. This is where the VIDEO comes
from: a library of clips the twin has ingested, each one probed once
(duration, shape, frame rate, codec, whether it carries sound) and recorded
by content hash, so the same file dropped twice is one file.

    python3 lib/story/media.py ingest ~/Movies/*.mp4      # add to the library
    python3 lib/story/media.py list                        # what is on the shelf
    python3 lib/story/media.py extract <clip> --out frames # frames for the director

Pure stdlib. `ffprobe` is the only external tool — probing a container does
not need a 476 MB virtualenv, and the one that does (PyAV) stays where it
earns its keep: frame-accurate decode in waveform.py.

Exit:
  0  on success
  2  on bad input (a missing file, an unreadable clip, a bad flag)
  3  on a runtime failure (ffprobe missing, a write that failed)
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DESCRIPTION = "The twin's media library — a shelf of the clips it owns."

# The library: clips on the shelf, and the index that says what is on it.
MEDIA_DIR = os.path.join(REPO, 'lib', 'story', 'media')
CLIPS_DIR = os.path.join(MEDIA_DIR, 'clips')
INDEX_PATH = os.path.join(MEDIA_DIR, 'index.jsonl')

VIDEO_EXTS = ('.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.ts')

# The name a clip gets on the shelf: its own stem, normalised, plus the day
# it arrived. The day keeps two drops of differently-named-but-identical
# material apart, and the stem keeps the provenance ("kisna-soba-ep1-ep2").
SLUG_MAX = 60


def log(msg):
    sys.stderr.write('[media] %s\n' % msg)


# --------------------------------------------------------------------------
# naming
# --------------------------------------------------------------------------

def slug(stem, when=None):
    """A safe filename stem: lowercase, ASCII, dashes, and the day it arrived.

    Non-ASCII characters are separators, not letters: "ne može biti to" becomes
    "ne-mo-e-biti-to". The original name is not lost — the index records the
    source basename — so a lossy slug costs nothing.
    """
    when = when or dt.date.today()
    cleaned = re.sub(r'[^a-z0-9]+', '-', str(stem).lower()).strip('-')[:SLUG_MAX]
    cleaned = cleaned.strip('-') or 'clip'
    return '%s-%s' % (cleaned, when.strftime('%Y%m%d'))


def source_label(path, keep_abspath=False):
    """What the index records about where a clip came from.

    The basename by default. An absolute path names the author's filesystem
    layout, and the index travels (it is pasted, shared, read by other
    tools); `--keep-abspath` keeps it for local debugging only.
    """
    if keep_abspath:
        return os.path.abspath(path)
    return os.path.basename(path)


# --------------------------------------------------------------------------
# the probe
# --------------------------------------------------------------------------

def sha256(path, buf=1 << 20):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(buf), b''):
            digest.update(chunk)
    return digest.hexdigest()


def parse_fraction(text):
    """'30/1' -> 30.0. None when it is not a fraction."""
    if not text:
        return None
    try:
        num, _, den = str(text).partition('/')
        den_value = float(den) if den else 1.0
        if den_value == 0:
            return None
        return float(num) / den_value
    except (TypeError, ValueError):
        return None


def parse_probe(payload):
    """An ffprobe JSON payload -> the record fields the index keeps.

    Pure, so it can be tested against a fixture without ffprobe installed.
    A container that does not carry a field yields None for it rather than
    raising — a clip with no audio is normal, not broken.
    """
    streams = payload.get('streams') or []
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)

    duration = (payload.get('format') or {}).get('duration')
    try:
        duration = round(float(duration), 3)   # type: ignore[arg-type]
    except (TypeError, ValueError):
        duration = None

    frames = video.get('nb_frames') if video else None
    try:
        frames = int(frames)                  # type: ignore[arg-type]
    except (TypeError, ValueError):
        frames = None

    record = {
        'duration_s': duration,
        'width': video.get('width') if video else None,
        'height': video.get('height') if video else None,
        'fps': parse_fraction(video.get('r_frame_rate') if video else None),
        'v_codec': video.get('codec_name') if video else None,
        'frames': frames,
        'audio': None,
    }
    if audio is not None:
        try:
            sample_rate = int(audio.get('sample_rate'))
        except (TypeError, ValueError):
            sample_rate = None
        record['audio'] = {
            'codec': audio.get('codec_name'),
            'sample_rate': sample_rate,
            'channels': audio.get('channels'),
        }
    return record


def probe(path, timeout=60):
    """Probe one file with ffprobe. Raises RuntimeError when it cannot be read."""
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        raise RuntimeError('ffprobe is not on PATH')
    cmd = [
        ffprobe, '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels',
        '-of', 'json', path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError('ffprobe failed: %s' % exc)
    if result.returncode != 0:
        detail = result.stderr.decode('utf8', 'replace').strip().splitlines()
        raise RuntimeError(detail[-1] if detail else 'ffprobe could not read the file')
    try:
        payload = json.loads(result.stdout.decode('utf8', 'replace'))
    except ValueError as exc:
        raise RuntimeError('ffprobe returned unreadable JSON: %s' % exc)
    if not any(s.get('codec_type') == 'video' for s in (payload.get('streams') or [])):
        raise RuntimeError('no video stream in the file')
    return parse_probe(payload)


# --------------------------------------------------------------------------
# the index
# --------------------------------------------------------------------------

def read_index(index_path=INDEX_PATH):
    """Every record on the shelf, in the order it was ingested."""
    if not os.path.exists(index_path):
        return []
    records = []
    with open(index_path, 'r') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except ValueError:
                # A torn line (an interrupted write) must not take the whole
                # index down with it.
                log('skipping an unreadable index line')
    return records


def write_index(records, index_path=INDEX_PATH):
    """Rewrite the index. Atomic: the file is replaced, never truncated."""
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    tmp = index_path + '.tmp'
    with open(tmp, 'w') as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + '\n')
    os.replace(tmp, index_path)


def upsert_index(record, index_path=INDEX_PATH):
    """Put a record in the index, keyed by the clip's name.

    Re-ingesting the same name replaces its record rather than appending a
    second line for it — otherwise `--force` grows the index every run.
    """
    records = read_index(index_path)
    replaced = False
    for i, existing in enumerate(records):
        if existing.get('file') == record.get('file'):
            records[i] = record
            replaced = True
            break
    if not replaced:
        records.append(record)
    write_index(records, index_path)
    return replaced


def find_by_sha(digest, index_path=INDEX_PATH):
    """The record for a content hash, or None."""
    for record in read_index(index_path):
        if record.get('sha256') == digest:
            return record
    return None


# --------------------------------------------------------------------------
# ingest
# --------------------------------------------------------------------------

def ingest(paths, library=CLIPS_DIR, index_path=INDEX_PATH, move=False,
           force=False, keep_abspath=False, dry_run=False, when=None):
    """Add files to the library. Returns a summary dict."""
    os.makedirs(library, exist_ok=True)
    summary = {'added': 0, 'skipped': 0, 'failed': 0, 'rows': []}

    for raw in paths:
        src = os.path.abspath(os.path.expanduser(raw))
        name = os.path.basename(src)

        if not os.path.isfile(src):
            summary['failed'] += 1
            summary['rows'].append((name, '-', 'FAILED: not a file', ''))
            continue
        if not name.lower().endswith(VIDEO_EXTS):
            summary['skipped'] += 1
            summary['rows'].append((name, '-', 'not a video', ''))
            continue

        try:
            digest = sha256(src)
        except OSError as exc:
            summary['failed'] += 1
            summary['rows'].append((name, '-', 'FAILED: unreadable', str(exc)[:40]))
            continue

        existing = find_by_sha(digest, index_path)
        if existing and not force:
            summary['skipped'] += 1
            summary['rows'].append((name, existing.get('file', '-'), 'duplicate', ''))
            continue

        # Probe before touching the disk: a file that cannot be read must
        # not leave a half-copied clip on the shelf.
        try:
            meta = probe(src)
        except RuntimeError as exc:
            summary['failed'] += 1
            summary['rows'].append((name, '-', 'FAILED: unreadable', str(exc)[:40]))
            continue

        stem, ext = os.path.splitext(name)
        target = slug(stem, when) + ext.lower()
        counter = 1
        while os.path.exists(os.path.join(library, target)) and not force:
            target = '%s-%d%s' % (slug(stem, when), counter, ext.lower())
            counter += 1
        dst = os.path.join(library, target)

        if dry_run:
            summary['rows'].append((name, target, 'would ingest',
                                    '%ss %sx%s' % (meta['duration_s'], meta['width'], meta['height'])))
            continue

        try:
            if move:
                shutil.move(src, dst)
            else:
                shutil.copy2(src, dst)
        except (OSError, shutil.Error) as exc:
            summary['failed'] += 1
            summary['rows'].append((name, target, 'FAILED: copy', str(exc)[:40]))
            continue

        record = {
            'file': target,
            'sha256': digest,
            'bytes': os.path.getsize(dst),
            'source': source_label(raw, keep_abspath),
            'ingested_at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        }
        record.update(meta)
        upsert_index(record, index_path)

        summary['added'] += 1
        summary['rows'].append((name, target, 'ingested',
                                '%ss %sx%s' % (meta['duration_s'], meta['width'], meta['height'])))

    return summary


# --------------------------------------------------------------------------
# list
# --------------------------------------------------------------------------

def format_duration(seconds):
    if not seconds:
        return '-'
    minutes, rest = divmod(float(seconds), 60)
    return '%d:%02d' % (int(minutes), int(round(rest)))


def list_library(index_path=INDEX_PATH):
    """The shelf, as a table. Returns the rows so a caller can render them."""
    rows = []
    for record in read_index(index_path):
        rows.append({
            'file': record.get('file', '?'),
            'duration': format_duration(record.get('duration_s')),
            'shape': '%sx%s' % (record.get('width') or '?', record.get('height') or '?'),
            'fps': record.get('fps') or '-',
            'codec': record.get('v_codec') or '-',
            'sound': 'yes' if record.get('audio') else 'no',
            'size_mb': round(record.get('bytes', 0) / 1e6, 1),
            'source': record.get('source', '-'),
        })
    return rows


def render_list(rows):
    if not rows:
        return 'the library is empty'
    columns = (('file', 'file'), ('len', 'duration'), ('shape', 'shape'),
               ('fps', 'fps'), ('codec', 'codec'), ('snd', 'sound'),
               ('MB', 'size_mb'), ('source', 'source'))
    # Size each column to its own content. A fixed width overflows the moment
    # a clip has a long name, and the row stops lining up with its header.
    widths = []
    for _, key in columns:
        longest = max([len(str(r[key])) for r in rows] + [len(key)])
        widths.append(min(longest, 44))
    lines = ['  '.join('%-*s' % (w, v) for w, (_, v) in zip(widths, columns))]
    for row in rows:
        lines.append('  '.join('%-*s' % (w, str(row[key])) for w, (_, key) in zip(widths, columns)))
    return '\n'.join(lines)


# --------------------------------------------------------------------------
# extract — frames for the director
# --------------------------------------------------------------------------

def resolve_clip(name, library=CLIPS_DIR, index_path=INDEX_PATH):
    """Find a clip by path, by exact library name, or by stem.

    The shelf holds dated names ("foo-20261109.mp4"); the operator remembers
    "foo". A stem that matches one clip exactly wins; several matches is an
    error rather than a guess.
    """
    candidate = os.path.abspath(os.path.expanduser(name))
    if os.path.isfile(candidate):
        return candidate

    records = read_index(index_path)
    for record in records:
        if record.get('file') == name:
            return os.path.join(library, record['file'])

    stem = os.path.splitext(os.path.basename(name))[0].lower()
    matches = [r for r in records
               if os.path.splitext(r.get('file', ''))[0].lower().startswith(stem)]
    if len(matches) == 1:
        return os.path.join(library, matches[0]['file'])
    if len(matches) > 1:
        raise ValueError('"%s" matches %d clips: %s'
                         % (name, len(matches),
                            ', '.join(m['file'] for m in matches)))
    raise ValueError('no clip called "%s" in the library' % name)


def extract(clip, out_dir, fps=1.0, start=None, duration=None, library=CLIPS_DIR,
            index_path=INDEX_PATH):
    """Pull frames out of a clip so the director can cut them.

    The director wants stills; a clip is a run of them. `--fps` sets how
    many frames a second are taken, `--start` and `--duration` window into
    the clip. Writes numbered JPEGs and returns their paths.
    """
    path = resolve_clip(clip, library, index_path)
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is not on PATH')
    if fps <= 0:
        raise ValueError('--fps must be greater than zero')

    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, '%04d.jpg')

    cmd = [ffmpeg, '-y', '-loglevel', 'error']
    if start is not None:
        cmd += ['-ss', str(start)]
    cmd += ['-i', path]
    if duration is not None:
        cmd += ['-t', str(duration)]
    cmd += ['-vf', 'fps=%s' % fps, '-q:v', '2', pattern]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=1800)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError('ffmpeg failed: %s' % exc)
    if result.returncode != 0:
        detail = result.stderr.decode('utf8', 'replace').strip().splitlines()
        raise RuntimeError(detail[-1] if detail else 'ffmpeg could not read the clip')

    return sorted(os.path.join(out_dir, n) for n in os.listdir(out_dir) if n.endswith('.jpg'))


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument('--dest', help='the library directory (default lib/story/media)')
    parser.add_argument('--keep-abspath', action='store_true',
                        help='record the absolute source path (debug only)')
    sub = parser.add_subparsers(dest='command')

    add = sub.add_parser('ingest', help='add files to the library')
    add.add_argument('files', nargs='+', help='video files to ingest')
    add.add_argument('--move', action='store_true', help='move instead of copy')
    add.add_argument('--force', action='store_true', help='re-ingest a known file')
    add.add_argument('--dry-run', action='store_true', help='say what would happen, do nothing')

    show = sub.add_parser('list', help='what is on the shelf')
    show.add_argument('--json', action='store_true', help='machine-readable output')

    cut = sub.add_parser('extract', help='pull frames out of a clip')
    cut.add_argument('clip', help='a path, a library name, or a stem')
    cut.add_argument('--out', required=True, help='where the frames go')
    cut.add_argument('--fps', type=float, default=1.0, help='frames per second (default 1)')
    cut.add_argument('--start', type=float, help='start this many seconds in')
    cut.add_argument('--duration', type=float, help='take this many seconds')

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 2

    library = os.path.abspath(os.path.expanduser(args.dest)) if args.dest else MEDIA_DIR
    clips = os.path.join(library, 'clips')
    index_path = os.path.join(library, 'index.jsonl')

    try:
        if args.command == 'ingest':
            summary = ingest(args.files, library=clips, index_path=index_path,
                             move=args.move, force=args.force,
                             keep_abspath=args.keep_abspath, dry_run=args.dry_run)
            width = max((len(row[0]) for row in summary['rows']), default=4)
            for src, dst, status, info in summary['rows']:
                print('  %s  %s  %s  %s' % (src[:width].ljust(width), dst.ljust(34),
                                             status.ljust(22), info))
            print('\n  %d ingested · %d skipped · %d failed%s  ->  %s'
                  % (summary['added'], summary['skipped'], summary['failed'],
                     '  (dry run)' if args.dry_run else '', library))
            return 1 if summary['failed'] and not summary['added'] else 0

        if args.command == 'list':
            rows = list_library(index_path)
            if args.json:
                print(json.dumps(rows, indent=2))
            else:
                print(render_list(rows))
            return 0

        if args.command == 'extract':
            frames = extract(args.clip, args.out, fps=args.fps, start=args.start,
                             duration=args.duration, library=clips, index_path=index_path)
            print('%d frames -> %s' % (len(frames), os.path.abspath(args.out)))
            return 0

    except ValueError as exc:
        log(str(exc))
        return 2
    except RuntimeError as exc:
        log(str(exc))
        return 3
    except OSError as exc:
        log(str(exc))
        return 3

    return 2


if __name__ == '__main__':
    sys.exit(main())
