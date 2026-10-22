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

// 5. The SHIPPED sheet — its provenance, guarded.
//
// Sections 1-4 test the builder's logic on synthetic input. This section
// guards the artifact that actually ships: assets/mj-sheets/<pack>/.
//
// The chain that makes the sheet trustworthy is
//
//     pack bullet -> variantLabel() -> manifest label -> page caption
//     meta.json  -> taskId         -> manifest taskId -> tile URL
//
// and nothing in the repo asserted it. The pack and the manifest are
// tracked, but they can drift: edit one clause in the pack, or
// regenerate a manifest from a different run, and the sheet keeps
// rendering — now captioned with a clause that did not produce the
// image next to it. The reader is told the wrong thing about the
// picture, which is the exact failure the caption logic exists to
// prevent.
//
// Everything asserted here reads TRACKED files only (the pack, the
// manifest, the sheet PNG, the tiles), so the guard runs in CI where
// mj-output/ — and therefore the per-generation meta.json files — do
// not exist.
//
// The section is data-driven: it walks every directory under
// assets/mj-sheets/, so a newly shipped pack is covered with no edit
// here.

process.stderr.write('\n5. the shipped sheet — pack, manifest and tiles agree\n');

const REPO = path.resolve(__dirname, '..');
const SHEETS_DIR = path.join(REPO, 'assets', 'mj-sheets');
const PACKS_DIR = path.join(REPO, 'assets', 'mural-prompts');

// Strip MJ's flags so two prompts can be compared on their prose alone.
// Same rule as variantLabel(): a flag and its value go together.
function stripFlags(s) {
    return String(s || '')
        .replace(/\s*--[\w-]+(\s+\S+)?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
// Longest common prefix / suffix across a set of strings.
function commonPrefix(list) {
    let p = list[0];
    for (const s of list) { let i = 0; while (i < p.length && i < s.length && p[i] === s[i]) i++; p = p.slice(0, i); }
    return p;
}
function commonSuffix(list) {
    let s = list[0];
    for (const t of list) { let i = 0; while (i < s.length && i < t.length && s[s.length - 1 - i] === t[t.length - 1 - i]) i++; s = s.slice(s.length - i); }
    return s;
}
// PNG dimensions live in the IHDR chunk: width at byte 16, height at 20.
function pngSize(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(24);
        fs.readSync(fd, buf, 0, 24, 0);
        if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } finally { fs.closeSync(fd); }
}
// A webp's size is in the VP8X chunk (24..30) for the extended format.
function webpSize(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(40);
        fs.readSync(fd, buf, 0, 40, 0);
        if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WEBP') return null;
        if (buf.slice(12, 16).toString() !== 'VP8X') return null;
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    } finally { fs.closeSync(fd); }
}
const sha256 = require('node:crypto').createHash;
// createHash returns a single-use object — one per file.
const digestOf = f => sha256('sha256').update(fs.readFileSync(f)).digest('hex');

const { extractPrompts } = require('./mj-submitter.js');
const sheetDirs = fs.existsSync(SHEETS_DIR)
    ? fs.readdirSync(SHEETS_DIR).filter(d => fs.existsSync(path.join(SHEETS_DIR, d, 'sheet-manifest.json')))
    : [];

assertTrue('at least one sheet ships', sheetDirs.length > 0);

