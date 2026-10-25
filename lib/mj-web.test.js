#!/usr/bin/env node
'use strict';
// lib/mj-web.test.js
//
// Tests for the web backend's pure logic.
//
// HISTORY — why this file was rewritten
//
// The previous version pinned `promptExcerpt` and `findTaskByPromptExpr`,
// the DOM-card matcher. That matcher was the source of the 2026-10-21
// misattribution: 6 of 12 accepted task ids belonged to the account
// owner's own concurrent jobs, so the contact sheet showed the owner's
// portrait in half its tiles. Acceptance now runs against the FEED API
// (lib/mj-feed.js), which carries the command each job actually ran with.
//
// The DOM matcher is GONE — not demoted, gone. Keeping an unsound matcher
// around as a "fallback" is how it came back and misattributed a second
// time. These tests now pin the parts of mj-web.js that the feed gate
// depends on, and the feed gate's own contract lives in mj-feed.test.js.
//
//   node lib/mj-web.test.js

const w = require('./mj-web.js');

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

process.stderr.write(`\n[mj-web.test]\n\n`);

// 1. expectedAspect — the ratio the feed gate demands.
//
// This is the value the gate checks the ENQUEUED command against. If it
// is extracted wrongly the gate accepts a drifted job (the 2026-10-21
// failure: our `--ar 16:9` became `--ar 4:3` because MJ's UI state won,
// and only `full_command` revealed it).
process.stderr.write(`1. expectedAspect extracts the requested ratio\n`);
assert('plain 16:9', w.expectedAspect('a drum skin --ar 16:9'), '16:9');
assert('lowercased', w.expectedAspect('a drum --ar 16:9'), '16:9');
assert('4:3', w.expectedAspect('a drum --ar 4:3'), '4:3');
assert('square', w.expectedAspect('a drum --ar 1:1'), '1:1');
assert('no ratio yields null', w.expectedAspect('a drum --raw --hd'), null);
assert('empty prompt yields null', w.expectedAspect(''), null);
// The ratio must come from the LAST occurrence, matching how MJ itself
// resolves a doubled flag.
assert('last --ar wins', w.expectedAspect('a drum --ar 4:3 --ar 16:9'), '16:9');
// A ratio mentioned in the PROSE must not be mistaken for the flag.
assert('prose "16:9" is not a flag',
    w.expectedAspect('a drum in 16:9 cinema scope --raw'), null);

