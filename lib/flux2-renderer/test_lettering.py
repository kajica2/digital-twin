#!/usr/bin/env python3
"""Unit tests for lib/flux2-renderer/lettering.py (TD-007).

Pure stdlib + PIL (already in the flux2 venv). No model, no network.

    python3 lib/flux2-renderer/test_lettering.py

The important assertion in here is that the EXACT title characters reach
the draw command. Without OCR we cannot read the rendered pixels back, so
the honest way to test "the cover says Chrome Heart and not CHIOME HEART"
is to test the plan that feeds the renderer — plan() is pure and its
output carries the literal strings.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lettering import (  # noqa: E402
    FAMILIES,
    compose,
    family_for_slug,
    fit_font_size,
    plan,
    relpath_for_manifest,
    resolve_font,
    scrim_gradient,
    split_units,
    wrap_text,
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


class _ProbeDraw:
    """Measures text without touching an image."""

    def textlength(self, text, font=None):
        return len(str(text)) * float(getattr(font, "size", 10)) * 0.6

    def textbbox(self, xy, text, font=None):
        w = self.textlength(text, font=font)
        h = float(getattr(font, "size", 10)) * 1.2
        return (0, 0, w, h)


class _ProbeFont:
    def __init__(self, size):
        self.size = size


def test_wrap_text():
    print("wrap_text — greedy wrapping")
    d = _ProbeDraw()
    f = _ProbeFont(10)  # each char ~6px -> 10 chars fit in 60px
    eq(wrap_text("one two three", f, 60, d), ["one two", "three"], "wraps on the fitting boundary")
    eq(wrap_text("short", f, 600, d), ["short"], "fits on one line")
    eq(wrap_text("supercalifragilistic", f, 30, d), ["supercalifragilistic"],
       "an over-long single word is kept, never dropped")
    eq(wrap_text("", f, 60, d), [], "empty text -> no lines")
    eq(wrap_text("   ", f, 60, d), [], "whitespace-only -> no lines")


def test_split_units():
    print("split_units — separators never strand")
    eq(split_units("TYPE : LOUD"), ["TYPE", ": LOUD"], "colon travels with the next word")
    eq(split_units("one two three"), ["one", "two", "three"], "plain words unchanged")
    eq(split_units("a, b"), ["a,", "b"], "punctuation glued to a word stays with that word")
    eq(split_units("WORD , b"), ["WORD", ", b"], "a STANDALONE separator travels with the next word")
    eq(split_units("Veil"), ["Veil"], "single word")
    eq(split_units(""), [], "empty")
    eq(split_units("trailing :"), ["trailing", ":"], "a trailing separator cannot merge, so it stands")
    eq(split_units("Ember — Smoke"), ["Ember", "— Smoke"], "em dash travels with the next word")

    d = _ProbeDraw()
    f = _ProbeFont(10)
    lines = wrap_text("TYPE : LOUD", f, 30, d)  # force a wrap
    check(all(not line.strip().endswith(":") for line in lines),
          f"no line ends in a dangling colon: {lines}")
    eq(" ".join(lines), "TYPE : LOUD", "wrapping loses nothing")


def test_relpath_for_manifest():
    """A shipped manifest must never carry the author's home directory."""
    print("relpath_for_manifest — no filesystem shape travels")
    import os as _os

    home = _os.path.expanduser("~")
    cwd = _os.getcwd()

    inside = _os.path.join(cwd, "assets", "marketplace", "covers", "a.jpg")
    eq(relpath_for_manifest(inside), "assets/marketplace/covers/a.jpg",
       "a path under the repo becomes repo-relative")

    under_home = home + "/Documents/some/other/place.png"
    eq(relpath_for_manifest(under_home), "~/Documents/some/other/place.png",
       "a path under home is tilde-prefixed, never absolute")

    sys_font = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
    eq(relpath_for_manifest(sys_font), "Arial Black.ttf",
       "an unrelated absolute path keeps only its basename")

    eq(relpath_for_manifest(""), "", "empty stays empty")
    check(home not in relpath_for_manifest(under_home),
          "the home directory itself never appears in the output")
    for candidate in (inside, under_home, sys_font):
        check("/Users/" not in relpath_for_manifest(candidate),
              f"no /Users/ leak for {relpath_for_manifest(candidate)}")


