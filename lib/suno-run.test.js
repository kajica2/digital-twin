#!/usr/bin/env node
'use strict';
// lib/suno-run.test.js
//
// Tests for the generation body the Suno runner submits.
//
// The body shape was NOT guessed. `POST /api/generate/v2-web/` validates
// against a pydantic model and returns that model's schema in its 422
// body, so the field names and the accepted `task` literals are ground
// truth. Two facts this file pins, both learned from real 422s:
//
//   * The body is FLAT. A nested `{ params: {...} }` envelope is
//     rejected — `params` is the pydantic MODEL's name in the 422
//     `loc`, not a field the endpoint reads.
//   * `duration` must be an INTEGER. The reference song reports 198.4
//     seconds; sending that fraction returns 422 `int_from_float`.
//
// The settings that actually shape a "style variant" are also pinned
// here, because a drift in any of them turns a variation of the
// reference song into a different song:
//
//   * task            cover      (it must cover the uploaded source)
//   * cover_clip_id   the source clip
//   * mv              chirp-hawk (v6)
//   * control_sliders.audio_weight  the protocol's influence value
//
//   node lib/suno-run.test.js

const { buildBody } = require('./suno-run.js');

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

process.stderr.write(`\n[suno-run.test]\n\n`);

const VARIANT = {
    preset: 'Absolute Fidelity Lock',
    title: 'KO TO TAMO VERA - Absolute Fidelity Lock',
    tags: 'Preserve the reference exactly. Ethio-jazz, instrumental;',
    influenceValue: 0.92,
};

const body = buildBody({
    variant: VARIANT,
    sourceClipId: '6f21bff8-4734-47e3-9f76-a14b7f45f4e8',
    duration: 198.4,
    sourceEnd: 22.362229166666665,
});

// ---------- 1. the flat shape ----------

assertTrue('the body is flat — no nested params envelope',
    body.params === undefined);
assert('the task is "cover"', body.task, 'cover');
assert('the model is v6 (chirp-hawk)', body.mv, 'chirp-hawk');
assert('the source clip is the cover_clip_id',
    body.cover_clip_id, '6f21bff8-4734-47e3-9f76-a14b7f45f4e8');
assert('the cover starts at zero', body.cover_start_s, 0);
assert('the cover ends at the source length', body.cover_end_s, 22.362229166666665);
assert('the prompt is the instrumental marker', body.prompt, '[Instrumental]');
assert('the generation is instrumental', body.make_instrumental, true);
assert('the tags are the variant tags', body.tags, VARIANT.tags);
assert('the title is the variant title', body.title, VARIANT.title);
assert('the negative tags are empty', body.negative_tags, '');

// ---------- 2. duration must be an integer ----------

assert('the duration is an integer', Number.isInteger(body.duration), true);
assert('the duration is the reference song length, rounded', body.duration, 198);
assertTrue('the rounding never loses more than half a second',
    Math.abs(body.duration - 198.4) <= 0.5);

// ---------- 3. the influence reaches the control slider ----------

assert('the influence is the audio weight',
    body.metadata.control_sliders.audio_weight, 0.92);
assert('weirdness is pinned to zero',
    body.metadata.control_sliders.weirdness_constraint, 0);
assert('aug creativity is pinned to one',
    body.metadata.control_sliders.aug_creativity, 1);
assert('the run is in max mode', body.metadata.is_max_mode, true);
assert('the client path is the create page', body.metadata.web_client_pathname, '/create');
assert('the create mode is custom', body.metadata.create_mode, 'custom');

// ---------- 4. the transaction is unique per submission ----------

assertTrue('a transaction uuid is present', typeof body.transaction_uuid === 'string' && body.transaction_uuid.length > 30);
const second = buildBody({
    variant: VARIANT,
    sourceClipId: '6f21bff8-4734-47e3-9f76-a14b7f45f4e8',
    duration: 198.4,
    sourceEnd: 22.36,
});
assertTrue('each submission gets its own transaction uuid',
    body.transaction_uuid !== second.transaction_uuid);

// ---------- 5. two variants differ only where they should ----------

const other = buildBody({
    variant: { ...VARIANT, title: 'KO TO TAMO VERA - Other', influenceValue: 0.85 },
    sourceClipId: '6f21bff8-4734-47e3-9f76-a14b7f45f4e8',
    duration: 198.4,
    sourceEnd: 22.36,
});
assert('the influence of the second variant is its own',
    other.metadata.control_sliders.audio_weight, 0.85);
assert('the source clip is unchanged between variants',
    other.cover_clip_id, body.cover_clip_id);
assert('the model is unchanged between variants', other.mv, body.mv);

// ---------- report ----------

process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
    failures.forEach(f => process.stderr.write(`  FAILED: ${f.label}\n`));
    process.exit(1);
}
