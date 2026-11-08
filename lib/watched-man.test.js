#!/usr/bin/env node
'use strict';
// lib/watched-man.test.js
//
// The THE WATCHED MAN registry — its own contract.
//
// The repo's rule about tests: an assertion that CANNOT fail is worse
// than no test. So every assertion here has a mutation that breaks
// it, and the mutations were run against the real code.

const fs = require('node:fs');
const path = require('node:path');

const {
    load, frames, frame, bySlug, acts, actFrames,
    buildFrame, buildPrompts, buildPack, renderDoc,
    dnaClause, identityClause, REGISTRY_PATH,
} = require('./watched-man.js');
const { extractPrompts } = require('./mj-submitter.js');
const { buildFullPrompt } = require('./mj-flags.js');
const { findViolations } = require('./prompt-lint-core.js');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));
const DEFAULT_ARGS = (CONFIG.mj && CONFIG.mj.defaultArgs) || '';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; return true; }
    failed++;
    failures.push(`${name}\n      actual   : ${JSON.stringify(actual)}\n      expected : ${JSON.stringify(expected)}`);
    return false;
}
function ok(name, cond, detail) {
    if (cond) { passed++; return true; }
    failed++;
    failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
    return false;
}

const reg = load();
const list = frames(reg);

console.log('\n1. the registry shape');
assert('twelve frames', list.length, 12);
assert('the numbers are 1..12', list.map(f => f.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
assert('three acts', acts(reg).length, 3);
assert('the acts cover every frame exactly once',
    acts(reg).flatMap(a => a.frames), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
assert('every frame belongs to an act',
    list.filter(f => !acts(reg).some(a => a.frames.includes(f.n))).length, 0);
assert('the slugs are unique', new Set(list.map(f => f.slug)).size, 12);
assert('every frame has prose', list.filter(f => !f.prose || f.prose.length < 40).length, 0);
assert('every frame has a camera clause', list.filter(f => !f.camera || f.camera.length < 20).length, 0);
assert('every frame has a light clause', list.filter(f => !f.light || f.light.length < 8).length, 0);
assert('every frame has a beat', list.filter(f => !f.beat || f.beat.length < 20).length, 0);

console.log('\n2. the MEASURED style reference');
assert('the style reference is the artist\'s own', reg.styleReference, 'https://s.mj.run/cATLXOMsR-o');
assert('it travels as --sref', reg.styleReferenceFlag, '--sref');
ok('the reference is a URL the account uses',
    /^https:\/\/s\.mj\.run\/[\w-]+$/.test(reg.styleReference), reg.styleReference);
ok('the reference is NOT the numeric studio styles',
    !/^\d+$/.test(reg.styleReference),
    'a numeric id would be the studio\'s own generated style, not the artist\'s job');
ok('the reference appears in the source job\'s command (measured)',
    reg.styleReference === 'https://s.mj.run/cATLXOMsR-o',
    'the artist\'s job c6403638 carries exactly this --sref');

console.log('\n3. the MEASURED flags');
assert('the flags', reg.flags, '--ar 16:9 --raw --v 8.2');
ok('the flags carry --raw (the artist\'s spelling of the style slot)', /--raw\b/.test(reg.flags));
ok('the flags carry --v 8.2 (the account\'s working engine)', /--v 8\.2\b/.test(reg.flags));
ok('the flags carry --ar 16:9', /--ar 16:9/.test(reg.flags));
ok('NO --profile is pinned (it rides on only 6 of 200 feed jobs, so it is a default, not a choice)',
    !/--profile\b/.test(reg.flags), 'pinning a default pins an accident');
ok('NO --style is pinned alongside --raw (that is the duplicated-flag bug)',
    !/--style\b/.test(reg.flags), '--raw owns the style slot');
ok('NO --cref / --edit (the set renders plain)', !/--(cref|edit|oref)\b/.test(reg.flags));
assert('the set renders plain', reg.renderPlain, true);

console.log('\n4. the DNA and the identity clause');
ok('the DNA is present on every frame',
    list.every(f => buildFrame(f.n, { reg }).includes(dnaClause(reg))));
ok('the identity clause is present on every frame',
    list.every(f => buildFrame(f.n, { reg }).includes(identityClause(reg))));
assert('the identity clause is constant', identityClause(reg), reg.identity);
ok('the identity clause denies the jacket the house clause denies',
    /no denim jacket/.test(reg.identity) && /no leather jacket/.test(reg.identity));
// The two clauses are DIFFERENT strings, so a mutation that swaps one
// for the other has to be caught. Asserting only "the identity clause
// is present" would not catch it — the DNA would be present too, and
// the identity clause would be present TWICE.
assert('the DNA clause is the registry\'s dnaProse', dnaClause(reg), reg.dnaProse);
ok('the DNA and the identity clause are different clauses',
    dnaClause(reg) !== identityClause(reg),
    'a mutation that returns the identity clause from dnaClause() must be caught');
ok('no frame carries the identity clause TWICE',
    list.every(f => {
        const p = buildFrame(f.n, { reg });
        return p.split(identityClause(reg)).length - 1 === 1;
    }),
    'the identity clause appears exactly once per frame');
ok('the DNA carries the house palette and texture',
    /Kodak 500T/.test(dnaClause(reg)) && /tobacco browns/.test(dnaClause(reg)) && /halation/.test(dnaClause(reg)),
    'the DNA is the house look, not a generic phrase');

console.log('\n5. the composed prompt');
const p1 = buildFrame(1, { reg });
ok('the prose comes first', p1.startsWith(reg.frames[0].prose.slice(0, 40)));
ok('the camera clause is present', p1.includes(reg.frames[0].camera));
ok('the style reference is present', p1.includes(`--sref ${reg.styleReference}`));
ok('the flags come last', p1.trim().endsWith(reg.flags));
ok('the style reference comes BEFORE the flags',
    p1.indexOf('--sref') < p1.indexOf(reg.flags),
    'MJ resolves a doubled flag by taking the last, so the order is load-bearing');
assert('one --sref per prompt', (p1.match(/--sref/g) || []).length, 1);
assert('one --ar per prompt', (p1.match(/--ar/g) || []).length, 1);
assert('one --v per prompt', (p1.match(/--v\b/g) || []).length, 1);

console.log('\n6. the camera rules — no distance, no orientation, a place');
const pack = buildPack({ reg });
// The house rules, measured (docs/VIDEO-FRAMING.md §4, §5 and the
// 2026-11-05 camera grid):
//
//   * a DISTANCE clause is ignored
//   * an ORIENTATION clause is ignored (the high angle, the top-down
//     flat lay and the dutch tilt all came back LEVEL)
//   * a PLACE clause lands
//   * the word "camera" in the PROSE renders a literal camera body
//
// So the camera clause may say where the camera stands ("the camera
// square on at the height of the table"), and must not ask for a
// distance or an orientation.
const CAMERA_BAD = [
    // distances
    /\bwide\b/i, /\bextreme close-?up\b/i, /\bclose-?up\b/i, /\bextreme\b/i,
    /\bwide shot\b/i, /\blong shot\b/i, /\bmedium shot\b/i, /\bdistant\b/i,
    // orientations
    /\bfrom above\b/i, /\bfrom directly overhead\b/i, /\bseen from above\b/i,
    /\btop-?down\b/i, /\bdutch\b/i, /\btilted\b/i, /\bdiagonal\b/i,
    /\bhigh angle\b/i, /\bbird'?s eye\b/i, /\boverhead\b/i,
    /\bdirectly overhead\b/i, /\bflat lay\b/i,
];
for (const f of list) {
    const c = f.camera;
    for (const re of CAMERA_BAD) {
        ok(`frame ${f.n} camera clause carries no ${re}`,
            !re.test(c), `"${c}"`);
    }
}
ok('the camera clause names a PLACE (where the camera stands, or what it sees from there)',
    list.every(f => /\bthe camera\b/.test(f.camera) || /\bseen from\b/.test(f.camera)),
    'every camera clause should say where the camera stands');
// The word "camera" in the PROSE renders a literal camera body
// (measured 2026-11-05: shot 11 came back as a camera body on a
// table). The check is on the PROSE, not the camera clause — the
// camera clause is allowed to say where the camera stands.
//
// It matches ANY camera noun, not just "a camera": "a security
// camera" is the same failure.
ok('no prose names a camera as a SUBJECT (it renders a literal camera body)',
    list.every(f => !/\bcameras?\b/i.test(f.prose)),
    list.filter(f => /\bcameras?\b/i.test(f.prose)).map(f => `frame ${f.n}: ${f.prose}`).join(' | '));
ok('the camera CLAUSE may say where the camera stands',
    list.some(f => /\bthe camera\b/.test(f.camera)),
    'the camera clause is where the camera\'s place belongs');
ok('no prose names a film stock (it renders a film strip with KODAK lettering)',
    list.every(f => !/\b(kodak|film stock|fuji|ilford|ektachrome)\b/i.test(f.prose)),
    'measured 2026-11-05: four of seven shots came back with a film-strip border');
// Count the light SOURCES, not every mention of a light word.
//
//   "one flickering fluorescent tube nearest the camera, the rest of
//    the corridor dimmer"   → ONE source (the tube)
//   "one window's daylight behind, the table's front in shadow" → ONE
//    source (the daylight; the window is the aperture, not a source)
//   "the flat light of a sky just before dawn, no lamp, no sun" → ONE
//
// So the pattern binds the adjective to its noun ("fluorescent tube"
// is one source, not two) and the count is of the FIRST clause — the
// one that names what is doing the lighting. The trailing clauses
// only say what falls away from it.
const SOURCE_NOUN = /\b(?:(?:fluorescent|led|tungsten|street|neon|sun|moon|hard|soft|overhead|weak|single)\s+)?(?:lamp|light|lit|bulb|tube|panel|source|sunlight|daylight|streetlight|sign|candle|fire|skylight)\b/gi;
const lightSources = (s) => {
    const first = String(s).split(',')[0];
    return (first.match(SOURCE_NOUN) || []).length;
};
ok('every frame names a light source',
    list.every(f => lightSources(f.light) >= 1),
    list.filter(f => lightSources(f.light) === 0).map(f => `frame ${f.n}: ${f.light}`).join(' | '));
ok('no frame names TWO light sources',
    list.every(f => lightSources(f.light) <= 1),
    list.filter(f => lightSources(f.light) > 1).map(f => `frame ${f.n}: ${f.light}`).join(' | '));

console.log('\n7. the pack round-trips through the SUBMITTER\'S OWN parser');
// The parser reads a FILE, so the pack is written to a scratch path
// and parsed from there — the real round trip, not a re-implementation
// of the parse.
const os = require('node:os');
const packFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watched-man-')), 'watched-man.md');
fs.writeFileSync(packFile, pack, 'utf8');
const parsed = extractPrompts(packFile);
assert('the pack yields twelve prompts', parsed.length, 12);
assert('the pack\'s prompts are the composed prompts, minus the --ar the parser surfaces separately',
    parsed.map(p => p.text), buildPrompts({ reg }).map(t => t.replace('--ar 16:9', '')));
ok('every packed prompt carries its own --ar', parsed.every(p => p.ar === '16:9'),
    'the parser surfaces the ratio separately');
assert('one bullet per frame in the pack',
    (pack.match(/^- /gm) || []).length, 12);

console.log('\n8. the pack round-trips through the SUBMITTER\'S OWN composer');
const composed = parsed.map(p => buildFullPrompt(p.text, p.ar, DEFAULT_ARGS));
ok('every composed command carries exactly ONE --ar',
    composed.every(c => (c.match(/--ar/g) || []).length === 1));
ok('the --ar is LAST in every composed command',
    composed.every(c => /--ar 16:9$/.test(c.trim())),
    'MJ honours the LAST --ar it sees');
ok('the config\'s --style AND its coupled --s are dropped (the prompt carries --raw)',
    composed.every(c => !/--style\b/.test(c) && !/(^|\s)--s\s/.test(c)),
    '--raw owns the style slot; two --s flags means the config silently wins');
ok('the style reference survives the composer',
    composed.every(c => c.includes(`--sref ${reg.styleReference}`)));
assert('one --sref per composed command',
    composed.filter(c => (c.match(/--sref/g) || []).length === 1).length, 12);
ok('the artist\'s --v 8.2 survives', composed.every(c => /--v 8\.2/.test(c)));

console.log('\n9. the acceptance matcher needs DISTINCT openings');
// The matcher reads the first 64 characters of the composed prompt.
// A shared prefix collapses the excerpts and N prompts get attributed
// to a few task ids (measured 2026-09-24 and 2026-11-05).
for (const len of [40, 48, 64]) {
    const openings = composed.map(c => c.slice(0, len));
    assert(`the composed openings are distinct at ${len} characters`,
        new Set(openings).size, 12);
}

console.log('\n10. the identity lint');
const violations = parsed.flatMap(p => findViolations(p.text));
assert('no prompt names the subject\'s race or ethnicity', violations.length, 0);

console.log('\n11. the doc');
const doc = renderDoc({ reg });
ok('the doc has a heading per frame',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every(n => doc.includes(`### ${String(n).padStart(2, '0')} —`)));
ok('the doc has a heading per act', acts(reg).every(a => doc.includes(`## ${a.title}`)));
ok('the doc carries the style reference', doc.includes(reg.styleReference));
ok('the doc carries the flags', doc.includes(reg.flags));
ok('the doc has no "undefined" (a group-label bug once rendered it in every heading)',
    !doc.includes('undefined'));
ok('the doc has no "null" cell (the unpicked-cell bug)',
    !/cell[^\n]*null/i.test(doc));

console.log('\n12. the generator is deterministic');
assert('the pack regenerates byte-identically', buildPack({ reg }), pack);
assert('the doc regenerates byte-identically', renderDoc({ reg }), doc);
assert('the prompts regenerate byte-identically', buildPrompts({ reg }), buildPrompts({ reg }));

console.log('\n13. the lookups');
assert('a frame by number', frame(7, reg).slug, 'dark-apartment');
assert('a frame by slug', bySlug('rooftop-final', reg).n, 12);
assert('a missing frame is null', frame(99, reg), null);
assert('an act\'s frames', actFrames('act-2', reg).map(f => f.n), [5, 6, 7, 8]);
assert('a missing act is empty', actFrames('act-9', reg).length, 0);

console.log('\n14. the plain-render path');
const plain = buildFrame(1, { reg, ref: false });
ok('the plain path drops the style reference', !plain.includes('--sref'));
ok('the plain path keeps the flags', plain.includes(reg.flags));
ok('the plain path keeps the DNA', plain.includes(dnaClause(reg)));

console.log('\n15. the registry is the single source');
const onDisk = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
assert('the on-disk registry is what the module loads', onDisk, reg);
ok('the registry names the registry file', REGISTRY_PATH.endsWith('watched-man.json'));

console.log('');
if (failed) {
    console.log(`  ${passed} passed, ${failed} failed\n`);
    for (const f of failures) console.log('  FAIL  ' + f + '\n');
    process.exit(1);
}
console.log(`  ${passed} passed, 0 failed\n`);
