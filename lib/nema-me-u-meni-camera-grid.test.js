#!/usr/bin/env node
'use strict';
// lib/nema-me-u-meni-camera-grid.test.js
//
// The contract the renderer depends on, asserted on the camera grid.
//
// Pure functions, no network, no credentials — the same shape as the
// repo's other registry tests (lib/nema-me-u-meni.test.js).
//
// The assertions here are the MEASURED rules, pinned so the set cannot
// silently drift back into the failure modes:
//
//   1. the set renders PLAIN — no --edit, no --cref (an attachment
//      decides the distance and the camera clause is disobeyed)
//   2. no camera clause contains the word "camera" (it renders a
//      literal camera body)
//   3. no borrowed prose carries a DISTANCE word (a distance clause is
//      ignored, and it fights the grid's own camera)
//   4. each frame names exactly ONE key light
//   5. the twelve cameras are each used EXACTLY once
//   6. each flag is resolved exactly once, the artist's winning
//   7. the pack round-trips through the SUBMITTER'S OWN parser, and its
//      openings are distinct (a shared prefix collapses the acceptance
//      matcher's excerpt)
//   8. the identity lint passes

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
    load, frames, frame, bySlug, cameras, camera, cameraOf,
    buildFrame, buildPrompts, buildPack, renderDoc, dnaClause, identityClause,
} = require('./nema-me-u-meni-camera-grid.js');

const { extractPrompts, buildFullPrompt } = require('./mj-submitter.js');

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { pass++; process.stdout.write(`  ✓ ${label}\n`); }
    else { fail++; process.stdout.write(`  ✗ ${label}\n`); }
}

// A flag boundary, not a bare word: "--s" must be counted as a FLAG, so
// it cannot match the "s" inside "--cw" or the "s" of "s.mj.run".
const countFlag = (text, flag) => (text.match(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, 'g')) || []).length;

const reg = load();
const list = frames(reg);

// ---------------------------------------------------------------------
// 1. The registry's shape
// ---------------------------------------------------------------------
console.log('\n1. the registry');

check('the registry loads', !!reg && reg.id === 'nema-me-u-meni-camera-grid');
check('it has a title', !!reg.title && reg.title.length > 0);
check('it names the master template as its source', reg.sourceRegistry === 'nema-me-u-meni');
check('it has the visual DNA', !!reg.visualDna && /500T/.test(reg.visualDna));
check('it has the identity clause', /no red coat/.test(reg.identity));
check('it has the artist\'s flags', /--ar 16:9/.test(reg.flags) && /--s 75/.test(reg.flags) && /--chaos 8/.test(reg.flags));
check('it is marked as a plain render', reg.renderPlain === true);

// ---------------------------------------------------------------------
// 2. Twelve frames, twelve cameras, three acts of four
// ---------------------------------------------------------------------
console.log('\n2. the frames and the cameras');

check('there are twelve frames', list.length === 12);
check('they are numbered 1..12', list.every((f, i) => f.n === i + 1));
check('the slugs are unique', new Set(list.map(f => f.slug)).size === 12);
check('every frame has a title', list.every(f => f.title && f.title.length));
check('every frame has a quote', list.every(f => f.quote && f.quote.length));
check('every frame has prose', list.every(f => f.prose && f.prose.length > 80));
check('every frame has a camera clause', list.every(f => f.camera && f.camera.length > 40));
check('every frame names a camera number', list.every(f => Number.isInteger(f.cameraN)));

check('there are twelve cameras', cameras(reg).length === 12);
check('the cameras are numbered 1..12', cameras(reg).every((c, i) => c.n === i + 1));
check('every camera has a name and a note', cameras(reg).every(c => c.name && c.note));

check('there are three acts', reg.acts.length === 3);
check('the acts cover 12 frames', reg.acts.reduce((n, a) => n + a.frames.length, 0) === 12);
check('every frame belongs to an act', reg.acts.flatMap(a => a.frames).sort((a, b) => a - b)
    .every((n, i) => n === i + 1));

