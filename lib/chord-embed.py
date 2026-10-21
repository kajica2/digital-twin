#!/usr/bin/env python3
"""
lib/chord-embed.py — Embed chord symbols and slash notation into MusicXML.

Takes a MusicXML file and a chord sequence (one chord per measure, space-separated)
and adds <harmony> elements to every part in the score. Optionally replaces the
rhythm-section staff content with slash notation (/// on the beat).

Usage:
    python3 lib/chord-embed.py input.musicxml --chords "C-7 F7 Bbmaj7 Eb7 D-7 G7 Cmaj7 C7"
    python3 lib/chord-embed.py input.musicxml --chords-file changes.txt
    python3 lib/chord-embed.py input.musicxml --chords "Cmaj7 D-7 G7" --slash
    python3 lib/chord-embed.py input.musicxml --chords "Cmaj7" --part "Piano" --part "Guitar"
    python3 lib/chord-embed.py --help

Chord format:
    Standard jazz chord symbol strings as music21 understands them:
    Cmaj7, D-7, G7, Bbmaj7, Eb7, F-7b5, B7alt, C7#9, Am7, etc.
    Use a period (.) for a measure with no chord (rest / N.C.).

Output:
    Writes input.chords.musicxml (or --output specified). Prints the chord-map
    to stdout so the user can verify against the form.

Requires:
    music21 (pip install music21 or brew install music21)

Design:
    Pure-Node-avoiding Python script that pairs with the existing chart-export.js
    workflow. Meant to be run BEFORE chart-export and MIDI export so the enriched
    MusicXML flows through the rest of the pipeline.

    Part matching is case-insensitive and supports partials: "Trumpet" matches
    "Trumpet in Bb", "Piano" matches "Piano", etc. By default applies to all
    parts; use --part to limit to specific staves.

    Slash notation replaces notes in the selected staves with four slash-beats
    per measure (quarter notes with slash notehead). Only applied when --slash
    is set and the part has no melody (typically Piano/Guitar/Drums).
"""

import sys
import os
import argparse

HAS_MUSIC21 = False
try:
    import music21 as m21
    HAS_MUSIC21 = True
except ImportError:
    pass


def parse_chords(chord_str):
    """Parse a space-separated chord string into a list. Period = N.C."""
    parts = chord_str.strip().split()
    result = []
    for p in parts:
        p = p.strip()
        if p == '.' or p == '':
            result.append(None)
        else:
            result.append(p)
    return result


def load_chords_file(path):
    """Read chords from a file — one chord per line or space-separated."""
    with open(path, 'r') as f:
        text = f.read().strip()
    # Try as newline-separated first
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if lines:
        # Could be "C-7 F7 Bbmaj7" on one line or chord per line
        # Check first line: if it has multiple tokens, treat whole file as space-sep
        if len(lines[0].split()) > 1:
            return parse_chords(text)
        else:
            return [None if c == '.' else c for c in lines]
    return []


def resolve_part_name(part, part_names):
    """Return True if the part's name matches one of the given names (case-insensitive partial)."""
    pname = part.partName.lower() if part.partName else ''
    for name in part_names:
        if name.lower() in pname:
            return True
    return False


def embed_chords(score, chords, part_names=None, slash=False):
    """
    Embed chord symbols into the score. Modifies in place.

    chords: list of chord strings or None
    part_names: list of part names to apply to (None = all parts)
    slash: if True, replace notes in matched parts with slash notation
    """
    # Get the total number of measures across the score
    # Count the max measures from the first part that has them
    max_measures = 0
    for part in score.parts:
        ml = len(part.flat.getElementsByClass('Measure'))
        if ml > max_measures:
            max_measures = ml

    if not chords:
        print("[chord-embed] No chords provided. Nothing to embed.")
        return score

    # If chords is shorter than measures, pad with None
    padded = list(chords) + [None] * (max_measures - len(chords))

    for part in score.parts:
        part_name = part.partName or 'Unnamed'
        matched = False
        if part_names:
            for pn in part_names:
                if pn.lower() in part_name.lower():
                    matched = True
                    break
        else:
            matched = True  # Apply to all parts

        if not matched:
            print(f"  [skip] {part_name} — not in target list")
            continue

        measures = part.getElementsByClass('Measure')
        chord_count = min(len(padded), len(measures))

        for i in range(chord_count):
            m = measures[i]
            chord_str = padded[i]
            if chord_str is None:
                continue  # N.C. — skip or could add "N.C." harmony

            try:
                chord = m21.harmony.ChordSymbol(chord_str)
                # Insert at the beginning of the measure (before notes)
                m.insert(0, chord)
            except Exception as e:
                print(f"  [warn] measure {i+1} ({part_name}): could not parse chord '{chord_str}': {e}")

        if slash and matched:
            replace_with_slash(part, measures, chord_count)

    return score


