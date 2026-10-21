#!/usr/bin/env python3
"""Unit tests for lib/flux2-renderer/prompts.py.

Pure stdlib — no torch, no diffusers, no model download. Run:

    python3 lib/flux2-renderer/test_prompts.py

Exits 0 when every check passes, 1 otherwise. Mirrors the plain-script
test convention used by lib/*.test.js in this repo (no test framework).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prompts import (  # noqa: E402
    _snap16,
    extract_prompts,
    format_for_render,
    parse_aspect,
    slugify,
)

_failures = []
_count = 0


def check(cond, label):
    global _count
    _count += 1
    if cond:
        print(f"  \033[32mok\033[0m   {label}")
    else:
        print(f"  \033[31mFAIL\033[0m {label}")
        _failures.append(label)


def eq(got, want, label):
    check(got == want, f"{label} (got {got!r}, want {want!r})")


def test_basic_pack():
    print("extract_prompts — a well-formed pack")
    pack = (
        "# Soft lamp at the window\n\n"
        "- A window at night, chipped mug on the sill --ar 16:9\n"
        "- Rain on the glass, one warm lamp --ar 16:9\n"
    )
    got = extract_prompts(pack)
    eq(len(got), 2, "two bullets -> two prompts")
    eq(got[0]["text"], "A window at night, chipped mug on the sill", "ar stripped from text")
    eq(got[0]["ar"], "16:9", "ar surfaced separately")


def test_frontmatter_and_commentary():
    print("extract_prompts — frontmatter, blockquotes, fences are ignored")
    pack = (
        "---\n"
        "title: style-preset pack\n"
        "ar: 2:3\n"
        "---\n"
        "\n"
        "> This is a note to the reader, not a prompt.\n"
        "\n"
        "```\n"
        "- this bullet lives in a code fence\n"
        "```\n"
        "\n"
        "- The only real prompt --ar 2:3\n"
        "\n"
        "Some trailing prose that is not a bullet.\n"
    )
    got = extract_prompts(pack)
    eq(len(got), 1, "only the real bullet survives")
    eq(got[0]["text"], "The only real prompt", "frontmatter not parsed as bullets")
    eq(got[0]["ar"], "2:3", "ar kept")


def test_edge_cases():
    print("extract_prompts — edge cases")
    eq(extract_prompts(""), [], "empty string -> no prompts")
    eq(extract_prompts(None), [], "None -> no prompts")
    eq(extract_prompts("-    \n-   \n"), [], "whitespace-only bullets dropped")
    eq(extract_prompts("* star bullet\n"), [{"text": "star bullet", "ar": None}], "star bullets accepted")
    eq(extract_prompts("- --ar 16:9\n"), [], "a bullet with only flags yields nothing")
    eq(extract_prompts("no bullets at all\njust prose\n"), [], "prose without bullets is ignored")


def test_prefix_and_shared():
    print("extract_prompts — shared prefixes stay distinct")
    pack = (
        "- Cinematic film still, anamorphic widescreen: a neon church at dawn\n"
        "- Cinematic film still, anamorphic widescreen: a figure on an empty platform\n"
    )
    got = extract_prompts(pack)
    eq(len(got), 2, "two prompts")
    check(got[0]["text"] != got[1]["text"], "shared prefix does not collapse the two")


def test_parse_aspect():
    print("parse_aspect — ratio parsing")
    eq(parse_aspect("16:9"), (16, 9), "16:9")
    eq(parse_aspect("1:1"), (1, 1), "1:1")
    eq(parse_aspect("2160:3840"), (2160, 3840), "tall phone ratio")
    eq(parse_aspect("nonsense"), None, "garbage -> None")
    eq(parse_aspect(""), None, "empty -> None")
    eq(parse_aspect(None), None, "None -> None")
    eq(parse_aspect("0:9"), None, "zero width rejected")
    eq(parse_aspect("-4:9"), None, "negative rejected")


def test_format_for_render():
    print("format_for_render — shape + area conservation")
    one = format_for_render({"text": "a", "ar": None})
    eq((one["width"], one["height"]), (832, 468), "no ar -> the caller-compatible default")

    nine = format_for_render({"text": "a", "ar": "16:9"})
    eq(nine["width"] % 16, 0, "derived width is a multiple of 16")
    eq(nine["height"] % 16, 0, "derived height is a multiple of 16")
    check(nine["width"] > nine["height"], "16:9 comes out landscape")

    square = format_for_render({"text": "a", "ar": "1:1"})
    check(abs(square["width"] - square["height"]) <= 16, "square stays square (within 16px)")
    eq(square["width"] % 16, 0, "square width is a multiple of 16")

    tall = format_for_render({"text": "a", "ar": "9:16"})
    check(tall["height"] > tall["width"], "9:16 renders taller than wide")
    eq(tall["height"] % 16, 0, "tall height is a multiple of 16")

    # Area is conserved so a 1:1 pack does not blow up the pixel count.
    default_area = 832 * 468
    check(
        abs(square["width"] * square["height"] - default_area) < default_area * 0.15,
        f"square area stays near the default ({square['width']*square['height']} vs {default_area})",
    )

    bad = format_for_render({"text": "a", "ar": "0:0"})
    check(bad["width"] >= 16 and bad["height"] >= 16, "a bad ratio never collapses to zero")

    eq(format_for_render({"text": "  spaced  "})["prompt"], "spaced", "prompt is trimmed")


def test_snap16():
    print("_snap16 — the constraint diffusers enforces")
    eq(_snap16(468), 464, "468 rounds DOWN to 464 (29.25 * 16)")
    eq(_snap16(832), 832, "832 is already /16")
    eq(_snap16(480), 480, "480 is already /16")
    eq(_snap16(1), 16, "tiny values floor at 16")
    eq(_snap16(0), 16, "zero floors at 16")
    eq(_snap16(8), 16, "8 rounds to 16")
    for v in (100, 250, 468, 777, 1024):
        check(_snap16(v) % 16 == 0, f"{v} -> {_snap16(v)} is divisible by 16")


def test_diffusers_rounding_is_real():
    """Evidence that /16 is not an invented rule.

    The 30-render batch of 2026-10-02 requested 832x468 and diffusers
    warned "Dimensions will be resized accordingly"; every produced PNG
    measured 832x464. This pins the rounding arithmetic so a future change
    to _snap16 cannot quietly diverge from what the pipeline does.
    """
    print("the /16 rule is the pipeline's, not ours")
    requested = format_for_render({"text": "x", "ar": None})
    eq((requested["width"], requested["height"]), (832, 468), "caller default is 832x468")
    eq(_snap16(requested["height"]), 464, "the pipeline's rounding of 468 is 464")
    check(_snap16(requested["height"]) != requested["height"],
          "requested != produced, which is why the manifest must record both")


def test_round_trip_with_pack():
    print("extract_prompts -> format_for_render — end to end")
    pack = (
        "- A window at night, chipped mug on the sill --ar 2:3\n"
        "- Rain on the glass, one warm lamp --ar 16:9\n"
        "- No ratio at all\n"
    )
    rendered = [format_for_render(e) for e in extract_prompts(pack)]
    eq(len(rendered), 3, "three renders")
    check(rendered[0]["prompt"] == "A window at night, chipped mug on the sill", "prompt body clean")
    check(rendered[0]["height"] > rendered[0]["width"], "2:3 comes out portrait")
    check(rendered[1]["width"] > rendered[1]["height"], "16:9 comes out landscape")
    # Derived shapes must satisfy the pipeline's /16 constraint.
    for r in rendered[:2]:
        check(
            r["width"] % 16 == 0 and r["height"] % 16 == 0 and r["width"] >= 16 and r["height"] >= 16,
            f"/16 and non-zero: {r['width']}x{r['height']}",
        )
    # The no-ar fallback is the documented exception: it is passed through
    # untouched for caller compatibility and the pipeline rounds it.
    eq(
        (rendered[2]["width"], rendered[2]["height"]),
        (832, 468),
        "fallback passes the caller default through unchanged",
    )
    eq(_snap16(rendered[2]["height"]), 464, "…and the pipeline rounds 468 to 464")


def test_slugify():
    print("slugify — batch filenames")
    eq(slugify("A window at night, chipped mug"), "a-window-at-night-chipped-mug", "lowercase + hyphens")
    eq(slugify("  spaced   out  "), "spaced-out", "runs of separators collapse")
    eq(slugify("!!!"), "frame", "no alphanumerics -> the 'frame' fallback")
    eq(slugify(""), "frame", "empty -> the 'frame' fallback")
    eq(slugify(None), "frame", "None -> the 'frame' fallback")
    long = slugify("one two three four five six seven eight nine ten eleven twelve")
    check(len(long) <= 40, f"long prompts truncate (got {len(long)} chars)")
    check(not long.startswith("-") and not long.endswith("-"), "no leading/trailing hyphen")
    check(slugify("Caf\x82 — na\xefve \xd6l") is not None, "non-ascii input never raises")


def main():
    test_basic_pack()
    test_frontmatter_and_commentary()
    test_edge_cases()
    test_prefix_and_shared()
    test_parse_aspect()
    test_format_for_render()
    test_snap16()
    test_diffusers_rounding_is_real()
    test_round_trip_with_pack()
    test_slugify()

    print()
    if _failures:
        print(f"\033[31m{_count - len(_failures)}/{_count} passed — {len(_failures)} FAILED\033[0m")
        return 1
    print(f"\033[32mALL {_count} CHECKS PASSED\033[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
