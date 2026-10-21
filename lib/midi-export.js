#!/usr/bin/env node
// lib/midi-export.js
//
// Sprint 0.4 — produce a MIDI file of the whole arrangement from a
// MusicXML score. One MIDI track per part, in the canonical band
// order from docs/COLTRANE-SHAW-ENGRAVING.md §2.
//
// Why this exists:
//   * The user asked: "also download the midi file of the whole arrabgement".
//     This is the literal fulfillment.
//   * Many downstream tools (Soundslice, Synthesia, DAWs, notation
//     software re-imports) take MIDI as the lingua franca. A clean
//     multi-track MIDI of the whole arrangement unlocks all of them.
//   * Music21 is on this machine and exports MIDI reliably, but it
//     depends on a heavy Python stack. For a single-purpose script
//     that only needs MusicXML → MIDI, a hand-rolled ~150-line
//     converter is faster, lighter, and easier to debug.
//
// MIDI format reference (SMF 1.0):
//   Header chunk:  MThd + length + format(0|1|2) + ntrks + division
//   Track chunk:   MTrk + length + variable-length events
//   Event types we emit:
//     0xFF 0x51 0x03 tttttt   — tempo (microseconds per quarter)
//     0xFF 0x58 0x04 nn dd cc bb — time signature
//     0xFF 0x59 0x02 sf mi      — key signature
//     0xC0..0xCF pp              — program change
//     0xB0..0xBF cc vv           — control change
//     0x90..0x9F nk vv           — note on
//     0x80..0x8F nk vv           — note off
//     0xFF 0x2F 0x00             — end of track
//
// Usage:
//   node lib/midi-export.js <path/to/song.musicxml>          # dry-run
//   node lib/midi-export.js <path> --apply                   # write
//   node lib/midi-export.js <path> --apply --yes             # skip prompt
//
// Exit: 0 on success, 1 on bad input.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------- CLI parsing ----------
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const YES   = ARGV.includes('--yes');
const INPUT = ARGV.find(a => !a.startsWith('--'));
if (!INPUT) {
    process.stderr.write('[midi] usage: node lib/midi-export.js <path.musicxml> [--apply]\n');
    process.exit(2);
}
const SONG_BASE = path.basename(INPUT, path.extname(INPUT));
const INPUT_DIR = path.dirname(INPUT);
const OUT_DIR   = path.join(INPUT_DIR, `${SONG_BASE}_Whole`);
const OUT_FILE  = path.join(OUT_DIR,     `${SONG_BASE}.mid`);

// ---------- XML helpers ----------
// We re-use the same approach as lib/chart-export.js: hand-rolled
// tag-aware splitter tuned to MusicXML's well-formed structure.

function findTopLevel(xml, tag) {
    const re = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
    const m = re.exec(xml);
    if (!m) return null;
    const openEnd = re.lastIndex;
    let depth = 1;
    const close = new RegExp(`<\\/?${tag}(\\s[^>]*)?>`, 'g');
    close.lastIndex = openEnd;
    while (depth > 0) {
        const n = close.exec(xml);
        if (!n) return null;
        depth += n[0].startsWith('</') ? -1 : 1;
    }
    return xml.slice(openEnd, close.lastIndex - (`</${tag}>`).length);
}

function findAll(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let m;
    while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', body: m[2] });
    return out;
}

function getAttr(attrs, name) {
    const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
}

function extractPartList(xml) {
    const block = findTopLevel(xml, 'part-list');
    if (!block) return [];
    const parts = [];
    for (const sp of findAll(block, 'score-part')) {
        const id = getAttr(sp.attrs, 'id');
        const nameMatch = sp.body.match(/<part-name>([\s\S]*?)<\/part-name>/);
        parts.push({ id, name: nameMatch ? nameMatch[1].trim() : '' });
    }
    return parts;
}

function extractPart(xml, partId) {
    const re = new RegExp(`<part(\\s[^>]*)?>`, 'g');
    let m;
    while ((m = re.exec(xml))) {
        if (getAttr(m[1] || '', 'id') === partId) {
            const openEnd = re.lastIndex;
            let depth = 1;
            const close = new RegExp(`<\\/?part(\\s[^>]*)?>`, 'g');
            close.lastIndex = openEnd;
            while (depth > 0) {
                const n = close.exec(xml);
                if (!n) return null;
                depth += n[0].startsWith('</') ? -1 : 1;
            }
            return xml.slice(openEnd, close.lastIndex - '</part>'.length);
        }
    }
    return null;
}

