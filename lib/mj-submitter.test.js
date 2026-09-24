#!/usr/bin/env node
// lib/mj-submitter.test.js
//
// Sprint 0.19 — test harness for the per-prompt retry state in
// mj-submitter.js. Pure-Node, no deps, no framework.
//
// Coverage:
//   1. writeDoneMarker creates .mj-done-<N> with valid JSON shape
//   2. readDoneIndices returns sorted indices of existing markers
//   3. readDoneIndices ignores unrelated files / non-numeric suffixes
//   4. clearDoneMarkers removes every .mj-done-* in the dir
//   5. extractPrompts → writeDoneMarker → readDoneIndices round-trip
//      matches the prompts list (every index has a marker after the
//      loop, none has markers before)
//   6. --skip-done simulation: when markers 0 and 2 exist, only
//      prompt 1 of 3 is processed

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

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

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-submitter-test-'));
const promptFile = path.join(TEST_DIR, 'lyrics.md');
fs.writeFileSync(promptFile, [
    '# Test — 3 prompts (16:9)',
    '',
    '> Source: synthetic',
    '',
    '- first prompt body --ar 16:9',
    '- second prompt body --ar 16:9',
    '- third prompt body --ar 16:9',
    '',
].join('\n'));

process.stderr.write(`\n[mj-submitter.test] test dir: ${TEST_DIR}\n\n`);

// 1. writeDoneMarker creates the file.
process.stderr.write(`1. writeDoneMarker creates marker\n`);
const m = submitter.writeDoneMarker(promptFile, 0, '/tmp/out/prompt-01.png');
assertTrue('marker file exists', fs.existsSync(m));
const mContent = JSON.parse(fs.readFileSync(m, 'utf8'));
assert('marker index', mContent.index, 0);
assert('marker outputPath', mContent.outputPath, '/tmp/out/prompt-01.png');
assertTrue('marker has timestamp', typeof mContent.timestamp === 'string' && mContent.timestamp.includes('T'));

// 2. readDoneIndices returns sorted indices.
process.stderr.write(`2. readDoneIndices sorted\n`);
assert('readDoneIndices([0])', submitter.readDoneIndices(promptFile), [0]);
submitter.writeDoneMarker(promptFile, 2, '/tmp/out/prompt-03.png');
assert('readDoneIndices([0,2])', submitter.readDoneIndices(promptFile), [0, 2]);
submitter.writeDoneMarker(promptFile, 1, '/tmp/out/prompt-02.png');
assert('readDoneIndices([0,1,2]) sorted', submitter.readDoneIndices(promptFile), [0, 1, 2]);

// 3. readDoneIndices ignores unrelated files / non-numeric.
process.stderr.write(`3. readDoneIndices ignores noise\n`);
fs.writeFileSync(path.join(TEST_DIR, '.mj-done-foo'), 'noise');
fs.writeFileSync(path.join(TEST_DIR, '.mj-done-'), 'noise');
fs.writeFileSync(path.join(TEST_DIR, 'other.txt'), 'noise');
assert('still [0,1,2] despite noise', submitter.readDoneIndices(promptFile), [0, 1, 2]);

// 4. clearDoneMarkers removes every .mj-done-* in the dir.
process.stderr.write(`4. clearDoneMarkers removes all markers\n`);
submitter.clearDoneMarkers(promptFile);
const remaining = fs.readdirSync(TEST_DIR).filter(e => e.startsWith(submitter.DONE_PREFIX));
assert('no markers after clear', remaining, []);
assertTrue('other.txt survives clear',
    fs.existsSync(path.join(TEST_DIR, 'other.txt')));

