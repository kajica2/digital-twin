#!/usr/bin/env python3
"""Unit tests for lib/story/director.py.

Pure stdlib, no model, no network. The decisions the director makes are
the product, so they are pinned here rather than only observed.

    python3 lib/story/director.test.py

Exits 0 when every check passes, 1 otherwise.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from director import (  # noqa: E402
    Director,
    hamming,
    load_lines,
    plan_fx,
    plan_motions,
    write_cutlist,
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


def frame(path, blur=3.0, yavg=120.0, spread=200.0, dhash=1):
    return {'path': path, 'ok': True, 'blur': blur, 'yavg': yavg,
            'spread': spread, 'dhash': dhash, 'reason': None}


def test_hamming():
    print("hamming — bits that differ")
    eq(hamming(0b1010, 0b1010), 0, "identical hashes differ in no bits")
    eq(hamming(0b1010, 0b1011), 1, "one bit differs")
    eq(hamming(0, 0xFFFFFFFFFFFFFFFF), 64, "all bits differ")


def test_technical_rejects():
    print("technical rejects — the frames that cannot be in a film")
    d = Director(['a line'])
    eq(d.technical_reject(frame('x.png', blur=3.0)), None, "a good frame is kept")
    eq(d.technical_reject(frame('x.png', blur=40.0)) is not None, True, "a soft frame is cut")
    eq(d.technical_reject(frame('x.png', yavg=2.0)) is not None, True, "a black frame is cut")
    eq(d.technical_reject(frame('x.png', yavg=252.0)) is not None, True, "a blown frame is cut")
    eq(d.technical_reject(frame('x.png', spread=10.0)) is not None, True, "a flat frame is cut")
    broken = {'path': 'x.png', 'ok': False, 'blur': None, 'yavg': None,
              'spread': None, 'dhash': None, 'reason': 'cannot decode'}
    check(d.technical_reject(broken) is not None, "an unreadable frame is cut")


def test_duplicate_collapse():
    print("duplicates — one picture survives")
    d = Director(['a line'])
    a = frame('a.png', dhash=0b1010)
    b = frame('b.png', dhash=0b1011)          # one bit away
    c = frame('c.png', dhash=0b1111000011110000)
    survivors, groups = d.collapse_duplicates([a, b, c])
    eq(len(survivors), 2, "the near-identical pair collapses to one")
    check(any(g == [a, b] or g == [b, a] for g in groups), "the pair is one group")
    survivors, _ = d.collapse_duplicates([a, b, c])
    eq(len(survivors), 2, "a distant frame is its own group")


def test_match_assigns_each_frame_once():
    print("matching — a frame belongs to one line")
    lines = [{'display': 'first', 'query': 'a room'},
             {'display': 'second', 'query': 'a street'}]
    d = Director(lines, threshold=0.1)
    frames = [frame('room.png'), frame('street.png'), frame('other.png')]
    #          room      street     other
    #  first    0.9       0.2        0.3
    #  second   0.1       0.8        0.4
    matrix = [[0.9, 0.2], [0.1, 0.8], [0.3, 0.4]]
    matches, unmatched, taken = d.match(frames, matrix)
    eq(len(matches), 2, "two lines are matched")
    eq(matches[0]['frame']['path'], 'room.png', "the first line takes the room")
    eq(matches[1]['frame']['path'], 'street.png', "the second line takes the street")
    eq([f['path'] for f in unmatched], ['other.png'], "the leftover frame is reported")
    used = [m['frame']['path'] for m in matches if m['frame']]
    eq(len(used), len(set(used)), "no frame is used twice")


def test_match_reports_a_gap_rather_than_a_wrong_frame():
    print("matching — a line with no frame is a gap, not a wrong picture")
    lines = [{'display': 'the coffee cup', 'query': 'a cup on a sill'},
             {'display': 'the floor', 'query': 'a wooden floor'}]
    d = Director(lines, threshold=0.1)
    frames = [frame('floor.png')]
    matrix = [[0.15, 0.80]]       # the only frame fits the floor, not the cup
    matches, unmatched, _ = d.match(frames, matrix)
    cup = [m for m in matches if m['line'] == 'the coffee cup'][0]
    eq(cup['frame'], None, "the coffee-cup line gets no frame")
    check(cup.get('gap') is not None, "the gap carries a reason")
    floor = [m for m in matches if m['line'] == 'the floor'][0]
    eq(floor['frame']['path'], 'floor.png', "the floor keeps the frame it fits")


def test_match_keeps_per_line_frames():
    print("matching — a line keeps up to per_line frames")
    lines = [{'display': 'one', 'query': 'q'}, {'display': 'two', 'query': 'q'}]
    d = Director(lines, threshold=0.1, per_line=2)
    frames = [frame('a.png'), frame('b.png'), frame('c.png')]
    matrix = [[0.9, 0.1], [0.8, 0.2], [0.7, 0.3]]
    matches, unmatched, _ = d.match(frames, matrix)
    kept = [m for m in matches if m['frame']]
    eq(len(kept), 2, "only per_line frames are kept for the one line that owns them")
    eq(len(unmatched), 1, "the runner-up is reported")


def test_motions_do_not_repeat():
    print("motions — a camera plan that does not read as a machine")
    motions = plan_motions(12)
    eq(len(motions), 12, "one motion per shot")
    for index in range(1, len(motions)):
        check(motions[index] != motions[index - 1],
              f"shot {index + 1} does not repeat the previous move ({motions[index]})")
    check(len(set(motions)) >= 3, "all three moves are used")


def test_fx_plan():
    print("fx — a look on every shot")
    eq(plan_fx(5, 'grain'), ['grain'] * 5, "every shot carries the base look")
    eq(plan_fx(0, 'grain'), [], "no shots, no looks")


def test_versions_use_different_frames():
    print("versions — each cut takes a different frame of the same line")
    lines = [{'display': 'one', 'query': 'q'}]
    matrix = [[0.9], [0.8], [0.7]]
    frames = [frame('a.png'), frame('b.png'), frame('c.png')]

    first = Director(lines, threshold=0.1, rank=0)
    matches, _u, _t = first.match(frames, matrix)
    second = Director(lines, threshold=0.1, rank=1)
    matches2, _u2, _t2 = second.match(frames, matrix)

    eq(matches[0]['frame']['path'], 'a.png', "version one takes the best frame")
    eq(matches2[0]['frame']['path'], 'b.png', "version two takes the second")
    check(matches[0]['frame']['path'] != matches2[0]['frame']['path'],
          "the two versions share no picture")


def test_evolution_orders_by_the_characters_own_path():
    print("evolution — the shots move in small steps, not in lyric order")
    lines = [{'display': 'one', 'query': 'q'}]
    # three frames on a line: the second is closest to the first, the
    # third is furthest away. The lyric order puts the far one in the
    # middle; the evolution must not.
    # the SCORES put the far frame second — the lyric order jumps; the
    # evolution must not.
    matrix = [[0.9], [0.86], [0.88]]
    frames = [frame('near.png'), frame('mid.png'), frame('far.png')]
    d = Director(lines, threshold=0.1, per_line=3)
    matches, _u, _t = d.match(frames, matrix)
    plan = {'shots': matches, 'track': None, 'fade': 0.0, 'fx': 'grain'}

    # embeddings: near and mid are close, far is on the other side
    embeddings = [[1.0, 0.0], [0.9, 0.44], [0.0, 1.0]]
    order = {'near.png': 0, 'mid.png': 1, 'far.png': 2}
    for shot in matches:
        shot['index'] = order[shot['frame']['path']]

    before = d.path_distance(plan['shots'], embeddings)
    evolved = d.evolve(plan, embeddings, start_index=0)
    after = d.path_distance(evolved['shots'], embeddings)
    check(after is not None and before is not None, "the travel is measured both ways")
    check(after < before, "the evolution travels less than the lyric order (%.3f < %.3f)"
          % (after, before))
    eq(evolved['shots'][0]['frame']['path'], 'near.png', "the evolution starts where it was told")


def test_path_distance_is_none_without_embeddings():
    print("evolution — no embeddings, no claim")
    d = Director(['one'])
    eq(d.path_distance([{'frame': frame('a.png')}], []), None,
       "without embeddings the travel is not measured")


def test_lines_loader():
    print("lines — the loader reads both shapes")
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test-fixtures-lines.tsv')
    with open(path, 'w') as handle:
        handle.write("display\tquery\n")
        handle.write("a lyric line\ta scene in words\n")
        handle.write("only a line\n")
    rows = load_lines(path)
    eq(len(rows), 2, "the header row is skipped")
    eq(rows[0]['display'], 'a lyric line', "the display text is read")
    eq(rows[0]['query'], 'a scene in words', "the query is read")
    eq(rows[1]['query'], 'only a line', "a line with no query is its own query")
    os.remove(path)


def test_cutlist_is_what_the_renderer_reads():
    print("cut list — the file the renderer consumes")
    import json
    import tempfile
    d = Director(['a line'])
    plan = {'shots': [{'line': 'a line', 'query': 'q', 'frame': frame('a.png'),
                       'duration': 4.0, 'score': 0.5}],
            'motions': ['zoom-in'], 'fxs': ['grain'], 'grade': 'vignette',
            'transition': 'none', 'track': None}
    with tempfile.NamedTemporaryFile('r', suffix='.json', delete=False) as handle:
        path = handle.name
    payload = write_cutlist(path, plan)
    written = json.load(open(path))
    eq(written['images'], ['a.png'], "the images are in cut order")
    eq(written['durations'], [4.0], "each shot carries its length")
    eq(written['motions'], ['zoom-in'], "each shot carries its move")
    eq(written['fx'], ['grain'], "each shot carries its look")
    eq(written['grade'], 'vignette', "the cut carries its grade")
    eq(payload['shots'][0]['line'], 'a line', "the shot carries its lyric")
    os.remove(path)


def main():
    for test in (test_hamming, test_technical_rejects, test_duplicate_collapse,
                 test_match_assigns_each_frame_once,
                 test_match_reports_a_gap_rather_than_a_wrong_frame,
                 test_match_keeps_per_line_frames,
                 test_versions_use_different_frames,
                 test_evolution_orders_by_the_characters_own_path,
                 test_path_distance_is_none_without_embeddings,
                 test_motions_do_not_repeat,
                 test_fx_plan, test_lines_loader, test_cutlist_is_what_the_renderer_reads):
        test()
    print()
    if _failures:
        print(f"{len(_failures)} FAILED of {_count} checks:")
        for label in _failures:
            print(f"  - {label}")
        return 1
    print(f"all {_count} checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