// THE GRID: each camera used EXACTLY once. This is the whole point of
// the set — twelve beats, twelve camera positions, none repeated and
// none skipped.
const used = list.map(f => f.cameraN).sort((a, b) => a - b);
check('every camera is used exactly once', JSON.stringify(used) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
check('cameraOf() resolves every frame', list.every(f => !!cameraOf(f, reg)));
check('cameraOf() gives the camera the frame names', list.every(f => cameraOf(f, reg).n === f.cameraN));

// The beats must be the MASTER TEMPLATE's beats — same order, same
// titles, same quotes. Otherwise this is a different film.
const master = require('./nema-me-u-meni.js');
const masterFrames = master.frames();
check('the beats are the master template\'s, in the same order',
    list.every((f, i) => f.n === masterFrames[i].n && f.slug === masterFrames[i].slug));
check('the quotes are the master template\'s',
    list.every((f, i) => f.quote === masterFrames[i].quote));
check('the titles are the master template\'s',
    list.every((f, i) => f.title === masterFrames[i].title));
check('the DNA is the master template\'s, byte for byte',
    reg.dnaProse === master.dnaClause());
check('the identity clause is the master template\'s, byte for byte',
    reg.identity === master.identityClause());

// ---------------------------------------------------------------------
// 3. THE PLAIN-RENDER RULE — no attachment
// ---------------------------------------------------------------------
console.log('\n3. the plain-render rule');

const prompts = buildPrompts({ reg });

check('the prompts carry NO --edit', prompts.every(p => countFlag(p, '--edit') === 0));
check('the prompts carry NO --cref', prompts.every(p => countFlag(p, '--cref') === 0));
check('the prompts carry NO --oref', prompts.every(p => countFlag(p, '--oref') === 0));
check('the prompts carry NO --sref', prompts.every(p => countFlag(p, '--sref') === 0));
check('the registry names no character reference (there is none to carry)',
    reg.characterRef === undefined);

// The opt-in path exists and works, but the DEFAULT is plain.
const withRef = buildFrame(1, { reg, ref: true });
check('asking for a reference on a registry that has none adds no reference flag',
    !/--edit|--cref/.test(withRef));
check('the default is still plain', !/--edit/.test(buildFrame(1, { reg })));

// ---------------------------------------------------------------------
// 4. THE CAMERA CLAUSE — no "camera", place named, objects named
// ---------------------------------------------------------------------
console.log('\n4. the camera clause');

const cameraClauses = list.map(f => f.camera);
check('no camera clause contains the word "camera"',
    cameraClauses.every(c => !/\bcamera\b/i.test(c)));
check('no camera clause contains the word "shot"',
    cameraClauses.every(c => !/\bshot\b/i.test(c)));
check('every camera clause says where the picture is taken from',
    cameraClauses.every(c => /\b(seen|looked)\b/.test(c)));

// A clause naming an OBJECT IN THE FRAME lands; one naming a DISTANCE
// does not. So each camera clause must name something concrete.
const OBJECT_WORDS = ['table', 'window', 'wall', 'cup', 'telephone', 'door', 'picture',
    'frame', 'floor', 'sofa', 'room', 'facade', 'street', 'glass', 'reflection',
    'shoulder', 'face', 'traffic', 'pavement', 'packet', 'lamp', 'flugelhorn',
    'instrument', 'rooftops', 'sky', 'man', 'him', 'his', 'hand', 'figure', 'building',
    'crossing', 'signal', 'asphalt', 'packet', 'chair', 'doorway', 'piano'];
check('every camera clause names an object in the picture',
    cameraClauses.every(c => OBJECT_WORDS.some(w => new RegExp(`\\b${w}\\b`, 'i').test(c))));

// ---------------------------------------------------------------------
// 5. THE BORROWED PROSE CARRIES NO DISTANCE
// ---------------------------------------------------------------------
console.log('\n5. the borrowed prose');

const DISTANCE = /\b(wide|extreme close-up|close-up|closeup|long shot|medium shot|medium-wide|full shot|establishing shot|macro shot|telephoto shot|bird'?s eye|over-the-shoulder|profile view|front on|centred symmetrical|dutch tilt|whip pan|low-angle|high angle|aerial)\b/i;
const proseHits = list.filter(f => DISTANCE.test(f.prose)).map(f => f.n);
check('no frame\'s prose carries a distance word', proseHits.length === 0);
if (proseHits.length) process.stdout.write(`      (offenders: ${proseHits.join(', ')})\n`);

// The template's own distance words must not have survived the borrow.
// ('almost entirely dark' is a DARKNESS descriptor, not a distance, so
// it is deliberately not on this list.)
const masterDistance = /\b(wide static shot|extreme close-up|long shot through|low-angle street-level|view from outside|medium-wide view|intimate medium shot|vast wide shot|wide still shot)\b/i;
check('no frame\'s prose carries a template distance phrase',
    list.every(f => !masterDistance.test(f.prose)));

// ---------------------------------------------------------------------
// 6. ONE KEY LIGHT PER FRAME
// ---------------------------------------------------------------------
console.log('\n6. the key light');

const LIGHT = /\b(light|lights|lit|daylight|lamp|lit window|tungsten|fluorescent|afternoon|morning|gray sky|pale)\b/gi;
function lightSources(text) {
    // Count DISTINCT light sources, not occurrences of the word. A frame
    // naming one window and one lamp is two sources; a frame saying
    // "light" twice about the same source is one.
    const found = new Set();
    const patterns = [
        /\b(window light|weak morning light|morning light|cold daylight|daylight from a distant room|pale gray window light|flat gray daylight|fluorescent interior|late-afternoon light|the red signal|a tungsten lamp|a small tungsten lamp|weak tungsten light|one soft tungsten lamp|the first pale light of morning|warm indoor light|the lit window|a distant streetlight)\b/gi,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) found.add(m[0].toLowerCase());
    }
    return found;
}
const lightCounts = list.map(f => lightSources(f.prose).size);
check('every frame names at least one light source', lightCounts.every(n => n >= 1));
check('every frame names exactly ONE light source', lightCounts.every(n => n === 1));
if (!lightCounts.every(n => n === 1)) {
    list.forEach((f, i) => { if (lightCounts[i] !== 1) process.stdout.write(`      (frame ${f.n}: ${lightCounts[i]} sources — ${[...lightSources(f.prose)].join(' | ')})\n`); });
}

// The prose must not name a film stock — MEASURED 2026-11-05: stock
// nouns in the prose render a film-strip border with lettering down one
// edge. The texture lives in the DNA clause, once.
const STOCK = /\b(kodak|film stock|fuji|ilford|35mm|16mm|analog film)\b/i;
check('no frame\'s prose names a film stock', list.every(f => !STOCK.test(f.prose)));

// ---------------------------------------------------------------------
// 7. THE FLAGS — each resolved exactly once, the artist's winning
// ---------------------------------------------------------------------
console.log('\n7. the flags');

check('the prompt carries exactly one --ar', prompts.every(p => countFlag(p, '--ar') === 1));
check('the prompt carries exactly one --style', prompts.every(p => countFlag(p, '--style') === 1));
check('the prompt carries exactly one --s', prompts.every(p => countFlag(p, '--s') + countFlag(p, '--stylize') === 1));
check('the prompt carries exactly one --chaos', prompts.every(p => countFlag(p, '--chaos') === 1));
check('the prompt carries exactly one --hd', prompts.every(p => countFlag(p, '--hd') === 1));

check('the config\'s --s 21 never appears', prompts.every(p => !/--s\s+21/.test(p) && !/--stylize\s+21/.test(p)));
check('the artist\'s --s 75 survives', prompts.every(p => /--s 75/.test(p)));
check('the artist\'s --chaos 8 survives', prompts.every(p => /--chaos 8/.test(p)));

// And the composed command through the repo's OWN composer — the one the
// watcher and mj-web.js both use — must not reintroduce the config's --s.
const CONFIG_DEFAULT = '--ar 16:9 --style raw --s 21';
const composed = prompts.map(p => buildFullPrompt(p, null, CONFIG_DEFAULT));
check('the composed command carries exactly one --s',
    composed.every(c => countFlag(c, '--s') + countFlag(c, '--stylize') === 1));
check('the composed command carries exactly one --ar', composed.every(c => countFlag(c, '--ar') === 1));
check('the composed command carries exactly one --style', composed.every(c => countFlag(c, '--style') === 1));
check('the composed command keeps the artist\'s --s 75', composed.every(c => /--s 75/.test(c)));
check('the composed command keeps the artist\'s --chaos 8', composed.every(c => /--chaos 8/.test(c)));
check('the composed command keeps the artist\'s --ar 16:9', composed.every(c => /--ar 16:9/.test(c)));
check('the composed command keeps the artist\'s --style raw', composed.every(c => /--style raw/.test(c)));
check('the composed command carries NO reference flag',
    composed.every(c => countFlag(c, '--edit') === 0 && countFlag(c, '--cref') === 0));

// ---------------------------------------------------------------------
// 8. THE PACK round-trips through the SUBMITTER'S OWN parser
// ---------------------------------------------------------------------
console.log('\n8. the pack');

const pack = buildPack({ reg });
const tmp = path.join(REPO, '.nema-grid-pack-test.md');
fs.writeFileSync(tmp, pack);
const extracted = extractPrompts(tmp);
fs.unlinkSync(tmp);

check('the pack parses to twelve prompts', extracted.length === 12);
check('every parsed prompt carries the identity clause',
    extracted.every(e => e.text.includes(reg.identity)));
check('every parsed prompt carries the DNA',
    extracted.every(e => e.text.includes(dnaClause(reg))));
check('every parsed prompt carries the artist\'s ratio', extracted.every(e => e.ar === '16:9'));
check('every parsed prompt carries the artist\'s remaining flags',
    extracted.every(e => /--s 75/.test(e.text) && /--chaos 8/.test(e.text) && /--style raw/.test(e.text)));
check('every parsed prompt carries the camera clause',
    extracted.every((e, i) => e.text.includes(list[i].camera)));
check('no parsed prompt carries a reference flag',
    extracted.every(e => !/--edit|--cref/.test(e.text)));

// The openings must be DISTINCT — a shared prefix collapses the
// acceptance matcher's excerpt and N prompts get attributed to a few
// task ids (measured 2026-09-24 → 2026-11-05).
const openings = extracted.map(e => e.text.slice(0, 64));
check('the 64-character openings are unique', new Set(openings).size === 12);

// Each prompt must also carry its OWN camera clause — a shared camera
// clause would collapse the matcher the same way.
check('every camera clause is distinct', new Set(cameraClauses).size === 12);

// ---------------------------------------------------------------------
// 9. THE IDENTITY LINT — the repo's own, through its own parser
// ---------------------------------------------------------------------
console.log('\n9. the identity lint');

const { lintPrompts } = (() => {
    const lint = require('./prompt-lint.js');
    return { lintPrompts: lint.lintPrompts || lint.checkPrompt || null };
})();

if (lintPrompts) {
    const violations = prompts.map(p => lintPrompts(p)).filter(v => v && v.length);
    check('no frame names the subject\'s race or ethnicity', violations.length === 0);
} else {
    const { execFileSync } = require('node:child_process');
    const tmp2 = path.join(REPO, '.nema-grid-lint-test.md');
    fs.writeFileSync(tmp2, pack);
    let ok = false;
    try {
        execFileSync('node', [path.join(__dirname, 'prompt-lint.js'), tmp2], { stdio: 'pipe' });
        ok = true;
    } catch (e) { ok = false; }
    fs.unlinkSync(tmp2);
    check('the identity lint passes on the pack', ok);
}

// ---------------------------------------------------------------------
// 10. The doc renders
// ---------------------------------------------------------------------
console.log('\n10. the doc');

const doc = renderDoc({ reg });
check('the doc names all twelve frames', list.every(f => doc.includes(f.title)));
check('the doc names all twelve cameras', cameras(reg).every(c => doc.includes(c.name)));
check('the doc states the plain render', /render plain/i.test(doc));
check('the doc shows each frame\'s composed prompt',
    list.every(f => doc.includes(buildFrame(f.n, { reg }))));

// ---------------------------------------------------------------------
// 11. THE RENDERED RESULT — the picked cells and the eye check
// ---------------------------------------------------------------------
console.log('\n11. the rendered result');

const withCells = list.filter(f => f.cell);
check('every frame carries a picked cell', withCells.length === 12);
check('every picked cell is one of the four grid cells',
    withCells.every(f => ['0_0', '0_1', '0_2', '0_3'].includes(f.cell)));
check('every frame carries a camera verdict',
    list.every(f => ['confirmed', 'not-confirmed', 'unknown'].includes(f.cameraLanded)));
check('every frame carries the reason for its verdict',
    list.every(f => f.cameraReason && f.cameraReason.length > 30));

// The eye check found 9 of 12 cameras landed. Pin that number, so a
// re-render that improves or breaks the set is visible in the diff.
const landed = list.filter(f => f.cameraLanded === 'confirmed');
check('nine of the twelve assigned cameras landed', landed.length === 9);

// The three that did NOT land are named, because they are the work:
// CAM 03 (high angle — came back eye level), CAM 08 (top-down — came
// back oblique) and CAM 04 (dutch tilt — came back level).
const missed = list.filter(f => f.cameraLanded === 'not-confirmed').map(f => f.cameraN).sort();
check('the three misses are the high angle, the top-down and the dutch tilt',
    JSON.stringify(missed) === JSON.stringify([3, 4, 8]));

// The missed frames must say WHY, in the frame's own words.
check('each missed frame explains what the camera did instead',
    list.filter(f => f.cameraLanded === 'not-confirmed')
        .every(f => /eye level|level/i.test(f.cameraReason)));

// THE MISSES WERE CHECKED IN ALL FOUR CELLS, and the camera was in NONE
// of them — so they are not picking failures, the JOBS never found the
// camera. That distinction is the actionable part: re-picking would not
// help, and a re-render with new wording would.
check('each missed frame says the camera was in NONE of the four cells',
    list.filter(f => f.cameraLanded === 'not-confirmed')
        .every(f => /NONE OF THE FOUR CELLS/i.test(f.cameraReason)));

// The CLIP cross-check agreed on WHICH frames missed, with no overlap
// between the two populations — that is the number that makes the
// finding credible.
check('the CLIP cross-check is recorded',
    /CLIP/i.test(reg._note_clip || ''));
check('the CLIP cross-check separates the two populations with no overlap',
    /no overlap/i.test(reg._note_clip || ''));

// The confirmed frames' reasons must name the camera they landed.
check('the whip pan frame names the smear',
    /smeared sideways/i.test((frame(5, reg) || {}).cameraReason || ''));
check('the front-on frame names the symmetry',
    /centre/i.test((frame(12, reg) || {}).cameraReason || ''));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
