#!/usr/bin/env python3
"""Unit tests for lib/story/lyrics.py.

Pure stdlib where it matters: the TIMING decisions — when a word is on the
screen — are the product, and they must agree with the way the renderer
joins the shots. A lyric that fades in a third of a second late is a lyric
that lands on the wrong picture.

    python3 lib/story/lyrics.test.py

Exits 0 when every check passes, 1 otherwise.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lyrics import (  # noqa: E402
    alpha_at,
    build_ffmpeg_command,
    shot_windows,
    wrap_text,
)

_failures = []
_count = 0


def check(cond, label):
    global _count
    _count += 1
    if cond:
        print("  \033[32mok\033[0m   %s" % label)
    else:
        print("  \033[31mFAIL\033[0m %s" % label)
        _failures.append(label)


def eq(got, want, label):
    check(got == want, "%s (got %r, want %r)" % (label, got, want))


def cutlist(durations, lines=None, transition='none', fade=0.6):
    shots = []
    for i, duration in enumerate(durations):
        line = (lines[i] if lines else 'line %d' % i)
        shots.append({'line': line, 'image': 'f%d.jpg' % i,
                      'duration': duration, 'score': 0.5})
    return {
        'images': ['f%d.jpg' % i for i in range(len(durations))],
        'durations': list(durations),
        'shots': shots,
        'transition': transition,
        'fade': fade,
    }


def test_windows_without_transition():
    print("windows — shots with no transition are back to back")
    windows = shot_windows(cutlist([4.0, 3.0, 2.0]))
    eq(len(windows), 3, "every shot has a window")
    eq(windows[0]['start'], 0.0, "the first shot starts at zero")
    eq(windows[0]['end'], 4.0, "the first shot ends after its duration")
    eq(windows[1]['start'], 4.0, "the second shot starts where the first ended")
    eq(windows[1]['end'], 7.0, "the second shot ends after its duration")
    eq(windows[2]['start'], 7.0, "the third shot starts where the second ended")
    eq(windows[2]['end'], 9.0, "the third shot ends after its duration")
    eq(windows[1]['line'], 'line 1', "the window carries its lyric")


def test_windows_with_crossfade():
    print("windows — a crossfade OVERLAPS the shots")
    # The renderer joins with xfade, so shot 2 starts fading in BEFORE shot
    # 1 has finished. Measured against the real renderer (plan.mjs), the
    # 4s+4s/fade-1 case puts the join at 3.000s and the film at 7.000s.
    # The lyric's window is the shot's DOMINANT span: it ends where the
    # next one takes over, at the midpoint of the dissolve.
    windows = shot_windows(cutlist([4.0, 4.0, 4.0], transition='crossfade', fade=1.0))
    eq(windows[0]['start'], 0.0, "the first shot starts at zero")
    eq(windows[1]['start'], 3.5, "the second shot takes over at the midpoint of the dissolve")
    eq(windows[2]['start'], 6.5, "the third shot takes over at the next midpoint")
    eq(windows[2]['end'], 10.0, "the last shot ends with the film")
    # The film's total length is the sum minus the overlaps — 10.0s, which
    # is what the renderer reports for three 4s shots with a 1s dissolve.
    total = windows[-1]['end']
    eq(total, 10.0, "the film is three 4s shots less two 1s dissolves")


def test_windows_do_not_overlap():
    print("windows — two lyrics are never on the screen at once")
    for durations, transition, fade in (([4.0, 4.0], 'crossfade', 1.0),
                                        ([4.0, 2.0], 'crossfade', 5.0),
                                        ([4.0, 3.0, 2.0], 'none', 0.6),
                                        ([5.0, 5.0, 5.0, 5.0], 'crossfade', 0.6)):
        windows = shot_windows(cutlist(durations, transition=transition, fade=fade))
        for i in range(len(windows) - 1):
            check(windows[i]['end'] <= windows[i + 1]['start'],
                  "shot %d ends before shot %d starts (%r vs %r)"
                  % (i, i + 1, windows[i]['end'], windows[i + 1]['start']))


def test_fade_is_clamped_to_half_the_shortest_shot():
    print("windows — a dissolve cannot be longer than half the shot it joins")
    # The renderer clamps the fade to half the shortest segment: a 2s shot
    # can only dissolve by 1s. The lyric window must use the SAME fade or
    # the words drift from the picture.
    windows = shot_windows(cutlist([4.0, 2.0], transition='crossfade', fade=5.0))
    eq(windows[1]['start'], 3.5, "the fade is clamped to half the 2s shot")
    eq(windows[1]['end'], 5.0, "the film is 4s + 2s less the 1s dissolve")


def test_windows_fall_back_to_the_shot_durations():
    print("windows — a cut list with no durations still works")
    payload = {'shots': [{'line': 'a', 'duration': 3.0},
                         {'line': 'b', 'duration': 2.0}],
               'transition': 'none'}
    windows = shot_windows(payload)
    eq(len(windows), 2, "both shots have a window")
    eq(windows[1]['start'], 3.0, "the second shot starts after the first")


def test_no_shots():
    print("windows — a cut list with no shots has no windows")
    eq(shot_windows({}), [], "an empty cut list has no windows")
    eq(shot_windows({'shots': []}), [], "an empty shot list has no windows")


def test_alpha():
    print("alpha — a word fades in, holds, and fades out")
    window = {'start': 10.0, 'end': 14.0}
    eq(alpha_at(window, 9.9), 0.0, "before the shot, the word is invisible")
    eq(alpha_at(window, 10.0), 0.0, "at the very start it has just begun")
    check(alpha_at(window, 10.2) > 0.0, "a fifth of a second in it is visible")
    check(alpha_at(window, 10.2) < 1.0, "a fifth of a second in it is not yet full")
    eq(alpha_at(window, 12.0), 1.0, "in the middle it is fully opaque")
    check(alpha_at(window, 13.8) < 1.0, "near the end it is fading out")
    eq(alpha_at(window, 14.1), 0.0, "after the shot, the word is invisible")
    eq(alpha_at(window, 14.0), 0.0, "at the very end it has gone")


def test_alpha_fades_can_be_disabled():
    print("alpha — the fades can be turned off")
    window = {'start': 10.0, 'end': 14.0}
    eq(alpha_at(window, 10.0, fade_in=0, fade_out=0), 1.0,
       "with no fades the word is up the moment the shot starts")
    eq(alpha_at(window, 13.9, fade_in=0, fade_out=0), 1.0,
       "and it stays up until the shot ends")


def test_alpha_never_leaves_the_range():
    print("alpha — the opacity is always a number between 0 and 1")
    window = {'start': 10.0, 'end': 14.0}
    for moment in [9.0, 10.0, 10.1, 11.0, 13.9, 14.0, 15.0]:
        value = alpha_at(window, moment)
        check(0.0 <= value <= 1.0, "at %.1fs the opacity is in range (%r)" % (moment, value))


def test_wrap():
    print("wrap — a long line wraps instead of running off the picture")
    class FakeDraw:
        """Measures at 10 pixels per character, so the maths is checkable."""

        def textlength(self, text, font=None):
            return len(text) * 10

    lines = wrap_text(FakeDraw(), 'one two three four five six seven', None, 100)
    check(len(lines) > 1, "a long line becomes several lines")
    for line in lines:
        check(len(line) * 10 <= 100, "no line is wider than the limit (%r)" % line)
    eq(' '.join(lines), 'one two three four five six seven', "no word is lost")

    single = wrap_text(FakeDraw(), 'one', None, 1000)
    eq(single, ['one'], "a short line stays one line")

    empty = wrap_text(FakeDraw(), '   ', None, 100)
    eq(empty, [], "a blank line is no line")

    broken = wrap_text(FakeDraw(), 'abcdefghijklmnop', None, 50)
    check(len(broken) > 1, "a word longer than the line is broken")
    eq(''.join(broken), 'abcdefghijklmnop', "and nothing is dropped")


def test_ffmpeg_input_order():
    print("the ffmpeg command — the OVERLAY is input 0 and the FILM is input 1")
    # This is the bug that made the whole layer invisible: with the film as
    # input 0, the opaque film is painted ON TOP of the text. The run wrote
    # 180 frames, exited 0, and changed ZERO pixels.
    command = build_ffmpeg_command('ffmpeg', '/tmp/film.mp4', '/tmp/out.mp4',
                                    1920, 1080, 30)
    pipe_at = command.index('pipe:0')
    film_at = command.index('/tmp/film.mp4')
    check(pipe_at < film_at, "the overlay (pipe:0) comes BEFORE the film")
    check(command[pipe_at - 1] == '-i', "the overlay is an input")
    check(command[film_at - 1] == '-i', "the film is an input")
    filter_complex = command[command.index('-filter_complex') + 1]
    check(filter_complex.startswith('[1:v][0:v]overlay'),
          "the filter lays input 1 (the film) under input 0 (the overlay) — got %r"
          % filter_complex)
    check('1:a?' in command, "the film's audio is mapped, so the music survives")
    check(command[command.index('-map') + 1] == '[v]', "the video comes from the filter")


def main():
    for test in (test_windows_without_transition, test_windows_with_crossfade,
                 test_windows_do_not_overlap,
                 test_fade_is_clamped_to_half_the_shortest_shot,
                 test_windows_fall_back_to_the_shot_durations, test_no_shots,
                 test_alpha, test_alpha_fades_can_be_disabled,
                 test_alpha_never_leaves_the_range, test_wrap,
                 test_ffmpeg_input_order):
        test()
    print()
    if _failures:
        print("%d FAILED of %d checks:" % (len(_failures), _count))
        for label in _failures:
            print("  - %s" % label)
        return 1
    print("all %d checks passed" % _count)
    return 0


if __name__ == '__main__':
    sys.exit(main())