// 2. The attachment guard must exist and must scope to the composer.
//
// The guard prevents a stale composer attachment from turning a
// submission into an EDIT job — which renders the account owner's
// image instead of the prompt (measured 2026-10-21: prompt 5 of a
// 12-prompt pack).
process.stderr.write(`2. composer attachment guard\n`);
assertTrue('probe is an IIFE', /^\s*\(\(\) =>/.test(w.COMPOSER_ATTACHMENT_PROBE));
assertTrue('probe looks for images', /querySelectorAll\('img'\)/.test(w.COMPOSER_ATTACHMENT_PROBE));
assertTrue('probe scopes to the composer via the textarea',
    /TEXTAREA|textarea/.test(w.COMPOSER_ATTACHMENT_PROBE));
assertTrue('probe recognises s.mj.run attachments',
    /s\\?\.mj\\?\.run/.test(w.COMPOSER_ATTACHMENT_PROBE));
assertTrue('clear expression is an IIFE', /^\s*\(\(\) =>/.test(w.COMPOSER_ATTACHMENT_CLEAR));
assertTrue('clear looks for a dismiss control',
    /remove|delete|close|clear|dismiss/i.test(w.COMPOSER_ATTACHMENT_CLEAR));

// 3. The submit response — the proof that a prompt was accepted.
//
// Clicking the composer's send button does NOT submit, however the
// click is delivered (measured live, 2026-10-22: element.click(), a
// full CDP mouse sequence with buttons:1, a pointer+mouse+click event
// sequence, and the same with document.hasFocus() confirmed true —
// four mechanisms, no submission, and elementFromPoint proved the
// coordinates were right). ENTER does submit.
//
// So the composer is driven with ENTER, and the acceptance signal is
// Midjourney's own answer: the POST /api/submit-jobs response carries
// the new job id, the job type, the full command and the batch size.
process.stderr.write(`3. the submit response\n`);
const REAL_SUBMIT_BODY = JSON.stringify({
    success: [{
        job_id: '1f0042fb-c58b-485e-a63d-a1743614e976',
        prompt: 'a lone red figure in an empty concrete underpass at night --style niji --ar 16:9 --raw --profile brvazka --hd --v 8.2',
        is_queued: false,
        softban: false,
        event_type: 'diffusion',
        job_type: 'v8-2_hd_diffusion',
        flags: { mode: 'relaxed', visibility: 'public' },
        meta: { height: 1648, width: 2944, batch_size: 4, parent_id: null, parent_grid: null },
        optimisticJobIndex: 0,
    }],
});
const parsed = w.parseSubmitResponse(REAL_SUBMIT_BODY);
assert('the job id is parsed', parsed.jobId, '1f0042fb-c58b-485e-a63d-a1743614e976');
assert('the job type is parsed', parsed.jobType, 'v8-2_hd_diffusion');
assert('the event type is parsed', parsed.eventType, 'diffusion');
assert('the full command is parsed', parsed.prompt.includes('--style niji'), true);
assert('the batch size is parsed', parsed.batchSize, 4);
assert('the dimensions are parsed', `${parsed.width}x${parsed.height}`, '2944x1648');
assert('a queued job is reported as queued', parsed.queued, false);
assert('a softban is reported', parsed.softban, false);
assert('an object body parses too', w.parseSubmitResponse(JSON.parse(REAL_SUBMIT_BODY)).jobId, parsed.jobId);
assert('a body with no success array is not a submission', w.parseSubmitResponse('{"error":"nope"}'), null);
assert('an empty success array is not a submission', w.parseSubmitResponse('{"success":[]}'), null);
assert('a body with no job id is not a submission', w.parseSubmitResponse('{"success":[{"prompt":"x"}]}'), null);
assert('a non-JSON body is not a submission', w.parseSubmitResponse('<html>502</html>'), null);
assert('a null body is not a submission', w.parseSubmitResponse(null), null);

// The dead send-button path must not come back. It is the exact bug
// that made the tool report a submission that never happened.
assert('the send-button finder is gone', typeof w.findSendButton, 'undefined');
assert('the send-button clicker is gone', typeof w.clickSendButton, 'undefined');
assert('the composer button probe is gone', typeof w.COMPOSER_BUTTONS, 'undefined');

// 3b. The queue gate.
//
// Midjourney REFUSES a prompt when the account's job queue is full, and
// it refuses it SILENTLY: the composer logs the prompt, never asks for
// a submission, and shows no error. Observed live on 2026-10-22 — a
// submission with one job queued was accepted, the same submission with
// two queued was turned away without a word.
//
// A tool that only watches for the submit response therefore reads the
// refusal as "nothing happened". The queue readout is how the refusal
// becomes legible.
process.stderr.write(`3b. the queue gate\n`);
assert('an empty queue has room', w.queueHasRoom(null), true);
assert('a missing readout has room', w.queueHasRoom(undefined), true);
assert('a blank readout has room', w.queueHasRoom('   '), true);
assert('one queued job has room', w.queueHasRoom('1 queued jobs'), true);
assert('two queued jobs have no room', w.queueHasRoom('2 queued jobs'), false);
assert('five queued jobs have no room', w.queueHasRoom('5 queued jobs'), false);
assert('the singular wording is read too', w.queueHasRoom('3 queued job'), false);
assert('the readout expression looks for the queue', /queued\\s\+jobs\?/i.test(w.QUEUE_READOUT), true);
assert('the refusal is detectable', /submit-jobs/.test(w.SUBMIT_STATE), true);
assert('the submit path waits for room', /waitForQueueRoom/.test(w.submitViaComposer.toString()), true);

// 3c. A refusal has two causes and they need opposite responses.
//
// A queue that is full is transient: wait and retry. A refusal with
// room in the queue is about the PROMPT: retrying is pointless, and the
// artist needs to be told which parameter is wrong.
//
// The prompt case is not hypothetical. `--style niji` (a model name —
// v8 has no style presets, only `--raw`) is refused SILENTLY, as are
// `--style fire` and `--style neon`. Measured live on 2026-10-22 with
// an empty queue: all three were refused, `--style raw` was accepted.
process.stderr.write(`3c. a refusal has two causes\n`);
assert('a refusal with room in the queue fails fast', w.refusalAction(null), 'fail');
assert('a refusal with room in the queue fails fast (0 queued)', w.refusalAction('0 queued jobs'), 'fail');
assert('a refusal with room in the queue fails fast (1 queued)', w.refusalAction('1 queued jobs'), 'fail');
assert('a refusal with a full queue waits', w.refusalAction('2 queued jobs'), 'wait');
assert('a refusal with a full queue waits (3 queued)', w.refusalAction('3 queued jobs'), 'wait');
assert('the refusal message names the style trap', /--style/.test(w.submitViaComposer.toString()), true);
assert('the refusal message names the raw style', /--raw/.test(w.submitViaComposer.toString()), true);
// The pure decision must be the one the submit path actually uses —
// otherwise the rule is tested and not applied.
assert('the submit path consults the refusal decision', /refusalAction\(/.test(w.submitViaComposer.toString()), true);

// 3d. The personalization toggle.
//
// The composer's "Personalize" control applies the ACCOUNT's profile
// and moodboards to every generation whatever the prompt says, and
// there is no flag for "no moodboards" — the text cannot express it.
// `--no-personalize` is therefore the ONLY way to a clean generation.
//
// The control has no attribute to read: the selected option is painted
// a saturated coral and the unselected one a neutral grey, so the
// chroma separates them. A React `element.click()` does NOT flip it —
// it needs a real mouse event at the button's coordinates.
//
// The assertions here are structural. The behaviour was measured live
// (2026-10-22: profile #8 + four moodboards on the account); what is
// pinned is that the state probe is a browser expression, that the
// click is a real mouse event, and that the flag is opt-in so the
// default path is untouched.
process.stderr.write(`3d. the personalization toggle\n`);
assert('the state probe is an IIFE', /^\s*\(\(\) =>/.test(w.PERSONALIZE_STATE), true);
assert('the state probe looks for the Personalize control',
    /Personalize/.test(w.PERSONALIZE_STATE), true);
assert('the state probe reads both options',
    /On\|Off/.test(w.PERSONALIZE_STATE), true);
assert('the state probe separates the options by chroma',
    /chroma/.test(w.PERSONALIZE_STATE), true);
assert('the toggle is flipped with a real mouse event',
    /Input\.dispatchMouseEvent/.test(w.disablePersonalization.toString()), true);
assert('the toggle verifies the change instead of assuming it',
    /did not turn off/.test(w.disablePersonalization.toString()), true);

// 4. The CDN url builder is re-exported from the feed module.
//
// The image urls are constructed from the job id rather than scraped
// from the DOM, because the feed is virtualized and the DOM carried
// whatever cards happened to be mounted.
process.stderr.write(`4. grid urls are derived from the job id\n`);
assert('four slots by default',
    w.gridUrls('11111111-2222-4333-8444-555555555555').length, 4);
assert('url shape',
    w.gridUrls('11111111-2222-4333-8444-555555555555')[0],
    'https://cdn.midjourney.com/11111111-2222-4333-8444-555555555555/0_0_640_N.webp?method=shortest');
assert('batch size honoured',
    w.gridUrls('11111111-2222-4333-8444-555555555555', 2).length, 2);

// 5. The acceptance window must be long enough to cover a generation.
//
// A job lands in the feed when it is ENQUEUED, which is quick; the
// images take longer. The gate polls the feed, so the window bounds the
// wait for the JOB, not for the pictures.
process.stderr.write(`5. acceptance window\n`);
assertTrue('accept window raised to >= 60s', w.ACCEPT_TIMEOUT >= 60000);

// 6. The DOM matcher must be gone.
//
// A regression guard, not a unit test of behaviour: the matcher was the
// misattribution source, and its absence is what keeps it from coming
// back as a "fallback". If this assertion fails, the matcher has been
// reintroduced and the feed gate has a shadow authority.
process.stderr.write(`6. the unsound DOM matcher is not reachable\n`);
assertTrue('findTaskByPromptExpr is not exported', w.findTaskByPromptExpr === undefined);
assertTrue('promptExcerpt is not exported', w.promptExcerpt === undefined);
assertTrue('reconcileFeed is not exported', w.reconcileFeed === undefined);

// 7. A refusal must carry Midjourney's own words.
//
// The submit path used to report "the response could not be read" — a
// sentence about the TOOL. On 2026-10-23 that hid the only thing that
// mattered: MJ's moderator had refused the prompt
// ("banned_prompt_detected"), and the operator had no way to know that
// from the error. The body is now surfaced.
//
// This is pure: no browser, no generation spent.
process.stderr.write(`7. a refusal carries Midjourney's own answer\n`);
const REFUSAL = '{"success":[],"failure":[{"type":"banned_prompt_detected","message":"Sorry! Our AI moderator thinks this prompt is probably against our Community Guidelines."}]}';
const msg = w.refusalMessage(REFUSAL, 400);
assertTrue('the refusal names the reason', /banned_prompt_detected/.test(msg));
assertTrue('the refusal quotes the message', /Community Guidelines/.test(msg));
assertTrue('the status is reported', /HTTP 400/.test(msg));
assert('an empty body is still a sentence',
    w.refusalMessage('', 200).includes('(empty body)'), true);
assert('a null body does not throw',
    /empty body/.test(w.refusalMessage(null)), true);
assertTrue('the body is truncated, not unbounded',
    w.refusalMessage('x'.repeat(5000)).length < 420);

// 8. The submit path must make the renderer believe it is focused.
//
// MEASURED, 2026-10-23: the same command, the same account, the same
// Chrome, one minute apart. With focus emulation ON the composer
// submitted (job f9020375); with it OFF the prompt stayed in the
// composer, Midjourney was never asked for a submission, and the tool
// reported "Midjourney refused the prompt" — a refusal that never
// happened. `mj-revise` had its own CDP setup and never enabled the
// domain, so the omission only showed up in unattended runs.
//
// The guard lives in the shared submit path, so no caller can forget it.
// This is behavioural: a fake client records the CDP calls, and the
// focus emulation has to arrive BEFORE the text is typed.
process.stderr.write(`8. the submit path focuses the renderer before it types\n`);

const fakeCdp = () => {
    const sent = [];
    return {
        sent,
        async send(method, params) {
            sent.push({ method, params });
            return {};
        },
        async js(expr) {
            if (typeof expr === 'string' && expr.includes('window.__mjSubmit || null')) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        success: [{ job_id: 'job-focus-1', job_type: 'v8-2_edit_diffusion' }],
                    }),
                };
            }
            if (typeof expr === 'string' && expr.includes('__mjApi || []')) {
                return { submitted: true, calls: [] };
            }
            return true;
        },
    };
};

