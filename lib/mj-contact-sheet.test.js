#!/usr/bin/env node
'use strict';
// lib/mj-contact-sheet.test.js
//
// Tests for the contact sheet builder's pure logic.
//
// The sheet is the deliverable of the MJ pipeline: a 12-up comparison of
// one brief rendered at different camera angles. Two things can silently
// corrupt it, and both are covered here.
//
// 1. The CAPTION must be the clause that produced the tile. If the
//    caption truncates at the wrong separator, the sheet says "overhead…"
//    for a tile that is not overhead — the reader is told the wrong thing
//    about the image. That was a real bug (2026-10-21): the truncation
//    regex cut at the FIRST separator, so "overhead mirror reflection,
//    red coat doubled in glass, muted 35mm documentary" collapsed to
//    "overhead…".
//
// 2. The TILE must be the grid cell the operator selected. Midjourney
//    returns a 4-up per prompt whose four cells are four different takes
//    on the brief, not four copies of one framing, so the per-variant
//    slot map has to reach the URL picker.
//
//   node lib/mj-contact-sheet.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sheet = require('./mj-contact-sheet.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: a, expected: e });
           process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`); }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[mj-contact-sheet.test]\n\n`);

// 1. variantLabel — the caption IS the prompt clause.

const HEAD = 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night';
const TAIL = 'one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text';
function prompt(clause) {
    return `${HEAD}, ${clause}, ${TAIL} --ar 16:9 --s 100 --raw --hd --v 8.2 --no text, watermark, logo`;
}

process.stderr.write('1. variantLabel — the caption is the prompt clause\n');
assert('short clause is returned verbatim',
    sheet.variantLabel(prompt('extreme symmetry')), 'extreme symmetry');
assert('a long clause keeps its leading words',
    sheet.variantLabel(prompt('overhead mirror reflection, red coat doubled in glass, muted 35mm documentary')),
    'overhead mirror reflection, red coat doubled in glass, muted 35mm…');
assert('the truncation cuts at a word boundary, not mid-word',
    sheet.variantLabel(prompt('behind the shoulder of the figure, tunnel vanishing point, quiet Japanese 35mm realism')),
    'behind the shoulder of the figure, tunnel vanishing point, quiet…');
assertTrue('a truncated caption keeps most of its text',
    sheet.variantLabel(prompt('overhead mirror reflection, red coat doubled in glass, muted 35mm documentary')).length > 40);
assert('flags are stripped from the caption',
    sheet.variantLabel(prompt('hard side profile at eye height')), 'hard side profile at eye height');
assert('a prompt with no head marker falls back to the whole text',
    sheet.variantLabel('a completely different prompt about a red coat'),
    'a completely different prompt about a red coat');
assert('an empty prompt does not throw', sheet.variantLabel(''), '');

// 2. pickSlotUrl — the tile is the requested grid cell.

process.stderr.write('\n2. pickSlotUrl — the requested grid cell\n');
const URLS = [
    'https://cdn.midjourney.com/abc/0_0_640_N.webp?method=shortest',
    'https://cdn.midjourney.com/abc/0_1_640_N.webp?method=shortest',
    'https://cdn.midjourney.com/abc/0_2_640_N.webp?method=shortest',
    'https://cdn.midjourney.com/abc/0_3_640_N.webp?method=shortest',
];
assert('slot 0 picks the first cell', sheet.pickSlotUrl(URLS, 0), URLS[0]);
assert('slot 1 picks the second cell', sheet.pickSlotUrl(URLS, 1), URLS[1]);
assert('slot 3 picks the fourth cell', sheet.pickSlotUrl(URLS, 3), URLS[3]);
assert('the highest-resolution cell of a slot wins',
    sheet.pickSlotUrl([
        'https://cdn.midjourney.com/abc/0_1_640_N.webp',
        'https://cdn.midjourney.com/abc/0_1_2048_N.webp',
    ], 1), 'https://cdn.midjourney.com/abc/0_1_2048_N.webp');
assert('an empty url list yields null', sheet.pickSlotUrl([], 0), null);
assert('a missing url list yields null', sheet.pickSlotUrl(null, 0), null);
assert('a full-resolution jpeg cell is picked by its slot number',
    sheet.pickSlotUrl(['https://cdn.midjourney.com/abc/0_2.jpeg'], 2),
    'https://cdn.midjourney.com/abc/0_2.jpeg');

// 3. loadPack — the per-variant slot map reaches the tile.

process.stderr.write('\n3. loadPack — the per-variant slot map\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-sheet-test-'));
function writePack(dir, spec) {
    const d = path.join(tmp, dir);
    fs.mkdirSync(path.join(d, 'prompt-01'), { recursive: true });
    for (const [name, n, slot] of spec) {
        const p = path.join(d, name);
        fs.mkdirSync(p, { recursive: true });
        const urls = [0, 1, 2, 3].map(i =>
            `https://cdn.midjourney.com/job-${n}/0_${i}_640_N.webp?method=shortest`);
        fs.writeFileSync(path.join(p, 'meta.json'), JSON.stringify({
            prompt: prompt('clause ' + n),
            taskId: 'job-' + n,
            imageUrls: urls,
        }));
        void slot;
    }
    return d;
}
const packDir = writePack('pack', [['prompt-01', 1, 0], ['prompt-02', 2, 0]]);

const defaultItems = sheet.loadPack(packDir);
assert('both variants load', defaultItems.length, 2);
assert('without a slot map every variant uses slot 0',
    defaultItems.map(i => i.slot), [0, 0]);
assert('without a slot map variant 01 gets cell 0',
    defaultItems[0].url,
    'https://cdn.midjourney.com/job-1/0_0_640_N.webp?method=shortest');

const mapped = sheet.loadPack(packDir, new Map([[2, 3]]));
assert('the slot map applies to the variant it names',
    mapped[1].url,
    'https://cdn.midjourney.com/job-2/0_3_640_N.webp?method=shortest');
assert('the slot map records the chosen slot on the item',
    mapped[1].slot, 3);
assert('variants outside the slot map keep the default',
    mapped[0].url,
    'https://cdn.midjourney.com/job-1/0_0_640_N.webp?method=shortest');
assert('the item carries the caption clause',
    mapped[0].label, 'clause 1');
assert('the item carries the task id', mapped[0].taskId, 'job-1');

// 4. buildHtml — the sheet shows every tile with its caption.

process.stderr.write('\n4. buildHtml — every tile is present and labelled\n');
const html = sheet.buildHtml(mapped);
assertTrue('one img per variant', (html.match(/<img /g) || []).length === 2);
assertTrue('the caption carries the clause', html.includes('clause 1'));
assertTrue('the caption carries the task id', html.includes('job-1'));
assertTrue('the sheet states the variant count', html.includes('2 up'));
assertTrue('the title is escaped', !/<h1>[^<]*<script/i.test(html));

fs.rmSync(tmp, { recursive: true, force: true });

process.stderr.write(`\n[mj-contact-sheet.test] passed: ${passed}, failed: ${failed}\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED ${f.label}\n`);
    process.exit(1);
}
process.exit(0);
