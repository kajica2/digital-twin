#!/usr/bin/env python3
"""Unit tests for lib/story/media.py.

Pure stdlib, no network, no model. The library's decisions — what a clip is
called, what the index records, what a duplicate is, which frames come out
— are the product, so they are pinned here rather than only observed.

    python3 lib/story/media.test.py

Exits 0 when every check passes, 1 otherwise.
"""

import datetime as dt
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from media import (  # noqa: E402
    format_duration,
    parse_fraction,
    parse_probe,
    render_list,
    slug,
    source_label,
    upsert_index,
    read_index,
    write_index,
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


def test_slug():
    print("slug — a name the filesystem and a shell can both carry")
    when = dt.date(2026, 11, 9)
    eq(slug('kisna-soba-ep1-ep2', when), 'kisna-soba-ep1-ep2-20261109',
       "the stem survives, the day is appended")
    eq(slug('Ne može biti to', when), 'ne-mo-e-biti-to-20261109',
       "spaces and non-ASCII become separators")
    eq(slug('UPPER_case', when), 'upper-case-20261109', "the name is lowercased")
    eq(slug('...', when), 'clip-20261109', "a name with nothing in it still gets one")
    eq(slug('a' * 100, when).startswith('a' * 60), True, "a long stem is cut to 60")
    eq(len(slug('a' * 100, when)), 60 + 9, "the cut stem plus the day")


def test_source_label():
    print("source label — the index does not name the filesystem")
    eq(source_label('/Users/someone/Movies/clip.mp4'), 'clip.mp4',
       "by default only the basename is recorded")
    eq(source_label('/Users/someone/Movies/clip.mp4', keep_abspath=True),
       '/Users/someone/Movies/clip.mp4', "the absolute path is available for debugging")
    check('/Users/' not in source_label('/Users/someone/Movies/clip.mp4'),
          "no home directory leaks into the default record")


def test_parse_fraction():
    print("fractions — a frame rate is a ratio")
    eq(parse_fraction('30/1'), 30.0, "30/1 is thirty")
    eq(parse_fraction('30000/1001'), 29.97002997002997, "a NTSC rate is not rounded away")
    eq(parse_fraction('0/0'), None, "a zero denominator is no rate")
    eq(parse_fraction(None), None, "no rate at all")
    eq(parse_fraction('30'), 30.0, "a bare number is a rate")


def test_parse_probe():
    print("the probe — an ffprobe payload becomes a record")
    payload = {
        'streams': [
            {'codec_type': 'video', 'codec_name': 'h264', 'width': 1920,
             'height': 1080, 'r_frame_rate': '30/1', 'nb_frames': '1800'},
            {'codec_type': 'audio', 'codec_name': 'aac',
             'sample_rate': '48000', 'channels': 2},
        ],
        'format': {'duration': '60.000000'},
    }
    record = parse_probe(payload)
    eq(record['duration_s'], 60.0, "the duration is seconds")
    eq(record['width'], 1920, "the width is read")
    eq(record['height'], 1080, "the height is read")
    eq(record['fps'], 30.0, "the frame rate is read")
    eq(record['v_codec'], 'h264', "the video codec is read")
    eq(record['frames'], 1800, "the frame count is read")
    eq(record['audio']['codec'], 'aac', "the audio codec is read")
    eq(record['audio']['sample_rate'], 48000, "the sample rate is read")
    eq(record['audio']['channels'], 2, "the channel count is read")

    silent = parse_probe({
        'streams': [{'codec_type': 'video', 'codec_name': 'h264', 'width': 640,
                     'height': 360, 'r_frame_rate': '25/1'}],
        'format': {'duration': '12.500000'},
    })
    eq(silent['audio'], None, "a clip with no sound has no audio record")
    eq(silent['frames'], None, "a container that does not count frames yields None")
    eq(silent['fps'], 25.0, "the frame rate is still read")

    empty = parse_probe({'streams': [], 'format': {}})
    eq(empty['duration_s'], None, "no duration yields None, not a crash")
    eq(empty['width'], None, "no width yields None")
    eq(empty['audio'], None, "no streams means no audio")


def test_index_round_trip():
    print("the index — a record survives the round trip")
    tmp = tempfile.mkdtemp(prefix='dt-media-test-')
    try:
        index = os.path.join(tmp, 'index.jsonl')
        record = {'file': 'clip-20261109.mp4', 'sha256': 'abc', 'bytes': 10,
                  'duration_s': 1.0, 'width': 2, 'height': 3}
        write_index([record], index)
        loaded = read_index(index)
        eq(len(loaded), 1, "one record comes back")
        eq(loaded[0]['file'], 'clip-20261109.mp4', "the name survives")
        eq(loaded[0]['sha256'], 'abc', "the hash survives")

        # A second record for the same name REPLACES the first — an index
        # that grows a line per re-ingest is an index nobody can read.
        upsert_index(dict(record, bytes=99), index)
        eq(len(read_index(index)), 1, "re-ingesting the same name replaces its record")
        eq(read_index(index)[0]['bytes'], 99, "the newer record wins")

        upsert_index({'file': 'other-20261109.mp4', 'sha256': 'def'}, index)
        eq(len(read_index(index)), 2, "a different name is a new record")

        # A torn line must not take the whole index down with it.
        with open(index, 'a') as handle:
            handle.write('{not json\n')
        eq(len(read_index(index)), 2, "an unreadable line is skipped, not fatal")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_duration_format():
    print("duration — minutes and seconds")
    eq(format_duration(60.0), '1:00', "a minute")
    eq(format_duration(48.0), '0:48', "under a minute")
    eq(format_duration(3600.0), '60:00', "an hour")
    eq(format_duration(None), '-', "an unknown duration")


def test_render_list():
    print("the shelf — a table, or the sentence that says it is empty")
    eq(render_list([]), 'the library is empty', "an empty shelf says so")
    rows = [{'file': 'clip.mp4', 'duration': '1:00', 'shape': '1920x1080',
             'fps': 30.0, 'codec': 'h264', 'sound': 'no', 'size_mb': 1.2,
             'source': 'clip.mp4'}]
    rendered = render_list(rows)
    check('clip.mp4' in rendered, "the clip's name is in the table")
    check('1920x1080' in rendered, "the shape is in the table")
    check('h264' in rendered, "the codec is in the table")


def main():
    for test in (test_slug, test_source_label, test_parse_fraction,
                 test_parse_probe, test_index_round_trip, test_duration_format,
                 test_render_list):
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
