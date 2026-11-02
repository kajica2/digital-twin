#!/usr/bin/env node
'use strict';
// lib/suno-humanize.test.js
//
// The HUMANIZE suffix — the raw/unpolished layer.
//
// WHY THIS IS A SEPARATE THING
//
// A style's descriptor says what the music IS. The raw layer says what
// it is NOT: not quantised, not mastered, not polished, not clean. And
// Suno's default sound IS polished — so a style without a raw clause
// comes back smooth, whatever the descriptor asked for.
//
// It is a SUFFIX because it composes AFTER the descriptor, and because
// the house rule is that the descriptor always wins when the two
// exceed the server's limit.
//
// THE VOCABULARY IS MEASURED, NOT INVENTED
//
// The account's own raw styles already carry a vocabulary that is much
// more concrete than a generic "raw and imperfect":
//
//   close-mic spit, lip buzz, unquantized timing drift
//   valve clicks, lip noise, tape saturation, human drift
//   live one-take room recording, slight timing imperfections
//   no autotune, no mastering, no compression, no quantized
//
// Those phrases are what Suno has been shown to respond to on THIS
// account, so the suffixes are built from them rather than from
// adjectives.
//
// TWO FIELDS, NOT ONE
//
// The raw clause goes in `tags` (after the descriptor) and the
// exclusions go in `negative_tags` — the house's own rule for Pro and
// Premier. MEASURED: the house's own "UNPLUGGED IMPERFECT TRUMPET"
// style is exactly 1000 characters, which is the tag limit — so the
// exclusions have to live somewhere else.
//
//   node lib/suno-humanize.test.js

const {
    HUMANIZE_SUFFIXES,
    DEFAULT_SUFFIX,
    humanizeText,
    humanizeFields,
    listSuffixes,
    LIMITS,
} = require('./suno-humanize.js');

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

// 1. The suffixes exist.
process.stderr.write('1. the suffixes\n');
const names = listSuffixes();
assert('there is at least one', names.length >= 3, true);
assert('raw is one of them', names.includes('raw'), true);
assert('unplugged is one of them', names.includes('unplugged'), true);
assert('one-take is one of them', names.includes('one-take'), true);

// 2. Every suffix says raw, unpolished and imperfect — because those
//    are the three words the brief names.
process.stderr.write('2. every suffix says raw, unpolished and imperfect\n');
for (const key of names) {
    const s = HUMANIZE_SUFFIXES[key];
    const text = `${s.suffix} ${(s.negatives || '')}`.toLowerCase();
    assert(`"${key}" says raw or unplugged`, /raw|unplugged|one-take/.test(text), true);
    assert(`"${key}" says unpolished or its equivalent`, /unpolish|no gloss|no glossy|no mastering|no compression/.test(text), true);
    assert(`"${key}" says imperfect`, /imperfect|honest|mistakes|rough/.test(text), true);
}

// 3. The vocabulary is CONCRETE — the measured phrases, not adjectives.
process.stderr.write('3. the vocabulary is concrete\n');
const raw = HUMANIZE_SUFFIXES.raw;
assert('it names the microphone', /close-mic/i.test(raw.suffix), true);
assert('it names timing drift', /drift|imperfection|unquantiz/i.test(raw.suffix), true);
assert('it names the tape', /tape/i.test(raw.suffix), true);
assert('it keeps mistakes', /honest mistakes|mistakes left in/i.test(raw.suffix), true);

// The exclusions are the house's own.
for (const n of ['no autotune', 'no mastering', 'no compression', 'no quantized']) {
    assert(`the raw suffix excludes "${n}"`, raw.negatives.includes(n), true);
}

// 4. The composition.
process.stderr.write('4. the composition\n');
const descriptor = 'Nordic contemporary modern jazz big band, 16-piece acoustic ensemble, muted trumpets';
const composed = humanizeText({ descriptor, suffix: 'raw' });
assert('the descriptor comes FIRST', composed.startsWith(descriptor), true);
assert('the suffix comes after', composed.indexOf('raw unprocessed') > descriptor.length, true);
assert('the two are joined by a comma', composed.includes(`${descriptor}, `), true);
assert('it fits the tag limit', composed.length <= LIMITS.tags, true);