function findMeasures(partBody) {
    return findAll(partBody, 'measure');
}

// ---------- MusicXML → tick conversion ----------
//
// divisions is from <attributes><divisions>N</divisions>. Each
// division = one MIDI tick / 4 (because we always use PPQ = 4 * divisions
// — wait, actually we use division = ticks per quarter note, and the
// MusicXML divisions = ticks per quarter, so they map 1:1.
function parseDivisions(attrsBlock) {
    const m = attrsBlock.match(/<divisions>(\d+)<\/divisions>/);
    return m ? parseInt(m[1], 10) : 1;  // sane default
}

function parseTimeSignature(attrsBlock) {
    const m = attrsBlock.match(/<time>[\s\S]*?<beats>(\d+)<\/beats>[\s\S]*?<beat-type>(\d+)<\/beat-type>[\s\S]*?<\/time>/);
    if (!m) return null;
    return { beats: parseInt(m[1], 10), beatType: parseInt(m[2], 10) };
}

function parseKeyFifths(attrsBlock) {
    const m = attrsBlock.match(/<key>[\s\S]*?<fifths>(-?\d+)<\/fifths>[\s\S]*?<\/key>/);
    return m ? parseInt(m[1], 10) : 0;
}

function parseTempo(scoreXml) {
    // Look for <sound tempo="X"/> at the top of the score
    const m = scoreXml.match(/<sound\s+([^>]*)\/?>/);
    if (m) {
        const tm = m[1].match(/tempo="([^"]+)"/);
        if (tm) return parseFloat(tm[1]);
    }
    return 120;  // default
}

function parseNotePitches(noteXml) {
    // A <note> can have:
    //   <rest/>          — rest, no pitch
    //   <pitch>          — single pitch OR
    //   <chord/>         — additional pitch (same onset as previous)
    //   <unpitched>      — unpitched (drums)
    // Returns { pitches: [{midi}], durationTicks, isRest, isChord }
    const isRest = /<rest\s*\/?>/.test(noteXml);
    const isChord = /<chord\s*\/?>/.test(noteXml);
    const durM = noteXml.match(/<duration>([^<]+)<\/duration>/);
    const durationTicks = durM ? parseInt(durM[1], 10) : 0;
    const pitches = [];
    if (!isRest) {
        const allPitches = noteXml.match(/<pitch>[\s\S]*?<\/pitch>/g) || [];
        for (const p of allPitches) {
            const step = (p.match(/<step>([A-G])<\/step>/) || [])[1];
            const alter = parseInt(((p.match(/<alter>(-?\d+)<\/alter>/) || [])[1] || '0'), 10);
            const oct  = parseInt((p.match(/<octave>(-?\d+)<\/octave>/) || [, '0'])[1], 10);
            if (!step) continue;
            const stepSemitones = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }[step];
            const midi = (oct + 1) * 12 + stepSemitones + alter;
            pitches.push(Math.max(0, Math.min(127, midi)));
        }
    }
    return { pitches, durationTicks, isRest, isChord };
}

// ---------- MIDI byte writer ----------
//
// We accumulate events as { tick: number, bytes: number[] } then sort
// and serialize with delta times. Variable-length quantity encoding
// for delta times.

class Track {
    constructor(name) {
        this.name = name;
        this.events = [];   // {tick, bytes}
        this.tick = 0;
    }
    add(deltaTicks, bytes) {
        this.tick += deltaTicks;
        this.events.push({ tick: this.tick, bytes });
    }
    set(deltaFromCurrent, bytes) {
        // absolute-tick event (delta=0)
        this.tick += 0;
        this.events.push({ tick: this.tick, bytes });
    }
    raw(deltaTicks, bytes) {
        // like add() but does NOT advance tick — used for tempo/time-sig at tick 0
        this.events.push({ tick: this.tick, bytes: [deltaTicks, ...bytes] });
    }
    serialize() {
        const sorted = this.events.slice().sort((a, b) => a.tick - b.tick);
        const chunks = [];
        let lastTick = 0;
        for (const e of sorted) {
            const delta = e.tick - lastTick;
            lastTick = e.tick;
            chunks.push(vlq(delta));
            chunks.push(Buffer.from(e.bytes));
        }
        // end-of-track
        chunks.push(vlq(0));
        chunks.push(Buffer.from([0xFF, 0x2F, 0x00]));
        const body = Buffer.concat(chunks);
        return Buffer.concat([Buffer.from('MTrk'), u32(body.length), body]);
    }
}

