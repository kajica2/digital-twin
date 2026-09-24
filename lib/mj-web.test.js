#!/usr/bin/env node
'use strict';
// lib/mj-web.test.js
//
// Sprint 0.25 — tests for the web backend's pure logic.
//
// The part worth pinning is `promptExcerpt`, because the acceptance check
// now matches a task card by the prompt text it carries. If the excerpt is
// not present verbatim in the rendered card, detection fails; if it is not
// distinctive, detection could match the wrong card. Both are testable
// without a browser.
//
// (The browser half of the backend — cookie injection, Cloudflare, the
// submit itself — is exercised by `--preflight` and real runs, not here.)
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

// 1. Params are stripped so MJ's own truncation of the tail can't break the match
process.stderr.write(`1. promptExcerpt strips params\n`);
assert('trailing params removed',
    w.promptExcerpt('a lone trumpet on a wet rooftop at dawn --style raw --s 250 --ar 16:9'),
    'a lone trumpet on a wet rooftop at dawn');
assertTrue('no --ar left in the excerpt',
    !/--/.test(w.promptExcerpt('a drum skin --ar 16:9')));
assert('mid-text params removed too',
    w.promptExcerpt('a ring of dancers --chaos 5 silhouetted against fire'),
    'a ring of dancers silhouetted against fi');

// 2. Excerpt length + normalisation
process.stderr.write(`2. normalisation\n`);
assert('whitespace collapsed',
    w.promptExcerpt('a   drum\n\tskin    stretched   taut'),
    'a drum skin stretched taut');
assertTrue('default length is 40',
    w.promptExcerpt('x'.repeat(200)).length === 40);
assert('custom length honoured',
    w.promptExcerpt('abcdefghij', 4), 'abcd');
assert('short prompt is not padded',
    w.promptExcerpt('a drum'), 'a drum');

// 3. Distinctiveness — two different prompts must not share an excerpt
process.stderr.write(`3. distinct prompts produce distinct excerpts\n`);
const pairs = [
    ['a single enormous drum skin stretched taut, lit hard from one side --ar 16:9',
     'overhead drone shot of a crowd standing in a perfect circle --ar 16:9'],
    ['close-up of a vocalist mid-breath at a studio microphone --ar 16:9',
     'a woven textile banner hanging in a dark room --ar 16:9'],
];
for (const [a, b] of pairs) {
    assertTrue(`distinct: "${a.slice(0, 22)}…" != "${b.slice(0, 22)}…"`,
        w.promptExcerpt(a) !== w.promptExcerpt(b));
}

// 4. The excerpt must be a literal substring of the card text.
//    Cards render as "<UI label><the prompt> <params as chips>", so the
//    excerpt (params stripped) must be findable by `includes`.
process.stderr.write(`4. excerpt matches the rendered card form\n`);
const prompt = 'a single enormous drum skin stretched taut, lit hard from one side --style raw --s 250 --ar 16:9';
const excerpt = w.promptExcerpt(prompt);
const cardText = 'Loop a single enormous drum skin stretched taut, lit hard from one side ar 16:9 raw stylize 250';
assertTrue('card text includes the excerpt', cardText.includes(excerpt));

// 5. The generated matcher expression is well-formed and quotes safely
process.stderr.write(`5. matcher expression\n`);
const expr = w.findTaskByPromptExpr('a quote " and a backslash \\ test');
assertTrue('expression is an IIFE', /^\s*\(\(\) =>/.test(expr));
assertTrue('excerpt is JSON-encoded (no raw quote breakout)', expr.includes('\\"'));
assertTrue('matches cdn.midjourney task uuids', /cdn\\\.midjourney\\\.com/.test(expr));
assertTrue('uses includes, not an anchored match', /\.includes\(want\)/.test(expr));

// 6. No URL in the matcher is unescaped
process.stderr.write(`6. the matcher cannot over-match\n`);
assertTrue('requires the /uuid/ path shape',
    /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(w.findTaskByPromptExpr('x')));

process.stderr.write(`\n[mj-web.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
