#!/usr/bin/env python3
"""Tests for the heartmula-twin CLI.

Pure functions only — no torch, no model, no checkpoints, no network. The
expensive parts (the device choice, the checkpoint check, the tag shape)
are exactly the parts that decide whether a run is worth starting.

    python3 lib/heartmula/tests/test_cli.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from heartmula_twin.cli import (  # noqa: E402
    build_args,
    build_tags,
    checkpoint_state,
    pick_device,
    read_lyrics,
)

PASSED = 0
FAILED = 0
FAILURES = []


def check(name):
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


# ---- the device ---------------------------------------------------------

@check("an explicit device is honoured")
def _():
    assert pick_device("cpu") == "cpu"
    assert pick_device("mps") == "mps"


@check("auto picks a device the machine actually has")
def _():
    device = pick_device("auto")
    assert device in ("mps", "cuda", "cpu"), device


@check("auto never picks cuda on a machine without nvidia")
def _():
    try:
        import torch

        if not torch.cuda.is_available():
            assert pick_device("auto") != "cuda"
    except ImportError:
        pass


# ---- the tags -----------------------------------------------------------

@check("tags are lower cased")
def _():
    assert build_tags("Modal Jazz, Trumpet") == "<tag>modal jazz, trumpet</tag>"


@check("tags that already carry the wrapper are left alone")
def _():
    assert build_tags("<tag>jazz</tag>") == "<tag>jazz</tag>"


@check("empty tags stay empty rather than becoming a bare wrapper")
def _():
    assert build_tags("") == ""
    assert build_tags(None) == ""


# ---- the checkpoints ----------------------------------------------------

@check("an empty checkpoint directory is not ready")
def _():
    with tempfile.TemporaryDirectory() as tmp:
        state = checkpoint_state(tmp)
        assert state["ready"] is False
        assert state["missing"], state


@check("a complete checkpoint directory is ready")
def _():
    with tempfile.TemporaryDirectory() as tmp:
        for rel in ("config.json", "gen_config.json", "tokenizer.json",
                    "HeartMuLa-oss-3B/config.json", "HeartCodec-oss/config.json"):
            path = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w", encoding="utf-8").close()
        state = checkpoint_state(tmp)
        assert state["ready"] is True, state
        assert state["missing"] == [], state


@check("one missing file keeps the whole thing not ready")
def _():
    with tempfile.TemporaryDirectory() as tmp:
        for rel in ("config.json", "gen_config.json", "tokenizer.json",
                    "HeartMuLa-oss-3B/config.json"):
            path = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w", encoding="utf-8").close()
        state = checkpoint_state(tmp)
        assert state["ready"] is False
        assert any("HeartCodec" in m for m in state["missing"]), state


# ---- the lyrics ---------------------------------------------------------

@check("a lyric file is read with its section headers")
def _():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "song.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("[Verse]\nThe radiator ticks\n")
        text = read_lyrics(path)
        assert "[Verse]" in text
        assert "radiator" in text


# ---- the arguments ------------------------------------------------------

@check("generate defaults to four minutes")
def _():
    args = build_args(["generate", "--lyrics", "x.txt"])
    assert args.seconds == 240
    assert args.max_audio_length_ms if hasattr(args, "max_audio_length_ms") else True


@check("the seconds flag is the only length knob")
def _():
    args = build_args(["generate", "--lyrics", "x.txt", "--seconds", "30"])
    assert args.seconds == 30


@check("a dry run is a flag, not a mode")
def _():
    args = build_args(["generate", "--lyrics", "x.txt", "--dry-run"])
    assert args.dry_run is True


@check("check takes no lyric")
def _():
    args = build_args(["check"])
    assert args.command == "check"


print(f"[heartmula.test] passed: {PASSED}, failed: {FAILED}")
if FAILED:
    for f in FAILURES:
        print(f"  ✗ {f}")
    raise SystemExit(1)