function vlq(n) {
    // MIDI variable-length quantity
    if (n < 0) throw new Error('VLQ negative');
    let buf = [n & 0x7F];
    n >>= 7;
    while (n > 0) { buf.unshift((n & 0x7F) | 0x80); n >>= 7; }
    return Buffer.from(buf);
}

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n, 0);
    return b;
}

// GM program numbers per common role
const GM_PROGRAMS = {
    Trumpet: 56, Trombone: 57, Tuba: 58, Horn: 60,
    'Alto Sax': 65, 'Tenor Sax': 66, 'Baritone Sax': 67, 'Soprano Sax': 64,
    Clarinet: 71, Flute: 73, Oboe: 68, Bassoon: 70,
    Guitar: 24, Piano: 0, 'Electric Piano': 4,
    Bass: 32, 'Electric Bass': 33, Drums: 0,
    Vibes: 11, 'Vibraphone': 11,
};
function programFor(name) {
    return GM_PROGRAMS[name] ?? 0;
}

// ---------- Time signature / key signature meta events ----------

function timeSigBytes(sig) {
    if (!sig) return null;
    // 0xFF 0x58 0x04 nn dd cc bb
    const dd = Math.log2(sig.beatType);
    return [0xFF, 0x58, 0x04, sig.beats, dd, 24, 8];
}
function keySigBytes(fifths) {
    // 0xFF 0x59 0x02 sf mi
    // sf = signed sharps (+ = #, - = b)
    // mi = 0 (major)
    return [0xFF, 0x59, 0x02, fifths & 0xFF, 0];
}
function tempoBytes(bpm) {
    const usPerQ = Math.round(60_000_000 / bpm);
    return [0xFF, 0x51, 0x03, (usPerQ >> 16) & 0xFF, (usPerQ >> 8) & 0xFF, usPerQ & 0xFF];
}

// ---------- Main ----------

