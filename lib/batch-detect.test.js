// lib/batch-detect.test.js — unit suite for the batch detector.
//
// Pure functions only: the name parser, the grouping rules and the
// ordering. No DOM, no browser.
//
// Run: node lib/batch-detect.test.js

'use strict';

const assert = require('node:assert');
const bd = require('./batch-detect.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

/** Shorthand: a file descriptor with just a name. */
const f = (name, extra) => Object.assign({ name: name }, extra || {});

/** The names of a batch, in order. */
const names = (batch) => batch.files.map((x) => x.name);

/** The batch labels, in order. */
const labels = (result) => result.batches.map((b) => b.label);

console.log('batch-detect');

// ---- parseName ----------------------------------------------------------

check('parseName reads a plain stem', () => {
    const p = bd.parseName('cover.png');
    assert.strictEqual(p.stem, 'cover');
    assert.strictEqual(p.ext, 'png');
    assert.strictEqual(p.prefix, 'cover');
    assert.strictEqual(p.index, null);
    assert.strictEqual(p.variant, null);
});

check('parseName splits a trailing frame number off the prefix', () => {
    const p = bd.parseName('frame-01.png');
    assert.strictEqual(p.prefix, 'frame');
    assert.strictEqual(p.index, 1);
});

check('parseName reads an attached frame number', () => {
    const p = bd.parseName('batch2.png');
    assert.strictEqual(p.prefix, 'batch');
    assert.strictEqual(p.index, 2);
});

check('parseName reads a bare number as index with no prefix', () => {
    const p = bd.parseName('01.png');
    assert.strictEqual(p.prefix, '');
    assert.strictEqual(p.index, 1);
});

check('parseName strips a variant word off the end', () => {
    const p = bd.parseName('01_full.png');
    assert.strictEqual(p.prefix, '');
    assert.strictEqual(p.index, 1);
    assert.strictEqual(p.variant, 'full');
});

check('parseName strips the variant that sits between prefix and number', () => {
    const p = bd.parseName('cover-final-01.png');
    assert.strictEqual(p.prefix, 'cover');
    assert.strictEqual(p.index, 1);
    assert.strictEqual(p.variant, 'final');
});

check('parseName only strips a variant from the END of the stem', () => {
    const p = bd.parseName('v1-frame.png');
    assert.strictEqual(p.prefix, 'v1-frame');
    assert.strictEqual(p.index, null);
});

check('parseName keeps a name that is only a variant word', () => {
    const p = bd.parseName('full.png');
    assert.strictEqual(p.prefix, 'full');
    assert.strictEqual(p.variant, null);
});

check('parseName reads the parent folder off a relative path', () => {
    const p = bd.parseName('frame-01.png', '2026-10-23/frame-01.png');
    assert.strictEqual(p.dir, '2026-10-23');
    assert.strictEqual(p.prefix, 'frame');
    assert.strictEqual(p.index, 1);
});

check('parseName keeps a five digit run as part of the name', () => {
    const p = bd.parseName('plate-12345.png');
    assert.strictEqual(p.index, null);
});

// ---- grouping -----------------------------------------------------------

check('frames with the same prefix land in one batch', () => {
    const r = bd.detectBatches([f('frame-01.png'), f('frame-02.png'), f('frame-03.png')]);
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 3);
});

check('different prefixes stay in different batches', () => {
    const r = bd.detectBatches([f('frame-01.png'), f('frame-02.png'), f('cover-01.png')]);
    assert.strictEqual(r.batches.length, 2);
    const cover = r.batches.find((b) => b.prefix === 'cover');
    const frame = r.batches.find((b) => b.prefix === 'frame');
    assert.ok(cover, 'cover batch exists');
    assert.ok(frame, 'frame batch exists');
    assert.strictEqual(cover.count, 1);
    assert.strictEqual(frame.count, 2);
});

