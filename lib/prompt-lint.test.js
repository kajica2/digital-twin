#!/usr/bin/env node
'use strict';
// lib/prompt-lint.test.js
//
// Tests for the prompt lint.
//
// The rule with teeth: a prompt must not name the subject's race or
// ethnicity, because the whole point of these prompts is that a
// reference photo governs who is in the frame. A prompt that says
// "a Black man" overrides the photo.
//
// The lint has to be sharp in BOTH directions. A lint that only
// catches the real cases but also fires on "black and white" or "a
// black coat" gets switched off, and then it protects nothing.
//
//   node lib/prompt-lint.test.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lint = require('./prompt-lint.js');

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
    else {
        failed++; failures.push({ label, actual: 'false', expected: 'true' });
        process.stderr.write(`  ✗ ${label}\n`);
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lint-test-'));
process.stderr.write('\n[prompt-lint.test]\n\n');

function flagged(text) {
    return lint.findViolations(text).map(v => v.match.toLowerCase());
}

// ------------------------------------------------------------------
// 1. The real cases — a demographic claim about a person
// ------------------------------------------------------------------
process.stderr.write('1. a prompt that names the subject\'s race is a finding\n');

assert('a black man is flagged', flagged('a black man in a grey coat'), ['black man']);
assert('an Asian woman is flagged', flagged('an Asian woman holding a saxophone'), ['asian woman']);
assert('a young Black man is flagged', flagged('A young Black man in a quilted jacket'), ['black man']);
assert('African-American saxophonist is flagged',
    flagged('African-American saxophonist on a stage'), ['african-american saxophonist']);
assert('african american spelled with a space is flagged',
    flagged('an african american trumpeter'), ['african american trumpeter']);
assert('a portrait of a Black musician is flagged',
    flagged('a portrait of a Black musician, dramatic light'), ['black musician']);
assert('a person of color is flagged',
    flagged('a person of color standing in the rain'), ['person of color']);
assert('of African descent is flagged',
    flagged('a woman of African descent, soft light'), ['of african descent']);
assert('a Latina artist is flagged', flagged('a Latina artist at work'), ['latina artist']);
assert('the wording is case-insensitive', flagged('A BLACK MAN shouting'), ['black man']);

// ------------------------------------------------------------------
// 2. The false positives the lint must NOT fire on
// ------------------------------------------------------------------
process.stderr.write('\n2. photographic treatments, clothing and scenery are not findings\n');

assert('black and white photograph is clean',
    flagged('a black and white photograph of a city street'), []);
assert('a framed black-and-white portrait is clean',
    flagged('a dense wall of clippings and a framed black-and-white portrait'), []);
assert('black-and-white portrait of a man is clean',
    flagged('a black-and-white portrait of a man, grainy'), []);
assert('a woman in a black coat is clean',
    flagged('a woman in a black coat, wind on the street'), []);
assert('a black piano is clean', flagged('a black piano in an empty room'), []);
assert('white wine on a table is clean', flagged('white wine on a table'), []);
assert('the Black Sea is clean', flagged('the Black Sea at dusk'), []);
assert('black metal guitar is clean', flagged('a black metal guitar on a stand'), []);
assert('Mexican cuisine is clean', flagged('a table of Mexican cuisine'), []);
assert('Asian fusion kitchen is clean', flagged('an Asian fusion kitchen, steam rising'), []);
assert('Indian summer light is clean', flagged('Indian summer light over a field'), []);
assert('a white picket fence is clean', flagged('a white picket fence, summer'), []);
assert('black coffee in a cup is clean', flagged('black coffee in a white cup'), []);

// ------------------------------------------------------------------
// 3. The two-word forms must not fire on the wrong noun
// ------------------------------------------------------------------
process.stderr.write('\n3. the descriptor must modify a PERSON noun\n');

assert('an Asian market is clean', flagged('an Asian market at dusk, lanterns'), []);
assert('an Indian summer storm is clean', flagged('an Indian summer storm rolling in'), []);
assert('a Turkish coffee pot is clean', flagged('a Turkish coffee pot on a tray'), []);
assert('an African sunset is clean', flagged('an African sunset over the savanna'), []);
assert('a Mexican mural is clean', flagged('a Mexican mural, bold colour blocks'), []);
assert('an Indian restaurant is clean', flagged('an Indian restaurant, warm light'), []);

// ------------------------------------------------------------------
// 4. Pack-level scanning
// ------------------------------------------------------------------
process.stderr.write('\n4. scanning a pack\n');

function writePack(name, body) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, body);
    return p;
}

