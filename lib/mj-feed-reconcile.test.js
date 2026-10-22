#!/usr/bin/env node
'use strict';
// lib/mj-feed-reconcile.test.js
//
// Tests for the reconcile tool's file-IO path.
//
// WHY THIS EXISTS
//
// lib/mj-feed-reconcile.js is the REPAIR path for the MJ pipeline: the
// web backend's DOM matcher can attribute a prompt to the wrong card,
// so the tool re-derives the truth from Midjourney's live feed and
// rewrites the pack's meta.json files.
//
// The matching half of that job is covered by lib/mj-feed.test.js. The
// FILE-IO half — reading the prompt slots, building the new meta,
// writing it back — was not covered by anything, and it is the half
// that touches the shipped artifact: the meta.json files are what the
// contact sheet's manifest, the tiles and the captions are derived
// from. A bug here corrupts the provenance of every image in the pack
// while leaving the images themselves perfectly fine.
//
// The module is now importable (the CLI only runs as the entry point),
// so these tests drive the real functions against real files in a
// temp dir. No browser, no network.
//
//   node lib/mj-feed-reconcile.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reconcile = require('./mj-feed-reconcile.js');

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

process.stderr.write(`\n[mj-feed-reconcile.test]\n\n`);

// ---------------------------------------------------------------------
// 1. expectedAspect — the ratio the pack asked for.
// ---------------------------------------------------------------------

process.stderr.write('1. expectedAspect\n');
assert('the aspect is read from the composed prompt',
    reconcile.expectedAspect('a figure in a tunnel --ar 16:9 --s 100'), '16:9');
assert('the aspect is lowercased',
    reconcile.expectedAspect('a figure --ar 16:9'), '16:9');
assert('a prompt with no aspect yields null',
    reconcile.expectedAspect('a figure --s 100'), null);
assert('an empty prompt yields null',
    reconcile.expectedAspect(''), null);
assert('the FIRST --ar wins',
    reconcile.expectedAspect('--ar 16:9 --ar 3:4'), '16:9');

// ---------------------------------------------------------------------
// 2. collectSlots — reading a pack off disk.
// ---------------------------------------------------------------------

process.stderr.write('\n2. collectSlots\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-reconcile-test-'));

// A pack with three slots, in the shape the submitter writes them:
// zero-padded dirs, a prompt.md holding the COMPOSED prompt, and a
// meta.json holding the previous reconciliation.
function writePack(root) {
    fs.mkdirSync(root, { recursive: true });
    const mk = (n, { prompt, meta } = {}) => {
        const d = path.join(root, `prompt-${n}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'prompt.md'),
            prompt !== undefined ? prompt : `# Prompt ${n}\na figure in a tunnel --ar 16:9 --s 100\n`);
        if (meta !== undefined) {
            fs.writeFileSync(path.join(d, 'meta.json'),
                typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2));
        }
    };
    mk('01', { meta: { index: 1, taskId: 'aaaa1111-0000-0000-0000-000000000000', imageCount: 4 } });
    mk('02', { meta: { index: 2, taskId: 'bbbb2222-0000-0000-0000-000000000000' } });
    mk('03');                      // no meta at all
    // Things that must be ignored.
    fs.mkdirSync(path.join(root, 'not-a-slot'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), 'ignore me');
    fs.writeFileSync(path.join(root, 'prompt-99.txt'), 'ignore me');
    return root;
}

const packDir = writePack(path.join(tmp, 'pack'));
const slots = reconcile.collectSlots(packDir);
assert('only prompt-NN dirs are collected', slots.length, 3);
assert('the slots come back in order',
    slots.map(s => s.dir), ['prompt-01', 'prompt-02', 'prompt-03']);
assert('the prompt header is stripped',
    slots[0].prompt, 'a figure in a tunnel --ar 16:9 --s 100');
assert('the prompt is trimmed',
    slots[0].prompt.endsWith('--s 100'), true);
assert('an existing meta is read',
    slots[0].meta.taskId, 'aaaa1111-0000-0000-0000-000000000000');
assert('a slot with no meta yields null',
    slots[2].meta, null);
assert('the meta path points at the slot',
    slots[0].metaFile, path.join(packDir, 'prompt-01', 'meta.json'));

// A corrupt meta must not take the whole run down — the reconcile is
// the repair path, and a pack with one damaged meta is exactly when
// you run it.
const corruptDir = writePack(path.join(tmp, 'corrupt'));
fs.writeFileSync(path.join(corruptDir, 'prompt-01', 'meta.json'), '{ this is not json');
const corruptSlots = reconcile.collectSlots(corruptDir);
assert('a corrupt meta does not throw', corruptSlots.length, 3);
assert('a corrupt meta becomes null', corruptSlots[0].meta, null);

// A dir with no prompt.md is not a slot.
const noPromptDir = writePack(path.join(tmp, 'noprompt'));
fs.unlinkSync(path.join(noPromptDir, 'prompt-02', 'prompt.md'));
assert('a slot without a prompt.md is skipped',
    reconcile.collectSlots(noPromptDir).map(s => s.dir), ['prompt-01', 'prompt-03']);