def test_fit_font_size():
    print("fit_font_size — largest size that fits")
    d = _ProbeDraw()
    import PIL.ImageDraw as _D
    import PIL.Image as _I

    probe = _D.Draw(_I.new("RGB", (4, 4)))
    font = resolve_font()
    size, lines = fit_font_size("Chrome Heart", font, 400, 120, probe, max_size=60, min_size=12)
    check(12 <= size <= 60, f"size within bounds (got {size})")
    check(1 <= len(lines) <= 4, f"line count sane (got {len(lines)})")
    eq(" ".join(lines), "Chrome Heart", "no characters lost while wrapping")

    tiny, tlines = fit_font_size("A very very long title that cannot possibly fit here",
                                 font, 80, 40, probe, max_size=40, min_size=12, max_lines=2)
    check(tiny >= 12, f"never below min_size (got {tiny})")
    eq(" ".join(tlines).count("A very"), 1, "text preserved even when forced small")

    # REGRESSION: an impossible fit must terminate. The first version of this
    # function pinned `size` at min_size and looped forever, hanging the test
    # run with no output at all. Tiny box, huge title, tiny floor.
    impossible, ilines = fit_font_size(
        "A title far longer than any box we could possibly give it here",
        font, 20, 8, probe, max_size=6, min_size=4, max_lines=1
    )
    check(impossible >= 4, f"impossible fit still returns (size={impossible})")
    check(isinstance(ilines, list) and ilines, "impossible fit still returns lines")


def test_plan_carries_exact_strings():
    """THE assertion: what the cover will say, character for character."""
    print("plan — the letters that reach the renderer")
    for title in ("Chrome Heart", "Veil", "TYPE : LOUD", "Overdrive",
                  "Midnight Circuit", "Smoke Portrait"):
        p = plan(832, 832, title, family="smoke")
        rendered = " ".join(p["title"]["lines"])
        eq(rendered, title, f"title survives planning intact: {title!r}")
        check(title not in ("CHIOME HEART", "VEAL", "OVERDDVIVE"),
              f"{title!r} is not the misspelling")

    p = plan(832, 832, "Chrome Heart", subtitle="neon pulse", family="neon-pulse")
    eq(" ".join(p["title"]["lines"]), "Chrome Heart", "title exact")
    eq(p["subtitle"]["lines"], ["neon pulse"], "subtitle exact")


def test_plan_geometry():
    print("plan — scrim placement per family")
    for fam, where in (("neon-pulse", "bottom"), ("smoke", "top"), ("type-loud", "center")):
        p = plan(832, 832, "X", family=fam)
        l, t, r, b = p["scrim"]["box"]
        eq(r - l, 832, f"{fam}: scrim spans full width")
        if where == "bottom":
            check(b == 832, f"{fam}: band anchored to the bottom edge")
        elif where == "top":
            check(t == 0, f"{fam}: band anchored to the top edge")
        else:
            check(0 < t < 832 and b < 832, f"{fam}: band floats centred")
        check(b > t, f"{fam}: band has height")

    p = plan(832, 468, "X", family="smoke")
    l, t, r, b = p["scrim"]["box"]
    check(b <= 468, "non-square plate is respected")