check('files from two folders never share a batch', () => {
    const r = bd.detectBatches([
        f('frame-01.png', { path: 'day-a/frame-01.png' }),
        f('frame-02.png', { path: 'day-a/frame-02.png' }),
        f('frame-01.png', { path: 'day-b/frame-01.png' }),
    ]);
    assert.strictEqual(r.batches.length, 2);
    assert.deepStrictEqual(r.batches.map((b) => b.scope).sort(), ['day-a', 'day-b']);
});

check('a numbered run in one folder is one batch', () => {
    const r = bd.detectBatches([
        f('01.png', { path: 'prompt-01/01.png' }),
        f('02.png', { path: 'prompt-01/02.png' }),
        f('03.png', { path: 'prompt-01/03.png' }),
    ]);
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 3);
});

check('the same frame at two sizes counts once, and keeps the bigger', () => {
    const r = bd.detectBatches([
        f('01_full.png', { path: 'prompt-01/01_full.png', width: 1024, height: 1024, bytes: 900 }),
        f('01_thumb.png', { path: 'prompt-01/01_thumb.png', width: 256, height: 256, bytes: 100 }),
    ]);
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 1);
    assert.strictEqual(names(r.batches[0])[0], '01_full.png');
});

check('a thumbnail beats a full render when it is the only larger one', () => {
    const r = bd.detectBatches([
        f('02_full.png', { path: 'p/02_full.png', bytes: 100 }),
        f('02_thumb.png', { path: 'p/02_thumb.png', bytes: 900 }),
    ]);
    assert.strictEqual(r.batches[0].count, 1);
    assert.strictEqual(names(r.batches[0])[0], '02_thumb.png');
});

check('two files with the same name and no variant word are both kept', () => {
    const r = bd.detectBatches([
        f('frame-01.png', { path: 'day-a/frame-01.png' }),
        f('frame-01.png', { path: 'day-b/frame-01.png' }),
    ], { mode: 'single' });
    assert.strictEqual(r.batches[0].count, 2, 'the same name twice is not a variant pair');
});

check('the batch says which file it left out and why', () => {
    const r = bd.detectBatches([
        f('01_full.png', { path: 'p/01_full.png', width: 1024, height: 1024 }),
        f('01_thumb.png', { path: 'p/01_thumb.png', width: 256, height: 256 }),
    ]);
    const batch = r.batches[0];
    assert.strictEqual(batch.count, 1);
    assert.strictEqual(batch.dropped.length, 1);
    assert.strictEqual(batch.dropped[0].file.name, '01_thumb.png');
    assert.strictEqual(batch.dropped[0].because, '01_full.png');
});

check('a number-only file joins the batch that already has that number', () => {
    const r = bd.detectBatches([
        f('frame-01.png', { path: 'day/frame-01.png' }),
        f('frame-02.png', { path: 'day/frame-02.png' }),
        f('01.png', { path: 'day/01.png' }),
    ]);
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 3);
});

check('a number-only file stays on its own when two batches could claim it', () => {
    const r = bd.detectBatches([
        f('frame-01.png', { path: 'day/frame-01.png' }),
        f('cover-01.png', { path: 'day/cover-01.png' }),
        f('01.png', { path: 'day/01.png' }),
    ]);
    assert.strictEqual(r.batches.length, 3);
});

check('a number-only file in a folder of its own stays on its own', () => {
    const r = bd.detectBatches([
        f('frame-01.png', { path: 'day/frame-01.png' }),
        f('01.png', { path: 'other/01.png' }),
    ]);
    assert.strictEqual(r.batches.length, 2);
});

// ---- ordering -----------------------------------------------------------

check('frames are ordered by their number, not by name', () => {
    const r = bd.detectBatches([f('frame-10.png'), f('frame-02.png'), f('frame-01.png')]);
    assert.deepStrictEqual(names(r.batches[0]), ['frame-01.png', 'frame-02.png', 'frame-10.png']);
});

