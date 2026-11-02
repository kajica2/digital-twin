#!/usr/bin/env node
'use strict';
// lib/mj-fetch-fullres.test.js
//
// Tests for the full-resolution cell fetcher.
//
//   node lib/mj-fetch-fullres.test.js

const f = require('./mj-fetch-fullres.js');

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

process.stderr.write('\n[mj-fetch-fullres.test]\n\n');

// The url shape.
//
// MEASURED 2026-11-02 on the live CDN: the un-suffixed path serves the
// native 1456×816 grid cell, and the `_U` path answers 422 unless the
// job was actually upscaled in the UI.
process.stderr.write('1. the full-resolution url\n');
assert('the original is the un-suffixed path',
    f.fullResUrl('8aa8525d-c004-4ddc-be69-8a72a8a5306c', '0_0', false),
    'https://cdn.midjourney.com/8aa8525d-c004-4ddc-be69-8a72a8a5306c/0_0.webp');
assert('the upscale is the _U path',
    f.fullResUrl('8aa8525d-c004-4ddc-be69-8a72a8a5306c', '0_0', true),
    'https://cdn.midjourney.com/8aa8525d-c004-4ddc-be69-8a72a8a5306c/0_0_U.webp');

// The slot parsing.
//
// A cell coordinate is `row_col` and nothing else. The flag values and
// the job id must not be mistaken for cells.
process.stderr.write('2. the slot parsing\n');
assert('cells are read', f.parseSlots(['0_0', '0_1']), ['0_0', '0_1']);
assert('flags are not cells', f.parseSlots(['--out', 'mj-output']), []);
assert('the job id is not a cell', f.parseSlots(['8aa8525d-c004-4ddc-be69-8a72a8a5306c']), []);
assert('a flag value that looks like a path is not a cell', f.parseSlots(['mj-output/pack']), []);
assert('duplicates collapse', f.parseSlots(['0_0', '0_0']), ['0_0']);
assert('a malformed coordinate is refused', f.parseSlots(['0_0_640_N']), []);
assert('a bare number is not a cell', f.parseSlots(['0']), []);

module.exports = { passed, failed };

if (require.main === module) {
    process.stderr.write(`\n[mj-fetch-fullres.test] passed: ${passed}, failed: ${failed}\n`);
    process.exit(failed === 0 ? 0 : 1);
}
