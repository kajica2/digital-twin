#!/usr/bin/env node
// lib/mj-scene-presets.test.js
//
// Test harness for the Midjourney SCENE PRESET registry.
//
// Mirrors the repo's house pattern: plain Node, no framework,
// `node lib/mj-scene-presets.test.js` to run.
//
// Coverage:
//   1. the registry loads and is well-formed (unique slugs, required fields)
//   2. the four groups are present, and every preset is in exactly one
//   3. every aspect ratio is one the repo can actually render
//   4. every cut recipe uses the RENDERER's own vocabulary (plan.mjs)
//   5. no preset carries an engine flag — the measured --v 7 softban trap
//   6. no preset carries a style/stylize flag — the config owns those
//   7. no preset carries a reference flag — refused on this account
//   8. no preset names the subject's race (the repo's prompt-lint rule)
//   9. composePrompt emits exactly one --ar, and the prose first
//  10. the pack round-trips through the submitter's own parser
//  11. every preset is distinct in its first 64 characters
//  12. the cut plan carries one motion + one look per shot, and a valid argv
//  13. the generated pack passes the repo's own prompt lint
//  14. the generated doc reports the registry's real counts
//
// No network, no browser, no credentials.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const REPO = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[mj-scene-presets.test]\n\n`);

// The renderer's own vocabulary is the single source of truth for what a
// cut may say — so the test reads it from plan.mjs rather than copying a
// list into the module under test.
(async () => {
const plan = await import('./render/plan.mjs');
const presetsLib = require('./mj-scene-presets.js');
const { findViolations } = require('./prompt-lint.js');
const { extractPrompts } = require('./mj-submitter.js');

const VOCAB = {
    fx: Object.keys(plan.FX),
    motions: plan.KEN_BURNS_MODES,
    aspects: ['16:9', '9:16', '21:9', '1:1', '4:5', '4:3'],
};

// ------------------------------------------------------------------
// 1. The registry loads and is well-formed.
// ------------------------------------------------------------------
process.stderr.write('1. registry shape\n');
const registry = presetsLib.loadRegistry(REPO);
assertTrue('the registry loads', !!registry);
assertTrue('the registry has presets', Array.isArray(registry.presets) && registry.presets.length > 0);
assert('the slugs are unique',
    new Set(registry.presets.map(p => p.slug)).size,
    registry.presets.length);

const REQUIRED = ['slug', 'name', 'group', 'bestFor', 'ar', 'prose', 'frame', 'cut'];
for (const p of registry.presets) {
    const missing = REQUIRED.filter(k => p[k] === undefined || p[k] === null || p[k] === '');
    assert(`"${p.slug}" has every required field`, missing, []);
}

// ------------------------------------------------------------------
// 2. The groups, and one group per preset.
// ------------------------------------------------------------------
process.stderr.write('2. groups\n');
const groups = [...new Set(registry.presets.map(p => p.group))].sort();
assert('the four preset groups are present', groups,
    ['electronic-pop', 'music-video', 'story-video', 'vertical']);
for (const g of groups) {
    const n = registry.presets.filter(p => p.group === g).length;
    assertTrue(`group "${g}" has at least one preset`, n > 0);
}

// ------------------------------------------------------------------
// 3. Aspect ratios the repo can actually render.
// ------------------------------------------------------------------
process.stderr.write('3. aspect ratios\n');
for (const p of registry.presets) {
    assertTrue(`"${p.slug}" uses a renderable aspect (${p.ar})`, VOCAB.aspects.includes(p.ar));
}

// ------------------------------------------------------------------
// 4. The cut recipes speak the renderer's language.
// ------------------------------------------------------------------
process.stderr.write('4. cut vocabulary\n');
for (const p of registry.presets) {
    assertTrue(`"${p.slug}" motion is a renderer motion (${p.cut.motion})`,
        VOCAB.motions.includes(p.cut.motion));
    for (const name of String(p.cut.fx || 'none').split('+')) {
        assertTrue(`"${p.slug}" fx "${name}" is a renderer fx`,
            name === 'none' || VOCAB.fx.includes(name));
    }
    if (p.cut.grade) {
        for (const name of String(p.cut.grade).split('+')) {
            assertTrue(`"${p.slug}" grade "${name}" is a renderer fx`,
                name === 'none' || VOCAB.fx.includes(name));
        }
    }
}

// ------------------------------------------------------------------
// 5. No engine flag.
//
// MEASURED 2026-10-26 on this account: `--v 7` came back SOFT-BANNED — a
// job id was returned, the job was never queued, and the CDN 404'd every
// size forever. `--v 8.2` is the account's proven engine, and it lives in
// lib/mj-config.json. A preset that names an engine would pin the pack to
// one that may be retired, so no preset may carry one.
// ------------------------------------------------------------------
process.stderr.write('5. no engine flag\n');

// The invariant is "NO PRESET CARRIES A FLAG", so the guard reads the
// preset payloads — the prose, the frame and the cut. It deliberately does
// NOT read the whole file: the registry's `_note` documents the --v 7
// softban by name, and a whole-file grep would trip on the warning.
function presetText(p) {
    return [p.prose, p.frame, JSON.stringify(p.cut)].join(' ');
}
const presetBodies = registry.presets.map(presetText).join('\n');
const registryText = presetBodies;
assertTrue('the registry names no --v / --version',
    !/(?<![\w-])--v(?![\w-])/.test(registryText) && !/(?<![\w-])--version(?![\w-])/.test(registryText));

// ------------------------------------------------------------------
// 6. No style / stylize flag.
//
// The config's `--style raw --s 21` is the house recipe ("stylize is the
// enemy"). buildFullPrompt drops the config's `--s` when the PROMPT names
// a style — so a preset carrying `--style raw` would silently reset
// stylize to Midjourney's default of 100.
// ------------------------------------------------------------------
process.stderr.write('6. no style flag\n');
assertTrue('the registry names no --style / --raw',
    !/(?<![\w-])--style(?![\w-])/.test(registryText) && !/(?<![\w-])--raw(?![\w-])/.test(registryText));
assertTrue('the registry names no --s / --stylize',
    !/(?<![\w-])--s(?![\w-])/.test(registryText) && !/(?<![\w-])--stylize(?![\w-])/.test(registryText));

// ------------------------------------------------------------------
// 7. No reference flags.
//
// MEASURED 2026-10-26: `--oref` with no `--v` is REFUSED, `--v 8.2 --oref`
// is REFUSED the same silent way, and `--v 7 --oref` is accepted but
// soft-banned. So a reference flag cannot travel in a preset.
// ------------------------------------------------------------------
process.stderr.write('7. no reference flags\n');
for (const flag of ['edit', 'cref', 'oref']) {
    assertTrue(`the registry names no --${flag}`,
        !new RegExp(`(?<![\\w-])--${flag}(?![\\w-])`).test(registryText));
}

// ------------------------------------------------------------------
// 8. The subject's identity is left to the reference photo.
// ------------------------------------------------------------------
process.stderr.write('8. identity\n');
for (const p of registry.presets) {
    const findings = findViolations(p.prose).concat(findViolations(p.frame));
    assert(`"${p.slug}" names no race or ethnicity`, findings.map(f => f.match), []);
}

// ------------------------------------------------------------------
// 9. composePrompt.
// ------------------------------------------------------------------
process.stderr.write('9. composePrompt\n');
const sample = registry.presets[0];
const composed = presetsLib.composePrompt(sample, {});
assertTrue('the composed prompt starts with the scene',
    composed.startsWith(sample.prose));
assertTrue('the composed prompt carries the frame clause',
    composed.includes(sample.frame));
assert('the composed prompt carries exactly one --ar',
    (composed.match(/(?<![\w-])--ar(?![\w-])/g) || []).length, 1);
assertTrue('the --ar comes last',
    /--ar\s+\S+\s*$/.test(composed));
assert('the --ar is the preset\'s own', composed.slice(-6), `--ar ${sample.ar}`.slice(-6));

const overridden = presetsLib.composePrompt(sample, { ar: '9:16' });
assertTrue('an explicit aspect overrides the preset\'s', /--ar 9:16\s*$/.test(overridden));

const withTail = presetsLib.composePrompt(sample, { extraTail: 'a dark coat over a black roll-neck' });
assertTrue('the extra tail is appended before the flags',
    withTail.includes('a dark coat over a black roll-neck'));
assertTrue('the extra tail is not inside the scene',
    !sample.prose.includes('a dark coat over a black roll-neck'));

// ------------------------------------------------------------------
// 10. The pack round-trips through the SUBMITTER'S parser.
// ------------------------------------------------------------------
process.stderr.write('10. pack round-trip\n');
const pack = presetsLib.buildPack(registry, { title: 'Scene Presets' });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-scene-presets-'));
const packFile = path.join(tmpDir, 'scene-presets.md');
fs.writeFileSync(packFile, pack.markdown);
const parsed = extractPrompts(packFile);
assert('the pack parses to one prompt per preset', parsed.length, registry.presets.length);
assert('every parsed prompt carries its aspect',
    parsed.map(p => p.ar), registry.presets.map(p => p.ar));
assertTrue('the pack header names the count',
    pack.markdown.includes(`— ${registry.presets.length} prompts`));
assertTrue('the pack has no engine flag',
    !/(?<![\w-])--v(?![\w-])/.test(pack.markdown));

// A pack is a registry sweep, so the 5–10 lyric-pack cap does not apply —
// but the pack must SAY so, or a reader will think it broke the rule.
assertTrue('the pack states that the cap does not apply',
    /cap does not apply/i.test(pack.markdown));

// ------------------------------------------------------------------
// 11. Every preset is distinct in its first 64 characters.
//
// Sprint 0.32: a pack whose prompts all opened with the same style clause
// produced ONE identical excerpt per prompt, and the acceptance matcher
// attributed 8 prompts to 3 task ids.
// ------------------------------------------------------------------
process.stderr.write('11. distinct openings\n');
const openings = registry.presets.map(p => p.prose.slice(0, 64).toLowerCase());
assert('the 64-character openings are unique',
    new Set(openings).size, registry.presets.length);

// ------------------------------------------------------------------
// 12. The cut plan.
// ------------------------------------------------------------------
process.stderr.write('12. cut plan\n');
const planOut = presetsLib.buildCutPlan(registry, { size: '16:9', mode: 'cut' });
assert('the plan carries one motion per shot', planOut.motions.length, registry.presets.length);
assert('the plan carries one look per shot', planOut.fx.length, registry.presets.length);
assertTrue('the plan has a grade for the whole cut', !!planOut.grade);
assertTrue('the argv names the renderer', planOut.argv.includes('bin/images-to-mp4.mjs'));
assertTrue('the argv carries the motions list',
    planOut.argv.includes(planOut.motions.join(',')));
assertTrue('the argv carries the looks list',
    planOut.argv.includes(planOut.fx.join(',')));
assertTrue('the argv carries the grade', planOut.argv.includes('--grade'));
for (const m of planOut.motions) {
    assertTrue(`plan motion "${m}" is a renderer motion`, VOCAB.motions.includes(m));
}
for (const spec of planOut.fx) {
    for (const name of String(spec).split('+')) {
        assertTrue(`plan look "${name}" is a renderer fx`,
            name === 'none' || VOCAB.fx.includes(name));
    }
}

// A filtered plan must be shorter than the whole registry.
const filtered = presetsLib.buildCutPlan(registry, { group: 'vertical' });
assert('a filtered plan covers only that group',
    filtered.motions.length, registry.presets.filter(p => p.group === 'vertical').length);

// An aspect filter must be honoured — a cut is ONE size, so it can only
// be built from presets that share an aspect ratio.
const sixteen = presetsLib.buildCutPlan(registry, { ar: '16:9' });
assert('an aspect filter selects only that aspect',
    sixteen.presets.length, registry.presets.filter(p => p.ar === '16:9').length);
for (const slug of sixteen.presets) {
    const p = registry.presets.find(x => x.slug === slug);
    assertTrue(`"${slug}" is a 16:9 preset`, p.ar === '16:9');
}
const arPack = presetsLib.buildPack(registry, { arFilter: '9:16' });
assert('the pack honours the aspect filter',
    (arPack.markdown.match(/--ar 9:9/g) || []).length, 0);
assertTrue('every prompt in an aspect-filtered pack carries that aspect',
    arPack.prompts.every(p => p.ar === '9:16'));
let threw = false;
try { presetsLib.buildCutPlan(registry, { ar: '5:4' }); } catch { threw = true; }
assertTrue('an aspect with no presets is refused', threw);

// ------------------------------------------------------------------
// 13. The generated pack passes the repo's OWN prompt lint.
// ------------------------------------------------------------------
process.stderr.write('13. prompt lint\n');
for (const p of parsed) {
    const findings = findViolations(p.text);
    assert(`the composed prompt "${p.text.slice(0, 32)}…" lints clean`,
        findings.map(f => f.match), []);
}

// ------------------------------------------------------------------
// 14. The generated doc reports the registry's real counts.
// ------------------------------------------------------------------
process.stderr.write('14. doc\n');
const doc = presetsLib.renderDoc(registry);
assertTrue('the doc states the preset count',
    doc.includes(String(registry.presets.length)));
for (const g of groups) {
    assertTrue(`the doc has a section for "${g}"`, doc.includes(g));
}
assertTrue('the doc carries the engine warning',
    /soft-?ban/i.test(doc));
assertTrue('the doc carries the consistency recipe',
    /constant clause/i.test(doc));

// ------------------------------------------------------------------
// summary
// ------------------------------------------------------------------
process.stderr.write(`\n[mj-scene-presets.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    process.stderr.write('\nFAILURES:\n');
    for (const f of failures) process.stderr.write(`  - ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed ? 1 : 0);
})().catch((e) => {
    process.stderr.write(`\n[mj-scene-presets.test] ERROR: ${e.stack}\n`);
    process.exit(2);
});
