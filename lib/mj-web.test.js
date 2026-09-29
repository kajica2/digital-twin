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
    'a ring of dancers silhouetted against fire');

// 2. Excerpt length + normalisation
process.stderr.write(`2. normalisation\n`);
assert('whitespace collapsed',
    w.promptExcerpt('a   drum\n\tskin    stretched   taut'),
    'a drum skin stretched taut');
assertTrue('default length is 64',
    w.promptExcerpt('x'.repeat(200)).length === 64);
assert('custom length honoured',
    w.promptExcerpt('abcdefghij', 4), 'abcd');
assert('short prompt is not padded',
    w.promptExcerpt('a drum'), 'a drum');

// Shared-prefix regression: a pack whose prompts all open with the same
// style clause must still yield distinct excerpts (2026-09-29 incident).
const cinematic = [
    'Cinematic film still, anamorphic widescreen: a neon-lit church nave at night, magenta and cyan --ar 16:9',
    'Cinematic film still, anamorphic widescreen: a club crowd silhouetted under a hard strobe --ar 16:9',
];
assertTrue('shared 45-char prefix still yields distinct excerpts',
    w.promptExcerpt(cinematic[0]) !== w.promptExcerpt(cinematic[1]));

// MJ's rendered card text drops em/en dashes — the excerpt must survive that
assert('em dash normalised to a space',
    w.promptExcerpt('a kitchen table by a window — chipped mug'),
    'a kitchen table by a window chipped mug');
assert('en dash normalised too',
    w.promptExcerpt('dusk – grass'), 'dusk grass');

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

// 7. Card scoping — the container over-match regression.
//
//    Exercised against a fake DOM mirroring the real feed: each card is
//    `a[href="/jobs/<id>"]` inside a card element, all cards inside one feed
//    container whose innerText holds every card's prompt. Matching the
//    container attributes a later prompt to the first card's task — the exact
//    failure that recorded four prompts against one task id.
process.stderr.write(`7. matcher is card-scoped (fake DOM)\n`);

const IDA = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const IDB = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const pA = 'Neon church interior at night: a dark concrete nave lit only by magenta and cyan neon tubes';
const pB = 'Morning haunt: pale sunrise light through a dusty window in an empty loft';
const pGhost = 'Dream sequence: a figure walking through low mist at dusk';

function fakeNode(spec) {
    const n = {
        tagName: spec.tag || 'DIV',
        innerText: spec.text || '',
        src: spec.src || '',
        parentElement: null,
        _attrs: spec.attrs || {},
        _imgs: spec.imgs || [],
        _links: spec.links || [],
    };
    n.getAttribute = (k) => (k in n._attrs ? n._attrs[k] : null);
    n.querySelectorAll = (sel) => (sel === 'img' ? n._imgs : (/a\[/.test(sel) ? n._links : []));
    return n;
}
const wire = (child, parent) => { child.parentElement = parent; };
const fakeDoc = (imgs, links) => ({ querySelectorAll: (sel) => (sel === 'img' ? imgs : (/a\[/.test(sel) ? links : [])) });
const match = (prompt, doc) => new Function('document', `return ${w.findTaskByPromptExpr(w.promptExcerpt(prompt))};`)(doc);

{
    const imgA = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${IDA}/0_0_640_N.webp` });
    const imgB = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${IDB}/0_0_640_N.webp` });
    const linkA = fakeNode({ tag: 'A', attrs: { href: `/jobs/${IDA}?index=0` }, imgs: [imgA] });
    const linkB = fakeNode({ tag: 'A', attrs: { href: `/jobs/${IDB}?index=0` }, imgs: [imgB] });
    const cardA = fakeNode({ text: `Loop${pA}`, imgs: [imgA], links: [linkA] });
    const cardB = fakeNode({ text: `Loop${pB}`, imgs: [imgB], links: [linkB] });
    const feed  = fakeNode({ text: `Today Loop${pA} Loop${pB}`, imgs: [imgA, imgB], links: [linkA, linkB] });
    wire(imgA, linkA); wire(imgB, linkB); wire(linkA, cardA); wire(linkB, cardB);
    wire(cardA, feed); wire(cardB, feed);
    const doc = fakeDoc([imgA, imgB], [linkA, linkB]);

    assert('later prompt resolves to its own card, not the first card', match(pB, doc), IDB);
    assert('first prompt resolves to the first card', match(pA, doc), IDA);
    assert('a prompt whose card is unmounted resolves to nothing', match(pGhost, doc), null);
}

{
    const imgA = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${IDA}/0_0_640_N.webp` });
    const imgB = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${IDB}/0_0_640_N.webp` });
    const cardA = fakeNode({ text: `Loop${pA}`, imgs: [imgA] });
    const cardB = fakeNode({ text: `Loop${pB}`, imgs: [imgB] });
    const feed  = fakeNode({ text: `Today Loop${pA} Loop${pB}`, imgs: [imgA, imgB] });
    wire(imgA, cardA); wire(imgB, cardB); wire(cardA, feed); wire(cardB, feed);

    assert('image fallback is card-scoped too', match(pB, fakeDoc([imgA, imgB], [])), IDB);
}

process.stderr.write(`\n[mj-web.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
