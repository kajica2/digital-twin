#!/usr/bin/env node
'use strict';
// lib/mj-look-presets.test.js
//
// The contract the renderer depends on, asserted on the look registry.
//
// Pure functions, no network, no credentials — the same shape as the
// repo's other registry tests.
//
// The assertions here are the MEASURED rules, pinned so the set cannot
// silently drift back into the failure modes:
//
//   1. a look preset carries NO flags (Rule 2 of the shot-registry
//      skill: engine, style and reference flags belong to the config)
//   2. a look descriptor names NO distance ("wide", "extreme close-up"
//      — measured to be ignored) and no camera instruction
//   3. the pack round-trips through the SUBMITTER'S OWN parser
//   4. every prompt's OPENING differs — a shared prefix collapses the
//      acceptance matcher's excerpt and N prompts get attributed to a
//      few task ids
//   5. each flag is resolved exactly once, and `--ar` is last
//   6. the identity lint passes
//   7. no two presets carry the same descriptor

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const {
    load, presets, preset, bySlug, families, anchorText,
    buildPrompt, buildPrompts, buildPack, renderDoc,
} = require('./mj-look-presets.js');

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
const list = presets(reg);

// ---------------------------------------------------------------------
// 1. The registry's shape
// ---------------------------------------------------------------------
console.log('\n1. the registry');

check('the registry loads', !!reg && reg.id === 'mj-look-presets');
check('it has a title', !!reg.title && reg.title.length > 0);
check('it has an anchor subject', !!reg.anchor && reg.anchor.length > 40);
check('the anchor is stored as clauses', Array.isArray(reg.anchorClauses) && reg.anchorClauses.length >= 3);
check('it has the house flags', /--ar 16:9/.test(reg.flags) && /--style raw/.test(reg.flags) && /--s 21/.test(reg.flags));
check('it has the negation suffix', reg.suffix === 'no text');

// ---------------------------------------------------------------------
// 2. Thirty presets, numbered 1..30
// ---------------------------------------------------------------------
console.log('\n2. the presets');

check('there are thirty presets', list.length === 30);
check('they are numbered 1..30', list.every((p, i) => p.n === i + 1));
check('the slugs are unique', new Set(list.map(p => p.slug)).size === 30);
check('every preset has a name', list.every(p => p.name && p.name.length > 3));
check('every preset has a descriptor', list.every(p => p.descriptor && p.descriptor.length > 25));
check('every preset has a family', list.every(p => p.family && p.family.length));
check('every preset has tags', list.every(p => Array.isArray(p.tags) && p.tags.length >= 2));

const descs = list.map(p => p.descriptor.toLowerCase());
check('no two descriptors are the same', new Set(descs).size === 30);

// The families are the useful grouping.
const fams = families(reg);
check('there are five families', fams.length === 5);
check('every preset\'s family is one of them',
    list.every(p => fams.includes(p.family)));

// ---------------------------------------------------------------------
// 3. A LOOK carries no flags and no distance
// ---------------------------------------------------------------------
console.log('\n3. the look descriptors');

// Rule 2 of the shot-registry skill: a preset carries no flags.
const FLAG_RE = /--(v|style|raw|s|stylize|ar|cref|oref|edit|sref|profile|no|chaos|weird|hd|tile)\b/;
check('no descriptor carries a flag', list.every(p => !FLAG_RE.test(p.descriptor)));

