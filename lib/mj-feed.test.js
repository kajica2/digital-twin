#!/usr/bin/env node
'use strict';
// lib/mj-feed.test.js
//
// Tests for the feed-gated matcher — the pure half of lib/mj-feed.js.
//
// The interesting assertions use REAL commands captured from the live
// Midjourney feed on 2026-10-21, including the four failure modes this
// module exists to catch:
//
//   - a job whose command carries our prompt but is an `--edit` job
//     (the owner's stale attachment leaked into our submission)
//   - a job whose command carries our prompt but was enqueued with the
//     UI's `--ar 4:3 --stylize 0` instead of our `--ar 16:9 --s 100`
//   - a video job (the owner's animation of our result)
//   - the account owner's own concurrent jobs, whose prose is unrelated
//
//   node lib/mj-feed.test.js

const f = require('./mj-feed.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: a, expected: e });
           process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`); }
}
function assertTrue(label, cond, detail) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: String(detail || false), expected: 'true' });
           process.stderr.write(`  ✗ ${label}${detail ? ` — ${detail}` : ''}\n`); }
}

process.stderr.write(`\n[mj-feed.test]\n\n`);

// ---------------------------------------------------------------------------
// Real commands captured from the live feed (2026-10-21).
// ---------------------------------------------------------------------------
const PROMPT_3 = 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, dutch tilt three-quarter view, gritty neo-noir 35mm, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text  --s 100 --raw --hd --v 8.2 --no text, watermark, logo --ar 16:9';

const JOB_3 = {
    id: '9934d6c9-8ee0-47da-9355-77e940aa5870',
    enqueue_time: '2026-10-21T10:38:49.020758+00:00',
    job_type: 'v8-2_hd_diffusion',
    full_command: 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, dutch tilt three-quarter view, gritty neo-noir 35mm, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text --no text, watermark, logo --ar 16:9 --raw --profile brvazka mhw6dpq xr39csb ouy9tof --hd --v 8.2',
    batch_size: 4,
};

// The SAME prompt, submitted as an EDIT because the composer still
// carried the account owner's uploaded image.
const JOB_5_EDIT = {
    id: 'e3376fb9-1111-2222-3333-444455556666',
    enqueue_time: '2026-10-21T10:41:19.168301+00:00',
    job_type: 'v8-2_edit_diffusion',
    full_command: 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, long 85mm compression from across the tunnel, formal fine-art 35mm, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text --no text, watermark, logo --ar 16:9 --raw --profile brvazka mhw6dpq xr39csb ouy9tof --edit https://s.mj.run/aJmtyQitDNA --hd --v 8.2',
    batch_size: 4,
};

// The SAME prompt, enqueued with the WEB UI's aspect + stylize instead
// of the ones we typed.
const JOB_5_UI_DRIFT = {
    id: 'afe8e8ab-1111-2222-3333-444455556666',
    enqueue_time: '2026-10-21T10:43:23.751492+00:00',
    job_type: 'v8-2_hd_diffusion',
    full_command: 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, long 85mm compression from across the tunnel, formal fine-art 35mm, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text --ar 4:3 --raw --profile brvazka mhw6dpq xr39csb det21e6 67lkfw3 --stylize 0 --hd --v 8.2',
    batch_size: 4,
};

// The owner's own concurrent job — completely unrelated prose.
const JOB_OWNER = {
    id: 'aaaa1111-bbbb-2222-cccc-333344445555',
    enqueue_time: '2026-10-21T10:40:00.000000+00:00',
    job_type: 'v8-2_hd_diffusion',
    full_command: 'three people pose for a sunny outdoor selfie near a street, the person taking the photo on the left is a man with short dark hair --ar 4:3 --raw --profile brvazka --hd --v 8.2',
    batch_size: 4,
};

// The owner's animation of one of our results — same prompt text, but a
// video job, so unusable as a still.
const JOB_VIDEO = {
    id: 'b69c2d3f-1111-2222-3333-444455556666',
    enqueue_time: '2026-10-21T10:58:17.532403+00:00',
    job_type: 'vid_1.1_i2v_start_end_b_video',
    full_command: 'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, behind the shoulder of the figure, tunnel vanishing point, quiet Japanese 35mm realism, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text --ar 184:103 --motion low --raw --video 1 --end loop',
    batch_size: 4,
};

// ---------------------------------------------------------------------------
process.stderr.write(`1. prose extraction\n`);
// Midjourney re-serialises the command: it moves `--no text, watermark,
// logo` ahead of `--ar 16:9` and appends `--profile …` of its own. The
// prose must come out identical on both sides.
assert('prose is the text before the first parameter',
    f.proseOf(JOB_3.full_command),
    'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, dutch tilt three-quarter view, gritty neo-noir 35mm, one overhead sodium streetlight as the only key, wet floor catching thin reflections, deep unlit tunnel falling away behind, 35mm lens wide open, fine natural film grain, muted palette, no text');
assert('the --no list does not leak into the prose',
    f.proseOf(JOB_3.full_command).includes('watermark'), false);
assert('prose of our own composed prompt matches the feed copy',
    f.proseOf(PROMPT_3), f.proseOf(JOB_3.full_command));
assert('whitespace is collapsed',
    f.proseOf('a   drum\n\tskin    stretched   taut'), 'a drum skin stretched taut');
assert('em dash is normalised',
    f.proseOf('a window — chipped mug'), 'a window chipped mug');

// ---------------------------------------------------------------------------
process.stderr.write(`2. flag parsing\n`);
assert('aspect is read',
    f.commandAspect(JOB_3.full_command), '16:9');
assert('UI-drifted aspect is read as 4:3',
    f.commandAspect(JOB_5_UI_DRIFT.full_command), '4:3');
assert('--s is folded onto --stylize',
    f.parseFlags('x --s 100 --raw').stylize, '100');
assert('--stylize is read',
    f.parseFlags('x --stylize 250').stylize, '250');
assert('a valueless flag is true',
    f.parseFlags('x --raw').raw, true);
assert('the last duplicate flag wins',
    f.parseFlags('x --ar 16:9 --ar 4:3').ar, '4:3');
assert('an --edit command is an edit',
    f.commandIsEdit(JOB_5_EDIT.full_command), true);
assert('a plain generation is not an edit',
    f.commandIsEdit(JOB_3.full_command), false);

// ---------------------------------------------------------------------------
process.stderr.write(`3. plain-job classification\n`);
assert('hd_diffusion is plain', f.isPlainJob(JOB_3), true);
assert('edit_diffusion is not plain', f.isPlainJob(JOB_5_EDIT), false);
assert('inpaint is not plain', f.isPlainJob({ job_type: 'v8-2_inpaint_edit_diffusion' }), false);
assert('video is not plain', f.isPlainJob(JOB_VIDEO), false);
assert('variation is not plain', f.isPlainJob({ job_type: 'v8-2_variation_diffusion' }), false);
assert('upsample is not plain', f.isPlainJob({ job_type: 'v8-2_upsample_diffusion' }), false);
assert('a job with no type is not plain', f.isPlainJob({ job_type: '' }), false);
assert('null is not plain', f.isPlainJob(null), false);

// The regression this block exists for: a hardcoded whitelist of job
// types could not recognise a job type it had never seen, so a v6.1 /
// Niji batch was rejected as "not a plain generation" AFTER Midjourney
// had accepted and billed for it — and the caller re-submitted every
// prompt. Measured 2026-10-25: 10 prompts became 15 generations.
assert('v6-1_raw_diffusion is plain',
    f.isPlainJob({ job_type: 'v6-1_raw_diffusion' }), true);
assert('v6_raw_diffusion_anime is plain (Niji)',
    f.isPlainJob({ job_type: 'v6_raw_diffusion_anime' }), true);
assert('a v7 raw generation is plain',
    f.isPlainJob({ job_type: 'v7_raw_diffusion' }), true);
assert('an unseen future version is still plain',
    f.isPlainJob({ job_type: 'v9-1_hd_diffusion' }), true);
assert('a v6.1 EDIT is still not plain',
    f.isPlainJob({ job_type: 'v6-1_edit_diffusion' }), false);
assert('a DRAFT generation is not plain',
    f.isPlainJob({ job_type: 'v8-2_draft_bs24_diffusion' }), false);
assert('a video generation is not plain',
    f.isPlainJob({ job_type: 'v8-2_video_diffusion' }), false);
assert('a type with no "diffusion" is not plain',
    f.isPlainJob({ job_type: 'v8-2_upscale' }), false);

// ---------------------------------------------------------------------------
process.stderr.write(`4. prompt identity\n`);
assert('the true job carries our prompt',
    f.commandMatchesPrompt(JOB_3.full_command, PROMPT_3), true);
assert('an unrelated job does not',
    f.commandMatchesPrompt(JOB_OWNER.full_command, PROMPT_3), false);
assert('a different variant of the pack does not',
    f.commandMatchesPrompt(
        'a lone figure in a saturated red coat standing three-quarter turned in an empty concrete underpass at night, extreme symmetry, centered one-point perspective, architectural 35mm, one overhead sodium streetlight as the only key',
        PROMPT_3), false);
assert('a leading image url is tolerated',
    f.commandMatchesPrompt(
        'https://s.mj.run/AMipmi7y19w ' + f.proseOf(PROMPT_3),
        PROMPT_3), true);

// ---------------------------------------------------------------------------
process.stderr.write(`5. flag fidelity\n`);
const STRICT = { expect: { ar: '16:9', stylize: '100' }, expectStrict: ['ar'], forbid: ['edit', 'cref', 'oref'] };

assert('the true job passes fidelity',
    f.checkFlags(JOB_3.full_command, STRICT).ok, true);
assert('UI-drifted flags fail fidelity',
    f.checkFlags(JOB_5_UI_DRIFT.full_command, STRICT).ok, false);
assert('the drift is reported by name',
    f.checkFlags(JOB_5_UI_DRIFT.full_command, STRICT).reasons.some(r => r.includes('--ar')), true);
assert('an edit flag is reported',
    f.checkFlags(JOB_5_EDIT.full_command, STRICT).reasons.some(r => r.includes('--edit')), true);
assert('a missing --ar fails when strict',
    f.checkFlags('x --raw', { expect: { ar: '16:9' }, expectStrict: ['ar'] }).ok, false);
assert('a missing --stylize is tolerated when not strict',
    f.checkFlags('x --ar 16:9 --raw', { expect: { ar: '16:9', stylize: '100' }, expectStrict: ['ar'] }).ok, true);
assert('a wrong --stylize is caught',
    f.checkFlags('x --ar 16:9 --stylize 0', { expect: { ar: '16:9', stylize: '100' } }).ok, false);

// ---------------------------------------------------------------------------
process.stderr.write(`6. job matching\n`);
assert('the true job matches',
    f.matchJob(JOB_3, PROMPT_3, STRICT).ok, true);
assert('the edit job does not match',
    f.matchJob(JOB_5_EDIT, PROMPT_3, STRICT).ok, false);
assert('the edit job says why',
    f.matchJob(JOB_5_EDIT, PROMPT_3, STRICT).reasons[0].includes('not a plain generation'), true);
assert('the UI-drifted job does not match',
    f.matchJob(JOB_5_UI_DRIFT, PROMPT_3, STRICT).ok, false);
assert('the video job does not match',
    f.matchJob(JOB_VIDEO, PROMPT_3, STRICT).ok, false);
assert('the owner\'s job does not match',
    f.matchJob(JOB_OWNER, PROMPT_3, STRICT).ok, false);
assert('a job with no id does not match',
    f.matchJob({}, PROMPT_3, STRICT).ok, false);

// ---------------------------------------------------------------------------
process.stderr.write(`7. finding the right job in a feed\n`);
const FEED = [JOB_VIDEO, JOB_OWNER, JOB_5_UI_DRIFT, JOB_3, JOB_5_EDIT];

assert('finds the true job',
    (f.findJob(FEED, PROMPT_3, STRICT) || {}).id, JOB_3.id);
assert('finds nothing when the only candidate is an edit',
    f.findJob([JOB_5_EDIT], PROMPT_3, STRICT), null);
assert('finds nothing when the only candidate drifted',
    f.findJob([JOB_5_UI_DRIFT], PROMPT_3, STRICT), null);
assert('an excluded id is not adopted',
    f.findJob(FEED, PROMPT_3, { ...STRICT, excludeIds: [JOB_3.id] }), null);
assert('a job enqueued before `after` is not adopted',
    f.findJob(FEED, PROMPT_3, { ...STRICT, after: '2026-10-21T10:39:00Z' }), null);

// When the same prompt was submitted twice (a retry), the EARLIEST job
// wins — the first submission is the one whose flags were correct.
const RETRY_A = { ...JOB_3, id: 'first-1111', enqueue_time: '2026-10-21T10:38:49.000000+00:00' };
const RETRY_B = { ...JOB_3, id: 'second-2222', enqueue_time: '2026-10-21T10:45:00.000000+00:00' };
assert('the earliest of two matching jobs wins',
    (f.findJob([RETRY_B, RETRY_A], PROMPT_3, STRICT) || {}).id, 'first-1111');

// ---------------------------------------------------------------------------
process.stderr.write(`8. CDN url construction\n`);
assert('four grid urls for a 4-up',
    f.gridUrls('abc', 4).length, 4);
assert('the url shape is the one the CDN serves',
    f.gridUrls('abc', 4)[0], 'https://cdn.midjourney.com/abc/0_0_640_N.webp?method=shortest');
assert('slots are numbered',
    f.gridUrls('abc', 4)[3], 'https://cdn.midjourney.com/abc/0_3_640_N.webp?method=shortest');

// ---------------------------------------------------------------------------
process.stderr.write(`9. browser-half expressions\n`);
assertTrue('DISCOVER_USER_ID reads the resource timing list',
    f.DISCOVER_USER_ID.includes('getEntriesByType'));
assertTrue('DISCOVER_USER_ID falls back to localStorage',
    f.DISCOVER_USER_ID.includes('localStorage'));
assertTrue('FETCH_FEED sends the CSRF header',
    f.FETCH_FEED('u').includes('X-CSRF-Protection'));
assertTrue('FETCH_FEED sends credentials',
    f.FETCH_FEED('u').includes("credentials: 'include'"));
assertTrue('FETCH_FEED interpolates the user id',
    f.FETCH_FEED('some-user-id').includes('some-user-id'));
assertTrue('PROBE_URLS interpolates the urls',
    f.PROBE_URLS(['https://x/y.webp']).includes('https://x/y.webp'));

// ---------------------------------------------------------------------------
process.stderr.write(`\n[mj-feed.test] ${passed} passed, ${failed} failed\n`);
if (failures.length) {
    for (const fl of failures) process.stderr.write(`  FAILED: ${fl.label}\n`);
    process.exit(1);
}
process.exit(0);