check('an unnumbered file sorts after the numbered run', () => {
    const r = bd.detectBatches([f('frame.png'), f('frame-01.png'), f('frame-02.png')]);
    assert.strictEqual(r.batches.length, 1);
    assert.deepStrictEqual(names(r.batches[0]), ['frame-01.png', 'frame-02.png', 'frame.png']);
});

check('a file with a different prefix is its own batch, not part of the run', () => {
    const r = bd.detectBatches([f('cover.png'), f('frame-01.png'), f('frame-02.png')]);
    assert.strictEqual(r.batches.length, 2);
});

// ---- modes --------------------------------------------------------------

check('folder mode groups by folder and ignores the name', () => {
    const r = bd.detectBatches([
        f('a.png', { path: 'one/a.png' }),
        f('b.png', { path: 'one/b.png' }),
        f('c.png', { path: 'two/c.png' }),
    ], { mode: 'folder' });
    assert.strictEqual(r.batches.length, 2);
    assert.strictEqual(r.batches.find((b) => b.scope === 'one').count, 2);
    assert.strictEqual(r.batches.find((b) => b.scope === 'two').count, 1);
});

check('single mode puts everything in one batch', () => {
    const r = bd.detectBatches([
        f('a.png', { path: 'one/a.png' }),
        f('b.png', { path: 'two/b.png' }),
    ], { mode: 'single' });
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 2);
});

check('auto mode leaves a file with no name signal on its own', () => {
    const r = bd.detectBatches([f('alpha.png'), f('beta.png')]);
    assert.strictEqual(r.batches.length, 2);
});

// ---- edges --------------------------------------------------------------

check('an empty list gives no batches', () => {
    const r = bd.detectBatches([]);
    assert.strictEqual(r.batches.length, 0);
    assert.strictEqual(r.total, 0);
});

check('one file gives one batch of one', () => {
    const r = bd.detectBatches([f('frame-01.png')]);
    assert.strictEqual(r.batches.length, 1);
    assert.strictEqual(r.batches[0].count, 1);
    assert.strictEqual(r.batches[0].singleton, true);
});

check('a file with no extension is still parsed', () => {
    const p = bd.parseName('frame-01');
    assert.strictEqual(p.ext, '');
    assert.strictEqual(p.prefix, 'frame');
    assert.strictEqual(p.index, 1);
});

check('a dotfile does not lose its whole name to the extension split', () => {
    const p = bd.parseName('.cover');
    assert.strictEqual(p.stem, '.cover');
});

check('the same input always gives the same batches', () => {
    const files = [f('frame-01.png'), f('frame-02.png'), f('cover.png')];
    const a = bd.detectBatches(files);
    const b = bd.detectBatches(files);
    assert.deepStrictEqual(labels(a), labels(b));
    assert.deepStrictEqual(names(a.batches[0]), names(b.batches[0]));
});

check('detection does not mutate the files it was given', () => {
    const files = [f('frame-01.png', { path: 'day/frame-01.png' })];
    const before = JSON.stringify(files);
    bd.detectBatches(files);
    assert.strictEqual(JSON.stringify(files), before);
});

check('every file lands in exactly one batch', () => {
    const files = [
        f('frame-01.png', { path: 'a/frame-01.png' }),
        f('frame-02.png', { path: 'a/frame-02.png' }),
        f('01_full.png', { path: 'b/01_full.png' }),
        f('01_thumb.png', { path: 'b/01_thumb.png' }),
        f('cover.png'),
    ];
    const r = bd.detectBatches(files);
    const seen = r.batches.flatMap((b) => b.files.map((x) => x.name + '|' + (x.path || '')));
    const unique = new Set(seen);
    assert.strictEqual(unique.size, seen.length, 'no file is in two batches');
    assert.strictEqual(seen.length, 4, 'the duplicate frame is dropped, the rest survive');
});

// ---- summary ------------------------------------------------------------

console.log('');
if (failed) {
    console.log(`batch-detect: ${passed} passed, ${failed} FAILED`);
    process.exit(1);
}
console.log(`batch-detect: ${passed} passed`);
