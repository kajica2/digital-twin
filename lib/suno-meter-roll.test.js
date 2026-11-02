#!/usr/bin/env node
'use strict';
// lib/suno-meter-roll.test.js
//
// The uncommon-meter rolls.
//
// A prompt here is TWO fields — a STYLE BOX and a LYRICS FIELD — and
// the roll is several covers of the house source, each carrying that
// pair.
//
// MEASURED 2026-11-02 on this account, and it is the reason this
// exists at all:
//
//   * A plain text generation is REFUSED. The submit answers with a
//     clip id, the balance does not move (7 -> 7), and the clip's audio
//     URL points at /api/forbidden.
//   * A COVER of an existing track RENDERS, and costs nothing.
//
// So these are made as covers. And on a cover, `override_fields:
// ['prompt','tags']` means the STYLE BOX REPLACES the source's
// descriptor — measured on the workspace's own clips, which carry the
// meter style rather than the source's "Dark jazz electronica" — while
// the lyrics travel in the prompt field.
//
// The house rule for meter prompts is to roll FOUR each: meter tags are
// probability weights, not commands.
//
//   node lib/suno-meter-roll.test.js

const {
    loadPrompts,
    findPrompt,
    coverBody,
    rollPlan,
    LIMITS,
} = require('./suno-meter-roll.js');

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

// 1. The prompts.
process.stderr.write('1. the prompts\n');
const prompts = loadPrompts();
assert('five of them', prompts.length, 5);
assert('Seven Bells is first', prompts[0].name, 'Seven Bells');
assert('found by slug', findPrompt('salt-cathedral').name, 'Salt Cathedral');
assert('found by name', findPrompt('Seven Bells').slug, 'seven-bells');
assert('not found by a wrong name', findPrompt('nope'), null);

// Every prompt carries both fields, and both fit.
for (const p of prompts) {
    assert(`"${p.name}" has a style box`, p.style.length > 0, true);
    assert(`"${p.name}" has a lyrics field`, p.lyrics.length > 0, true);
    assert(`"${p.name}" style fits ${LIMITS.tags}`, p.style.length <= LIMITS.tags, true);
    assert(`"${p.name}" lyrics fit ${LIMITS.prompt}`, p.lyrics.length <= LIMITS.prompt, true);
    assert(`"${p.name}" has a meter`, !!p.meter, true);
    assert(`"${p.name}" has a production note`, !!p.note, true);
}

// The house rule: INSTRUMENTAL by default. Every style box says no
// vocals, and every lyrics field is made of SECTION TAGS — Suno
// invents a singer otherwise.
for (const p of prompts) {
    assert(`"${p.name}" forbids vocals`, /no vocals/.test(p.style), true);
    assert(`"${p.name}" opens with a section tag`, /^\[/.test(p.lyrics.trim()), true);
    // And the piece is instrumental throughout: no line is a sung
    // lyric, they are all directives.
    const sung = p.lyrics.split('\n').filter((l) => l.trim() && !l.trim().startsWith('['));
    assert(`"${p.name}" has no sung lines`, sung.length, 0);
}

// Every lyrics field uses square brackets for its directives.
for (const p of prompts) {
    const bad = p.lyrics.split('\n').filter((l) => l.trim() && !l.trim().startsWith('['));
    assert(`"${p.name}" has only bracketed directives`, bad.length, 0);
}

// The meter is in the STYLE BOX, not only in the tags.
for (const p of prompts) {
    assert(`"${p.name}" puts its meter in the style box`, p.style.includes(p.meter.split(' / ')[0]), true);
}

// 2. The cover body.
process.stderr.write('2. the cover body\n');
const seven = findPrompt('seven-bells');
const body = coverBody({
    prompt: seven,
    sourceClipId: 'src-1',
    sourceDuration: 214.8,
    title: 'Seven Bells',
    workspace: 'ws-1',
    influence: 0.7,
});
assert('it covers the source', body.cover_clip_id, 'src-1');
assert('the task is a cover', body.task, 'cover');
assert('the style box is the style', body.tags, seven.style);
assert('the lyrics field is the prompt', body.prompt, seven.lyrics);
assert('the style box REPLACES the source descriptor', body.override_fields.includes('tags'), true);
assert('the lyrics travel in the prompt', body.override_fields.includes('prompt'), true);
assert('the influence is set', body.metadata.control_sliders.audio_weight, 0.7);
assert('the project is the workspace', body.project_id, 'ws-1');
assert('it runs the source length', body.cover_end_s, 214.8);

// The negative tags close the style box — the house rule.
assert('the negatives are present', body.negative_tags.length > 0, true);

// 3. The roll plan.
process.stderr.write('3. the roll plan\n');
const plan = rollPlan({ prompts: [seven], sourceClipId: 'src-1', sourceDuration: 214.8, workspace: 'ws-1' });
assert('four rolls per prompt', plan.length, 4);
assert('every roll has a distinct title', new Set(plan.map((r) => r.title)).size, 4);
assert('every roll carries the style', plan.every((r) => r.body.tags === seven.style), true);
assert('every roll carries the lyrics', plan.every((r) => r.body.prompt === seven.lyrics), true);
assert('every roll covers the source', plan.every((r) => r.body.cover_clip_id === 'src-1'), true);

// Five prompts at four rolls each.
const all = rollPlan({ prompts, sourceClipId: 's', sourceDuration: 100, workspace: 'w' });
assert('five prompts roll to twenty', all.length, 20);

// A prompt can ask for its own roll count.
const two = rollPlan({ prompts: [seven], roll: 2, sourceClipId: 's', sourceDuration: 1, workspace: 'w' });
assert('the roll count is honoured', two.length, 2);

process.stderr.write(`\n[suno-meter-roll.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
