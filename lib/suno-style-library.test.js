#!/usr/bin/env node
'use strict';
// lib/suno-style-library.test.js
//
// The Anchor Five + Ten Extensions registry.
//
// A preset here is a Suno STYLE — a self-contained style text to paste
// into the style field, or to save as a custom style in the account.
//
// What the tests pin:
//   * every preset fits the server's limits (1000-char tags, 100-char
//     title) — a style that overflows is silently TRUNCATED by the
//     client and the last clause (usually the imperfections) is what
//     goes;
//   * the header line is built from the preset's own fields, so the
//     tempo/mood/role can never drift from the descriptor;
//   * the descriptor is preserved VERBATIM — the house rule is that the
//     text is the artist's, and a tool that rewords it is a tool that
//     loses the details (the flubbed attack, the dropout, the breath).
//
//   node lib/suno-style-library.test.js

const {
    loadLibrary,
    findPreset,
    styleHeader,
    styleText,
    styleTitle,
    LIMITS,
} = require('./suno-style-library.js');

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

const lib = loadLibrary();

// 1. The library itself.
process.stderr.write('1. the library\n');
assert('it loads', Array.isArray(lib.presets), true);
assert('it holds fifteen presets', lib.presets.length, 15);
assert('five anchors', lib.presets.filter((p) => p.group === 'anchor-five').length, 5);
assert('ten extensions', lib.presets.filter((p) => p.group === 'extensions').length, 10);

// 2. The house order is preserved.
process.stderr.write('2. the house order\n');
assert('the first is Midnight Solstice', lib.presets[0].name, 'Midnight Solstice');
assert('the fifth is Peak Hour Prayer', lib.presets[4].name, 'Peak Hour Prayer');
assert('the sixth is Room Tone', lib.presets[5].name, 'Room Tone');
assert('the last is Sunrise Procession', lib.presets[14].name, 'Sunrise Procession');
assert('the indexes are 1..15', lib.presets.map((p) => p.index), lib.presets.map((_, i) => i + 1));

// 3. The limits — this is the one that bites.
process.stderr.write('3. the server limits\n');
for (const p of lib.presets) {
    const text = styleText(p);
    assert(`"${p.name}" fits the ${LIMITS.tags}-char tag limit`, text.length <= LIMITS.tags, true);
    assert(`"${p.name}" fits the ${LIMITS.title}-char title limit`,
        styleTitle(p).length <= LIMITS.title, true);
}
// And there is headroom, not a technicality.
const longest = lib.presets.map((p) => styleText(p).length).sort((a, b) => b - a)[0];
assert('the longest style has real headroom', longest <= 800, true);

// 4. The header is built from the preset's own fields.
process.stderr.write('4. the header\n');
const ms = findPreset('midnight-solstice');
assert('it is found by slug', !!ms, true);
assert('it is found by name', findPreset('Midnight Solstice').slug, 'midnight-solstice');
assert('it is not found by a wrong name', findPreset('nope'), null);
const header = styleHeader(ms);
assert('it opens with a bracketed title', header.startsWith('[Midnight Solstice — Deep House / Modal Jazz]'), true);
assert('it carries the tempo', /120 BPM/.test(header), true);
assert('it carries the mood', /introspective/.test(header), true);
assert('it carries the role', /meditative narrator/.test(header), true);
assert('the tempo, mood and role are on one line', header.split('\n')[1].split(' · ').length, 3);

// A free tempo is still a tempo.
assert('a Free tempo is carried', /Free/.test(styleHeader(findPreset('tape-memory'))), true);
assert('a Rubato tempo is carried', /Rubato/.test(styleHeader(findPreset('room-tone'))), true);

// 5. The descriptor is VERBATIM.
process.stderr.write('5. the descriptor is verbatim\n');
for (const p of lib.presets) {
    const text = styleText(p);
    assert(`"${p.name}" carries its descriptor unchanged`, text.includes(p.descriptor), true);
}
// The imperfections survive — they are the point of the house.
const raw = findPreset('tape-reel');
assert('the tape wear survives', /one accidental splice audible/.test(styleText(raw)), true);
assert('the no-clean-fade survives', /no clean fade/.test(styleText(raw)), true);
const midnight = findPreset('midnight-solstice');
assert('the tape dropout survives', /one tape dropout near the second chorus/.test(styleText(midnight)), true);
assert('the room tone survives', /room tone framing the intro and outro/.test(styleText(midnight)), true);

// 6. The title.
process.stderr.write('6. the title\n');
assert('it is the name', styleTitle(ms), 'Midnight Solstice');
assert('it survives a long name', styleTitle({ name: 'x'.repeat(150) }).length, LIMITS.title);

// 7. The tags limit is enforced, not assumed.
process.stderr.write('7. an over-long style is cut, not sent\n');
const huge = { name: 'Huge', genre: 'G', tempo: 'T', mood: 'M', role: 'R', descriptor: 'y'.repeat(2000) };
assert('the text is cut to the limit', styleText(huge).length <= LIMITS.tags, true);
assert('the header survives the cut', styleText(huge).startsWith('[Huge — G]'), true);

process.stderr.write(`\n[suno-style-library.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