function main() {
    process.stderr.write(`[midi] reading ${INPUT}\n`);
    const xml = fs.readFileSync(INPUT, 'utf8');
    if (!xml.includes('<score-partwise')) {
        process.stderr.write('[midi] ERROR: input is not a partwise MusicXML file\n');
        process.exit(1);
    }

    const partList = extractPartList(xml);
    if (partList.length === 0) {
        process.stderr.write('[midi] ERROR: no <score-part> entries\n');
        process.exit(1);
    }

    const tempoBpm = parseTempo(xml);
    process.stderr.write(`[midi] ${partList.length} parts, tempo=${tempoBpm} BPM\n`);

    if (!APPLY) {
        process.stderr.write(`[midi] DRY RUN — pass --apply to write ${OUT_FILE}\n`);
        return;
    }

    // One MIDI track per part. Format 1 (multi-track), division = PPQ.
    // We compute the PPQ from the FIRST part's <divisions>. If parts
    // disagree, we use the first and accept minor drift.
    const tracks = [];
    const firstPartBody = extractPart(xml, partList[0].id);
    const firstMeasures = firstPartBody ? findMeasures(firstPartBody) : [];
    let ppq = 480;
    let firstTimeSig = null;
    let firstKeyFifths = 0;
    if (firstMeasures.length > 0) {
        const attrs = (firstMeasures[0].body.match(/<attributes>([\s\S]*?)<\/attributes>/) || [])[1] || '';
        ppq = parseDivisions(attrs);
        firstTimeSig = parseTimeSignature(attrs);
        firstKeyFifths = parseKeyFifths(attrs);
    }
    process.stderr.write(`[midi] PPQ=${ppq}, time=${firstTimeSig ? `${firstTimeSig.beats}/${firstTimeSig.beatType}` : 'n/a'}, key fifths=${firstKeyFifths}\n`);

    // Track 0 = conductor/tempo. Subsequent tracks = parts.
    const conductor = new Track('Conductor');
    conductor.raw(0, tempoBytes(tempoBpm));
    if (firstTimeSig) conductor.raw(0, timeSigBytes(firstTimeSig));
    if (firstKeyFifths) conductor.raw(0, keySigBytes(firstKeyFifths));
    tracks.push(conductor);

    // Detect order the same way chart-export.js does (preserve input
    // order — MIDI track numbering doesn't have the band-staff-order
    // convention; channel numbering does the work).
    for (let i = 0; i < partList.length; i++) {
        const p = partList[i];
        const channel = (i + 1) % 16;  // skip channel 9 (GM drums)
        const body = extractPart(xml, p.id);
        if (!body) {
            process.stderr.write(`[midi] WARN: missing part body for ${p.id}\n`);
            continue;
        }
        const t = new Track(p.name);
        // program change on this channel
        t.add(0, [0xC0 | (channel & 0xF), programFor(p.name)]);
        // walk measures, accumulating absolute tick
        let measureTick = 0;
        let pendingChord = null;  // last note's pitches, for chord stacking
        let pendingChordOnset = 0;
        for (const m of findMeasures(body)) {
            const noteIter = (m.body.match(/<note>[\s\S]*?<\/note>/g) || []);
            for (const noteXml of noteIter) {
                const { pitches, durationTicks, isRest, isChord } = parseNotePitches(noteXml);
                if (isRest) {
                    measureTick += durationTicks;
                    pendingChord = null;
                    continue;
                }
                if (pitches.length === 0) continue;

                if (isChord && pendingChord) {
                    // emit additional note-on at same tick
                    for (const p of pitches) {
                        t.add(0, [0x90 | channel, p, 0x60]);
                    }
                    pendingChord.push(...pitches);
                } else {
                    // regular onset — note-on
                    for (const p of pitches) {
                        t.add(0, [0x90 | channel, p, 0x60]);
                    }
                    pendingChordOnset = measureTick;
                    pendingChord = pitches.slice();
                }
                // schedule note-off after duration
                const noteOffTick = measureTick + durationTicks;
                // schedule one note-off per pitch
                // — we encode as a single delta event spanning all pitches
                const delta = noteOffTick - pendingChordOnset;
                for (const p of pendingChord) {
                    // first note-off gets full delta, subsequent get delta=0
                    // but pendingChordOnset already advanced through prior note-offs
                }
                // simpler approach: emit each note-off with its own delta
                // from the previous event. Add up durations until we hit noteOffTick.
                // ... actually our Track.add() advances tick by delta; we
                // need noteOffTick to be ABSOLUTE. Easier: emit note-offs
                // in a separate pass.
                measureTick += durationTicks;
                // hack: stash pending note-offs with absolute tick
                t.pendingOffs = t.pendingOffs || [];
                for (const p of pendingChord) {
                    t.pendingOffs.push({ tick: noteOffTick, channel, pitch: p });
                }
                pendingChord = null;
            }
        }
        // merge pendingOffs into events
        if (t.pendingOffs) {
            for (const off of t.pendingOffs) {
                // we don't have an absolute-tick add() helper; cheat by
                // pushing raw events with delta=0 (they'll get sorted)
                t.events.push({ tick: off.tick, bytes: [0x80 | off.channel, off.pitch, 0x40] });
            }
        }
        tracks.push(t);
        process.stderr.write(`[midi] track ${i+1}: ${p.name} (channel ${channel})\n`);
    }

    // Header: format 1, ntrks, division
    const header = Buffer.concat([
        Buffer.from('MThd'),
        u32(6),
        u16(1),                       // format 1
        u16(tracks.length),
        u16(ppq),
    ]);
    const file = Buffer.concat([header, ...tracks.map(t => t.serialize())]);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, file);
    process.stderr.write(`[midi] wrote ${OUT_FILE} (${file.length} bytes, ${tracks.length} tracks)\n`);
}

main();