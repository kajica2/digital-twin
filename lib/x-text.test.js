#!/usr/bin/env node
'use strict';
// lib/x-text.test.js
//
// Tests for the tweet text rules.
//
// The rule with teeth here: X counts 280 WEIGHTED characters, not 280
// raw ones, and the engine's caption is 424 characters with a full tag
// set. Something has to be cut, and which thing gets cut is a publish
// decision, so it is pinned by a test rather than left to chance.
//
//   node lib/x-text.test.js

const xt = require('./x-text.js');

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
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[x-text.test]\n\n`);

// 1. counting
process.stderr.write(`1. counting\n`);
assert('plain latin counts one per character', xt.countLength('hello'), 5);
assert('an empty string is zero', xt.countLength(''), 0);
assert('null is zero', xt.countLength(null), 0);
assert('a space counts', xt.countLength('a b'), 3);
assert('a url counts as 23 whatever its length',
    xt.countLength('https://example.com/' + 'x'.repeat(100)), 23);
assert('a url inside text counts as 23',
    xt.countLength('see https://a.co now'), 3 + 1 + 23 + 1 + 3);
assert('two urls count as 46 plus the space between them',
    xt.countLength('https://a.co https://b.co'), 47);
assert('wide characters count as two', xt.countLength('漢字'), 4);
assert('an emoji counts as two', xt.countLength('🎺'), 2);
assert('a latin-1 accented character counts as one', xt.countLength('é'), 1);
assert('the 280th character is still inside the limit',
    xt.countLength('a'.repeat(280)) <= xt.MAX_LENGTH, true);
assert('the 281st character is not',
    xt.countLength('a'.repeat(281)) > xt.MAX_LENGTH, true);

// 2. truncation
process.stderr.write(`2. truncation\n`);
assert('a short text is untouched', xt.truncate('hello', 280), 'hello');
const CUT = xt.truncate('the quick brown fox jumps over the lazy dog', 20);
assertTrue('the cut text fits', xt.countLength(CUT) <= 20);
assertTrue('the cut text ends with an ellipsis', CUT.endsWith('…'));
assertTrue('the cut text kept the leading words', CUT.startsWith('the quick'));
assert('a single word is cut too', xt.truncate('supercalifragilistic', 10).length < 20, true);

// 3. fitting
process.stderr.write(`3. fitting\n`);
const FIT = xt.fit({ body: 'A body.', hashtags: ['#one', '#two', '#three'] });
assert('the body survives', FIT.body, 'A body.');
assert('every tag fits here', FIT.hashtags, ['#one', '#two', '#three']);
assert('nothing was dropped', FIT.dropped, []);
assert('the result is body, blank line, tags', FIT.text, 'A body.\n\n#one #two #three');

const SHORT = xt.fit({ body: 'x'.repeat(275), hashtags: ['#a', '#b'] });
assertTrue('the fitted text fits the limit', xt.countLength(SHORT.text) <= 280);
assertTrue('at least one tag survived', SHORT.hashtags.length >= 1);
assertTrue('the dropped tags are reported', SHORT.dropped.length >= 1);
assertTrue('the body was not truncated when the tags could go instead', !SHORT.truncated);

const TINY = xt.fit({ body: 'x'.repeat(300), hashtags: ['#a'] });
assertTrue('an impossible body is truncated', TINY.truncated);
assertTrue('the truncated result still fits', xt.countLength(TINY.text) <= 280);

const EMPTY = xt.fit({ body: '', hashtags: ['#a', '#b'] });
assert('an empty body still carries the tags', EMPTY.text, '#a #b');
assert('an empty body with no tags is empty', xt.fit({ body: '', hashtags: [] }).text, '');

const OVER = xt.fit({ body: 'body', hashtags: ['#' + 'x'.repeat(300)] });
assert('a tag that cannot fit is dropped', OVER.hashtags, []);
assertTrue('the too-long tag is reported', OVER.dropped.length === 1);

// The tail after the first tag that does not fit is dropped too, and
// EVERY dropped tag has to be reported — a silently discarded tail
// would tell the user that nothing much was lost when a dozen tags
// were.
const TAIL = xt.fit({ body: 'x'.repeat(270), hashtags: ['#a', '#b', '#c', '#d', '#e'] });
assertTrue('the tail is dropped', TAIL.hashtags.length < 5);
assertTrue('every dropped tag is reported', TAIL.dropped.length === 5 - TAIL.hashtags.length);
assertTrue('the reported tail is the tail that was lost',
    TAIL.dropped.every(t => !TAIL.hashtags.includes(t)));

// 4. splitting a caption
process.stderr.write(`4. splitting\n`);
const SPLIT = xt.splitCaption('The body.\n\n#one #two');
assert('the body is split off', SPLIT.body, 'The body.');
assert('the tags are split off', SPLIT.hashtags, ['#one', '#two']);
assert('a caption with no tags keeps its body', xt.splitCaption('Just a body.').body, 'Just a body.');
assert('a caption with no tags has no tag list', xt.splitCaption('Just a body.').hashtags, []);
assert('a trailing paragraph that is not tags stays in the body',
    xt.splitCaption('Body.\n\nnot tags').body, 'Body.\n\nnot tags');

// 5. fitting the live caption
process.stderr.write(`5. the live caption\n`);
const LIVE = 'Neon Pulse — cover study. 5 seed variants of the same cover at 832×832, with the title set in layout rather than painted in.\n\n#neon #neonpulse #pulse #cover #jazz #modaljazz #ambient #soundcloud #bandcamp #spotify #vinyl #saxophone #trumpet #piano #improvisation #contrafact #same #title #rather #than #painted #weimarjazzdatabase #bebop #dorianmode #quartalvoicings #generativeart #diffusionmodels #midjourney #notanaiimage';
assertTrue('the live caption is over the limit to begin with',
    xt.countLength(LIVE) > xt.MAX_LENGTH);
const PFIT = xt.fit({ body: xt.splitCaption(LIVE).body, hashtags: xt.splitCaption(LIVE).hashtags });
assertTrue('the fitted caption fits', xt.countLength(PFIT.text) <= xt.MAX_LENGTH);
assertTrue('the body survives intact', PFIT.body.startsWith('Neon Pulse — cover study.'));
assertTrue('the tags were dropped', PFIT.dropped.length > 0);
assertTrue('the tags that fit are kept', PFIT.hashtags.length > 0);
assertTrue('the most important tag survives', PFIT.hashtags.includes('#neon'));
assertTrue('fitting is idempotent',
    xt.fit({ body: xt.splitCaption(PFIT.text).body, hashtags: xt.splitCaption(PFIT.text).hashtags }).text === PFIT.text);

process.stderr.write(`\n[x-text.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    process.stderr.write('\nFailures:\n');
    for (const f of failures) {
        process.stderr.write(`  ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
    process.exit(1);
}
