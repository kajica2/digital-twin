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
const REPO = path.resolve(__dirname, '..');
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

// 7b. --sref is resolved exactly once, like --ar.
//
// 2026-10-21: the config gained a default `--sref 6965361632` so every
// generation inherits one style reference. Appending it blindly would
// produce `--sref <prompt's own> --sref 6965361632` for any prompt that
// names its own reference — and MJ, like --ar, honours the last one. So the
// default has to be dropped when the prompt carries its own.
process.stderr.write(`7b. buildFullPrompt — single --sref\n`);
const SREF_DEFAULTS = '--ar 16:9 --raw --profile mhw6dpq --stylize 0 --sref 6965361632';
const countSref = (s) => (s.match(/--sref\s+\S+/g) || []).length;
// Flag-only counters: they count the FLAG itself, so a valueless
// `--sref` (the author forgot the id) is counted too. The flag+value
// counter above cannot see that case.
const countSrefFlag = (s) => (s.match(/--sref(?=\s|$)/g) || []).length;
const countArFlag = (s) => (s.match(/--ar(?=\s|$)/g) || []).length;

let s1 = submitter.buildFullPrompt('a trumpet at dawn', '16:9', SREF_DEFAULTS);
assert('exactly one --sref', countSref(s1), 1);
assertTrue('keeps the default sref', s1.includes('--sref 6965361632'));
assertTrue('keeps the other default params',
    s1.includes('--raw') && s1.includes('--profile mhw6dpq') && s1.includes('--stylize 0'));
assert('ar still last', s1.slice(s1.indexOf('--ar')).startsWith('--ar 16:9'), true);

// A prompt naming its own --sref wins; the default's copy is dropped.
let s2 = submitter.buildFullPrompt('x --sref 1234567890', '16:9', SREF_DEFAULTS);
assert('still exactly one --sref', countSref(s2), 1);
assertTrue('prompt sref preserved', s2.includes('--sref 1234567890'));
assertTrue('default sref dropped', !s2.includes('--sref 6965361632'));

// No defaults at all -> no --sref invented.
let s3 = submitter.buildFullPrompt('x', '16:9', '');
assert('no sref invented', countSref(s3), 0);

// Defaults without an --sref are untouched by the new logic.
let s4 = submitter.buildFullPrompt('x', '16:9', '--style raw --s 250');
assert('no sref from sref-less defaults', countSref(s4), 0);
assertTrue('style defaults intact', s4.includes('--style raw') && s4.includes('--s 250'));

// The shipped config's own defaultArgs resolve cleanly.
//
// The DEFAULT FIXTURE is used here, not lib/mj-config.json. The contract
// under test is "a defaults string carrying one --sref yields one
// --sref" — a property of buildFullPrompt, not of whatever the config
// file happens to contain this week. (An earlier version of this test
// read the shipped config and asserted its literal --sref id and flags;
// the config's defaultArgs are artistic choices that change — --s 21
// replaced the style block on 2026-10-18 — and pinning them turned a
// config edit into a test failure that said nothing about the code.)
const shipCfg = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'mj-config.json'), 'utf8'));
let s5 = submitter.buildFullPrompt('a trumpet at dawn', '16:9', SREF_DEFAULTS);
assert('defaults with one --sref yield one --sref', countSref(s5), 1);
assertTrue('the defaults --sref survives', s5.includes('--sref 6965361632'));
// The shipped config is still exercised — it must not CRASH the builder,
// whatever it contains.
assertTrue('the shipped config resolves without throwing',
    typeof submitter.buildFullPrompt('a trumpet at dawn', '16:9', shipCfg.mj.defaultArgs) === 'string');

// 7b-bis. A VALUELESS --sref in the prompt.
//
// The guard used to be /--sref\s+\S+/ — it required a value after the
// flag. A prompt ending in a bare `--sref` (the author forgot the id)
// was therefore NOT detected, and the config default was emitted
// alongside it: two --sref flags, and MJ honours the last one, so the
// config default silently overrode the author's intent.
//
// The guard now matches the FLAG, with a boundary so `--srefs 1` does
// not match.
let v1 = submitter.buildFullPrompt('a face --sref', '16:9', SREF_DEFAULTS);
assert('valueless prompt --sref → one --sref', countSrefFlag(v1), 1);
assertTrue('the config default is not emitted alongside it', !v1.includes('--sref 6965361632'));
assertTrue('the prompt\'s own --sref survives', v1.includes('--sref'));

