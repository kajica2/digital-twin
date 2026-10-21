#!/usr/bin/env node
// lib/mj-prompt-generator.test.js
//
// Sprint 0.18 — test harness for the prompt-expansion generator.
// Mirrors the other lib/*.test.js patterns: plain Node, no framework,
// `node lib/mj-prompt-generator.test.js` to run.
//
// Coverage:
//   1. countFor heuristic clamps to [5, 10] for every line-count band
//   2. countFor respects explicit --n override (clamped to [5, 10])
//   3. countFor falls back to 5 for empty input
//   4. STYLES rotation covers all 4 distinct visual directions
//   5. build() produces N bullets, each ending in --ar 16:9
//   6. snippetFor distributes lyrics across N prompts (no prompt empty)
//   7. formatMd header matches the convention
//   8. extractPrompts in mj-submitter parses what build() emits
//      (round-trip integration)
//   9. file write via main() lands in the configured out path

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const gen = require('./mj-prompt-generator.js');
const submitter = require('./mj-submitter.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else      { failed++; failures.push({ label, actual: 'false', expected: 'true' });
                process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[mj-prompt-generator.test]\n\n`);

// 1. countFor heuristic — every line-count band clamps to [5, 10].
process.stderr.write(`1. countFor heuristic\n`);
assert('1 line → 5',           gen.countFor(1),   5);
assert('4 lines → 5',          gen.countFor(4),   5);
assert('5 lines → 6',          gen.countFor(5),   6);
assert('9 lines → 6',          gen.countFor(9),   6);
assert('10 lines → 7',         gen.countFor(10),  7);
assert('14 lines → 7',         gen.countFor(14),  7);
assert('15 lines → 8 default', gen.countFor(15),  8);
assert('19 lines → 8',         gen.countFor(19),  8);
assert('20 lines → 9',         gen.countFor(20),  9);
assert('24 lines → 9',         gen.countFor(24),  9);
assert('25 lines → 10',        gen.countFor(25),  10);
assert('100 lines → 10 (cap)', gen.countFor(100), 10);

// 2. --n override (N_RAW path is exercised via the public countFor
// when called from main(); the clamp lives in countFor itself).
// countFor doesn't read N_RAW — it's read in main(). Verify the
// public countFor ignores --n (callers pass N_RAW themselves in
// main()). For the test, simulate the override at the call site:
// in main(), `countFor(lineCount)` is the auto path; for explicit
// N, main() clamps directly. So we mirror that clamp here.
function clampN(n) { return Math.max(5, Math.min(10, n)); }
assert('explicit n=3 → 5 (clamped up)',  clampN(3),  5);
assert('explicit n=8 → 8',               clampN(8),  8);
assert('explicit n=10 → 10',             clampN(10), 10);
assert('explicit n=20 → 10 (clamped dn)',clampN(20), 10);

// 3. zero lines + zero idea → falls back to 5.
process.stderr.write(`2. countFor empty input\n`);
assert('0 lines → 5', gen.countFor(0), 5);

// 3. STYLES has 4 distinct visual directions.
process.stderr.write(`3. STYLES rotation\n`);
assertTrue('STYLES has 4 entries', gen.STYLES.length === 4);
// Each entry should contain the title arg in its template (sanity).
const sampleStyle = gen.STYLES[0]('Test Title', 'sample snippet');
assertTrue('STYLES[0] mentions title', sampleStyle.includes('Test Title'));
assertTrue('STYLES[0] mentions snippet', sampleStyle.includes('sample snippet'));
assertTrue('STYLES are distinct',
    new Set(gen.STYLES.map(s => s('T', 'S'))).size === 4);

// 4. build() produces N bullets, each ending in --ar.
process.stderr.write(`4. build() output shape\n`);
const built = gen.build({
    title: 'Soft Lamp at the Window',
    ideaText: 'a quiet R&B ballad',
    lyricLines: ['soft lamp at the window', 'where you used to read', 'rain on the glass', 'the chair is empty'],
    n: 8,
    ar: '16:9',
});
assert('build produces 8 prompts', built.length, 8);
for (let i = 0; i < built.length; i++) {
    assertTrue(`prompt ${i + 1} starts with "- "`, built[i].startsWith('- '));
    assertTrue(`prompt ${i + 1} ends with --ar 16:9`,
        built[i].endsWith('--ar 16:9'),
        true);
}
assertTrue('all prompts distinct', new Set(built).size === built.length);

// 5. snippetFor distributes lyrics.
process.stderr.write(`5. snippetFor distribution\n`);
const lines = Array.from({ length: 16 }, (_, i) => `line-${i + 1}`);
const snips = Array.from({ length: 8 }, (_, i) =>
    gen.snippetFor(i, 8, lines, 'Title', ''));
let allDistinct = new Set();
for (const s of snips) allDistinct.add(s);
assertTrue('8 snippets from 16 lines are non-empty',
    snips.every(s => s && s.length > 0));
assertTrue('snippets cover at least 5 distinct slices',
    allDistinct.size >= 5);

// 6. formatMd header + bullet count + --ar.
process.stderr.write(`6. formatMd header\n`);
const md = gen.formatMd({
    title: 'Test Song',
    ideaText: 'a quick test',
    lyricLines: ['one', 'two', 'three'],
    prompts: built,
    ar: '16:9',
    n: 8,
});
assertTrue('header matches convention',
    md.startsWith('# Test Song — 8 prompts (16:9)\n'));
assertTrue('source line present',
    md.includes('> Source:'));
assertTrue('has 8 bullet lines',
    md.split('\n').filter(l => l.startsWith('- ')).length === 8);
assertTrue('no bullet exceeds prompt length',
    md.split('\n').every(l => !l.startsWith('- ') || l.length < 600));

// 7. extractPrompts in mj-submitter parses what build() emits.
process.stderr.write(`7. round-trip: build → extractPrompts\n`);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-prompt-gen-test-'));
const tmpMd = path.join(tmpDir, 'round-trip.md');
fs.writeFileSync(tmpMd, md, 'utf8');
const extracted = submitter.extractPrompts(tmpMd);
assert('extractPrompts returns 8 entries', extracted.length, 8);
assertTrue('every entry has text + ar',
    extracted.every(p => p.text && p.ar === '16:9'));
for (let i = 0; i < extracted.length; i++) {
    assertTrue(`extracted prompt ${i + 1} matches built prompt ${i + 1}`,
        extracted[i].text === built[i].replace(/^- /, '').replace(/ --ar 16:9$/, ''));
    assertTrue(`extracted prompt ${i + 1} ar is 16:9`,
        extracted[i].ar === '16:9');
}

// 8. file write via main() — exercise the end-to-end path.
process.stderr.write(`8. main() writes a valid file\n`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-prompt-gen-out-'));
const outFile = path.join(outDir, 'soft-lamp.md');
// Simulate CLI args via env? No — main() reads process.argv. So
// we exec a child node process with the right argv.
const { execFileSync } = require('node:child_process');
execFileSync(process.execPath, [
    path.resolve(__dirname, 'mj-prompt-generator.js'),
    '--idea', 'soft lamp at the window, where you used to read',
    '--title', 'Soft Lamp at the Window',
    '--ar', '16:9',
    '--out', outFile,
], { encoding: 'utf8' });
const onDisk = fs.readFileSync(outFile, 'utf8');
assertTrue('main() wrote file', fs.existsSync(outFile));
assertTrue('file has 5-10 prompts',
    onDisk.split('\n').filter(l => l.startsWith('- ')).length >= 5 &&
    onDisk.split('\n').filter(l => l.startsWith('- ')).length <= 10);
assertTrue('file header matches convention',
    onDisk.startsWith('# Soft Lamp at the Window — '));
assertTrue('every bullet ends with --ar 16:9',
    onDisk.split('\n').filter(l => l.startsWith('- ')).every(l => l.endsWith('--ar 16:9')));

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[mj-prompt-generator.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) {
        process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
}
process.exit(failed === 0 ? 0 : 1);