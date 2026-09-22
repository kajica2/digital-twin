"""Core loopable-video-segmenter logic. No gradio imports — CLI-safe.

Faithful port of the author's kajica2/loopable-video-segmenter app.py
(MIT), with one structural addition: `compute_segments()` is split out so
the CLI and the UI share the same boundary-detection pipeline, and the
status message reports which path was actually used (beat detection vs
equal-time fallback).
"""

from __future__ import annotations

import os
import tempfile
import zipfile
from typing import List, Optional, Tuple

from moviepy.editor import VideoFileClip, concatenate_videoclips, vfx
import librosa
import numpy as np
import soundfile as sf  # noqa: F401  (pulled in for librosa audio decode parity)


def extract_audio(video_clip, tmp_dir):
    """Extract audio to a temporary wav file and return path, or None."""
    audio_path = os.path.join(tmp_dir, "audio.wav")
    if video_clip.audio is None:
        return None
    video_clip.audio.write_audiofile(audio_path, fps=22050, logger=None)
    return audio_path


def get_beat_times(audio_path, duration):
    """Return list of beat times in seconds, or None if no audio/beats."""
    if audio_path is None:
        return None
    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)
        beat_times = beat_times[beat_times < duration]
        if len(beat_times) < 2:
            return None
        return beat_times
    except Exception:
        return None


def segment_by_beats(duration, beat_times, num_segments):
    """Split beat times into num_segments contiguous groups, or None."""
    n_beats = len(beat_times)
    if n_beats < num_segments:
        return None
    indices = np.linspace(0, n_beats, num_segments + 1, dtype=int)
    segments = []
    for i in range(num_segments):
        start_idx = indices[i]
        end_idx = indices[i + 1] if i < num_segments - 1 else n_beats
        start_time = beat_times[start_idx]
        end_time = beat_times[end_idx - 1]  # last beat in this group
        segments.append((start_time, end_time))
    return segments


def compute_segments(
    video_path: str, num_segments: int
) -> Tuple[List[Tuple[float, float]], bool]:
    """Return (segments, used_beat_detection) for a video.

    Raises ValueError on invalid input. Falls back to equal-time slices
    when the video has no usable audio or too few beats.
    """
    if not video_path:
        raise ValueError("No video path provided.")
    if num_segments < 1:
        raise ValueError("Number of segments must be at least 1.")

    clip = VideoFileClip(video_path)
    try:
        duration = clip.duration
        tmp_dir = tempfile.mkdtemp()
        audio_path = extract_audio(clip, tmp_dir)
        beat_times = get_beat_times(audio_path, duration)
        beat_segments = None
        used_beats = False
        if beat_times is not None:
            beat_segments = segment_by_beats(duration, beat_times, num_segments)
            if beat_segments is not None:
                used_beats = True

        if beat_segments is None:
            seg_dur = duration / num_segments
            beat_segments = [
                (i * seg_dur, min((i + 1) * seg_dur, duration))
                for i in range(num_segments)
            ]

        return beat_segments, used_beats
    finally:
        clip.close()


def create_loopable_segments(video_path, num_segments, make_loopable=True):
    """Split + render + zip. Returns (zip_path, message); (None, msg) on bad input."""
    try:
        num_segments = int(num_segments)
    except Exception:
        return None, "Number of segments must be an integer."
    if num_segments < 1:
        return None, "Number of segments must be at least 1."

    try:
        segments, used_beats = compute_segments(video_path, num_segments)
    except ValueError as exc:
        return None, str(exc)
    except Exception as exc:  # ffmpeg / codec / file errors
        return None, f"Failed to process video: {exc}"

    clip = VideoFileClip(video_path)
    tmp_dir = tempfile.mkdtemp()
    output_files = []
    try:
        for i, (start, end) in enumerate(segments):
            if end <= start:
                end = min(start + 0.5, clip.duration)

            sub = clip.subclip(start, end)
            if make_loopable:
                sub = concatenate_videoclips([sub, sub.fx(vfx.time_mirror)])

            out_path = os.path.join(tmp_dir, f"segment_{i + 1:02d}.mp4")
            if clip.audio is None:
                sub = sub.without_audio()
                sub.write_videofile(out_path, codec="libx264", audio=False, logger=None)
            else:
                sub.write_videofile(out_path, codec="libx264", audio_codec="aac", logger=None)
            output_files.append(out_path)

        zip_path = os.path.join(tmp_dir, "loopable_segments.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in output_files:
                zf.write(f, arcname=os.path.basename(f))
    finally:
        clip.close()

    method = "beat detection" if used_beats else "equal-time fallback"
    return zip_path, f"Created {num_segments} loopable segments using {method}."