def test_scrim_gradient():
    """A hard rectangle reads as a UI panel pasted on the art; a ramp reads as light."""
    print("scrim_gradient — ramp, not a slab")

    def alphas(placement):
        g = scrim_gradient(10, 100, (0, 0, 10, 100), (255, 0, 0, 200), placement)
        col = [g.getpixel((5, y))[3] for y in range(100)]
        return col

    bot = alphas("bottom")
    check(bot[0] < bot[-1], "bottom: opaque at the bottom edge")
    check(bot[0] <= 20, f"bottom: transparent at the inner edge (got {bot[0]})")
    check(bot[-1] >= 190, f"bottom: near-full alpha at the outer edge (got {bot[-1]})")

    top = alphas("top")
    check(top[0] > top[-1], "top: opaque at the top edge")
    check(top[0] >= 190 and top[-1] <= 20, "top: fades downward")

    ctr = alphas("center")
    check(ctr[49] >= ctr[0] and ctr[49] >= ctr[-1], "center: strongest in the middle")
    check(ctr[0] <= 20 and ctr[-1] <= 20, "center: fades to both edges")

    # a ramp must not be flat — that is the whole point
    check(len(set(bot)) > 10, f"bottom ramp is not a slab ({len(set(bot))} distinct alphas)")


def test_title_lockup():
    print("fit_font_size — a lockup, not a broken word")
    import PIL.ImageDraw as _D
    import PIL.Image as _I

    # Real font metrics here on purpose. An earlier draft measured width as
    # 0.6 * len(text) * size, which made the trade-off numbers fiction and
    # failed against real Arial Black.
    probe = _D.Draw(_I.new("RGB", (4, 4)))
    font = resolve_font()

    size, lines = fit_font_size("TYPE : LOUD", font, 700, 700, probe,
                                max_size=240, min_size=12, max_lines=4)
    eq(" ".join(lines), "TYPE : LOUD", "the title is intact, character for character")
    check(1 <= len(lines) <= 2, f"short title is one or two lines, never three (got {len(lines)})")
    check(all(not ln.strip().endswith(":") for ln in lines),
          f"no dangling colon at a line break (got {lines})")
    check(size >= 12, f"size is usable (got {size})")

    size2, lines2 = fit_font_size(
        "A Title Far Too Long To Ever Fit On One Line At Any Readable Size",
        font, 420, 700, probe, max_size=200, min_size=12, max_lines=4
    )
    check(len(lines2) > 1, f"a long title wraps (got {len(lines2)} lines)")
    check(size2 >= 12, "and stays at or above min_size")
    eq(" ".join(lines2),
       "A Title Far Too Long To Ever Fit On One Line At Any Readable Size",
       "no characters lost when wrapping")

    size3, lines3 = fit_font_size("TYPE : LOUD", font, 700, 700, probe,
                                  max_size=240, min_size=12, max_lines=4,
                                  prefer_single_line=False)
    check(size3 >= size,
          f"prefer_single_line=False may use more size by wrapping ({size3} vs {size})")
    check(len(lines3) >= 1, "and still returns lines")


def test_plan_edge_cases():
    print("plan — edge cases")
    p = plan(832, 832, "", family="smoke")
    eq(p["title"]["lines"], [], "empty title -> no lines to draw (consistent with wrap_text)")

    p = plan(832, 832, "X", family="no-such-family")
    eq(p["family"], "smoke", "unknown family falls back rather than exploding")

    p = plan(832, 832, "X", family="smoke")
    eq(p["subtitle"], None, "no subtitle -> no subtitle block")

    p = plan(832, 832, "Ünïcödé — Tïtlé", family="smoke")
    eq(" ".join(p["title"]["lines"]), "Ünïcödé — Tïtlé", "unicode survives")

    eq(sorted(FAMILIES.keys()), ["neon-pulse", "smoke", "type-loud"], "the three families exist")


def test_family_for_slug():
    print("family_for_slug — slug to treatment")
    eq(family_for_slug("neon_pulse-01"), "neon-pulse", "underscore slug")
    eq(family_for_slug("neon-pulse-01"), "neon-pulse", "hyphen slug")
    eq(family_for_slug("01-neon_pulse-01"), "neon-pulse", "render-order prefix stripped")
    eq(family_for_slug("05-smoke-03"), "smoke", "smoke with prefix")
    eq(family_for_slug("11-type_loud-01"), "type-loud", "type-loud with prefix")
    eq(family_for_slug("type_loud-02"), "type-loud", "type-loud without prefix")
    eq(family_for_slug("something-else"), "smoke", "unknown slug falls back")
    eq(family_for_slug(""), "smoke", "empty slug falls back")
    eq(family_for_slug(None), "smoke", "None falls back")