// Ten-plus slots must stay in NUMERIC order. Lexicographic sorting
// would put prompt-10 before prompt-2.
const manyDir = path.join(tmp, 'many');
fs.mkdirSync(manyDir, { recursive: true });
for (let i = 1; i <= 12; i++) {
    const d = path.join(manyDir, `prompt-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'prompt.md'), `# Prompt ${i}\np ${i}\n`);
}
assert('twelve slots come back in numeric order',
    reconcile.collectSlots(manyDir).map(s => s.dir),
    Array.from({ length: 12 }, (_, i) => `prompt-${String(i + 1).padStart(2, '0')}`));

// ---------------------------------------------------------------------
// 3. buildMeta — the meta that gets written.
// ---------------------------------------------------------------------

process.stderr.write('\n3. buildMeta\n');
const slot = slots[0];
const urls = ['https://cdn.midjourney.com/aaaa1111-0000-0000-0000-000000000000/0_0_640_N.webp'];
const built = reconcile.buildMeta(slot, { id: 'aaaa1111-0000-0000-0000-000000000000' }, urls, '2026-10-22T00:00:00.000Z');

assert('the task id is the reconciled one',
    built.taskId, 'aaaa1111-0000-0000-0000-000000000000');
assert('the match is attributed to the feed',
    built.matchedBy, 'feed-command');
assert('the image urls are recorded', built.imageUrls, urls);
assert('the image count matches the urls', built.imageCount, 1);
assert('the prompt is the composed one', built.prompt, slot.prompt);
assert('the reconcile time is recorded',
    built.reconciledAt, '2026-10-22T00:00:00.000Z');
assert('the slot is marked complete', built.complete, true);

// isNewestTask belonged to the DOM matcher this tool replaces. Leaving
// it behind would keep asserting a provenance claim the reconcile
// just disproved.
assert('the stale DOM-matcher claim is dropped',
    'isNewestTask' in built, false);
assert('the old meta is not serialised with the dropped key',
    JSON.stringify(built).includes('isNewestTask'), false);

// Fields the tool does not re-derive are preserved.
const kept = reconcile.buildMeta(
    { ...slot, meta: { ...slot.meta, custom: 'keep me', isNewestTask: true } },
    { id: 'cccc3333-0000-0000-0000-000000000000' }, urls, '2026-10-22T00:00:00.000Z');
assert('unrelated old fields survive', kept.custom, 'keep me');
assert('the dropped key does not come back', 'isNewestTask' in kept, false);

// The index comes from the old meta when there is one, and from the
// directory name when there is not.
assert('the old index is kept', built.index, 1);
const noMetaSlot = slots[2];
const derived = reconcile.buildMeta(noMetaSlot, { id: 'dddd4444-0000-0000-0000-000000000000' }, urls, '2026-10-22T00:00:00.000Z');
assert('a missing index is derived from the dir name', derived.index, 3);

// ---------------------------------------------------------------------
// 4. writeMeta — the file on disk.
// ---------------------------------------------------------------------

process.stderr.write('\n4. writeMeta\n');
const outFile = path.join(tmp, 'out-meta.json');
const written = reconcile.writeMeta(outFile, built);
assert('the file is written', fs.existsSync(outFile), true);
const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
assert('the file round-trips', parsed.taskId, built.taskId);
assert('the file carries no dropped key',
    Object.keys(parsed).includes('isNewestTask'), false);
assert('the file is valid json with the expected shape',
    Object.keys(parsed).sort(),
    ['complete', 'imageCount', 'imageUrls', 'index', 'matchedBy', 'prompt', 'reconciledAt', 'taskId'].sort());
assert('writeMeta returns the meta it wrote', written.taskId, built.taskId);

// ---------------------------------------------------------------------
// 5. taskIdChanged — the flag the operator reads.
// ---------------------------------------------------------------------

process.stderr.write('\n5. taskIdChanged\n');
const A = 'e17ecddc-2eb2-4c69-b4b4-47606c0c4523';
const B = '10e199ff-9deb-4083-8f53-3fa5c9231deb';
assert('the same id is not a change', reconcile.taskIdChanged(A, A), false);
assert('a different id is a change', reconcile.taskIdChanged(A, B), true);
assert('a new id where there was none is a change', reconcile.taskIdChanged(null, A), true);
assert('no id found where there was one is a change', reconcile.taskIdChanged(A, null), true);
assert('neither id found is not a change', reconcile.taskIdChanged(null, null), false);

// The regression this file exists for: the old code truncated the OLD
// id to 8 chars and compared it against the full uuid, so the flag was
// ALWAYS true and every line of the reconcile output said CHANGED —
// including the lines where nothing had changed. The comparison is
// prefix-aware now, so that mistake cannot produce a false change.
assert('a truncated id and its full form are the same job',
    reconcile.taskIdChanged(A.slice(0, 8), A), false);
assert('a truncated id against a different full id is a change',
    reconcile.taskIdChanged(A.slice(0, 8), B), true);
assert('a full id and its truncated form are the same job',
    reconcile.taskIdChanged(A, A.slice(0, 8)), false);
assert('two ids sharing a prefix but differing are a change',
    reconcile.taskIdChanged('e17ecddc-0000-0000-0000-000000000000',
                            'e17ecddc-1111-1111-1111-111111111111'), true);

fs.rmSync(tmp, { recursive: true, force: true });

process.stderr.write(`\n[mj-feed-reconcile.test] passed: ${passed}, failed: ${failed}\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED ${f.label}\n`);
    process.exit(1);
}
process.exit(0);