const cleanPack = writePack('clean.md',
    '# Clean pack — 2 prompts (16:9)\n\n' +
    '- a black and white street photograph, rain on the asphalt --ar 16:9\n' +
    '- a woman in a black coat walking past a lit window --ar 16:9\n');

const dirtyPack = writePack('dirty.md',
    '# Dirty pack — 2 prompts (16:9)\n\n' +
    '- a quiet street at dawn --ar 16:9\n' +
    '- a young Black man on the steps of a tenement --ar 16:9\n');

const prosePack = writePack('prose.md',
    '# Just a document\n\nSome prose about prompts and how they are written.\n\n' +
    'No bullets here at all, so it is not a pack.\n');

const cleanScan = lint.scanFile(cleanPack);
assert('a clean pack reports no violations', cleanScan.violations.length, 0);
assert('a clean pack still counts its prompts', cleanScan.prompts, 2);

const dirtyScan = lint.scanFile(dirtyPack);
assert('a dirty pack reports one violation', dirtyScan.violations.length, 1);
assert('the violation names the offending phrase',
    dirtyScan.violations[0].match, 'Black man');
assert('the violation points at a line number',
    typeof dirtyScan.violations[0].line, 'number');
assert('the violation points at the right line',
    dirtyScan.violations[0].line, 4);

assert('a document with no bullets is not treated as a pack',
    lint.scanFile(prosePack).skipped, 'not a prompt pack (no top-level bullets)');
assertTrue('looksLikePack is true for a pack', lint.looksLikePack('- a prompt\n'));
assertTrue('looksLikePack is false for prose', !lint.looksLikePack('just prose\n'));

// ------------------------------------------------------------------
// 5. The lint agrees with the submitter about what a pack contains
// ------------------------------------------------------------------
process.stderr.write('\n5. the lint reads the pack the way the watcher will\n');

const { extractPrompts } = require('./mj-submitter.js');
assert('the lint and the submitter see the same prompt count',
    lint.scanFile(dirtyPack).prompts, extractPrompts(dirtyPack).length);

const fencedPack = writePack('fenced.md',
    '# Fenced — 1 prompt (16:9)\n\n' +
    '```\n- a Black man in a fence block, ignored by the watcher\n```\n' +
    '\n- the only real prompt, a street at dawn --ar 16:9\n');

const fencedScan = lint.scanFile(fencedPack);
assert('a fenced bullet is ignored, as the watcher ignores it',
    fencedScan.violations.length, 0);
assert('a fenced pack still counts its real prompt', fencedScan.prompts, 1);

// ------------------------------------------------------------------
// 6. The term lists themselves
// ------------------------------------------------------------------
process.stderr.write('\n6. the term lists\n');

assertTrue('race terms are non-empty', lint.RACE_TERMS.length > 30);
assertTrue('person nouns are non-empty', lint.PERSON_NOUNS.length > 20);
assertTrue('every race term is lowercase', lint.RACE_TERMS.every(t => t === t.toLowerCase()));
assertTrue('every person noun is lowercase', lint.PERSON_NOUNS.every(t => t === t.toLowerCase()));
assertTrue('"black" and "white" are both terms',
    lint.RACE_TERMS.includes('black') && lint.RACE_TERMS.includes('white'));

// ------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });

process.stderr.write(`\n[prompt-lint.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    process.stderr.write(`\nFAILED:\n${failures.map(f => `  - ${f.label}\n    expected ${f.expected}\n    got      ${f.actual}`).join('\n')}\n`);
    process.exit(1);
}
process.stderr.write('ALL PROMPT-LINT CHECKS PASSED\n');