(async () => {
    const cdp = fakeCdp();
    const job = await w.submitViaComposer(cdp, 'a drum skin --ar 16:9');
    assert('the job is returned', job && job.jobId, 'job-focus-1');
    const focusIdx = cdp.sent.findIndex(c => c.method === 'Emulation.setFocusEmulationEnabled');
    const typeIdx = cdp.sent.findIndex(c => c.method === 'Input.insertText');
    assertTrue('focus emulation is enabled', focusIdx >= 0);
    assertTrue('focus emulation is enabled before the text is typed',
        focusIdx >= 0 && typeIdx >= 0 && focusIdx < typeIdx);
    assertTrue('focus emulation is enabled, not disabled',
        cdp.sent[focusIdx] && cdp.sent[focusIdx].params
            && cdp.sent[focusIdx].params.enabled === true);

    // -----------------------------------------------------------------
    // 9. a known job id is authoritative — and is never re-submitted
    //
    // The bug: a hardcoded job-type whitelist in lib/mj-feed.js could not
    // recognise `v6-1_raw_diffusion` / `v6_raw_diffusion_anime`, so the
    // prose matcher reported "no matching job in the feed" for a job
    // Midjourney had just accepted. The caller then submitted AGAIN.
    // Measured 2026-10-25: a 10-prompt v6.1 / Niji batch billed 15
    // generations for 10 prompts and wrote no metadata.
    //
    // The fix is two-part and both parts are pinned here: the submit
    // response's job id is what gets awaited, and a job that cannot be
    // confirmed is reported rather than re-submitted.
    process.stderr.write(`9. a known job id is awaited, never re-submitted\n`);

    const feedCdp = (items) => ({
        sent: [],
        async send(method, params) { this.sent.push({ method, params }); return {}; },
        async js(expr) {
            if (typeof expr === 'string' && expr.includes('/api/imagine')) {
                return { status: 200, items };
            }
            return true;
        },
    });

    const V61 = {
        id: 'job-known-1',
        job_type: 'v6-1_raw_diffusion',
        event_type: 'diffusion',
        enqueue_time: new Date().toISOString(),
        batch_size: 4,
        full_command: 'a lighthouse at dusk --ar 16:9 --v 6.1',
    };

    (async () => {
        const cdp = feedCdp([V61]);
        const hit = await w.awaitJobById(cdp, 'user-1', 'job-known-1',
            'a lighthouse at dusk --ar 16:9', { expect: { ar: '16:9' }, expectStrict: ['ar'] }, 6000);
        assert('the known v6.1 job is returned', hit && hit.id, 'job-known-1');
        assertTrue('awaiting a known id submits nothing',
            !cdp.sent.some(c => c.method === 'Input.insertText'));

        // Present but wrong: a drifted ratio must NOT be accepted, and
        // must NOT be retried either.
        const drifted = { ...V61, id: 'job-known-2', full_command: 'a lighthouse at dusk --ar 4:3 --v 6.1' };
        const cdp2 = feedCdp([drifted]);
        const miss = await w.awaitJobById(cdp2, 'user-1', 'job-known-2',
            'a lighthouse at dusk --ar 16:9', { expect: { ar: '16:9' }, expectStrict: ['ar'] }, 3000);
        assert('a drifted job is rejected, not awaited forever', miss, null);
        assertTrue('a rejected job does not cause a new submission',
            !cdp2.sent.some(c => c.method === 'Input.insertText'));

        // Absent from the feed entirely: null, and still no submission.
        const cdp3 = feedCdp([]);
        const gone = await w.awaitJobById(cdp3, 'user-1', 'job-known-3',
            'a lighthouse at dusk --ar 16:9', {}, 2000);
        assert('an absent job id returns null', gone, null);
        assertTrue('an absent job id is not re-submitted as a side effect',
            !cdp3.sent.some(c => c.method === 'Input.insertText'));
    })().then(() => {
    process.stderr.write(`\n[mj-web.test] passed: ${passed}, failed: ${failed}\n`);
    if (failed > 0) {
        for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
        process.exit(failed === 0 ? 0 : 1);
    });
})();

