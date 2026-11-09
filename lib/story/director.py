#!/usr/bin/env python3
"""lib/story/director.py — decide which frames make the cut, and how.

A lyric video is a set of stills and a set of lines. The naive join is
one frame per line in file order, which is how a slideshow happens. The
director instead treats it as a selection problem:

  1. MEASURE every candidate frame — softness, exposure, and a perceptual
     hash (ffmpeg does all three; nothing is loaded into Python).
  2. REJECT the technically broken ones: unreadable, too soft, crushed or
     blown out.
  3. COLLAPSE near-duplicates: the same frame re-rolled, or two cells of
     one Midjourney grid, are one shot. The better of the pair survives.
  4. MATCH what survives to the lyric: CLIP ranks every (frame, line)
     pair, each line claims its best frame, and every frame that no line
     claims is CUT.
  5. PLAN the cut: per-shot duration on the beat grid, a camera move per
     shot, a look per shot, and a grade for the whole thing.

Step 4 is a RANKING, not a verdict. CLIP is good at "is this a room with
a door" and bad at "is this the room with the door that opened by
itself". The director therefore reports every decision with its reason
and its score, and writes a contact sheet so the decision can be looked
at. A director that cannot be argued with is not a director.

Pure stdlib (ffmpeg is the only external tool). Python 3.9 compatible.

    from director import Director
    d = Director(lines)
    plan = d.plan(candidates)
    print(plan.report())
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from array import array

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

IMAGE_EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp')

# A frame softer than this is a mistake, not a look: ffmpeg's blurdetect
# reads ~5 on a sharp frame, ~3 on the linocut stills this repo renders and
# ~52 on a frame blurred with sigma=12.
BLUR_MAX = 24.0
# YAVG is the luma average (0-255) and SPREAD is YMAX-YMIN. A frame whose
# whole range sits in a sliver is a flat frame — a white wall or a black
# hole, not an image.
YAVG_MIN = 6.0
YAVG_MAX = 249.0
SPREAD_MIN = 40.0
# Two dhashes within this many bits are the same picture.
#
# Measured on the 60-frame Breath Forgets the Count set: byte-identical
# copies sit at distance 0, and the nearest two DISTINCT frames (two cells
# of one Midjourney grid, which are different pictures) sit at distance 6.
# A threshold of 8 was collapsing real frames; 3 keeps the copies and
# nothing else.
DUP_BITS = 3

MOTIONS = ('zoom-in', 'zoom-out', 'pan-left')


# --------------------------------------------------------------------------
# ffmpeg helpers
# --------------------------------------------------------------------------

def _ffmpeg(args, timeout=60, loglevel='error'):
    try:
        return subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', loglevel] + args,
            capture_output=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _ffprobe_duration(path):
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, timeout=60,
        ).stdout.decode('utf8', 'replace').strip()
        value = float(out)
        return value if value > 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def measure_frame(path):
    """The three measurements the director needs from one frame.

    `blur` is ffmpeg's blurdetect mean (higher = softer), `yavg` the luma
    average, `spread` YMAX-YMIN (the frame's whole tonal range), and `dhash`
    a 64-bit difference hash for near-duplicate detection.
    """
    # Absolute, because the caller's cwd is not the renderer's cwd, and a
    # relative path that resolves against the wrong directory reads as an
    # unreadable frame.
    path = os.path.abspath(path)
    result = {'path': path, 'ok': False, 'blur': None, 'yavg': None,
              'spread': None, 'dhash': None, 'reason': None}

    # The stats go to a FILE, never to stdout. Two reasons, both measured:
    # a WebP carries an XMP block that ffmpeg copies into the metadata
    # stream, and a byte sequence inside it can split a stats line in two
    # ("...YAVG=" / "105.207") — so the file is read with a regex over the
    # whole content rather than line by line. And `-f null -` plus
    # `metadata=print:file=-` both claim stdout, which made the read
    # intermittently come back empty — a frame that could not be measured
    # would have been cut from the film for no reason.
    stats_file = os.path.join(tempfile.mkdtemp(prefix='dt-measure-'), 'stats.txt')
    try:
        _ffmpeg(['-i', path, '-map_metadata', '-1',
                 '-vf', 'signalstats,metadata=print:file=%s' % stats_file,
                 '-f', 'null', os.devnull])
        try:
            with open(stats_file, 'rb') as handle:
                text = handle.read().decode('utf8', 'replace')
        except OSError:
            result['reason'] = 'cannot decode'
            return result
    finally:
        shutil.rmtree(os.path.dirname(stats_file), ignore_errors=True)

    values = {}
    for key in ('YMIN', 'YAVG', 'YMAX'):
        found = re.search(r'signalstats\.%s=([0-9.]+)' % key, text)
        if found:
            values[key] = found.group(1)
    try:
        ymin = float(values['YMIN'])
        yavg = float(values['YAVG'])
        ymax = float(values['YMAX'])
    except (KeyError, ValueError):
        result['reason'] = 'cannot decode'
        return result
    result['yavg'] = yavg
    result['spread'] = ymax - ymin

    # blurdetect prints its metric at INFO level, so this call cannot use the
    # error-only loglevel the other two use.
    blur = _ffmpeg(['-i', path, '-vf', 'blurdetect', '-f', 'null', '-'], loglevel='info')
    if blur is not None:
        match = re.search(r'blur mean:\s*([0-9.]+)', blur.stderr.decode('utf8', 'replace'))
        if match:
            result['blur'] = float(match.group(1))

    raw = _ffmpeg(['-i', path, '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-'])
    if raw is not None and len(raw.stdout) == 72:
        data = raw.stdout
        bits = 0
        for row in range(8):
            for col in range(8):
                bits = (bits << 1) | (1 if data[row * 9 + col] > data[row * 9 + col + 1] else 0)
        result['dhash'] = bits

    result['ok'] = result['reason'] is None
    return result


def hamming(a, b):
    """Bits that differ between two dhashes."""
    return bin(a ^ b).count('1')


# --------------------------------------------------------------------------
# beats, measured from the track
# --------------------------------------------------------------------------

def beat_grid(track_path, hop=512, sample_rate=16000):
    """Beat times in seconds, from the track's own energy envelope.

    The audio is decoded to mono 16-bit PCM by ffmpeg and the energy of
    each hop is computed here; the tempo is the strongest periodicity in
    that envelope, and the beats are the peaks that follow it. No
    dependencies: the array module reads the PCM, everything else is
    arithmetic.

    Returns (beats, bpm). `beats` is empty when the track cannot be read.
    """
    decoded = _ffmpeg(['-i', track_path, '-ac', '1', '-ar', str(sample_rate),
                       '-f', 's16le', '-'], timeout=300)
    if decoded is None or not decoded.stdout:
        return [], 0.0

    samples = array('h')
    samples.frombytes(decoded.stdout[:len(decoded.stdout) - (len(decoded.stdout) % 2)])

    frames = len(samples) // hop
    if frames < 32:
        return [], 0.0

    energy = [0.0] * frames
    for i in range(frames):
        chunk = samples[i * hop:(i + 1) * hop]
        total = 0
        for value in chunk:
            total += value * value
        energy[i] = (total / float(len(chunk))) ** 0.5

    # The envelope's difference is what spikes on a transient.
    onset = [0.0]
    for i in range(1, frames):
        delta = energy[i] - energy[i - 1]
        onset.append(delta if delta > 0 else 0.0)

    # Tempo: the lag whose periodicity in the onset envelope is strongest,
    # searched over 60-200 BPM.
    fps = sample_rate / float(hop)
    min_lag = max(1, int(fps * 60.0 / 200.0))
    max_lag = min(frames - 1, int(fps * 60.0 / 60.0))
    best_lag, best_score = 0, -1.0
    for lag in range(min_lag, max_lag + 1):
        score = 0.0
        for i in range(lag, frames):
            score += onset[i] * onset[i - lag]
        if score > best_score:
            best_score, best_lag = score, lag
    if not best_lag:
        return [], 0.0
    bpm = 60.0 * fps / best_lag

    # Beats: the strongest onset inside each period, walked forward.
    beats = []
    index = 0
    while index < frames:
        window = range(index, min(index + best_lag, frames))
        peak = max(window, key=lambda i: onset[i])
        beats.append(peak / fps)
        index += best_lag
    return beats, round(bpm, 2)


def energy_envelope(track_path, hop=1024, sample_rate=16000):
    """The track's loudness over time: (seconds, rms) pairs.

    The PCM is decoded by ffmpeg and read here with the array module —
    no numpy, no dependency.
    """
    decoded = _ffmpeg(['-i', track_path, '-ac', '1', '-ar', str(sample_rate),
                       '-f', 's16le', '-'], timeout=300)
    if decoded is None or not decoded.stdout:
        return []
    samples = array('h')
    samples.frombytes(decoded.stdout[:len(decoded.stdout) - (len(decoded.stdout) % 2)])
    hop_samples = int(sample_rate * hop / 1000.0)
    out = []
    for index in range(0, max(0, len(samples) - hop_samples), hop_samples):
        chunk = samples[index:index + hop_samples]
        total = 0
        for value in chunk:
            total += value * value
        out.append((index / float(sample_rate), (total / float(len(chunk))) ** 0.5))
    return out


def cracks(track_path, minimum=0.4, hop=1024):
    """The moments where the song CRACKS — the quiet passages between movements.

    A crack is a stretch of near-silence inside a track that is otherwise
    loud. It is where the music opens up, and it is where a dissolve
    belongs: a cut placed on the crack reads as the film breathing with
    the song, and a cut placed on a steady beat in the middle of a crack
    reads as the film missing it.

    Measured on "november_8 — Geometric Shadow Box": the crack runs from
    148.06 s to 155.86 s, and the track's own tail is quiet after it.
    """
    envelope = energy_envelope(track_path, hop=hop)
    if len(envelope) < 20:
        return []
    levels = sorted(level for _, level in envelope)
    floor = levels[int(len(levels) * 0.05)]
    threshold = max(1.0, floor * 1.8)

    out = []
    run = None
    for seconds, level in envelope:
        if level < threshold:
            if run is None:
                run = seconds
        else:
            if run is not None and seconds - run >= minimum:
                out.append((round(run, 3), round(seconds, 3)))
            run = None
    if run is not None:
        out.append((round(run, 3), round(envelope[-1][0], 3)))
    return out


_CRACK_CACHE = {}


def crack_windows(track_path):
    """The track's cracks, computed once per path."""
    if not track_path:
        return []
    if track_path not in _CRACK_CACHE:
        _CRACK_CACHE[track_path] = cracks(track_path)
    return _CRACK_CACHE[track_path]


def durations_on_grid(count, track_path=None, minimum=1.2, maximum=12.0, fade=0.0):
    """Seconds per shot: the cuts land on beats and the film covers the song.

    A dissolve makes consecutive shots OVERLAP by the fade, so the film's
    length is `sum(durations) - (shots - 1) * fade`. The durations are
    therefore derived from the CUT POSITIONS rather than from the shot
    count: the cuts are placed on the track's beats, and each shot is
    given the distance to the next cut PLUS the fade it shares with it.

    That makes both things true at once: the cuts sit on the beat, and
    the finished film is exactly as long as the song. Spreading the shots
    evenly instead made the film come out (shots - 1) x fade short, and
    the song was cut off at the end.
    """
    if not track_path:
        return [3.0] * count

    beats, _ = beat_grid(track_path)
    seconds = _ffprobe_duration(track_path)
    if not seconds or count < 1:
        return [3.0] * count

    if beats and len(beats) >= 2:
        # One cut per boundary. A boundary lands on a CRACK when the song
        # has one near where it should be — the film then breathes with the
        # music — and on the nearest beat otherwise.
        windows = crack_windows(track_path)
        window = max(2.0, seconds * 0.04)
        # A dissolve may not be longer than half the shortest shot it joins,
        # so a shot has to be at least twice the fade or the plan silently
        # shortens every dissolve in the film. The floor is applied here,
        # before the cuts are placed.
        floor = max(minimum, 2.0 * fade + 0.2)

        cuts = []
        at = 0
        for index in range(count - 1):
            target = seconds * (index + 1) / float(count)
            chosen = None
            for start, _end in windows:
                if abs(start - target) <= window:
                    chosen = start
                    break
            if chosen is None:
                at = min(range(at, len(beats)), key=lambda i: abs(beats[i] - target))
                chosen = beats[at]
            if cuts and chosen <= cuts[-1]:
                later = [b for b in beats if b > cuts[-1]]
                chosen = later[0] if later else cuts[-1] + floor
                at = min(range(at, len(beats)), key=lambda i: abs(beats[i] - chosen))
            # A boundary that would leave a shot shorter than the floor is
            # not taken: the dissolve could not complete over it.
            previous = cuts[-1] if cuts else 0.0
            if chosen - previous < floor and len(cuts) < count - 1:
                continue
            cuts.append(chosen)
        if not cuts:
            return [3.0] * count

        # The shot lengths: from one cut to the next, plus the fade each
        # shot shares with the one after it. The last shot runs to the end
        # of the song. There is one shot per cut, plus the one that opens
        # the film.
        out = []
        for index in range(len(cuts) + 1):
            start = cuts[index - 1] if index > 0 else 0.0
            end = cuts[index] if index < len(cuts) else seconds
            # Every shot but the last shares a dissolve with the next one,
            # so it is one fade longer; the last shot has nobody to
            # overlap with and ends exactly with the song. No upper cap
            # either: the shots have to cover the track, and a cap would
            # silently eat the difference and cut the music off.
            length = end - start
            if index < len(cuts):
                length += fade
            out.append(max(minimum, length))
        return out

    each = (seconds + (count - 1) * fade) / float(count)
    return [min(maximum, max(minimum, each))] * count


# --------------------------------------------------------------------------
# the director
# --------------------------------------------------------------------------

class Director:
    """Choose the frames, and say why.

    A line is either a plain string or a dict with `display` (what the
    report prints) and `query` (what CLIP is asked — the scene in words,
    because a lyric line is not a caption).
    """

    def __init__(self, lines, threshold=0.18, blur_max=BLUR_MAX,
                 yavg_min=YAVG_MIN, yavg_max=YAVG_MAX, spread_min=SPREAD_MIN,
                 dup_bits=DUP_BITS, root=None, per_line=1, rank=0):
        self.lines = []
        for line in lines or []:
            if isinstance(line, dict):
                display = line.get('display') or line.get('text') or ''
                query = line.get('query') or display
            else:
                display = str(line)
                query = str(line)
            self.lines.append({'display': display, 'query': query})
        self.threshold = threshold
        self.blur_max = blur_max
        self.yavg_min = yavg_min
        self.yavg_max = yavg_max
        self.spread_min = spread_min
        self.dup_bits = dup_bits
        # The report prints paths relative to this root: four dozen frames
        # share three basenames, so a basename is not an identifier.
        self.root = root
        # How many frames one lyric line may keep. One is a slideshow; three
        # is a film. The frames that do not make the count are cut.
        self.per_line = max(1, int(per_line))
        # Which of a line's frames THIS version uses: 0 is the best, 1 the
        # second, 2 the third. The versions therefore share no picture.
        self.rank = max(0, int(rank))
        self._spare = []

    # -- measurement --------------------------------------------------------

    def measure(self, candidates):
        out = []
        for path in candidates:
            out.append(measure_frame(path))
        return out

    # -- rejection ----------------------------------------------------------

    def technical_reject(self, frame):
        """Why this frame cannot be in the film, or None."""
        if not frame['ok']:
            return 'cannot decode'
        if frame['blur'] is not None and frame['blur'] > self.blur_max:
            return 'too soft (blur %.1f)' % frame['blur']
        if frame['yavg'] is not None:
            if frame['yavg'] < self.yavg_min:
                return 'too dark (luma %.0f)' % frame['yavg']
            if frame['yavg'] > self.yavg_max:
                return 'blown out (luma %.0f)' % frame['yavg']
        if frame['spread'] is not None and frame['spread'] < self.spread_min:
            return 'flat (range %.0f)' % frame['spread']
        return None

    def collapse_duplicates(self, frames, scores=None):
        """Keep one frame per near-duplicate group.

        The survivor is the one with the best score for the line it fits
        best; without scores, the sharpest survives.
        """
        groups = []
        for frame in frames:
            placed = False
            for group in groups:
                head = group[0]
                if frame['dhash'] is None or head['dhash'] is None:
                    continue
                if hamming(frame['dhash'], head['dhash']) <= self.dup_bits:
                    group.append(frame)
                    placed = True
                    break
            if not placed:
                groups.append([frame])

        survivors = []
        for group in groups:
            if len(group) == 1:
                survivors.append(group[0])
                continue
            def rank(frame):
                sharp = -(frame['blur'] if frame['blur'] is not None else 0.0)
                best = scores.get(frame['path'], 0.0) if scores else 0.0
                return (best, sharp)
            survivors.append(max(group, key=rank))
        return survivors, groups

    # -- matching -----------------------------------------------------------

    def match(self, frames, matrix):
        """Give every line its frames; report what nobody claimed.

        `matrix` is images x lines of CLIP similarities. Each frame is
        ASSIGNED to the line it matches best — one line, one owner — so a
        frame can never be used twice and a line can never steal another
        line's picture. A frame whose best score is under the threshold is
        cut outright; a frame that loses to the frames already taken for
        its own line is cut as a runner-up.

        Each line keeps up to `per_line` frames, best score first. That is
        what makes the cut a movie rather than a slideshow: a lyric line
        with three good frames gets three shots, and the ones that fit it
        badly are gone.
        """
        if not matrix or not frames:
            return [], list(frames), {}

        lines = self.lines
        taken = {}
        scores_for_line = [[matrix[f][l] for f in range(len(frames))] for l in range(len(lines))]
        best_line_for_frame = [max(range(len(lines)), key=lambda l: scores_for_line[l][f])
                               for f in range(len(frames))]

        # Frames grouped by the line they belong to, best score first.
        owned = {l: [] for l in range(len(lines))}
        for frame_index, line_index in enumerate(best_line_for_frame):
            owned[line_index].append(frame_index)
        for line_index in owned:
            owned[line_index].sort(key=lambda f: scores_for_line[line_index][f], reverse=True)

        matches = []
        claimed = set()
        for line_index, line in enumerate(lines):
            kept = []
            for position, frame_index in enumerate(owned[line_index]):
                score = scores_for_line[line_index][frame_index]
                # The VERSION picks the rank: version one takes the line's
                # best frame, version two its second, version three its
                # third — so the three versions share no picture.
                wanted = (position >= self.rank
                          and position < self.rank + self.per_line)
                if wanted and score >= self.threshold and len(kept) < self.per_line:
                    kept.append(frame_index)
                    claimed.add(frame_index)
                else:
                    if position < self.rank:
                        reason = 'kept by an earlier version'
                    elif position >= self.rank + self.per_line:
                        reason = ('a runner-up — %d frame(s) already carry this line'
                                  % self.per_line)
                    else:
                        reason = 'below the threshold (%.3f)' % score
                    self._spare.append({'path': frames[frame_index]['path'], 'reason': reason})
            if not kept:
                matches.append({'line': line['display'], 'query': line['query'],
                                'frame': None, 'score': max([scores_for_line[line_index][f]
                                                            for f in owned[line_index]] or [0.0]),
                                'gap': 'no frame fits this line'})
                continue
            for frame_index in kept:
                matches.append({
                    'line': line['display'],
                    'query': line['query'],
                    'frame': frames[frame_index],
                    'index': frames[frame_index].get('index'),
                    'score': scores_for_line[line_index][frame_index],
                })

        unmatched = [f for i, f in enumerate(frames) if i not in claimed]
        taken = {frames[f]['path']: scores_for_line[l][f]
                 for l in range(len(lines)) for f in owned[l] if f in claimed}
        return matches, unmatched, taken

    # -- the cut ------------------------------------------------------------

    def plan(self, candidates, matrix=None, track_path=None, fx='grain',
             grade='vignette', transition='none', fade=0.6):
        """The whole decision, in one pass. Returns a plan dict."""
        frames = self.measure(candidates)
        # The CLIP matrix was measured on the CANDIDATE list, so every
        # frame carries its row. Rejecting a frame or collapsing a
        # duplicate removes a row, and a matrix indexed by the survivors
        # would score the wrong picture — silently, and wrongly.
        for index, frame in enumerate(frames):
            frame['index'] = index
        self._spare = []

        rejected = []
        survivors = []
        for frame in frames:
            reason = self.technical_reject(frame)
            if reason:
                rejected.append({'path': frame['path'], 'reason': reason})
            else:
                survivors.append(frame)

        scores = {}
        if matrix:
            for index, frame in enumerate(survivors):
                scores[frame['path']] = max(matrix[index]) if matrix[index] else 0.0

        unique, groups = self.collapse_duplicates(survivors, scores)
        duplicates = []
        for group in groups:
            if len(group) > 1:
                for frame in group[1:]:
                    duplicates.append({
                        'path': frame['path'],
                        'reason': 'near-duplicate of %s' % self.label(group[0]['path']),
                    })

        if matrix:
            rows = [frame['index'] for frame in unique]
            aligned = [[matrix[row][column] for column in range(len(self.lines))]
                       for row in rows]
            matches, unmatched, taken = self.match(unique, aligned)
            spare_paths = {item['path'] for item in self._spare}
            for frame in unmatched:
                if frame['path'] in spare_paths:
                    continue          # it already has its own reason
                rejected.append({
                    'path': frame['path'],
                    'reason': 'no line claims it (best score %.3f)' % scores.get(frame['path'], 0.0),
                })
        else:
            matches = [{'line': line['display'], 'query': line['query'],
                        'frame': frame, 'score': None}
                       for line, frame in zip(self.lines, unique)]
            unmatched = unique[len(self.lines):]
            for frame in unmatched:
                rejected.append({'path': frame['path'], 'reason': 'surplus'})

        shots = [m for m in matches if m['frame'] is not None]
        durations = durations_on_grid(len(shots), track_path, fade=fade)
        # The cut plan may decide on fewer boundaries than lines (a boundary
        # that cannot carry a full dissolve is not taken), so the shot list
        # follows the plan rather than the other way round.
        if len(durations) < len(shots):
            shots = shots[:len(durations)]
        for shot, duration in zip(shots, durations):
            shot['duration'] = duration

        plan = {
            'shots': shots,
            'rejected': rejected + duplicates + self._spare,
            'gaps': [{'line': m['line'], 'reason': m.get('gap', 'no frame'),
                      'score': m.get('score')} for m in matches if m['frame'] is None],
            'fx': fx,
            'grade': grade,
            'transition': transition,
            'fade': fade,
            'track': track_path,
        }
        plan['motions'] = plan_motions(len(shots))
        plan['fxs'] = plan_fx(len(shots), fx)
        return plan

    # -- the evolution -------------------------------------------------------

    def path_distance(self, shots, embeddings):
        """How far the picture travels from shot to shot, in CLIP space.

        The sum of `1 - closeness` along the shot order. A small number
        means the film moves in small steps — the character changes
        gradually. It is the measurement the evolution version claims, and
        it is reported for the lyric order too, so the claim can be
        checked rather than believed.
        """
        vectors = []
        for shot in shots:
            index = shot.get('index')
            if index is None or index >= len(embeddings):
                return None
            vectors.append(embeddings[index])
        if len(vectors) < 2:
            return None
        total = 0.0
        for i in range(1, len(vectors)):
            total += 1.0 - sum(a * b for a, b in zip(vectors[i - 1], vectors[i]))
        return round(total, 4)

    def evolve(self, plan, embeddings, start_index=0):
        """Re-order the shots into the character's EVOLUTION.

        The lyric order is the SONG's order. The evolution is the
        CHARACTER's order: the shot after a shot is the one that looks
        most like it, so the character moves through his states one small
        step at a time instead of jumping.

        The path is a nearest-neighbour walk through the CLIP embedding
        space, starting at the shot that best carries the first line. It
        is a MEASUREMENT of how close two frames look — not a preference
        about what should come next — and the walk's total distance is
        reported, so the claim can be checked.
        """
        shots = [s for s in plan['shots'] if s.get('frame')]
        if len(shots) < 3 or not embeddings:
            return plan

        vectors = []
        for shot in shots:
            index = shot.get('index')
            vectors.append(embeddings[index] if index is not None and index < len(embeddings) else None)
        if any(v is None for v in vectors):
            return plan

        def closeness(a, b):
            return sum(x * y for x, y in zip(vectors[a], vectors[b]))

        order = [start_index]
        remaining = set(range(len(shots))) - {start_index}
        while remaining:
            current = order[-1]
            nxt = min(remaining, key=lambda i: -closeness(current, i))
            order.append(nxt)
            remaining.discard(nxt)

        distance = 0.0
        for index in range(1, len(order)):
            distance += 1.0 - closeness(order[index - 1], order[index])

        original = list(plan['shots'])
        plan['shots'] = [original[position] for position in order]
        plan['evolution'] = {
            'order': order,
            'pathDistance': round(distance, 4),
            'meanStep': round(distance / max(1, len(order) - 1), 4),
        }
        # The durations follow the new order: the shot lengths are the
        # song's, the sequence is the character's.
        plan['durations'] = durations_on_grid(len(plan['shots']), plan.get('track'),
                                             fade=plan.get('fade', 0.6))
        plan['motions'] = plan_motions(len(plan['shots']))
        plan['fxs'] = plan_fx(len(plan['shots']), plan.get('fx', 'grain'))
        for shot, duration in zip(plan['shots'], plan['durations']):
            shot['duration'] = duration
        return plan

    # -- the versions --------------------------------------------------------

    def plan_versions(self, candidates, matrix=None, embeddings=None, track_path=None,
                      versions=3, fx='grain', grade='vignette', transition='none',
                      fade=0.6):
        """The same song, cut three ways.

        Version one takes each line's best frame, version two its second,
        version three its third — so the three versions share NO picture ✓.
        The last version is then re-ordered into the character's EVOLUTION
        (see `evolve`): the shots move through his states one small step
        at a time instead of following the song's word order ✓ ✓.
        """
        plans = []
        for index in range(max(1, int(versions))):
            self.rank = index
            plan = self.plan(candidates, matrix, track_path=track_path, fx=fx,
                             grade=grade, transition=transition, fade=fade)
            plans.append(plan)
        if embeddings and len(plans) > 1:
            lyric_distance = self.path_distance(plans[0]['shots'], embeddings)
            plans[0]['pathDistance'] = lyric_distance
            plans[-1] = self.evolve(plans[-1], embeddings)
            plans[-1]['lyricPathDistance'] = lyric_distance
            plans[-1]['pathDistance'] = self.path_distance(plans[-1]['shots'], embeddings)
        return plans

    # -- reporting ----------------------------------------------------------

    def label(self, path):
        """A path the reader can act on: relative to the frames root."""
        if self.root:
            try:
                return os.path.relpath(path, self.root)
            except ValueError:
                pass
        return os.path.basename(path)


    def report(self, plan):
        lines = []
        lines.append('the cut — %d shot(s), %d cut' % (len(plan['shots']), len(plan['rejected'])))
        for index, shot in enumerate(plan['shots']):
            score = ('%.3f' % shot['score']) if shot.get('score') is not None else '  -  '
            lines.append('  %2d  %-9s %6.2fs  %s' % (
                index + 1, score, shot['duration'], shot['line']))
            lines.append('      %s  [%s]' % (self.label(shot['frame']['path']),
                                             plan['motions'][index]))
        if plan['gaps']:
            lines.append('  gaps — a line no frame earned:')
            for gap in plan['gaps']:
                if isinstance(gap, dict):
                    lines.append('      %-52s %s' % (gap['line'], gap.get('reason', '')))
                else:
                    lines.append('      %s' % gap)
        if plan.get('pathDistance') is not None:
            lines.append('  the picture travels %.3f in CLIP space over the cut'
                         % plan['pathDistance'])
            if plan.get('lyricPathDistance') is not None:
                lines.append('  (the lyric order travels %.3f — the evolution is %s)'
                             % (plan['lyricPathDistance'],
                                'smoother' if plan['pathDistance'] < plan['lyricPathDistance']
                                else 'not smoother'))
        if plan['rejected']:
            lines.append('  cut —')
            for item in plan['rejected']:
                lines.append('      %-44s %s' % (self.label(item['path']), item['reason']))
        return '\n'.join(lines)


# --------------------------------------------------------------------------
# the cut list, shared with the renderer
# --------------------------------------------------------------------------

def plan_motions(count):
    """A camera move per shot that does not read as a machine.

    Push, pull, pan — in a fixed order that never puts the same move twice
    in a row and never pans twice in three.
    """
    out = []
    for index in range(count):
        if index and out[-1] == MOTIONS[0]:
            out.append(MOTIONS[1])
        elif out[-2:] == ['zoom-out', 'zoom-in'] if len(out) > 1 else False:
            out.append(MOTIONS[2])
        else:
            out.append(MOTIONS[index % 3])
    return out


def plan_fx(count, base='grain'):
    """A look per shot. The base look on every shot; the grade is separate."""
    return [base] * count


def write_cutlist(path, plan, images=None):
    """Write the cut list the renderer reads.

    The renderer (bin/cut-list-to-mp4.mjs) owns the ffmpeg graph; this file
    only says WHAT to render — which file, in which order, for how long,
    with which move and look.
    """
    payload = {
        'images': images if images is not None else [s['frame']['path'] for s in plan['shots']],
        'durations': [s['duration'] for s in plan['shots']],
        'motions': plan['motions'],
        'fx': plan['fxs'],
        'grade': plan['grade'],
        'transition': plan['transition'],
        'fade': plan.get('fade', 0.6),
        'track': plan['track'],
        'pathDistance': plan.get('pathDistance'),
        'lyricPathDistance': plan.get('lyricPathDistance'),
        'shots': [{
            'line': s['line'],
            'query': s.get('query'),
            'image': s['frame']['path'],
            'duration': s['duration'],
            'score': s.get('score'),
        } for s in plan['shots']],
    }
    with open(path, 'w') as handle:
        json.dump(payload, handle, indent=2)
    return payload


# --------------------------------------------------------------------------
# CLIP, when it is available
# --------------------------------------------------------------------------

def clip_scores(images, lines, python=None, timeout=1800):
    """The similarity matrix and the image embeddings, or (None, None).

    The scoring runs in the clip-interrogator venv — the only interpreter
    on this machine with torch and the ViT-H weights — and is spoken to
    over stdin/stdout as JSON. The embeddings are the normalised image
    vectors: the evolution ordering walks through them.
    """
    if not images or not lines:
        return None, None
    script = os.path.join(REPO, 'lib', 'story', 'clip_score.py')
    if python is None:
        python = os.path.join(REPO, 'lib', 'clip-interrogator', '.venv', 'bin', 'python')
    if not os.path.exists(python):
        return None
    try:
        out = subprocess.run(
            [python, script],
            input=json.dumps({'images': list(images), 'lines': list(lines)}).encode(),
            capture_output=True, timeout=timeout,
        )
        payload = json.loads(out.stdout.decode('utf8', 'replace'))
        return payload.get('matrix'), payload.get('embeddings')
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, None


def clip_matrix(images, lines, python=None, timeout=1800):
    """The images x lines similarity matrix, or None when CLIP is absent."""
    matrix, _embeddings = clip_scores(images, lines, python=python, timeout=timeout)
    return matrix


def load_lines(path):
    """Read the lines file.

    A plain `.txt` is one lyric line per line. A `.tsv` is
    `display <tab> query` — the display text is what the report prints and
    the query is what CLIP is asked, because a lyric line ("Hinges swing,
    current finds the tongue mid-sentence") is not a caption and CLIP
    will not match it to a picture on its own.
    """
    with open(path) as handle:
        raw = handle.read()
    if path.endswith('.tsv'):
        rows = []
        header_cells = ('display', 'lyric', 'line')
        header_query = ('text', 'query', 'scene', 'caption')
        for row in raw.splitlines():
            if not row.strip():
                continue
            parts = row.split('\t')
            display = parts[0].strip()
            query = parts[1].strip() if len(parts) > 1 and parts[1].strip() else display
            if (not rows and display.lower() in header_cells
                    and query.lower() in header_query):
                continue   # the header row
            rows.append({'display': display, 'query': query})
        return rows
    return [line.strip() for line in raw.splitlines() if line.strip()]


def main():
    """python3 lib/story/director.py --frames DIR --lines FILE [...]"""
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--frames', required=True, help='a directory of candidate frames')
    parser.add_argument('--lines', required=True, help='one lyric line per line, or a .tsv')
    parser.add_argument('--cutlist', help='write the cut list here')
    parser.add_argument('--track', help='an audio track (durations follow its beats)')
    parser.add_argument('--threshold', type=float, default=0.18)
    parser.add_argument('--per-line', type=int, default=1,
                        help='frames each lyric line may keep')
    parser.add_argument('--versions', type=int, default=3,
                        help='how many cuts to make; each uses different frames '
                             'and the last follows the character\'s evolution')
    parser.add_argument('--transition', default='none', choices=['none', 'crossfade'],
                        help='how one shot gives way to the next; crossfade is the smooth one')
    parser.add_argument('--fade', type=float, default=0.9,
                        help='the dissolve length, crossfade only')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    lines = load_lines(args.lines)
    queries = [line['query'] if isinstance(line, dict) else line for line in lines]

    frames = []
    for root, _dirs, names in os.walk(args.frames):
        for name in names:
            if name.lower().endswith(IMAGE_EXTS):
                frames.append(os.path.join(root, name))
    frames.sort()

    director = Director(lines, threshold=args.threshold, root=os.path.abspath(args.frames),
                        per_line=args.per_line)
    matrix, embeddings = clip_scores(frames, queries)

    if args.versions > 1:
        plans = director.plan_versions(frames, matrix, embeddings=embeddings,
                                       track_path=args.track, versions=args.versions,
                                       transition=args.transition, fade=args.fade)
    else:
        plans = [director.plan(frames, matrix, track_path=args.track,
                               transition=args.transition, fade=args.fade)]

    written = []
    for index, plan in enumerate(plans, start=1):
        if args.cutlist:
            path = args.cutlist
            if args.versions > 1:
                stem, ext = os.path.splitext(args.cutlist)
                path = '%s.v%d%s' % (stem, index, ext or '.json')
            write_cutlist(path, plan)
            written.append(path)
        if args.json:
            print(json.dumps({'version': index, 'shots': plan['shots'],
                              'rejected': plan['rejected'], 'gaps': plan['gaps'],
                              'evolution': plan.get('evolution')}, indent=2, default=str))
        else:
            if len(plans) > 1:
                print('\n=== version %d%s ===' % (index, ' — the evolution' if plan.get('evolution') else ''))
            print(director.report(plan))

    if written:
        print('\ncut lists:')
        for path in written:
            print('  %s' % path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
