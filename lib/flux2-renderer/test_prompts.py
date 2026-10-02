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

from prompts import extract_prompts, format_for_render, parse_aspect, slugify  # noqa: E402

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
    eq((one["width"], one["height"]), (832, 468), "no ar -> the proven default 16:9")

    nine = format_for_render({"text": "a", "ar": "16:9"})
    eq(nine["width"] % 2, 0, "width is even")
    eq(nine["height"] % 2, 0, "height is even")
    check(nine["width"] > nine["height"], "16:9 comes out landscape")

    square = format_for_render({"text": "a", "ar": "1:1"})
    check(abs(square["width"] - square["height"]) <= 2, "square stays square (within 2px)")

    tall = format_for_render({"text": "a", "ar": "9:16"})
    check(tall["height"] > tall["width"], "9:16 renders taller than wide")

    # Area is conserved so a 1:1 pack does not blow up the pixel count.
    default_area = 832 * 468
    check(
        abs(square["width"] * square["height"] - default_area) < default_area * 0.15,
        f"square area stays near the default ({square['width']*square['height']} vs {default_area})",
    )

    bad = format_for_render({"text": "a", "ar": "0:0"})
    check(bad["width"] >= 2 and bad["height"] >= 2, "a bad ratio never collapses to zero")

    eq(format_for_render({"text": "  spaced  "})["prompt"], "spaced", "prompt is trimmed")


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
    check(rendered[2]["width"] == 832 and rendered[2]["height"] == 468, "unspecified falls back")
    for r in rendered:
        check(
            r["width"] % 2 == 0 and r["height"] % 2 == 0 and r["width"] >= 2 and r["height"] >= 2,
            f"even, non-zero dimensions: {r['width']}x{r['height']}",
        )


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