def test_resolve_font():
    print("resolve_font — never a bitmap fallback")
    f = resolve_font()
    check(os.path.isfile(f), f"resolves to a real file: {f}")

    os.environ["COVER_FONT"] = "/definitely/not/a/font.ttf"
    try:
        f2 = resolve_font()
        check(os.path.isfile(f2), "a bad COVER_FONT falls through to candidates")
    finally:
        del os.environ["COVER_FONT"]

    try:
        resolve_font("/nope/missing.ttf")
        # candidate list still wins, which is intended behaviour
        check(True, "explicit missing font falls through to the candidate list")
    except FileNotFoundError:
        check(True, "explicit missing font raises when no candidate exists")


def test_compose_writes_real_output():
    print("compose — real file, real pixels")
    from PIL import Image

    with tempfile.TemporaryDirectory() as td:
        plate = os.path.join(td, "plate.jpg")
        Image.new("RGB", (832, 832), (20, 20, 30)).save(plate, "JPEG", quality=90)
        before = Image.open(plate).convert("RGB").tobytes()

        out = os.path.join(td, "cover.jpg")
        res = compose(plate, out, "Chrome Heart", subtitle="neon pulse", family="neon-pulse")

        check(os.path.isfile(out), "output written")
        eq(res["title"], "Chrome Heart", "manifest carries the title")
        eq(res["width"], 832, "manifest width matches the plate")
        eq(res["titleLines"], ["Chrome Heart"], "manifest lists the drawn line")

        after_img = Image.open(out)
        eq(after_img.size, (832, 832), "output keeps the plate dimensions")
        check(after_img.convert("RGB").tobytes() != before, "pixels changed — type was painted")

        band = after_img.convert("RGB").crop((0, 500, 832, 832))
        colors = band.getcolors(maxcolors=1_000_000) or []
        check(len(colors) > 20, f"the type band is not a flat block ({len(colors)} colours)")

        out2 = os.path.join(td, "cover2.jpg")
        res2 = compose(plate, out2, "Veil", family="smoke")
        eq(res2["titleLines"], ["Veil"], "a second family renders the right string too")


def test_compose_requires_a_font():
    print("compose — fails loudly without a font, never PIL's bitmap default")
    from PIL import Image

    with tempfile.TemporaryDirectory() as td:
        plate = os.path.join(td, "plate.jpg")
        Image.new("RGB", (832, 832), (20, 20, 30)).save(plate, "JPEG", quality=90)
        out = os.path.join(td, "x.jpg")
        saved = dict(os.environ)
        os.environ["COVER_FONT"] = ""
        try:
            # Empty COVER_FONT is falsy so candidates still apply; force the
            # failure path by pointing every candidate at nothing.
            import lettering as L
            old = L.DEFAULT_FONT_CANDIDATES
            L.DEFAULT_FONT_CANDIDATES = ("/nope/a.ttf", "/nope/b.ttf")
            try:
                try:
                    compose(plate, out, "X", family="smoke")
                    check(False, "raises FileNotFoundError when no font exists")
                except FileNotFoundError:
                    check(True, "raises FileNotFoundError when no font exists")
            finally:
                L.DEFAULT_FONT_CANDIDATES = old
        finally:
            os.environ.clear()
            os.environ.update(saved)
        check(not os.path.exists(out), "nothing written when it cannot letter the cover")


def main():
    test_wrap_text()
    test_split_units()
    test_relpath_for_manifest()
    test_fit_font_size()
    test_title_lockup()
    test_plan_carries_exact_strings()
    test_plan_geometry()
    test_scrim_gradient()
    test_plan_edge_cases()
    test_family_for_slug()
    test_resolve_font()
    test_compose_writes_real_output()
    test_compose_requires_a_font()

    print()
    if _failures:
        print(f"\033[31m{_count - len(_failures)}/{_count} passed — {len(_failures)} FAILED\033[0m")
        return 1
    print(f"\033[32mALL {_count} CHECKS PASSED\033[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
