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

// 3. The send-button finder.
//
// The submit path clicks MJ's send button rather than betting on Enter:
// under CDP, Enter degrades after the first submission of a session.
process.stderr.write(`3. send-button finder\n`);
const btns = [
    { label: 'Add images', hasSvg: true, disabled: false },
    { label: 'send', hasSvg: false, disabled: false },
];
assert('the send button is found', !!w.findSendButton(btns), true);
assert('an add-images button is never the send button',
    !!w.findSendButton([{ label: 'Add images', hasSvg: true, disabled: false }]), false);
assert('a disabled button is never the send button',
    !!w.findSendButton([{ label: 'send', hasSvg: true, disabled: true }]), false);
assert('an empty list yields nothing', w.findSendButton([]), null);
assert('a non-list yields nothing', w.findSendButton(null), null);

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

process.stderr.write(`\n[mj-web.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
