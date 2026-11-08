"""audio-splitter — detect the tracks in a long recording and cut them apart."""

from .detect import detect, decode, rms_db, quiet_runs, gap_boundaries, noise_floor  # noqa: F401

__all__ = ["detect", "decode", "rms_db", "quiet_runs", "gap_boundaries", "noise_floor"]
