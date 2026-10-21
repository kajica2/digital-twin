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
const match = (prompt, doc, seen = [], beforeSnapshot = []) => new Function('document', `return ${w.findTaskByPromptExpr(w.promptExcerpt(prompt), seen, beforeSnapshot)};`)(doc);

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

// 8. Seen-task set — a task id recorded for an earlier prompt in the same
// run must never be accepted again (2026-09-30: one 8-image task was
// recorded against two different prompts). Regression: the matcher
// polled without exclusions and the fallback path reused the newest
// consumed card.
process.stderr.write(`8. seen-task exclusion\n`);
{
    const imgA = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${IDA}/0_0_640_N.webp` });
    const linkA = fakeNode({ tag: 'A', attrs: { href: `/jobs/${IDA}?index=0` }, imgs: [imgA] });
    const cardA = fakeNode({ text: `Loop${pA}`, imgs: [imgA], links: [linkA] });
    wire(imgA, linkA); wire(linkA, cardA);
    const doc = fakeDoc([imgA], [linkA]);

    assertTrue('matcher source embeds a seen Set', /new Set\(/.test(w.findTaskByPromptExpr('x', [IDA])));
    assertTrue('matcher source carries the excluded id',
        w.findTaskByPromptExpr('x', [IDA]).includes(IDA));
    assert('already-consumed id is never accepted', match(pA, doc, [IDA]), null);
    assert('an unrelated seen id does not block the match',
        match(pA, doc, ['ffffffff-0000-4fff-8fff-ffffffffffff']), IDA);
}
assertTrue('accept window raised to >= 60s', w.ACCEPT_TIMEOUT >= 60000);

// 9. Shared-prefix pack — every prompt in this 8-pack opens with the
//    same ~110-char style clause ("Ultra realistic black and white fine
//    art editorial photograph. A professional man in his late 30s …")
//    then diverges with a per-prompt unique verb + object. A matcher
//    that takes the excerpt from offset 0 sees the same 64-char string
//    for every prompt, attributes them all to the first card, and an
//    8-prompt run collapses to 1 task. The fix: take the excerpt from
//    a window after the shared boilerplate, where the per-prompt
//    unique content lives.
process.stderr.write(`9. shared-prefix pack — 8 prompts with identical intros must not collapse to one task\n`);
{
    const shared = 'Ultra realistic black and white fine art editorial photograph. A professional man in his late 30s ';
    const diverge = [
        'stands alone in a vast empty concert hall just after soundcheck, the only figure visible in rows of seats.',
        'sits alone on the edge of an unmade hotel bed late at night, the city skyline visible through floor-to-ceiling windows.',
        'is visible through the glass of a soundproof recording booth, headphones over his ears, one hand on the pop filter of a vintage Neumann microphone.',
        'stands alone on the flat tar roof of a tall office building at dawn, the city skyline spreading behind him in soft early light.',
        'stands alone in an empty contemporary art museum gallery at closing time, contemplating a single large abstract canvas mounted on a far white wall.',
        'walks alone down a long backstage corridor, harsh overhead fluorescent tubes casting a single long shadow behind him.',
        'sits alone in the back of a taxi late at night, city lights streaking past the rain-spattered window.',
        'stands alone at a wooden speaker\u2019s podium in an empty university auditorium, mid-thought, hands resting on the edges of the lectern.',
    ];
    const prompts = diverge.map(d => shared + d);
    const tids = diverge.map((_, i) => `0000000${i}-0000-4000-8000-00000000000${i}`);

    // Distinct excerpts first — the same input as the matcher would see.
    const excerpts = prompts.map(p => w.promptExcerpt(p));
    const uniqueExcerpts = new Set(excerpts);
    assertTrue('8 prompts with shared 110-char prefix produce 8 distinct excerpts',
        uniqueExcerpts.size === 8);

    // End-to-end: 8 cards, 8 prompts, each prompt matches its own card.
    const allImgs = [];
    const allLinks = [];
    const cards = [];
    for (let i = 0; i < 8; i++) {
        const img = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${tids[i]}/0_0_640_N.webp` });
        const link = fakeNode({ tag: 'A', attrs: { href: `/jobs/${tids[i]}?index=0` }, imgs: [img] });
        const card = fakeNode({ text: `Loop${prompts[i]}`, imgs: [img], links: [link] });
        wire(img, link); wire(link, card);
        allImgs.push(img); allLinks.push(link); cards.push(card);
    }
    const feed = fakeNode({
        text: 'Today ' + prompts.map((p, i) => `Loop${p}`).join(' '),
        imgs: allImgs, links: allLinks,
    });
    for (const c of cards) wire(c, feed);
    const doc = fakeDoc(allImgs, allLinks);

    // Simulate the full run: for each prompt, match, then add the
    // returned taskId to the seen set before the next call.
    const seen = [];
    const seenPerCall = [];
    for (let i = 0; i < 8; i++) {
        const got = match(prompts[i], doc, seen);
        seenPerCall.push(got);
        if (got) seen.push(got);
    }
    assert('prompt 1 (concert hall) -> task 1',
        seenPerCall[0], tids[0]);
    assert('prompt 2 (hotel bed) -> task 2',
        seenPerCall[1], tids[1]);
    assert('prompt 3 (recording booth) -> task 3',
        seenPerCall[2], tids[2]);
    assert('prompt 4 (rooftop) -> task 4',
        seenPerCall[3], tids[3]);
    assert('prompt 5 (museum gallery) -> task 5',
        seenPerCall[4], tids[4]);
    assert('prompt 6 (backstage corridor) -> task 6',
        seenPerCall[5], tids[5]);
    assert('prompt 7 (taxi) -> task 7',
        seenPerCall[6], tids[6]);
    assert('prompt 8 (podium) -> task 8',
        seenPerCall[7], tids[7]);
    assertTrue('all 8 prompts produced 8 distinct taskIds',
        new Set(seenPerCall).size === 8);
}

