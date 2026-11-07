#!/usr/bin/env python3
"""Tests for the audio-splitter detector.

Synthetic signals only — no file, no ffmpeg, no network. The detector's
job is to turn an energy profile into boundaries, so the tests feed it
energy profiles it could have measured.

    python3 lib/audio-splitter/tests/test_detect.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from audio_splitter.detect import (  # noqa: E402
    frame_signal,
    gap_boundaries,
    noise_floor,
    quiet_runs,
    rms_db,
)

PASSED = 0
FAILED = 0
FAILURES = []


def check(name):
    """Register a test. Decorator-free so the file reads top to bottom."""

    def wrap(fn):
        global PASSED, FAILED
        try:
            fn()
            PASSED += 1
        except AssertionError as err:
            FAILED += 1
            FAILURES.append(f"{name}: {err}")
        except Exception as err:  # noqa: BLE001
            FAILED += 1
            FAILURES.append(f"{name}: {type(err).__name__}: {err}")
        return fn

    return wrap


# ---- framing ------------------------------------------------------------

@check("framing produces one row per hop")
def _():
    x = np.zeros(4096, dtype=np.float32)
    frames = frame_signal(x, 1024, 1024)
    assert frames.shape == (4, 1024), frames.shape


@check("a signal shorter than one frame yields no frames")
def _():
    assert frame_signal(np.zeros(100, dtype=np.float32), 1024, 1024).shape[0] == 0


# ---- rms ----------------------------------------------------------------

@check("a half-scale sine reads about -9 dB per frame (RMS, not peak)")
def _():
    n = 4096
    t = np.arange(n) / 22050.0
    x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    db = rms_db(frame_signal(x, 1024, 1024))
    # The RMS of a half-scale sine is 0.5/sqrt(2) = -9.03 dBFS. A peak
    # reading would be -6 dBFS; the detector measures RMS.
    assert abs(float(db[0]) - (-9.03)) < 0.3, db[0]


@check("silence reads as the floor, not as a number")
def _():
    db = rms_db(frame_signal(np.zeros(2048, dtype=np.float32), 1024, 1024))
    assert db[0] < -190, db[0]


# ---- the noise floor ----------------------------------------------------

@check("the noise floor ignores the loud half of the profile")
def _():
    db = np.concatenate([np.full(50, -60.0), np.full(50, -10.0)])
    floor = noise_floor(db, percentile=10.0)
    assert abs(floor - (-60.0)) < 1.0, floor


@check("an empty profile still has a floor")
def _():
    assert noise_floor(np.zeros(0)) < 0


# ---- quiet runs ---------------------------------------------------------

@check("a quiet run is found between two loud stretches")
def _():
    db = np.concatenate([np.full(20, -10.0), np.full(10, -50.0), np.full(20, -10.0)])
    runs = quiet_runs(db, -40.0, min_frames=5)
    assert runs == [(20, 29)], runs


@check("a short dip is not a run")
def _():
    db = np.concatenate([np.full(20, -10.0), np.full(2, -50.0), np.full(20, -10.0)])
    assert quiet_runs(db, -40.0, min_frames=5) == []


@check("two dips are two runs")
def _():
    db = np.concatenate([
        np.full(10, -10.0), np.full(6, -50.0), np.full(10, -10.0),
        np.full(6, -50.0), np.full(10, -10.0),
    ])
    assert quiet_runs(db, -40.0, min_frames=5) == [(10, 15), (26, 31)]


@check("a run that reaches the end of the profile is still a run")
def _():
    db = np.concatenate([np.full(20, -10.0), np.full(8, -50.0)])
    assert quiet_runs(db, -40.0, min_frames=5) == [(20, 27)]


# ---- boundaries ---------------------------------------------------------

@check("a long gap becomes a boundary in the middle of the gap")
def _():
    runs = [(100, 199)]
    boundaries = gap_boundaries(runs, min_gap_seconds=3.5, hop_seconds=0.0464399)
    assert len(boundaries) == 1
    # The gap covers frames 100..199, i.e. 100*hop .. 200*hop seconds;
    # the middle of that is 150*hop.
    assert abs(boundaries[0] - (150 * 0.0464399)) < 1e-6, boundaries[0]


@check("a short gap does not become a boundary")
def _():
    runs = [(100, 149)]  # 2.3 s
    assert gap_boundaries(runs, min_gap_seconds=3.5, hop_seconds=0.0464399) == []


@check("boundaries come out in order")
def _():
    runs = [(100, 199), (500, 599), (900, 999)]
    bounds = gap_boundaries(runs, min_gap_seconds=3.5, hop_seconds=0.0464399)
    assert len(bounds) == 3
    assert bounds == sorted(bounds), bounds


@check("the measured album shape gives 27 boundaries at 3.5 s")
def _():
    # The Western Serbia recording: 27 splice gaps of 3.9-4.6 s, and
    # within-piece pauses of 1.0-3.0 s. This is that profile, shrunk.
    hop = 0.0464399
    runs = []
    for i in range(27):
        start = 100 + i * 4000
        runs.append((start, start + int(round(4.2 / hop))))
    for i in range(20):
        start = 200 + i * 3000
        runs.append((start, start + int(round(1.5 / hop))))
    runs.sort()
    bounds = gap_boundaries(runs, min_gap_seconds=3.5, hop_seconds=hop)
    assert len(bounds) == 27, len(bounds)


print(f"[audio-splitter.test] passed: {PASSED}, failed: {FAILED}")
if FAILED:
    for f in FAILURES:
        print(f"  ✗ {f}")
    raise SystemExit(1)