for (const dir of sheetDirs) {
    const base = path.join(SHEETS_DIR, dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'sheet-manifest.json'), 'utf8'));
    const tag = `[${dir}]`;

    // The pack that produced the sheet must still exist, tracked, and
    // parseable by the submitter's own parser — the same parser the
    // watcher uses, so "the pack parses" means "the pack would submit".
    const packFile = path.join(PACKS_DIR, `${manifest.pack.replace(/_/g, '-')}.md`);
    assertTrue(`${tag} the source pack still exists`, fs.existsSync(packFile));
    if (!fs.existsSync(packFile)) continue;

    const prompts = extractPrompts(packFile);
    assert(`${tag} the pack yields the manifest's variant count`,
        prompts.length, manifest.count);

    // Every variant is the same aspect — a comparison sheet with mixed
    // ratios is not a comparison.
    assertTrue(`${tag} every prompt is 16:9`,
        prompts.every(p => p.ar === '16:9'));

    // One brief, twelve variants: the prompts share a substantial head
    // and a substantial tail and differ only in the middle clause.
    const texts = prompts.map(p => stripFlags(p.text));
    const head = commonPrefix(texts);
    const tail = commonSuffix(texts);
    assertTrue(`${tag} the variants share a common head`, head.length >= 40);
    assertTrue(`${tag} the variants share a common tail`, tail.length >= 40);
    const middles = texts.map(t => t.slice(head.length, t.length - tail.length).trim());
    assertTrue(`${tag} every variant has a non-empty distinguishing clause`,
        middles.every(m => m.length > 0));
    assert(`${tag} the distinguishing clauses are all different`,
        new Set(middles).size, middles.length);

    // THE guard: the caption on the tile is the clause that produced it.
    assertTrue(`${tag} every caption is the clause that produced its tile`,
        manifest.variants.every((v, i) =>
            i < prompts.length && sheet.variantLabel(prompts[i].text) === v.label));
    assertTrue(`${tag} every caption is the start of its own clause`,
        manifest.variants.every((v, i) =>
            i < middles.length &&
            middles[i].startsWith(v.label.replace(/…$/, '').trim())));

    // Provenance: 12 distinct jobs, and each tile's URL points at the
    // job the manifest recorded for it.
    assert(`${tag} the task ids are all different`,
        new Set(manifest.variants.map(v => v.taskId)).size, manifest.variants.length);
    assertTrue(`${tag} every tile url points at its own recorded job`,
        manifest.variants.every(v => v.imageUrl.includes(v.taskId)));

    // The grid the sheet was cut on must match the variant count.
    assert(`${tag} the grid holds exactly the variants`,
        manifest.grid.cols * manifest.grid.rows, manifest.variants.length);

    // The tiles ship as local files so the artifact survives the CDN.
    // Each one must exist, be a real image, and be DIFFERENT — a 12-up
    // comparison with one image copied twelve times is worthless.
    const tilesDir = path.join(base, 'tiles');
    const tileFiles = manifest.variants.map(v => path.join(tilesDir, `prompt-${v.index}.webp`));
    assertTrue(`${tag} every tile ships as a local file`,
        tileFiles.every(f => fs.existsSync(f)));
    assertTrue(`${tag} every tile is a real webp image`,
        tileFiles.filter(f => fs.existsSync(f)).every(f => {
            const s = webpSize(f);
            return s && s.width > 0 && s.height > 0;
        }));
    assertTrue(`${tag} every tile carries real pixels`,
        tileFiles.filter(f => fs.existsSync(f)).every(f => fs.statSync(f).size > 1024));
    const digests = tileFiles.filter(f => fs.existsSync(f)).map(digestOf);
    assert(`${tag} no two tiles are the same image`,
        new Set(digests).size, digests.length);

    // The sheet PNG must be a real image, big enough for the grid it
    // claims to hold.
    const png = path.join(base, manifest.sheet);
    assertTrue(`${tag} the sheet png ships`, fs.existsSync(png));
    if (fs.existsSync(png)) {
        const size = pngSize(png);
        assertTrue(`${tag} the sheet png is a real png`, size !== null);
        if (size) {
            assertTrue(`${tag} the sheet is wide enough for its grid`,
                size.width >= manifest.grid.cols * manifest.grid.thumbPx);
            assertTrue(`${tag} the sheet is tall enough for its grid`,
                size.height >= Math.round(manifest.grid.rows * manifest.grid.thumbPx * 9 / 16));
        }
    }
}

process.stderr.write(`\n[mj-contact-sheet.test] passed: ${passed}, failed: ${failed}\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED ${f.label}\n`);
    process.exit(1);
}
process.exit(0);
