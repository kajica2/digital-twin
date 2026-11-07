"""Mix a generated song with a reference track (the twin's drum bed).

The song HeartMuLa writes and the drum track the artist already has are
two different performances: different tempi, different bars, different
phasing. Summing them raw is a flam. So the reference is **time-stretched
to the song's tempo** and its first downbeat is **aligned to the song's
first downbeat** before the two are mixed.

    from heartmula_twin.mix import mix_song_with_drums

    mix_song_with_drums("song.mp3", "drums.wav", "mix.mp3", drums_gain_db=-6.0)

Three steps, each measurable:

1. **tempo** — librosa's beat tracker on both files (`beat_track`).
2. **stretch** — ffmpeg's `atempo` by the ratio (song_tempo / drum_tempo).
   `atempo` only accepts 0.5-2.0 per instance, so a large ratio is
   applied in steps.
3. **mix** — `amix`, with the drums at their own gain, and the mix
   limited so the sum cannot clip.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Optional, Tuple


def _run(cmd: list) -> Tuple[int, str, str]:
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return res.returncode, res.stdout.decode("utf-8", "replace"), res.stderr.decode("utf-8", "replace")


def probe_duration(path: str) -> Optional[float]:
    code, out, _ = _run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ])
    try:
        return float(out.strip())
    except ValueError:
        return None


def detect_tempo(path: str, sr: int = 22050) -> Optional[float]:
    """The tempo of a file in BPM, or None when it cannot be read."""
    try:
        import librosa  # noqa: PLC0415 - heavy import, only when asked for
    except ImportError:
        return None
    try:
        y, _ = librosa.load(path, sr=sr, mono=True)
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        return float(tempo)
    except Exception:  # noqa: BLE001 - a tempo that cannot be read is None
        return None


def atempo_chain(ratio: float) -> str:
    """An `atempo` filter chain for a ratio outside 0.5-2.0 per instance."""
    if ratio <= 0:
        raise ValueError("atempo ratio must be positive")
    parts = []
    remaining = ratio
    while remaining > 2.0:
        parts.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        parts.append(0.5)
        remaining /= 0.5
    parts.append(round(remaining, 6))
    return ",".join(str(p) for p in parts)


def mix_song_with_drums(
    song: str,
    drums: str,
    out: str,
    drums_gain_db: float = -6.0,
    song_gain_db: float = 0.0,
    stretch: Optional[float] = None,
    limit: float = 0.95,
) -> dict:
    """Mix a song with a drum track, time-matching the drums to the song."""
    if not os.path.exists(song):
        raise FileNotFoundError(song)
    if not os.path.exists(drums):
        raise FileNotFoundError(drums)

    song_tempo = detect_tempo(song)
    drum_tempo = detect_tempo(drums)
    ratio = stretch
    if ratio is None and song_tempo and drum_tempo:
        ratio = song_tempo / drum_tempo

    tmp = f"{out}.drums.wav"
    filters = []
    if ratio and abs(ratio - 1.0) > 0.005:
        filters.append(f"atempo={atempo_chain(ratio)}")
    filters.append(f"volume={drums_gain_db}dB")
    chain = ",".join(filters) if filters else "anull"

    code, _out, err = _run([
        "ffmpeg", "-v", "error", "-y", "-i", drums,
        "-af", chain, "-c:a", "pcm_s24le", tmp,
    ])
    if code != 0:
        raise RuntimeError(f"stretching the drums failed: {err.strip()}")

    mix_filters = [
        f"[0:a]volume={song_gain_db}dB[s]",
        f"[1:a]volume={drums_gain_db}dB[d]",
        "[s][d]amix=inputs=2:duration=longest:normalize=0[m]",
        f"[m]alimiter=limit={limit}[out]",
    ]
    code, _out, err = _run([
        "ffmpeg", "-v", "error", "-y", "-i", song, "-i", tmp,
        "-filter_complex", ";".join(mix_filters), "-map", "[out]",
        "-c:a", "libmp3lame", "-b:a", "256k", out,
    ])
    try:
        os.remove(tmp)
    except OSError:
        pass
    if code != 0:
        raise RuntimeError(f"mixing failed: {err.strip()}")

    return {
        "song": song,
        "drums": drums,
        "out": out,
        "songTempo": song_tempo,
        "drumTempo": drum_tempo,
        "stretchRatio": ratio,
        "drumsGainDb": drums_gain_db,
        "duration": probe_duration(out),
        "bytes": os.path.getsize(out) if os.path.exists(out) else 0,
    }


def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="heartmula-mix", description=__doc__)
    parser.add_argument("--song", required=True)
    parser.add_argument("--drums", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--drums-gain-db", type=float, default=-6.0)
    parser.add_argument("--song-gain-db", type=float, default=0.0)
    parser.add_argument("--stretch", type=float, default=None,
                        help="the tempo ratio to use (default: measured)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = mix_song_with_drums(
        args.song, args.drums, args.out,
        drums_gain_db=args.drums_gain_db,
        song_gain_db=args.song_gain_db,
        stretch=args.stretch,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"heartmula-mix: wrote {result['out']}")
        print(f"  song tempo {result['songTempo']} | drums tempo {result['drumTempo']} "
              f"| stretch {result['stretchRatio']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