// 5. Round-trip.
process.stderr.write(`5. round-trip: extract → write → read\n`);
submitter.clearDoneMarkers(promptFile);
const ps = submitter.extractPrompts(promptFile);
assert('extracted 3 prompts', ps.length, 3);
assertTrue('no markers yet', submitter.readDoneIndices(promptFile).length === 0);
for (let i = 0; i < ps.length; i++) {
    submitter.writeDoneMarker(promptFile, i, `/tmp/out/prompt-${i + 1}.png`);
}
const after = submitter.readDoneIndices(promptFile);
assert('all 3 indices present', after, [0, 1, 2]);

// 6. --skip-done simulation. The submitter loop in main() reads
// readDoneIndices and skips those indices. We simulate that logic
// here (without launching Chrome) and assert the todo list is
// exactly the un-shipped prompts.
process.stderr.write(`6. --skip-done logic simulation\n`);
submitter.clearDoneMarkers(promptFile);
submitter.writeDoneMarker(promptFile, 0, '/tmp/p1.png');
submitter.writeDoneMarker(promptFile, 2, '/tmp/p3.png');
const alreadyDone = submitter.readDoneIndices(promptFile);
const todo = ps
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => !alreadyDone.includes(i));
assert('todo is just prompt index 1',
    todo.map(x => x.i), [1]);

// 7. buildFullPrompt — --ar must be emitted exactly once, and last.
//
// Regression: the submitter appended `--ar <caller>` and then the whole
// defaultArgs string, whose own `--ar 3:4` produced
// `--ar 16:9 --ar 3:4`. MJ honours the LAST --ar, so the config default
// silently overrode the ratio the caller asked for.
process.stderr.write(`7. buildFullPrompt — single, last --ar\n`);
const DEFAULTS = '--ar 3:4 --style raw --s 250';
const countAr = (s) => (s.match(/--ar\s+\S+/g) || []).length;

let p1 = submitter.buildFullPrompt('a trumpet at dawn', '16:9', DEFAULTS);
assert('exactly one --ar', countAr(p1), 1);
assertTrue('keeps the caller ar', p1.includes('--ar 16:9'));
assertTrue('drops the config ar', !p1.includes('--ar 3:4'));
assertTrue('keeps other default params', p1.includes('--style raw') && p1.includes('--s 250'));
assert('--ar is last', p1.slice(p1.indexOf('--ar')).startsWith('--ar 16:9'), true);
assert('full text', p1, 'a trumpet at dawn --style raw --s 250 --ar 16:9');

// A prompt that already carries --ar wins over the caller's.
let p2 = submitter.buildFullPrompt('x --ar 1:1', '16:9', DEFAULTS);
assert('prompt-embedded ar wins', countAr(p2), 1);
assertTrue('embedded ar preserved', p2.includes('--ar 1:1'));

// No caller ar → the config default's ar is used, still once.
let p3 = submitter.buildFullPrompt('x', null, DEFAULTS);
assert('falls back to the config ar', countAr(p3), 1);
assertTrue('config ar used', p3.includes('--ar 3:4'));

// No defaults at all → caller ar still applied.
let p4 = submitter.buildFullPrompt('x', '9:16', '');
assert('ar applied with no defaults', p4, 'x --ar 9:16');

// No ar anywhere → no --ar emitted.
let p5 = submitter.buildFullPrompt('x', null, '--style raw');
assert('no ar emitted', countAr(p5), 0);
assert('defaults still applied', p5, 'x --style raw');

// 8. The composed prompt for a real extracted pack is unambiguous.
process.stderr.write(`8. end-to-end prompt composition\n`);
const composed = ps.map(p => submitter.buildFullPrompt(p.text, p.ar, DEFAULTS));
assertTrue('every composed prompt has exactly one --ar',
    composed.every(c => countAr(c) === 1));
assertTrue('every composed prompt asks for 16:9',
    composed.every(c => c.includes('--ar 16:9')));
assertTrue('none leak the config ratio',
    composed.every(c => !c.includes('--ar 3:4')));

// Cleanup
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[mj-submitter.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) {
        process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
}
process.exit(failed === 0 ? 0 : 1);