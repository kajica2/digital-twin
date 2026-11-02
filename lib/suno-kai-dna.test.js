#!/usr/bin/env node
'use strict';
// lib/suno-kai-dna.test.js
//
// The KAI sound DNA — the Nordic Modern Jazz Big Band.
//
// A style here is THREE fields, because the house's master style does
// not fit in one:
//
//   style         the master style text (856 chars)
//   negativeTags  the exclusions (211 chars)
//   lyrics        the arrangement, as section tags (626 chars)
//
// MEASURED against the server's limits: the style and the exclusions
// are 1069 characters TOGETHER — over the 1000-character tag limit —
// so they have to go in separate fields. That is the house rule for
// Pro/Premier anyway: move the exclusions into Exclude Styles.
//
// The tests pin that, the arrangement's shape, and the house rules the
// lyrics field must obey (square brackets, blank lines, the meter in
// the style box).
//
//   node lib/suno-kai-dna.test.js

const {
    loadDna,
    findStyle,
    styleFields,
    arrangementLyrics,
    variationFields,
    LIMITS,
} = require('./suno-kai-dna.js');

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

// 1. The registry.
process.stderr.write('1. the registry\n');
const dna = loadDna();
assert('it loads', Array.isArray(dna.styles), true);
const kai = findStyle('nordic-big-band');
assert('it is found by slug', !!kai, true);
assert('it is found by name', findStyle('Nordic Modern Jazz Big Band').slug, 'nordic-big-band');
assert('a wrong name is not found', findStyle('nope'), null);

// 2. The limits — the reason this is three fields and not one.
process.stderr.write('2. the limits\n');
const fields = styleFields(kai);
assert('the style fits the tag limit', fields.style.length <= LIMITS.tags, true);
assert('the negatives fit the negative-tag limit', fields.negativeTags.length <= LIMITS.negative_tags, true);
assert('the lyrics fit the prompt limit', fields.prompt.length <= LIMITS.prompt, true);
assert('the style and the negatives do NOT fit one field together',
    fields.style.length + fields.negativeTags.length > LIMITS.tags, true);
assert('they fit as two separate fields',
    fields.style.length <= LIMITS.tags && fields.negativeTags.length <= LIMITS.negative_tags, true);

// 3. The arrangement.
process.stderr.write('3. the arrangement\n');
assert('six movements', kai.arrangement.length, 6);
assert('it opens with The Empty Hall', kai.arrangement[0].title, 'The Empty Hall');
assert('it ends with Unfinished Light', kai.arrangement[5].title, 'Unfinished Light');
assert('every movement has a clock time', kai.arrangement.every((s) => /^\d+:\d\d$/.test(s.start) && /^\d+:\d\d$/.test(s.end)), true);
assert('every movement has a direction', kai.arrangement.every((s) => s.direction.length > 0), true);

// The times are contiguous and ascending.
const starts = kai.arrangement.map((s) => s.start);
assert('the times ascend', starts, ['0:00', '0:35', '1:15', '2:00', '2:45', '3:30']);

// 4. The lyrics field obeys the house rules.
process.stderr.write('4. the lyrics field\n');
const lyrics = arrangementLyrics(kai);
const lines = lyrics.split('\n').filter((l) => l.trim());
assert('one line per movement', lines.length, 6);
assert('every line is a bracketed directive', lines.every((l) => l.trim().startsWith('[')), true);
assert('every line carries its clock time', lines.every((l) => /\d+:\d\d-\d+:\d\d/.test(l)), true);
assert('every line carries its movement title', lines.every((l) => /The Empty Hall|Uneven Footsteps|Sixteen Breaths|Fractured Conversation|The Room Opens|Unfinished Light/.test(l)), true);
assert('no line is a sung lyric', lines.filter((l) => !l.trim().startsWith('[')).length, 0);

// The meter goes in the STYLE BOX, not only in the tags.
assert('the meter is in the style box', /Alternating 4\/4 and 7\/8 phrases/.test(kai.style), true);
assert('the tempo is in the style box', /105 BPM/.test(kai.style), true);

// And the house's exclusions.
process.stderr.write('5. the exclusions\n');
const negatives = kai.negativeTags;
for (const n of ['EDM', 'synth bass', 'cinematic trailer brass', 'aggressive swing',
    'bebop shredding', 'glossy studio production', 'quantized drums',
    'exaggerated crescendos', 'pop chord progressions', 'vocals', 'autotune',
    'artificial orchestration']) {
    assert(`"${n}" is excluded`, negatives.includes(n), true);
}
// And the style says no vocals too.
assert('the style itself forbids vocals', /no vocals/.test(kai.style), true);

// 6. The house's own variation.
process.stderr.write('6. the suggested variation\n');
const v = variationFields(kai);
assert('it has a name', v.title, 'Nordic Chamber Big Band x Raw Kai Flugelhorn x Asymmetric Jazz Minimalism');
assert('its style fits', v.style.length <= LIMITS.tags, true);
assert('it keeps the flugelhorn as the centre', /flugelhorn as the emotional center/.test(v.style), true);
assert('it keeps the asymmetry', /natural hesitation rather than a mathematical exercise/.test(v.style), true);
assert('it has the note', v.note.length > 0, true);

// 7. The architecture table.
process.stderr.write('7. the musical architecture\n');
for (const key of ['tempo', 'meter', 'brass', 'saxophones', 'piano', 'bass', 'drums', 'harmony', 'recording']) {
    assert(`"${key}" is specified`, !!kai.architecture[key], true);
}
assert('the suggested weirdness is 60%', kai.suggested.weirdness, '60%');
assert('the suggested style influence is 80%', kai.suggested.styleInfluence, '80%');

process.stderr.write(`\n[suno-kai-dna.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