// The humanize layer keeps its TAIL when the two overflow — because
// the tail IS the layer's meaning. MEASURED: the KAI master style is
// 856 characters and the raw suffix is 176, and with the descriptor
// winning the style came out ending "dry close-mic roo".
process.stderr.write('5. the humanize layer keeps its tail\n');
const huge = 'x'.repeat(995);
const overflow = humanizeText({ descriptor: huge, suffix: 'raw' });
assert('it is cut to the limit', overflow.length <= LIMITS.tags, true);
assert('the suffix survives WHOLE', overflow.endsWith(HUMANIZE_SUFFIXES.raw.suffix), true);
assert('the descriptor gave way', overflow.startsWith('x'), true);

// The real case: the KAI master style (856) plus the raw suffix (176)
// is 1034 — over the limit.
process.stderr.write('5b. the KAI master style fits with the raw layer\n');
const kaiStyle = 'Nordic contemporary modern jazz big band, 16-piece acoustic ensemble, restrained muted trumpets, '
    + 'soft trombone voicings, breathy saxophone section, lyrical low-register flugelhorn, intimate piano, '
    + 'resonant upright bass, delicate ride cymbal and brushed snare. Alternating 4/4 and 7/8 phrases, '
    + 'medium tempo around 105 BPM, subtle polyrhythmic displacement, sparse unresolved modal jazz harmony, '
    + 'suspended chords, melancholic Scandinavian atmosphere. Minimalist orchestral writing, slowly evolving '
    + 'motifs, understated brass counterpoint, conversational improvisation, delicate ensemble swells, '
    + 'spacious pauses. Recorded live to two-track in a natural concert hall, authentic room reflections, '
    + 'audible breathing, loose human timing, unprocessed acoustic instruments, wide dynamic range, '
    + 'warm analog texture. Instrumental only, no vocals, no commercial polish';
const kaiHuman = humanizeText({ descriptor: kaiStyle, suffix: 'raw' });
assert('it fits the limit', kaiHuman.length <= LIMITS.tags, true);
assert('the raw layer is intact at the end', kaiHuman.endsWith('honest mistakes left in'), true);
assert('the meter survived', /7\/8/.test(kaiHuman), true);
assert('the ensemble survived', /flugelhorn/.test(kaiHuman), true);
assert('the tail is not a broken word', /roo\b/.test(kaiHuman), false);
assert('the descriptor starts at a clause boundary', /^\s*[A-Za-z0-9]/.test(kaiHuman), true);
assert('it does not start mid-phrase', /^[a-z]/.test(kaiHuman), false);

// A style with no descriptor is just the suffix.
assert('no descriptor means just the suffix', humanizeText({ descriptor: '', suffix: 'raw' }), raw.suffix);

// 6. The two fields.
process.stderr.write('6. the two fields\n');
const fields = humanizeFields({ descriptor, suffix: 'raw' });
assert('the style field carries the composition', fields.style, composed);
assert('the negative field carries the exclusions', fields.negativeTags, raw.negatives);
assert('the negatives fit their own limit', fields.negativeTags.length <= LIMITS.negative_tags, true);
// The house's own most-developed raw style is exactly at the limit.
const fullFields = humanizeFields({ descriptor: kaiStyle, suffix: 'raw' });
assert('a full-length style still fits the tag limit', fullFields.style.length <= LIMITS.tags, true);
assert('but the style and the exclusions do NOT fit one field together',
    fullFields.style.length + fullFields.negativeTags.length > LIMITS.tags, true);

// 7. A style that ALREADY has a humanize clause is not doubled.
process.stderr.write('7. no doubling\n');
const already = `${descriptor}, raw unprocessed recording, honest mistakes left in`;
const once = humanizeText({ descriptor: already, suffix: 'raw' });
assert('it is not applied twice', (once.match(/raw unprocessed recording/g) || []).length, 1);

// 8. The default suffix.
process.stderr.write('8. the default\n');
assert('the default is raw', DEFAULT_SUFFIX, 'raw');
assert('an unknown suffix falls back to the default', humanizeText({ descriptor, suffix: 'nope' }), humanizeText({ descriptor, suffix: 'raw' }));

process.stderr.write(`\n[suno-humanize.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
