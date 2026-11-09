#!/usr/bin/env node
'use strict';
// lib/render/pitch-shift.mjs — shift a track by a number of semitones.
//
//   node lib/render/pitch-shift.mjs in.mp3 -2 out.mp3
//   node lib/render/pitch-shift.mjs in.mp3 -2 out.mp3 --keep-length
//
// HOW IT WORKS
//
// ffmpeg's `asetrate` changes the playback rate, which changes both the
// pitch and the tempo. The tempo is put back with `atempo`, so the file
// keeps its length and only the pitch moves:
//
//   asetrate = rate * 2^(semitones/12)
//   atempo   = 2^(-semitones/12)
//
// A negative number of semitones goes DOWN (`-2` is a whole tone lower).
// `--keep-length` is the default; `--change-length` leaves the tempo
// alone and lets the track get shorter or longer, which is the other
// thing you sometimes want.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let input = null;
let semitones = null;
let output = null;
let keepLength = true;
let help = false;

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--change-length') { keepLength = false; continue; }
    if (a === '--keep-length') { keepLength = true; continue; }
    if (a === '-2' || /^-?\d+(\.\d+)?$/.test(a)) { semitones = Number(a); continue; }
    if (!input) { input = a; continue; }
    if (!output) { output = a; continue; }
}

function usage() {
    return [
        'pitch-shift — shift a track by semitones',
        '',
        'usage: node lib/render/pitch-shift.mjs <in> <semitones> <out> [--keep-length|--change-length]',
        '',
        '  -2   two semitones down      +3   three semitones up',
        '  --keep-length     the default: the tempo is restored, so the file keeps its duration',
        '  --change-length   the tempo follows the pitch (the file gets shorter or longer)',
    ].join('\n');
}

if (help || !input || semitones === null || !output) {
    process.stdout.write(usage() + '\n');
    process.exit(input && semitones !== null && !output ? 2 : 0);
}

if (!fs.existsSync(input)) {
    process.stderr.write(`pitch-shift: no such file: ${input}\n`);
    process.exit(2);
}

/** The filter chain for a shift of `n` semitones. */
export function filterChain(n, keepLength = true) {
    const ratio = Math.pow(2, n / 12);
    const parts = [`asetrate=${Math.round(48000 * ratio)}`, 'aresample=48000'];
    if (keepLength) {
        // atempo accepts 0.5-2.0 per instance; a big shift is chained.
        const target = 1 / ratio;
        let remaining = target;
        const steps = [];
        while (remaining > 2.0) { steps.push(2.0); remaining /= 2.0; }
        while (remaining < 0.5) { steps.push(0.5); remaining /= 0.5; }
        steps.push(remaining);
        parts.push(`atempo=${steps.map(s => s.toFixed(6)).join(',')}`);
    }
    return parts.join(',');
}

const outDir = path.dirname(path.resolve(output));
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const res = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', input,
    '-af', filterChain(semitones, keepLength),
    '-c:a', 'libmp3lame', '-b:a', '256k',
    output,
], { stdio: 'inherit' });

if (res.status !== 0) {
    process.stderr.write('pitch-shift: ffmpeg failed\n');
    process.exit(res.status === null ? 1 : res.status);
}

console.log(`pitch-shift: ${input} ${semitones >= 0 ? '+' : ''}${semitones} semitones -> ${output}`);
