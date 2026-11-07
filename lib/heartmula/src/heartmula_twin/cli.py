"""`heartmula` — the twin's way into HeartMuLa.

HeartMuLa (github.com/HeartMuLa/heartlib, Apache-2.0 for both the code and
the weights) is an open-source music foundation model: it writes a whole
song from **lyrics + style tags**, in several languages, with a 3B
open-weights release that runs on a laptop.

    heartmula check
    heartmula generate --lyrics song.txt --tags "modal jazz, trumpet, warm" --out song.mp3

The checkpoints live in `lib/heartmula/ckpt/` (gitignored):

    ckpt/
    ├── HeartCodec-oss/
    ├── HeartMuLa-oss-3B/
    ├── config.json
    ├── gen_config.json
    └── tokenizer.json

Two things this CLI decides for you:

* **the device.** The upstream example defaults to `cuda`. This picks `mps`
  on Apple silicon, `cuda` when nvidia is there, and `cpu` otherwise — and
  says which one it picked before the model loads.
* **the dtypes.** `bf16` for the language model, `fp32` for the codec (the
  upstream note is explicit: bf16 in the codec degrades the audio).

Everything that costs time happens only after the arguments are checked:
`--dry-run` prints the plan and loads nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional, Tuple

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_CKPT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "ckpt")


def pick_device(requested: str = "auto") -> str:
    """The device to run on: mps on Apple silicon, cuda on nvidia, else cpu."""
    if requested and requested != "auto":
        return requested
    try:
        import torch  # noqa: PLC0415

        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001 - torch may be missing in a dry run
        pass
    return "cpu"


def checkpoint_state(ckpt_dir: str) -> dict:
    """What is (and is not) on disk under the checkpoint directory."""
    required = [
        "config.json",
        "gen_config.json",
        "tokenizer.json",
        os.path.join("HeartMuLa-oss-3B", "config.json"),
        os.path.join("HeartCodec-oss", "config.json"),
    ]
    present = []
    missing = []
    for rel in required:
        (present if os.path.exists(os.path.join(ckpt_dir, rel)) else missing).append(rel)
    size = 0
    for root, _dirs, files in os.walk(ckpt_dir):
        for name in files:
            try:
                size += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return {
        "dir": ckpt_dir,
        "ready": not missing,
        "missing": missing,
        "present": present,
        "bytes": size,
    }


def read_lyrics(path: str) -> str:
    """Read a lyric file. Section headers ([Verse], [Chorus]) are kept."""
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def build_tags(raw: Optional[str]) -> str:
    """Normalise a tag string: lower case, comma separated, wrapped in <tag>."""
    tags = (raw or "").strip().lower()
    if not tags:
        return ""
    if not tags.startswith("<tag>"):
        tags = f"<tag>{tags}"
    if not tags.endswith("</tag>"):
        tags = f"{tags}</tag>"
    return tags


def build_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="heartmula", description=__doc__)
    sub = parser.add_subparsers(dest="command")

    check = sub.add_parser("check", help="report the checkpoint and the device")
    check.add_argument("--ckpt", default=DEFAULT_CKPT)
    check.add_argument("--device", default="auto")

    gen = sub.add_parser("generate", help="write a song from lyrics and tags")
    gen.add_argument("--lyrics", required=True, help="a .txt file with the lyric")
    gen.add_argument("--tags", default="", help="comma separated style tags")
    gen.add_argument("--out", default="data/heartmula/song.mp3")
    gen.add_argument("--ckpt", default=DEFAULT_CKPT)
    gen.add_argument("--seconds", type=int, default=240, help="the length to write")
    gen.add_argument("--device", default="auto")
    gen.add_argument("--codec-device", default=None,
                     help="where the codec runs (default: the same device as the model)")
    gen.add_argument("--version", default="3B", choices=["3B", "7B"])
    gen.add_argument("--topk", type=int, default=50)
    gen.add_argument("--temperature", type=float, default=1.0)
    gen.add_argument("--cfg-scale", type=float, default=3.0)
    gen.add_argument("--compile", action="store_true",
                     help="let torch.compile run (faster on CUDA, broken on MPS)")
    gen.add_argument("--lazy-load", action="store_true",
                     help="load and drop each module in turn (saves memory)")
    gen.add_argument("--dry-run", action="store_true", help="print the plan, load nothing")
    gen.add_argument("--json", action="store_true")

    return parser.parse_args(argv)


def _device_and_dtypes(device: str) -> Tuple[str, str, str]:
    """(mula device, codec device, mula dtype) for the requested device."""
    if device == "cpu":
        # bf16 on cpu is slow and poorly supported; float32 is the honest
        # choice for a machine without a GPU.
        return "cpu", "cpu", "float32"
    return device, device, "bfloat16"


def main(argv: Optional[List[str]] = None) -> int:
    args = build_args(argv)
    if not args.command:
        print(build_args(["--help"]).format_help())
        return 0

    device = pick_device(args.device)
    state = checkpoint_state(args.ckpt)

    if args.command == "check":
        payload = {
            "device": device,
            "checkpoints": state,
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0 if state["ready"] else 1

    if not os.path.exists(args.lyrics):
        sys.stderr.write(f"heartmula: no such lyric file: {args.lyrics}\n")
        return 2
    lyrics = read_lyrics(args.lyrics)
    tags = build_tags(args.tags)
    mula_device, codec_device, mula_dtype = _device_and_dtypes(device)
    if getattr(args, "codec_device", None):
        codec_device = args.codec_device
    plan = {
        "lyrics": args.lyrics,
        "lyricsChars": len(lyrics),
        "tags": tags,
        "out": args.out,
        "seconds": args.seconds,
        "maxAudioLengthMs": args.seconds * 1000,
        "version": args.version,
        "device": {"mula": mula_device, "codec": codec_device},
        "dtype": {"mula": mula_dtype, "codec": "float32"},
        "topk": args.topk,
        "temperature": args.temperature,
        "cfgScale": args.cfg_scale,
        "lazyLoad": args.lazy_load,
        "checkpoints": state,
    }
    if args.dry_run:
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return 0
    if not state["ready"]:
        sys.stderr.write(
            "heartmula: the checkpoints are not in place.\n"
            f"  missing: {', '.join(state['missing'])}\n"
            "  fetch them with:\n"
            "    hf download --local-dir ./ckpt 'HeartMuLa/HeartMuLaGen'\n"
            "    hf download --local-dir ./ckpt/HeartMuLa-oss-3B 'HeartMuLa/HeartMuLa-oss-3B-happy-new-year'\n"
            "    hf download --local-dir ./ckpt/HeartCodec-oss HeartMuLa/HeartCodec-oss-20260123\n"
        )
        return 1

    # On Apple silicon the pipeline's torch.compile path dies in the
    # Metal backend ("device_assert_async should be handled by CSEProxy"),
    # and the inductor wants triton, which does not exist on macOS. Both
    # are compile-time concerns only, so the compile is turned off unless
    # the caller asks for it.
    if not getattr(args, "compile", False):
        os.environ.setdefault("TORCH_COMPILE_DISABLE", "1")

    import torch  # noqa: PLC0415 - deliberately late: a dry run must not pay for it

    # torchaudio 2.9+ saves through **torchcodec**, and torchcodec's
    # bundled ffmpeg dylibs will not load against a Homebrew ffmpeg 8
    # ("Could not load this library: libtorchcodec_core8.dylib").
    # torchaudio 2.10 dropped its other backends, so the write is done
    # with soundfile directly — it is already a dependency, and it
    # writes wav without any codec at all.
    try:
        import numpy as _np
        import soundfile as _sf
        import torchaudio  # noqa: PLC0415

        def _save_with_soundfile(uri, src, sample_rate=44100, channels_first=False, **kwargs):
            # torchaudio.save accepts a path OR an open file object, and the
            # pipeline hands it the latter — soundfile needs the object
            # itself, not its repr.
            data = src.detach().to("cpu").numpy() if hasattr(src, "detach") else _np.asarray(src)
            if data.ndim == 2 and channels_first:
                data = data.T
            target = uri if hasattr(uri, "write") else str(uri)
            _sf.write(target, data, int(sample_rate), subtype="PCM_16")

        torchaudio.save = _save_with_soundfile
    except Exception:  # noqa: BLE001 - fall back to whatever torchaudio does
        pass

    from heartlib import HeartMuLaGenPipeline  # noqa: PLC0415

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    save_path = args.out
    post_convert = None
    if save_path.lower().endswith(".mp3"):
        save_path = save_path[:-4] + ".wav"
        post_convert = args.out

    pipe = HeartMuLaGenPipeline.from_pretrained(
        args.ckpt,
        device={"mula": torch.device(mula_device), "codec": torch.device(codec_device)},
        dtype={"mula": getattr(torch, mula_dtype), "codec": torch.float32},
        version=args.version,
        lazy_load=args.lazy_load,
    )
    with torch.no_grad():
        pipe(
            {"lyrics": lyrics, "tags": tags},
            max_audio_length_ms=args.seconds * 1000,
            save_path=save_path,
            topk=args.topk,
            temperature=args.temperature,
            cfg_scale=args.cfg_scale,
        )
    if post_convert and os.path.exists(save_path):
        import subprocess  # noqa: PLC0415

        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", save_path,
                        "-c:a", "libmp3lame", "-b:a", "256k", post_convert], check=True)
        os.remove(save_path)

    written = post_convert or save_path
    if args.json:
        print(json.dumps({**plan, "written": os.path.exists(written),
                          "bytes": os.path.getsize(written) if os.path.exists(written) else 0},
                         indent=2, ensure_ascii=False))
    else:
        print(f"heartmula: wrote {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
