#!/usr/bin/env node
'use strict';
// lib/social-shared.test.js
//
// The shared social rules: one tag alphabet, one tier contract, one
// POST.md shape. These are the rules lib/ig-poster.js's parser depends
// on, so they are pinned here rather than left to the caller's memory.
//
//   node lib/social-shared.test.js

const shared = require('./social-shared.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push(label);
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push(label); process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write('\n[social-shared.test]\n\n');

// normalizeTag
assert('a tag is one word', shared.normalizeTag('Minimalist Home Decor'), '#Minimalist');
assert('a tag drops the punctuation', shared.normalizeTag('rgb-split!'), '#rgbsplit');
assert('a tag keeps its underscores', shared.normalizeTag('modal_jazz'), '#modal_jazz');
assert('a tag drops a leading hash', shared.normalizeTag('#jazz'), '#jazz');
assert('an empty tag is empty', shared.normalizeTag('   '), '');
assert('a non-string is empty', shared.normalizeTag(null), '');

// normalizeTagList
assert('a list is canonicalised', shared.normalizeTagList(['#Jazz', 'modal jazz', 'rgb-split']), ['#Jazz', '#modal', '#rgbsplit']);
assert('a list is de-duplicated case-insensitively', shared.normalizeTagList(['#jazz', '#Jazz']), ['#jazz']);
assert('a list keeps its order', shared.normalizeTagList(['#b', '#a']), ['#b', '#a']);
assert('a non-list is empty', shared.normalizeTagList('nope'), []);

// normalizeTier
const WARN = [];
assert('a tier is capped', shared.normalizeTier(Array.from({ length: 20 }, (_, i) => '#t' + i), 'primarySet', WARN).length, 7);
const SHORT = shared.normalizeTier(['#a'], 'primarySet', WARN);
assert('a short tier is not padded', SHORT.length, 1);
assertTrue('a short tier is a warning, never padding', WARN.some(w => /primarySet has \d+ tag\(s\)/.test(w)));
assert('a full tier has no warning', shared.normalizeTier(['#a', '#b', '#c', '#d', '#e', '#f', '#g'], 'primarySet', []).length, 7);

// stripTags
assert('tags are stripped from the body', shared.stripTags('look #jazz now'), 'look now');
assert('the body is trimmed', shared.stripTags('  hello  '), 'hello');
assert('an empty body stays empty', shared.stripTags(''), '');

// appendHashtags
assert('the tags go on their own line', shared.appendHashtags('a caption', ['#x', '#y']), 'a caption\n\n#x #y');
assert('an empty caption stays empty', shared.appendHashtags('', ['#x']), '');

// buildPlatformContent
const PERSONA = shared.normalizePersona({
    personaName: 'Neon Pulse',
    description: 'a cover study',
    primarySet: ['#neon', '#pulse'],
    secondarySet: ['#cover'],
    nicheSet: ['#studio'],
    youtube: { title: 'Neon Pulse', description: 'a cover study', tags: ['#neon'] },
    social: {
        instagram: { caption: 'Neon Pulse — cover study.' },
        tiktok: 'Neon Pulse — cover study.',
        twitter: { caption: 'Neon Pulse — cover study.' },
        facebook: { caption: 'Neon Pulse — cover study.' },
    },
});
const CONTENT = shared.buildPlatformContent(PERSONA);
assert('the hashtag union is the tiers in order', CONTENT.hashtags, ['#neon', '#pulse', '#cover', '#studio']);
assert('the caption carries the hashtag line', CONTENT.social.instagram.caption.endsWith('#neon #pulse #cover #studio'), true);
assert('the caption body carries no tag', CONTENT.social.instagram.caption.split('\n\n')[0].includes('#'), false);
assert('every platform gets a caption', Object.keys(CONTENT.social).sort(), ['facebook', 'instagram', 'tiktok', 'twitter']);
assert('the youtube title falls back to the persona name', CONTENT.youtube.title, 'Neon Pulse');

// toYoutubeMetadata
const YT = shared.toYoutubeMetadata(PERSONA);
assert('the youtube tags keep their hash', YT.tags[0], '#neon');
assert('the youtube csv drops the hash', YT.tagsCsv, 'neon');
assert('the youtube tags are the declared ones', YT.tags, ['#neon']);
assert('the youtube metadata has a title', YT.title, 'Neon Pulse');

// toIgPostMd — the contract lib/ig-poster.js reads
const MD = shared.toIgPostMd(PERSONA);
assert('the post md starts with the title', MD.startsWith('# Neon Pulse\n'), true);
assert('the post md has a caption section', MD.includes('\n## Caption\n'), true);
assert('the post md has a next section', MD.includes('\n## Next\n'), true);
assert('the post md has a hashtags section', MD.includes('\n## Hashtags\n'), true);
assert('the caption comes before the next section', MD.indexOf('## Caption') < MD.indexOf('## Next'), true);
assert('the hashtags come after the next section', MD.indexOf('## Hashtags') > MD.indexOf('## Next'), true);
assert('the tag line is the hashtags', /## Hashtags\n\n#neon #pulse #cover #studio\n$/.test(MD), true);
assert('the caption body has no hashtag', MD.split('## Caption')[1].split('## Next')[0].includes('#'), false);

process.stderr.write(`\n[social-shared.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f}\n`);
    process.exit(1);
}