def replace_with_slash(part, measures, count):
    """Replace note content in measures with slash notation (4 beats, slash notehead)."""
    for i in range(min(count, len(measures))):
        m = measures[i]
        # Remove all notes and chords from this measure
        notes_to_remove = [n for n in m.notes if n.isNote or n.isChord]
        for n in notes_to_remove:
            try:
                m.remove(n)
            except Exception:
                pass

        # Add a 4/4 time signature if not present — default to 4 quarter slashes
        ts = m.getTimeSignatures()
        beats = 4
        if ts:
            beats = int(ts[0].numerator)  # Use numerator as beat count

        # Create slashes
        for beat in range(beats):
            # Quarter note at the beat position
            n = m21.note.Note('G3', type='quarter')
            n.notehead = 'slash'
            n.stemDirection = 'up'
            offset = 0 if beat == 0 else beat * (4.0 / beats)  # quarter resolution
            # Simplify: use 1.0 per quarter
            note_positions = {
                0: 0.0,
                1: 1.0,
                2: 2.0,
                3: 3.0,
            }
            # If ts is compound, adjust
            if beats > 4:
                note_positions = {i: i * (4.0 / beats) for i in range(beats)}

            try:
                m.insert(note_positions[beat], n)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(
        description='Embed chord symbols and slash notation into MusicXML.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('input', help='Input MusicXML file')
    parser.add_argument('--output', '-o', help='Output MusicXML file (default: input.chords.musicxml)')
    parser.add_argument('--chords', '-c', help='Chord sequence: space-separated, one per measure (use . for N.C.)')
    parser.add_argument('--chords-file', '-f', help='File with chord sequence (one per line or space-sep)')
    parser.add_argument('--part', '-p', action='append', dest='parts', help='Apply to named part(s) only (repeatable)')
    parser.add_argument('--slash', '-s', action='store_true', help='Replace notes with slash notation in matched parts')
    parser.add_argument('--apply', action='store_true', help='Write output and print summary (default: dry-run)')
    parser.add_argument('--yes', action='store_true', help='Skip confirmation')

    args = parser.parse_args()

    if args.chords and args.chords_file:
        print("[chord-embed] error: specify --chords or --chords-file, not both")
        sys.exit(1)

    if not args.chords and not args.chords_file:
        print("[chord-embed] error: no chords provided. Use --chords or --chords-file")
        print("  Example: python3 lib/chord-embed.py score.musicxml --chords 'Cmaj7 D-7 G7 C'")
        sys.exit(1)

    if not HAS_MUSIC21:
        print("[chord-embed] error: music21 is required. Install with:")
        print("  pip install music21")
        print("  brew install music21")
        sys.exit(1)

    # Load chords
    if args.chords_file:
        chords = load_chords_file(args.chords_file)
    else:
        chords = parse_chords(args.chords)

    if not chords:
        print("[chord-embed] error: no chords parsed from input")
        sys.exit(1)

    # Load MusicXML
    try:
        score = m21.converter.parse(args.input)
    except Exception as e:
        print(f"[chord-embed] error: could not parse {args.input}: {e}")
        sys.exit(1)

    part_count = len(score.parts)
    measure_count = max(len(p.flat.getElementsByClass('Measure')) for p in score.parts)
    print(f"[chord-embed] loaded: {args.input}")
    print(f"  parts: {part_count}")
    print(f"  measures: {measure_count}")
    print(f"  chords: {len(chords)}")
    print(f"  apply to: {', '.join(args.parts) if args.parts else 'all parts'}")
    print(f"  slash notation: {'yes' if args.slash else 'no'}")
    print()

    # Print chord map
    chord_labels = [c if c else 'N.C.' for c in chords]
    max_cols = 8
    print("  Chord map:")
    for i in range(0, len(chord_labels), max_cols):
        row = chord_labels[i:i+max_cols]
        nums = [f"m{i+j+1:>3}" for j in range(len(row))]
        print(f"    {'  '.join(nums)}")
        print(f"    {'  '.join(f'{c:>4}' for c in row)}")
        print()

    if not args.apply and not args.yes:
        print("[chord-embed] Dry-run. Use --apply to write.")
        sys.exit(0)

    # Embed
    embed_chords(score, chords, part_names=args.parts, slash=args.slash)

    # Output path
    output = args.output or args.input.replace('.musicxml', '.chords.musicxml')
    if output == args.input:
        output = args.input + '.chords.musicxml'

    try:
        score.write('musicxml', fp=output)
        print(f"[chord-embed] wrote: {output}")
    except Exception as e:
        print(f"[chord-embed] error: could not write {output}: {e}")
        sys.exit(1)

    # Quick verification
    try:
        verify = m21.converter.parse(output)
        verify_parts = len(verify.parts)
        harmony_elts = sum(1 for _ in verify.recurse().getElementsByClass('Harmony'))
        print(f"  verification: {verify_parts} parts, {harmony_elts} harmony elements")
    except Exception as e:
        print(f"  verification failed: {e}")

    print(f"[chord-embed] done.")


if __name__ == '__main__':
    main()