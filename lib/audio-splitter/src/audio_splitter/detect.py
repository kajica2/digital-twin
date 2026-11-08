"""Track detection for a long recording.

The problem: a "Traditional Music of Western Serbia" album arrives as ONE
mp3 — 57 minutes, no tags, no gaps you can see with `silencedetect`
because the room tone sits at about -40 dBFS, not at digital silence.

So the boundaries are found from the ENERGY PROFILE, not from silence:

  1. decode to mono 22050 Hz (ffmpeg),
  2. frame it (1024 samples = 46.4 ms) and take the RMS of each frame,
  3. find the NOISE FLOOR (the 10th percentile of the frame dB — robust,
     because a tenth of an album is quiet enough to set the floor),
  4. find the QUIET RUNS: maximal runs of frames within `--floor-db` of
     that floor,
  5. a quiet run is a TRACK GAP when it is at least `--min-gap` seconds
     long. The album's splices are a distinct population (measured on the
     Western Serbia recording: 27 gaps of 3.9-4.6 s, against within-piece
     pauses of 1.0-3.0 s), which is why the threshold separates them
     cleanly at 3.5 s.

The boundary is placed in the MIDDLE of the gap, so both pieces keep the
same amount of silence.

Pure functions over arrays; the CLI in cli.py does the decoding and the
cutting.
"""

from __future__ import annotations

import subprocess
from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np

SAMPLE_RATE = 22050
FRAME = 1024
HOP = 1024


def decode(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode any audio file to mono float32 in [-1, 1]."""
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", path,
            "-ac", "1", "-ar", str(sample_rate),
            "-f", "f32le", "-",
        ],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def frame_signal(x: np.ndarray, frame: int = FRAME, hop: int = HOP) -> np.ndarray:
    """Split a signal into overlapping frames (as a 2-D view, no copy)."""
    if len(x) < frame:
        return np.empty((0, frame), dtype=x.dtype)
    n = 1 + (len(x) - frame) // hop
    strides = (x.strides[0] * hop, x.strides[0])
    return np.lib.stride_tricks.as_strided(x, shape=(n, frame), strides=strides)


def rms_db(frames: np.ndarray) -> np.ndarray:
    """The RMS of each frame, in dBFS."""
    if frames.size == 0:
        return np.zeros(0, dtype=np.float64)
    power = (frames.astype(np.float64) ** 2).mean(axis=1)
    return 10.0 * np.log10(np.maximum(power, 1e-20))


def noise_floor(db: np.ndarray, percentile: float = 10.0) -> float:
    """The quiet level of the recording — a robust percentile, not the minimum."""
    if db.size == 0:
        return -90.0
    return float(np.percentile(db, percentile))


def quiet_runs(
    db: np.ndarray,
    threshold: float,
    min_frames: int,
) -> List[Tuple[int, int]]:
    """Maximal runs of frames at or below `threshold`, at least `min_frames` long."""
    runs: List[Tuple[int, int]] = []
    start: Optional[int] = None
    for i, value in enumerate(db):
        if value <= threshold:
            if start is None:
                start = i
        elif start is not None:
            if i - start >= min_frames:
                runs.append((start, i - 1))
            start = None
    if start is not None and len(db) - start >= min_frames:
        runs.append((start, len(db) - 1))
    return runs


def gap_boundaries(
    runs: Sequence[Tuple[int, int]],
    min_gap_seconds: float,
    hop_seconds: float,
) -> List[float]:
    """The boundary time (seconds) for each gap long enough to be a track gap.

    The boundary sits in the middle of the gap, so the silence is shared
    evenly between the two pieces.
    """
    out: List[float] = []
    for start, end in runs:
        if (end - start + 1) * hop_seconds < min_gap_seconds:
            continue
        out.append(((start + end + 1) / 2.0) * hop_seconds)
    return out


def detect(
    path: str,
    min_gap: float = 3.5,
    floor_db: float = 6.0,
    sample_rate: int = SAMPLE_RATE,
    frame: int = FRAME,
    hop: int = HOP,
) -> dict:
    """Detect the track boundaries of a recording.

    Returns a dict with the boundaries (seconds), the segments, and the
    measurements the caller needs to judge the result: the noise floor,
    every quiet run, and the gap lengths.
    """
    x = decode(path, sample_rate)
    frames = frame_signal(x, frame, hop)
    db = rms_db(frames)
    hop_seconds = hop / sample_rate
    floor = noise_floor(db)
    runs = quiet_runs(db, floor + floor_db, max(1, int(round(0.8 / hop_seconds))))
    boundaries = gap_boundaries(runs, min_gap, hop_seconds)
    duration = len(x) / sample_rate
    cuts = [0.0] + boundaries + [duration]
    segments = [
        {
            "index": i + 1,
            "start": round(cuts[i], 3),
            "end": round(cuts[i + 1], 3),
            "seconds": round(cuts[i + 1] - cuts[i], 3),
        }
        for i in range(len(cuts) - 1)
    ]
    gap_lengths = [round((e - s + 1) * hop_seconds, 3) for s, e in runs]
    return {
        "file": path,
        "duration": round(duration, 3),
        "sample_rate": sample_rate,
        "noise_floor_db": round(floor, 2),
        "threshold_db": round(floor + floor_db, 2),
        "min_gap": min_gap,
        "boundaries": [round(b, 3) for b in boundaries],
        "segments": segments,
        "quiet_runs": [
            {"start": round(s * hop_seconds, 3), "end": round((e + 1) * hop_seconds, 3),
             "seconds": round((e - s + 1) * hop_seconds, 3)}
            for s, e in runs
        ],
        "gap_lengths": gap_lengths,
    }


def longest_gaps(result: dict, count: int = 12) -> List[Tuple[float, float]]:
    """The `count` longest quiet runs, as (seconds, length) pairs."""
    runs = sorted(result.get("quiet_runs", []), key=lambda r: r["seconds"], reverse=True)
    return [(r["start"], r["seconds"]) for r in runs[:count]]
