#!/usr/bin/env node
'use strict';
// lib/suno-post-humanize.test.js
//
// The POST-SUBMIT humanize preset.
//
// WHAT "POST-SUBMIT" MEANS HERE
//
// A track has already been submitted and rendered. Now the humanize
// layer is applied to it: the clip's OWN style (the one Suno came back
// with) is composed with the raw suffix, and the clip is re-covered
// with that.
//
// MEASURED 2026-11-02, the two halves of the operation:
//
//   * The clip's own style is in `metadata.tags` — and it is Suno's
//     PARAPHRASE of what was sent, not the sent text. The clip comes
//     back with, say, "raw two-track concert-hall recording with room
//     reflections, audible breaths, tape wobble, bleed, dry close-mic
//     room tone and unquantized timing" where the request said
//     "Recorded live to two-track in a natural concert hall, authentic
//     room reflections, audible breathing, loose human timing".
//
//   * A cover of an EXISTING clip renders and costs nothing (a plain
//     generation is refused on this account). So the post-submit
//     operation is a COVER — of the submitted clip itself, with
//     `cover_clip_id` naming the submitted clip.
//
// That matters: the post-submit pass uses the clip's OWN style — the
// paraphrase Suno actually used — rather than the style we sent. So it
// humanizes what the track IS, not what we asked for.
//
//   node lib/suno-post-humanize.test.js

const {
    postSubmitBody,
    postSubmitPlan,
    buildTitle,
    LIMITS,
} = require('./suno-post-humanize.js');
const { humanizeFields } = require('./suno-humanize.js');

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

// The shape of a submitted clip, measured.
const SUBMITTED = {
    id: 'fe1d5108-4249-4026-8ef9-f87c18d1f6cb',
    title: 'Nordic Modern Jazz Big Band',
    status: 'complete',
    metadata: {
        tags: 'Modal jazz, restrained medium pace around 105 BPM, instrumental; raw two-track concert-hall recording with room reflections, audible breaths, tape wobble, bleed, dry close-mic room tone and unquantized timing. A 16-piece acoustic ensemble shapes alternating 4/4 and 7/8 phrases with subtle rhythmic displacement.',
        prompt: '[Intro | 0:00-0:35 | The Empty Hall — Solo piano]',
        duration: 198,
        make_instrumental: true,
        has_vocal: false,
        cover_clip_id: '1443a36e-116f-4d6d-8c97-09f4a5dc3041',
        edited_clip_id: '1443a36e-116f-4d6d-8c97-09f4a5dc3041',
        task: 'cover',
    },
};

// 1. The body.
process.stderr.write('1. the body\n');
const body = postSubmitBody({
    clip: SUBMITTED,
    suffix: 'raw',
    workspace: 'ws-1',
    title: 'Nordic Modern Jazz Big Band (Raw)',
    influence: 0.8,
});

assert('it covers the SUBMITTED clip, not the source', body.cover_clip_id, SUBMITTED.id);
assert('the task is a cover', body.task, 'cover');
assert('the style is the clip own style with the raw layer', body.tags.includes('raw unprocessed recording'), true);
assert('it keeps the clip own descriptor', body.tags.includes('unquantized timing'), true);
assert("the lyrics travel", body.prompt, SUBMITTED.metadata.prompt);
assert('the style REPLACES (override_fields)', body.override_fields, ['prompt', 'tags']);
assert('the project is the workspace', body.project_id, 'ws-1');
assert('the influence is set', body.metadata.control_sliders.audio_weight, 0.8);
assert("it runs the clip length", body.cover_end_s, 198);
assert('it is instrumental', body.make_instrumental, true);
assert('the style fits the tag limit', body.tags.length <= LIMITS.tags, true);
assert('the negatives fit their limit', body.negative_tags.length <= LIMITS.negative_tags, true);

// The exclusions ride in the negative field.
assert('the exclusions are in the negative field', /no autotune/.test(body.negative_tags), true);

// 2. The title.
process.stderr.write('2. the title\n');
assert('it is the name plus the suffix', buildTitle('Nordic Modern Jazz Big Band', 'raw'), 'Nordic Modern Jazz Big Band (Raw)');
assert('it fits the title limit', buildTitle('x'.repeat(200), 'raw').length <= LIMITS.title, true);
assert('it keeps the suffix when the name is long', buildTitle('x'.repeat(200), 'raw').includes('Raw'), true);

// 3. The plan.
process.stderr.write('3. the plan\n');
const plan = postSubmitPlan({
    clips: [SUBMITTED],
    suffix: 'raw',
    workspace: 'ws-1',
});
assert('one entry per clip', plan.length, 1);
assert('it carries the title', plan[0].title, 'Nordic Modern Jazz Big Band (Raw)');
assert('it carries the body', plan[0].body.cover_clip_id, SUBMITTED.id);

// A clip with no style at all still gets the suffix — it is the point.
const bare = postSubmitPlan({
    clips: [{ id: 'bare-1', title: 'Bare', metadata: { duration: 100 } }],
    suffix: 'raw',
    workspace: 'ws-1',
});
assert('a clip with no style gets the raw layer', bare[0].body.tags.includes('raw unprocessed recording'), true);
assert('a clip with no style has no lyrics', bare[0].body.prompt, '[Instrumental]');

// A clip with no duration gets the max-mode length.
const noDur = postSubmitPlan({
    clips: [{ id: 'nd-1', title: 'No Duration', metadata: { tags: 'x' } }],
    suffix: 'raw',
    workspace: 'ws-1',
});
assert('no duration means the max-mode length', noDur[0].body.cover_end_s, 198);

// 4. The composition is the humanize layer's, unchanged.
process.stderr.write('4. the composition comes from the humanize layer\n');
const h = humanizeFields({ descriptor: SUBMITTED.metadata.tags, suffix: 'raw' });
assert('the style is exactly what the humanize layer composes', body.tags, h.style);
assert('the negatives are exactly what the humanize layer gives', body.negative_tags, h.negativeTags);

process.stderr.write(`\n[suno-post-humanize.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
