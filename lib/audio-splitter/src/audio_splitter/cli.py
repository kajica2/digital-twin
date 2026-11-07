"""`audio-split` — detect the tracks in a long recording and cut them apart.

    audio-split "album.mp3" --out "album-split"

Every piece is re-encoded (never stream-copied: a copy that starts
mid-frame clicks), tagged with its track number, and listed in a
manifest.json beside them.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import List, Optional

from .detect import detect, longest_gaps

DEFAULT_MIN_GAP = 3.5
DEFAULT_FLOOR_DB = 6.0


def _safe_name(text: str) -> str:
    """A filename-safe stem from the source name."""
    keep = []
    for ch in text:
        keep.append(ch if (ch.isalnum() or ch in " -_.") else "-")
    out = "".join(keep).strip().replace(" ", "-")
    while "--" in out:
        out = out.replace("--", "-")
    return out or "track"


def probe_duration(path: str) -> Optional[float]:
    """The duration of a written file, in seconds (None when unreadable)."""
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        return float(res.stdout.decode().strip())
    except ValueError:
        return None


def cut(
    source: str,
    out_dir: str,
    segment: dict,
    index: int,
    total: int,
    album: str,
    fmt: str = "mp3",
    bitrate: int = 192,
    fade: float = 0.03,
) -> Optional[str]:
    """Cut one segment out of the source and write it, tagged."""
    stem = f"{index:02d}-{_safe_name(album)}"
    if fmt == "wav":
        name = f"{stem}.wav"
        codec: List[str] = ["-c:a", "pcm_s24le"]
    else:
        name = f"{stem}.mp3"
        codec = ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k"]
    path = os.path.join(out_dir, name)
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{segment['start']:.3f}",
           "-to", f"{segment['end']:.3f}", "-i", source,
           # The source carries an attached cover picture (an mjpeg stream).
           # Without an explicit audio map ffmpeg picks THAT stream and
           # writes the 0.236 s cover instead of the music — measured, and
           # it only bites the first cut, because a later seek has left
           # the cover behind.
           "-map", "0:a:0", "-vn"]
    if fade > 0:
        # A short fade at each end: the cut lands in silence, but a fade
        # costs nothing and removes any click.
        dur = max(0.001, segment["seconds"])
        cmd += ["-af", f"afade=t=in:st=0:d={fade},afade=t=out:st={dur - fade:.3f}:d={fade}"]
    cmd += codec + [
        "-metadata", f"title={album} — {index}",
        "-metadata", f"album={album}",
        "-metadata", f"track={index}/{total}",
        "-metadata", f"album_artist={album}",
        path,
    ]
    res = subprocess.run(cmd, stderr=subprocess.PIPE)
    if res.returncode != 0:
        sys.stderr.write(res.stderr.decode("utf-8", "replace"))
        return None
    # Verify what was written against what was asked for. A cut that
    # silently produced the wrong length is worse than a failed cut.
    written = probe_duration(path)
    if written is None or abs(written - segment["seconds"]) > 0.5:
        sys.stderr.write(
            f"audio-split: cut {index} is {written} s, expected {segment['seconds']} s\n"
        )
        return None
    return path


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="audio-split", description=__doc__)
    parser.add_argument("file", help="the recording to split")
    parser.add_argument("--out", default=None, help="output folder (default: <file>-split)")
    parser.add_argument("--min-gap", type=float, default=DEFAULT_MIN_GAP,
                        help="a quiet run must be at least this long to be a track gap")
    parser.add_argument("--floor-db", type=float, default=DEFAULT_FLOOR_DB,
                        help="how far above the noise floor a frame may sit and still count as quiet")
    parser.add_argument("--format", default="mp3", choices=["mp3", "wav"])
    parser.add_argument("--bitrate", type=int, default=192)
    parser.add_argument("--fade", type=float, default=0.03)
    parser.add_argument("--dry-run", action="store_true", help="detect and report, cut nothing")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)

    if not os.path.exists(args.file):
        sys.stderr.write(f"audio-split: no such file: {args.file}\n")
        return 2

    result = detect(args.file, min_gap=args.min_gap, floor_db=args.floor_db)
    album = os.path.splitext(os.path.basename(args.file))[0]
    total = len(result["segments"])

    if args.dry_run:
        payload = {
            "file": result["file"],
            "duration": result["duration"],
            "noise_floor_db": result["noise_floor_db"],
            "tracks": total,
            "segments": result["segments"],
            "longest_gaps": longest_gaps(result),
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    out_dir = args.out or (os.path.splitext(args.file)[0] + "-split")
    os.makedirs(out_dir, exist_ok=True)

    written = []
    for segment in result["segments"]:
        path = cut(args.file, out_dir, segment, segment["index"], total, album,
                   fmt=args.format, bitrate=args.bitrate, fade=args.fade)
        if path is None:
            sys.stderr.write(f"audio-split: cut failed at {segment['start']:.1f}s\n")
            return 1
        written.append({"file": os.path.basename(path), "bytes": os.path.getsize(path),
                        "start": segment["start"], "end": segment["end"],
                        "seconds": segment["seconds"]})

    manifest = {
        "source": os.path.basename(args.file),
        "sourceSeconds": result["duration"],
        "detector": {
            "noiseFloorDb": result["noise_floor_db"],
            "thresholdDb": result["threshold_db"],
            "minGapSeconds": result["min_gap"],
        },
        "tracks": written,
    }
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)

    if args.json:
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    else:
        print(f"audio-split: {total} track(s) -> {out_dir}")
        for entry in written:
            print(f"  {entry['file']}  {entry['seconds']:8.1f}s  {entry['bytes'] / 1e6:6.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