// 10. Pre-existing feed — when the prompt file is re-run, the cards
//     from the previous run are still in the feed and have the same
//     prompt text. The matcher must ignore them and find the NEW card.
//     Without beforeSnapshot, a re-run of an 8-prompt pack matches
//     the new prompts to the previous run's cards, collapsing 16
//     generations to 8 taskIds (2026-10-18 incident: B&W editorial
//     re-run; prompts 2/4/6 all matched previous-run taskIds).
process.stderr.write(`10. beforeSnapshot — pre-existing feed cards are not accepted as new\n`);
{
    const OLD_ID = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const NEW_ID = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const oldPrompt = 'a stage lit by a single red spotlight, empty seats, a microphone stand alone';
    const newPrompt = 'a stage lit by a single red spotlight, empty seats, a microphone stand alone';

    // Same prompt, two cards, two taskIds. The matcher would prefer
    // whichever seed comes first in DOM order — without beforeSnapshot
    // that's the OLD card. With it, the OLD card is excluded.
    const oldImg = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${OLD_ID}/0_0_640_N.webp` });
    const oldLink = fakeNode({ tag: 'A', attrs: { href: `/jobs/${OLD_ID}?index=0` }, imgs: [oldImg] });
    const oldCard = fakeNode({ text: `Loop${oldPrompt}`, imgs: [oldImg], links: [oldLink] });
    wire(oldImg, oldLink); wire(oldLink, oldCard);

    const newImg = fakeNode({ tag: 'IMG', src: `https://cdn.midjourney.com/${NEW_ID}/0_0_640_N.webp` });
    const newLink = fakeNode({ tag: 'A', attrs: { href: `/jobs/${NEW_ID}?index=0` }, imgs: [newImg] });
    const newCard = fakeNode({ text: `Loop${newPrompt}`, imgs: [newImg], links: [newLink] });
    wire(newImg, newLink); wire(newLink, newCard);

    const feed = fakeNode({ text: `Loop${oldPrompt} Loop${newPrompt}`, imgs: [oldImg, newImg], links: [oldLink, newLink] });
    wire(oldCard, feed); wire(newCard, feed);
    const doc = fakeDoc([oldImg, newImg], [oldLink, newLink]);

    // Without beforeSnapshot: the matcher walks the OLD seed first
    // (it's at index 0 in the querySelectorAll result) and matches it.
    assert('without beforeSnapshot, OLD card matches first', match(newPrompt, doc), OLD_ID);

    // With beforeSnapshot containing the OLD id: the matcher skips
    // it, walks to the NEW seed, and matches that.
    assert('with beforeSnapshot containing OLD id, NEW card matches',
        match(newPrompt, doc, [], [OLD_ID]), NEW_ID);

    // The matcher's source must carry the new beforeSnapshot parameter.
    const expr = w.findTaskByPromptExpr('x', [], [OLD_ID]);
    assertTrue('matcher source contains a before Set',
        /new Set\(\s*\[\s*\"11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa\"/.test(expr));
}

process.stderr.write(`\n[mj-web.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