// A valueless --sref followed by another flag is the same case.
let v2 = submitter.buildFullPrompt('a face --sref --raw', '16:9', SREF_DEFAULTS);
assert('valueless prompt --sref before another flag → one --sref', countSrefFlag(v2), 1);
assertTrue('the config default is not emitted alongside it', !v2.includes('--sref 6965361632'));

// The flag boundary: `--srefs` is a different flag and must not count.
let v3 = submitter.buildFullPrompt('x --srefs 1', '16:9', SREF_DEFAULTS);
assert('--srefs is not a --sref', countSrefFlag(v3), 1);
assertTrue('the default sref survives when only --srefs is present', v3.includes('--sref 6965361632'));

// The same rule applies to --ar: a bare `--ar` in the prompt owns the
// flag, so the ratio must not be emitted alongside it.
let v4 = submitter.buildFullPrompt('a face --ar', '16:9', DEFAULTS);
assert('valueless prompt --ar → one --ar', countArFlag(v4), 1);
assertTrue('no ratio is emitted alongside the prompt\'s own --ar', !v4.includes('--ar 3:4'));

// A prompt with a real --ar still wins (unchanged behaviour).
let v5 = submitter.buildFullPrompt('x --ar 1:1', '16:9', DEFAULTS);
assert('prompt --ar with a value → one --ar', countArFlag(v5), 1);
assertTrue('the prompt ratio is kept', v5.includes('--ar 1:1'));

// Free text in defaultArgs is preserved. The segment rebuild used to
// drop anything before the first flag.
let v6 = submitter.buildFullPrompt('x', '16:9', 'cinematic --ar 16:9 --raw');
assertTrue('free text before the first flag survives', v6.includes('cinematic'));
assertTrue('the flags survive too', v6.includes('--raw') && v6.includes('--ar 16:9'));

// 7b-ter. --s and --raw are resolved exactly once, like --ar and --sref.
//
// The same failure class twice over:
//   * `--raw` is MJ v5+'s alias for `--style raw`. A prompt carrying
//     `--raw` owns the style slot, so the config's `--style raw` must
//     not be appended alongside it.
//   * `--s` is the stylize amount. The config's `--s 250` is paired
//     with its `--style raw`; a prompt carrying its own `--s` must not
//     have the config's appended after it, because MJ honours the
//     LAST --s and the config would silently override the artist.
const countSFlag = (s) => (s.match(/--s(?=\s|$)/g) || []).length;
const countStyleFlag = (s) => (s.match(/--style(?=\s|$)/g) || []).length;

// The config's style block: --style raw + --s 250, as shipped.
const STYLE_DEFAULTS = '--style raw --s 250';

// A prompt carrying --raw: the config's --style raw is dropped, and
// with it the --s 250 that was paired with it.
let r1 = submitter.buildFullPrompt('a face --raw', '16:9', STYLE_DEFAULTS);
assert('prompt --raw → no duplicate --style', countStyleFlag(r1), 0);
assert('prompt --raw → no duplicate --s', countSFlag(r1), 0);

// A prompt carrying --style: same.
let r2 = submitter.buildFullPrompt('a face --style custom', '16:9', STYLE_DEFAULTS);
assert('prompt --style → no duplicate --style', countStyleFlag(r2), 1);
assert('prompt --style → no duplicate --s', countSFlag(r2), 0);
assertTrue('the prompt\'s own style survives', r2.includes('--style custom'));

// A prompt carrying its own --s (and no --style): the config's --s is
// dropped, the prompt's survives.
let r3 = submitter.buildFullPrompt('a face --s 50', '16:9', STYLE_DEFAULTS);
assert('prompt --s → one --s', countSFlag(r3), 1);
assertTrue('the prompt\'s own --s survives', r3.includes('--s 50'));
assertTrue('the config\'s --s 250 is dropped', !r3.includes('--s 250'));