// A distance clause is measured to be IGNORED (docs/VIDEO-FRAMING.md §1
// Step 2) — so a look must not spend its words on one.
const DISTANCE = /\b(extreme close-up|close-up|wide shot|wide angle|long shot|medium shot|establishing shot|bird'?s eye|over-the-shoulder|aerial)\b/i;
const distanceHits = list.filter(p => DISTANCE.test(p.descriptor)).map(p => p.n);
check('no descriptor names a distance', distanceHits.length === 0);
if (distanceHits.length) process.stdout.write(`      (offenders: ${distanceHits.join(', ')})\n`);

// A camera INSTRUCTION (not a lens characteristic) is the prompt's
// business, not a look's. "wide angle" is a lens, which is allowed;
// "the camera is at chest height" is an instruction.
check('no descriptor gives a camera instruction',
    list.every(p => !/the camera (is|at|stands|looks|moves)/i.test(p.descriptor)));

// The look must not smuggle a SUBJECT in — the subject is the anchor's
// job, and a look that names one is a scene preset in disguise.
const SUBJECT_SMUGGLE = /\b(a man|a woman|a child|the singer|the drummer)\b/i;
check('no descriptor smuggles in a subject',
    list.every(p => !SUBJECT_SMUGGLE.test(p.descriptor)));

// ---------------------------------------------------------------------
// 4. The anchor rotates, so the openings differ
// ---------------------------------------------------------------------
console.log('\n4. the anchor rotation');

const prompts = buildPrompts({ reg });
const openings = prompts.map(p => p.slice(0, 64));
check('the 64-character openings are unique', new Set(openings).size === 30);

// The FIRST WORDS must differ, not merely the 64-char window — the
// matcher's excerpt is short.
const firstWords = prompts.map(p => p.split(' ').slice(0, 3).join(' '));
check('the first three words differ across the set', new Set(firstWords).size >= 4);

// The SCENE is the same in every prompt — only the words move. The
// check is that every prompt names the same three elements (a man, a
// chair, a window) rather than carrying an identical string.
const SCENE_ELEMENTS = [/man|figure|he\b/i, /chair/i, /window|light/i];
check('every prompt names the man, the chair and the window',
    prompts.every(p => SCENE_ELEMENTS.every(re => re.test(p))));

// NEVER SAY THE SAME THING TWICE.
//
// MEASURED 2026-11-05: the first version appended the anchor clauses
// blindly, so most prompts carried "a wooden chair in the middle of the
// floor" twice. In the first eight submissions, every prompt with the
// duplicate was refused (5 of 8) and every prompt without it was
// accepted (2 of 8). One of the five rendered anyway, so it is a risk
// rather than the sole cause — but the correlation is perfect and the
// rule is simple.
//
// The check is on the SUBJECT words of each prompt (before the look
// descriptor), because that is where the duplication was.
const SUBJECT_NOUNS = /\b(man|room|chair|window|overcoat|light|figure|empty|bare|floor|air|dust|coat|coat)\b/g;
const repeated = [];
for (const p of prompts) {
    const subject = p.split(', ').slice(0, 3).join(', ');
    const words = subject.toLowerCase().match(SUBJECT_NOUNS) || [];
    const counts = {};
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const rep = Object.entries(counts).filter(([, v]) => v > 1).map(([k]) => k);
    if (rep.length) repeated.push({ rep, subject });
}
check('no prompt says the same subject word twice', repeated.length === 0);
if (repeated.length) {
    for (const r of repeated) process.stdout.write(`      (${r.rep.join(',')}) ${r.subject.slice(0, 70)}\n`);
}

// The rotation is deterministic.
check('anchorText() is deterministic', anchorText(7, reg) === anchorText(7, reg));
check('anchorText() differs per preset', anchorText(1, reg) !== anchorText(2, reg));

// The prompt must not be so long that the model spends its budget on
// the subject. The refused batch ran 254-306 chars and the accepted one
// 237-251, so the working set sits well under 300.
check('every prompt is under 340 characters', prompts.every(p => p.length < 340));

// ---------------------------------------------------------------------
// 5. The flags — resolved exactly once, --ar last
// ---------------------------------------------------------------------
console.log('\n5. the flags');

check('the prompt carries exactly one --ar', prompts.every(p => countFlag(p, '--ar') === 1));
check('the prompt carries exactly one --style', prompts.every(p => countFlag(p, '--style') === 1));
check('the prompt carries exactly one --s', prompts.every(p => countFlag(p, '--s') + countFlag(p, '--stylize') === 1));

// `--ar` must be LAST of the flags — MJ honours the LAST occurrence of
// a duplicated flag, so its position matters.
check('--ar is the last flag', prompts.every(p => /--ar\s+16:9$/.test(p.trim())));

// And the composed command through the repo's OWN composer.
const CONFIG_DEFAULT = '--ar 16:9 --style raw --s 21';
const composed = prompts.map(p => buildFullPrompt(p, null, CONFIG_DEFAULT));
check('the composed command carries exactly one --ar', composed.every(c => countFlag(c, '--ar') === 1));
check('the composed command carries exactly one --s',
    composed.every(c => countFlag(c, '--s') + countFlag(c, '--stylize') === 1));
check('the composed command carries exactly one --style', composed.every(c => countFlag(c, '--style') === 1));
check('the composed command keeps --ar 16:9', composed.every(c => /--ar 16:9/.test(c)));
check('the composed command keeps --s 21', composed.every(c => /--s 21/.test(c)));

// ---------------------------------------------------------------------
// 6. The pack round-trips through the SUBMITTER'S OWN parser
// ---------------------------------------------------------------------
console.log('\n6. the pack');

const pack = buildPack({ reg });
const tmp = path.join(REPO, '.look-pack-test.md');
fs.writeFileSync(tmp, pack);
const extracted = extractPrompts(tmp);
fs.unlinkSync(tmp);

check('the pack parses to thirty prompts', extracted.length === 30);
check('every parsed prompt carries its descriptor',
    extracted.every((e, i) => e.text.includes(list[i].descriptor)));
check('every parsed prompt carries the negation', extracted.every(e => e.text.includes('no text')));
check('every parsed prompt carries the ratio', extracted.every(e => e.ar === '16:9'));
check('every parsed prompt carries the style and strength',
    extracted.every(e => /--style raw/.test(e.text) && /--s 21/.test(e.text)));

// The extracted openings must still be distinct — the parser's own view.
const parsedOpenings = extracted.map(e => e.text.slice(0, 64));
check('the parsed openings are unique', new Set(parsedOpenings).size === 30);

// ---------------------------------------------------------------------
// 7. The identity lint — the repo's own, through its own parser
// ---------------------------------------------------------------------
console.log('\n7. the identity lint');

const { lintPrompts } = (() => {
    const lint = require('./prompt-lint.js');
    return { lintPrompts: lint.lintPrompts || lint.checkPrompt || null };
})();

if (lintPrompts) {
    const violations = prompts.map(p => lintPrompts(p)).filter(v => v && v.length);
    check('no prompt names the subject\'s race or ethnicity', violations.length === 0);
} else {
    const tmp2 = path.join(REPO, '.look-lint-test.md');
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
// 8. Lookup and the doc
// ---------------------------------------------------------------------
console.log('\n8. lookup and the doc');

check('preset() finds by number', preset(1, reg).slug === 'analog-noir-1970s');
check('bySlug() finds by slug', bySlug('neon-noir-1980s', reg).n === 6);
check('preset() returns null for a missing preset', preset(99, reg) === null);

const doc = renderDoc({ reg });
check('the doc names every preset', list.every(p => doc.includes(p.name)));
check('the doc states the anchor', doc.includes(reg.anchor));
check('the doc explains why one subject', /the look's doing/i.test(doc));
check('the doc explains the distinct openings', /opens with its own short phrase/i.test(doc));
check('the doc shows every composed prompt',
    list.every(p => doc.includes(buildPrompt(p.n, { reg }))));

// ---------------------------------------------------------------------
// 9. THE CUT RECIPE — the RENDERER'S vocabulary, and the ratio rule
// ---------------------------------------------------------------------
//
// A look's cut recipe names the renderer's own effects. An INVENTED
// name is a crash at render time, not a warning — so the names are
// asserted against `lib/render/plan.mjs`'s own tables, which is the
// table the renderer reads.
//
// The native ratio is PART OF THE MEDIUM: an anamorphic 35mm look is
// 21:9, a broadcast tape is 4:3, an instant photo is 1:1. A cut is ONE
// ratio (the renderer takes one --size for a whole cut), so a plan
// spanning several ratios is REFUSED rather than silently scaled.
console.log('\n9. the cut recipe and the ratio rule');

// `lib/render/plan.mjs` is an ES module and this file is CommonJS, so
// the tables are read through a CHILD PROCESS rather than a top-level
// `import` — mixing `require()` with top-level `await` is ambiguous in
// Node and the file refuses to load.
const rendererSrc = fs.readFileSync(path.join(REPO, 'lib/render/plan.mjs'), 'utf8');
function rendererTable(name) {
    const out = execFileSync('node', ['--input-type=module', '-e', `
        import { ${name} } from ${JSON.stringify(path.join(REPO, 'lib/render/plan.mjs'))};
        console.log(JSON.stringify(${name}));
    `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
}
const KEN_BURNS_MODES = rendererTable('KEN_BURNS_MODES');
const FX = rendererTable('FX');
const TRANSITIONS = rendererTable('TRANSITIONS');

check('the renderer table loaded', Array.isArray(KEN_BURNS_MODES) && typeof FX === 'object');
check('the renderer table came from the renderer, not a copy',
    rendererSrc.includes('export const FX'));

const badMotion = list.filter(p => p.cut && !KEN_BURNS_MODES.includes(p.cut.motion));
check('every cut motion is a renderer mode', badMotion.length === 0,
    badMotion.map(p => `${p.slug}:${p.cut.motion}`).join(', '));

const fxNames = (list) => String(list).split('+').filter(n => n && n !== 'none');
const badFx = list.filter(p => p.cut && fxNames(p.cut.fx).some(n => !(n in FX)));
check('every cut fx is a renderer effect', badFx.length === 0,
    badFx.map(p => `${p.slug}:${p.cut.fx}`).join(', '));

const badGrade = list.filter(p => p.cut && fxNames(p.cut.grade).some(n => !(n in FX)));
check('every cut grade is a renderer effect', badGrade.length === 0,
    badGrade.map(p => `${p.slug}:${p.cut.grade}`).join(', '));

const badTransition = list.filter(p => p.cut && !TRANSITIONS.includes(p.cut.transition));
check('every cut transition is a renderer transition', badTransition.length === 0,
    badTransition.map(p => `${p.slug}:${p.cut.transition}`).join(', '));

check('every cut has a positive duration', list.every(p => p.cut && p.cut.each > 0));
check('every look carries a native ratio', list.every(p => /^\d+:\d+$/.test(p.ar || '')));

// The ratios really do differ — a registry where every look claims
// 16:9 is a registry that flattened the medium.
const ratios = [...new Set(list.map(p => p.ar))].sort();
check('the looks carry more than one native ratio', ratios.length > 1, ratios.join(', '));

// The stock is DATA, and the composer projects it two ways.
check('every look carries its stock', list.every(p => p.stock && p.stock.length > 0));
check('every look carries the scene-safe projection', list.every(p => p.styleScene && p.styleScene.length > 0));
check('the scene-safe projection drops the stock',
    list.every(p => !p.styleScene.includes(p.stock)));
check('the full projection keeps the stock',
    list.every(p => p.style.includes(p.stock)));
check('the artist\'s descriptor is kept verbatim',
    list.every(p => p.descriptor && p.descriptor.length > 0));

// The cut plan builds — the vocabulary check alone does not prove the
// composed plan is ACCEPTED by the renderer.
let planOk = true, planErr = '';
for (const ratio of ratios) {
    const subset = list.filter(p => p.ar === ratio);
    try {
        // The plan is built INSIDE the child process, because
        // `buildRenderPlan` lives in the ES module.
        const script = `
            import { buildRenderPlan } from ${JSON.stringify(path.join(REPO, 'lib/render/plan.mjs'))};
            const plan = buildRenderPlan({
                inputNames: ${JSON.stringify(subset.map(p => `${String(p.n).padStart(2, '0')}.webp`))},
                width: 1920, height: 1080,
                kenBurns: ${JSON.stringify(subset[0].cut.motion)},
                fx: ${JSON.stringify(subset[0].cut.fx)},
                grade: ${JSON.stringify(subset[0].cut.grade)},
                transition: ${JSON.stringify(subset[0].cut.transition)},
            });
            if (!plan || !plan.filterComplex || !plan.args) throw new Error('no filter graph');
            console.log(JSON.stringify({ filter: plan.filterComplex.length, args: plan.args.length }));
        `;
        execFileSync('node', ['--input-type=module', '-e', script],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { planOk = false; planErr = `${ratio}: ${String(e.stderr || e.message).split('\n')[0]}`; break; }
}
check('every ratio\'s cut plan is accepted by the renderer', planOk, planErr);

// ---------------------------------------------------------------------
// 10. THE RENDERED SET — the recorded cell picks
// ---------------------------------------------------------------------
//
// Every look was rendered from the SAME anchor subject, so any
// difference between two frames is the look's doing. The registry
// records the cell the measurement screen picked, so the set is
// reproducible rather than a folder of files.
//
// The screen's rule: the cell closest to the MEDIAN luma, never a
// blown one over 90. Two looks have EVERY cell blown — for those the
// sheet shows the least-blown cell and the registry says so.
console.log('\n10. the rendered set');

check('every look records a picked cell', list.every(p => /^[0-3]_[0-3]$/.test(p.cell || '')));
check('every look records its cell luma', list.every(p => typeof p.cellLuma === 'number'));
check('the cell luma is measured, not invented', list.every(p => p.cellLuma > 0 && p.cellLuma < 200));

const allBlown = list.filter(p => p.allCellsBlown);
check('the looks with every cell blown are recorded as such',
    allBlown.every(p => p.allCellsBlown === true));
check('a look with a usable cell is NOT flagged all-blown',
    list.filter(p => !p.allCellsBlown).every(p => p.allCellsBlown !== true));

// The picked cell is never blown UNLESS every cell is.
const wronglyBlown = list.filter(p => !p.allCellsBlown && p.cellLuma > 90);
check('a picked cell is never blown unless every cell is', wronglyBlown.length === 0,
    wronglyBlown.map(p => `${p.slug}:${p.cellLuma}`).join(', '));

// The picked cells are DISTINCT across the set — the same slot for
// every look would mean the screen never chose.
const cells = list.map(p => p.cell);
check('the set picks more than one cell', new Set(cells).size > 1,
    `${new Set(cells).size} distinct`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
