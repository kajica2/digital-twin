#!/usr/bin/env node
// lib/mj-dashboard-index.test.js
//
// Unit tests for the pure logic of lib/mj-dashboard-index.js.
//
// The generator walks a 469-generation corpus, so the tests here cover the
// FUNCTIONS, not the corpus: the prompt-library exclusion, the external-url
// redaction, the tracked-file filter, the "nothing tracked" guard and the
// prompt-count parity with the submitter's own parser.
//
// Pure-Node, no deps, no framework. Run: node lib/mj-dashboard-index.test.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const gen = require('./mj-dashboard-index.js');
const submitter = require('./mj-submitter.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}
function assertTrue(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-dashboard-test-'));
process.stderr.write(`\n[mj-dashboard-index.test] test dir: ${TEST_DIR}\n\n`);

// ------------------------------------------------------------------
// 1. The prompt-library exclusion.
//
// PROMPT-EXPANSION-FORMAT.md is the FORMAT DOCUMENTATION, not a prompt
// pack — its 33 example bullets inflated the headline. It must be
// excluded by name; a real pack must not be.
// ------------------------------------------------------------------
process.stderr.write('1. prompt-library exclusion\n');
assertTrue('PROMPT-EXPANSION-FORMAT.md is a doc file', gen.isDocPromptFile('PROMPT-EXPANSION-FORMAT.md'));
assertTrue('STYLE-PRESETS.md is a doc file', gen.isDocPromptFile('STYLE-PRESETS.md'));
assertTrue('a real pack is not a doc file', !gen.isDocPromptFile('mood-frames-eight.md'));
assertTrue('a doc file is recognised by full path too',
  gen.isDocPromptFile('assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md'));

const fakeEntries = [
  { file: 'assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md', name: 'Format', prompts: 33, ar: '16:9' },
  { file: 'assets/mural-prompts/real-pack.md', name: 'Real pack', prompts: 2, ar: '16:9' },
  { file: 'assets/mural-prompts/untracked-pack.md', name: 'Untracked', prompts: 1, ar: null },
  { file: 'assets/mural-prompts/empty-pack.md', name: 'Empty', prompts: 0, ar: null },
];
const fakeTracked = new Set([
  'assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md',
  'assets/mural-prompts/real-pack.md',
  'assets/mural-prompts/empty-pack.md',
]);
const lib = gen.buildPromptLibrary(fakeEntries, fakeTracked);
assert('only the tracked, non-doc, non-empty pack is published',
  lib.library.map((p) => p.file), ['assets/mural-prompts/real-pack.md']);
assert('the published pack keeps its prompt count', lib.library[0].prompts, 2);
assert('the published pack keeps its --ar', lib.library[0].ar, '16:9');
assert('every excluded pack is reported with a reason',
  lib.excluded.length, 3);
assertTrue('the doc file is reported as excluded',
  lib.excluded.some((e) => e.file.endsWith('PROMPT-EXPANSION-FORMAT.md') && /documentation/.test(e.reason)));
assertTrue('the untracked pack is reported as excluded',
  lib.excluded.some((e) => e.file.endsWith('untracked-pack.md') && /not tracked/.test(e.reason)));
assertTrue('the empty pack is reported as excluded',
  lib.excluded.some((e) => e.file.endsWith('empty-pack.md') && /no prompts/.test(e.reason)));

// ------------------------------------------------------------------
// 2. External-url redaction in published prompt text.
//
// The published prompts carry the artist's face-reference photo urls
// (--cref https://d.uguu.se/…). The url must go, the flag name must stay.
// ------------------------------------------------------------------
process.stderr.write('2. external-url redaction\n');
assert('a url after a flag is redacted, flag kept',
  gen.redactExternalUrls('a face --cref https://d.uguu.se/eUKgzOko.jpg --cw 100'),
  'a face --cref [redacted-url] --cw 100');
assert('a url inside a sentence is redacted',
  gen.redactExternalUrls('portrait of the artist https://d.uguu.se/x.jpg in the studio'),
  'portrait of the artist [redacted-url] in the studio');
assert('a prompt with no url is unchanged',
  gen.redactExternalUrls('a trumpet at dawn, raw, 16:9'),
  'a trumpet at dawn, raw, 16:9');
assert('trailing punctuation survives redaction',
  gen.redactExternalUrls('see https://d.uguu.se/x.jpg.'),
  'see [redacted-url].');
assertTrue('no uguu url survives redaction',
  !/uguu/.test(gen.redactExternalUrls('--cref https://d.uguu.se/eUKgzOko.jpg')));

// ------------------------------------------------------------------
// 3. The tracked-file filter.
//
// `git ls-files` also lists staged-but-uncommitted files, which do not
// exist on the deployed site. The filter keeps only the tracked set.
// ------------------------------------------------------------------
process.stderr.write('3. tracked-file filter\n');
const trackedSet = new Set(['assets/marketplace/coda-fern.jpg']);
assert('tracked files are kept',
  gen.filterTracked(['assets/marketplace/coda-fern.jpg'], trackedSet),
  ['assets/marketplace/coda-fern.jpg']);
assert('untracked files are dropped',
  gen.filterTracked(['assets/flux2/render-01.png'], trackedSet),
  []);
assert('a mix keeps only the tracked ones',
  gen.filterTracked(['assets/marketplace/coda-fern.jpg', 'assets/flux2/render-01.png'], trackedSet),
  ['assets/marketplace/coda-fern.jpg']);

// ------------------------------------------------------------------
// 4. The "nothing tracked" guard.
//
// An index with zero images must never be written — the generator fails
// loudly instead.
// ------------------------------------------------------------------
process.stderr.write('4. nothing-tracked guard\n');
let threw = null;
try { gen.assertTrackedSet(new Set()); } catch (e) { threw = e; }
assertTrue('an empty tracked set throws', threw !== null);
assertTrue('the error explains itself', threw && /no tracked files/i.test(threw.message));
let threw2 = null;
try { gen.assertTrackedSet(null); } catch (e) { threw2 = e; }
assertTrue('a null tracked set throws', threw2 !== null);
assertTrue('a non-empty tracked set passes', gen.assertTrackedSet(trackedSet) === trackedSet);

// ------------------------------------------------------------------
// 5. Prompt-count parity with the submitter's parser.
//
// extractPrompts is the single source of truth. The generator must not
// reimplement the counter.
// ------------------------------------------------------------------
process.stderr.write('5. prompt-count parity\n');
const packFile = path.join(TEST_DIR, 'pack.md');
fs.writeFileSync(packFile, [
    '# Test pack — 3 prompts (16:9)',
    '> Source: a test',
    '- first prompt --ar 16:9',
    '- second prompt --ar 16:9',
    '  continued on the next line',
    '- third prompt --ar 1:1',
    '',
    '```',
    '- not a prompt, it is in a code fence',
    '```',
].join('\n'));
const parsed = submitter.extractPrompts(packFile);
const counted = gen.countPackPrompts(packFile);
assert('the generator counts what extractPrompts parses', counted.prompts, parsed.length);
assert('the count is 3', counted.prompts, 3);
assert('the --ar values come from the parsed prompts', [...counted.ars].sort(), ['16:9', '1:1']);
assertTrue('the code-fence bullet is not counted', !parsed.some((p) => p.text.includes('code fence')));

// A doc file with example bullets must not be counted as a pack.
const docFile = path.join(TEST_DIR, 'PROMPT-EXPANSION-FORMAT.md');
fs.writeFileSync(docFile, ['# Format', '- example bullet one', '- example bullet two'].join('\n'));
assertTrue('the doc file is recognised by name', gen.isDocPromptFile(docFile));

// ------------------------------------------------------------------
// 6. The 4-up grid derivation.
//
// meta.json does not always hold exactly four urls: some generations
// carry the grid at 640 AND at 384, some an upscale next to the grid.
// The grid is slots 0..3 at the highest resolution available.
// ------------------------------------------------------------------
process.stderr.write('6. 4-up grid derivation\n');
assert('a plain 4-up grid is taken as is',
  gen.deriveGridUrls([
    'https://cdn.midjourney.com/t/0_0_640_N.webp',
    'https://cdn.midjourney.com/t/0_1_640_N.webp',
    'https://cdn.midjourney.com/t/0_2_640_N.webp',
    'https://cdn.midjourney.com/t/0_3_640_N.webp',
  ]).length, 4);
assert('the 640 copy wins over the 384 copy of the same slot',
  gen.deriveGridUrls([
    'https://cdn.midjourney.com/t/0_0_640_N.webp',
    'https://cdn.midjourney.com/t/0_0_384_N.webp',
  ]), ['https://cdn.midjourney.com/t/0_0_640_N.webp']);
assert('the grid is ordered by slot',
  gen.deriveGridUrls([
    'https://cdn.midjourney.com/t/0_2_640_N.webp',
    'https://cdn.midjourney.com/t/0_0_640_N.webp',
  ]), [
    'https://cdn.midjourney.com/t/0_0_640_N.webp',
    'https://cdn.midjourney.com/t/0_2_640_N.webp',
  ]);
assert('an empty url list yields no grid', gen.deriveGridUrls([]), []);
assert('a missing url list yields no grid', gen.deriveGridUrls(undefined), []);

// Cleanup
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[mj-dashboard-index.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
  process.stderr.write('failures:\n' + failures.map((f) => '  - ' + f).join('\n') + '\n');
}
process.exit(failed === 0 ? 0 : 1);