// A prompt with NO style and NO --s of its own: the config's style
// block is left intact — the defaults still apply.
let r4 = submitter.buildFullPrompt('a face', '16:9', STYLE_DEFAULTS);
assert('no prompt style → the config style survives', countStyleFlag(r4), 1);
assert('no prompt --s → the config --s survives', countSFlag(r4), 1);
assertTrue('the config --s 250 survives', r4.includes('--s 250'));

// The flag boundary: `--sref`/`--style` are not `--s`.
let r5 = submitter.buildFullPrompt('x --srefs 1', '16:9', STYLE_DEFAULTS);
assert('--srefs is not an --s', countSFlag(r5), 1);

// 7b. The three combinations the 2026-10-21 red-coat pack exercised.
//
// The pack's prompts each carried `--s 100 --raw` while the config
// defaultArgs carried `--style raw --s 21`. Before the fix the composed
// prompt carried BOTH `--s 100` and the config's `--s 21` — and MJ
// honours the LAST --s, so the config silently overrode the artist's
// chosen stylization. The three shapes:
//
//   prompt has --s AND --raw   → prompt's --s wins, config's --s dropped
//   prompt has --s only        → prompt's --s wins, config's --style kept
//   prompt has --raw only      → config's --style kept, config's --s dropped
const CONFIG_STYLE_DEFAULTS = '--ar 16:9 --style raw --s 21';

let u1 = submitter.buildFullPrompt('a figure --s 100 --raw', '16:9', CONFIG_STYLE_DEFAULTS);
assert('prompt --s + --raw → one --s', countSFlag(u1), 1);
assertTrue('the prompt\'s --s 100 survives', u1.includes('--s 100'));
assertTrue('the config\'s --s 21 is dropped', !u1.includes('--s 21'));
assert('prompt --s + --raw → no duplicate --style', countStyleFlag(u1), 0);

let u2 = submitter.buildFullPrompt('a figure --s 100', '16:9', CONFIG_STYLE_DEFAULTS);
assert('prompt --s only → one --s', countSFlag(u2), 1);
assertTrue('the prompt\'s --s 100 survives', u2.includes('--s 100'));
assertTrue('the config\'s --s 21 is dropped', !u2.includes('--s 21'));
assert('prompt --s only → the config style survives', countStyleFlag(u2), 1);

let u3 = submitter.buildFullPrompt('a figure --raw', '16:9', CONFIG_STYLE_DEFAULTS);
assert('prompt --raw only → no duplicate --style', countStyleFlag(u3), 0);
assert('prompt --raw only → the config --s is dropped', countSFlag(u3), 0);
assertTrue('no --s 21 leaks through', !u3.includes('--s 21'));

// 7c. The mj-web.js composition — the defaults string carries TWO --sref
// flags (the config default plus the user's --sref-url fragment).
//
// lib/mj-web.js builds DEFAULT_ARGS_EFF as `config defaultArgs` + the
// user's ref fragments, so the string handed to buildFullPrompt already
// contains `--sref 6965361632 --sref https://…`. The old code only
// stripped the default's copy when the PROMPT carried a --sref, so the
// mj-web path emitted two flags and MJ silently took the wrong one.
//
// Precedence (documented in buildFullPrompt): a --sref in the prompt text
// wins outright; otherwise the LAST --sref in the defaults string wins —
// which is the user's, because mj-web appends the user fragment after the
// config default. The config default is never emitted alongside it.
process.stderr.write(`7c. buildFullPrompt — two --sref in the defaults string\n`);
const TWO_SREF_DEFAULTS = SREF_DEFAULTS
    + ' --cref https://d.uguu.se/user-choice.jpg --cw 100'
    + ' --sref https://d.uguu.se/user-choice.jpg --sw 100';

let t1 = submitter.buildFullPrompt('a trumpet at dawn', '16:9', TWO_SREF_DEFAULTS);
assert('two-sref defaults → one --sref', countSref(t1), 1);
assertTrue('the user sref wins', t1.includes('--sref https://d.uguu.se/user-choice.jpg'));
assertTrue('the config default sref is dropped', !t1.includes('--sref 6965361632'));
assertTrue('the other default params survive',
    t1.includes('--raw') && t1.includes('--profile mhw6dpq') && t1.includes('--stylize 0'));
assertTrue('the ref fragments survive',
    t1.includes('--cref https://d.uguu.se/user-choice.jpg') && t1.includes('--cw 100') && t1.includes('--sw 100'));
assert('ar still last', t1.slice(t1.indexOf('--ar')).startsWith('--ar 16:9'), true);

// The prompt's own --sref beats BOTH defaults copies.
let t2 = submitter.buildFullPrompt('x --sref 1234567890', '16:9', TWO_SREF_DEFAULTS);
assert('two-sref defaults + prompt sref → one --sref', countSref(t2), 1);
assertTrue('prompt sref preserved', t2.includes('--sref 1234567890'));
assertTrue('neither default sref survives',
    !t2.includes('--sref 6965361632') && !t2.includes('--sref https://d.uguu.se/user-choice.jpg'));

// A --sref carrying SEVERAL values (MJ accepts a list) keeps them together
// on the single surviving flag — the values must not be orphaned.
let t3 = submitter.buildFullPrompt('x', '16:9', '--sref https://a.example/1.jpg https://b.example/2.jpg');
assert('one --sref for a multi-value sref', countSref(t3), 1);
assertTrue('both sref values kept on the flag',
    t3.includes('--sref https://a.example/1.jpg https://b.example/2.jpg'));

// A --sref in the prompt keeps its own values and still wins outright.
let t4 = submitter.buildFullPrompt('x --sref https://a.example/1.jpg https://b.example/2.jpg', '16:9', TWO_SREF_DEFAULTS);
assert('prompt multi-value sref → one --sref', countSref(t4), 1);
assertTrue('prompt sref values kept',
    t4.includes('--sref https://a.example/1.jpg https://b.example/2.jpg'));

// 8. The composed prompt for a real extracted pack is unambiguous.
process.stderr.write(`8. end-to-end prompt composition\n`);
const composed = ps.map(p => submitter.buildFullPrompt(p.text, p.ar, DEFAULTS));
assertTrue('every composed prompt has exactly one --ar',
    composed.every(c => countAr(c) === 1));
assertTrue('every composed prompt asks for 16:9',
    composed.every(c => c.includes('--ar 16:9')));
assertTrue('none leak the config ratio',
    composed.every(c => !c.includes('--ar 3:4')));

// 9. Blockquotes are ignored at ANY indent depth. Regression: the
// parser only matched column-zero `>`, so an indented `> Tune:` note
// under a bullet (natural markdown) fell through to the continuation
// branch and leaked into the submitted prompt — caught 2026-09-30 on
// the source-frames-10days pack. Pin both shapes.
process.stderr.write(`9. blockquotes ignored at any indent\n`);
const bqFile = path.join(TEST_DIR, 'blockquotes.md');
fs.writeFileSync(bqFile, [
    '# Pack (16:9)',
    '> Source: top-level note, must be ignored',
    '',
    '- Extreme close-up of a wet fern frond, one ant at the lower-left edge of frame --ar 16:9',
    '  > Tune: indented note, must also be ignored (was leaking pre-fix)',
    '',
    '- A brutalist corridor at dusk, a figure walking toward camera --ar 16:9',
    '> Tune: column-zero note between prompts, ignored',
    '',
    '- A porcelain teacup floating in a dark room, a wisp of steam --ar 1:1',
    '```text',
    '> tune inside a code fence, ignored',
    '```',
    '',
].join('\n'));
const bq = submitter.extractPrompts(bqFile);
assert('blockquote file yields 3 prompts', bq.length, 3);
assertTrue('indented tune note not in prompt 1', !bq[0].text.includes('Tune'));
assertTrue('column-zero tune not in prompt 2', !bq[1].text.includes('Tune'));
assertTrue('code-fence tune not in prompt 3', !bq[2].text.includes('Tune'));
assertTrue('prompt 1 text is clean', bq[0].text === 'Extreme close-up of a wet fern frond, one ant at the lower-left edge of frame');
assert('prompt 3 ar survives', bq[2].ar, '1:1');

// Cleanup
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[mj-submitter.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) {
        process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
}
process.exit(failed === 0 ? 0 : 1);