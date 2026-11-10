#!/usr/bin/env node
'use strict';
// lib/felt-bunny.test.js
//
// The contract the renderer depends on, asserted on the registry.
//
// Pure functions, no network, no credentials — the same shape as the
// repo's other watcher/registry tests.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
    load, frames, frame, bySlug, buildFrame, buildPrompts, buildPack, renderDoc,
    dnaClause, identityClause, characterClause,
} = require('./felt-bunny.js');

const { extractPrompts, buildFullPrompt } = require('./mj-submitter.js');

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { pass++; process.stdout.write(`  ✓ ${label}\n`); }
    else { fail++; process.stdout.write(`  ✗ ${label}\n`); }
}

// A flag boundary, not a bare word: "--s" must be counted as a FLAG,
// so it cannot match the "s" inside "--cw" or the "s" of "s.mj.run".
const countFlag = (text, flag) => (text.match(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, 'g')) || []).length;

const reg = load();
const list = frames(reg);

// ---------------------------------------------------------------------
// 1. The registry's shape
// ---------------------------------------------------------------------
console.log('\n1. the registry');

check('the registry loads', !!reg && reg.id === 'felt-bunny');
check('it has a title', !!reg.title && reg.title.length > 0);
check('it has a concept', !!reg.concept && reg.concept.length > 20);
check('it names the source job', /^([0-9a-f-]{36})$/.test(reg.source.jobId));
check('it names the source cell', reg.source.cell === '0_2');
check('the anchor is the source cell URL',
    reg.source.cellUrl === `https://cdn.midjourney.com/${reg.source.jobId}/0_2.webp`);
check('it keeps the source job\'s own prompt',
    /needle-felted wool/.test(reg.source.sourcePrompt));
check('it has the visual DNA', !!reg.dnaProse && reg.dnaProse.length > 20);
check('it has an identity clause', /no clothing/.test(reg.identity));
check('it has the house flags', /--edit https:\/\//.test(reg.flags) && /--v 8\.2/.test(reg.flags));

// ---------------------------------------------------------------------
// 2. Two frames, numbered 1..2, in story order
// ---------------------------------------------------------------------
console.log('\n2. the frames');

check('there are two frames', list.length === 2);
check('they are numbered 1..2', list.every((f, i) => f.n === i + 1));
check('the slugs are unique', new Set(list.map(f => f.slug)).size === 2);
check('every frame has a title', list.every(f => f.title && f.title.length));
check('every frame has an opening', list.every(f => f.opening && f.opening.length > 20));
check('every frame has a detail', list.every(f => f.detail && f.detail.length > 20));
check('every frame has a camera clause', list.every(f => f.camera && f.camera.length > 20));
check('every frame names ONE light', list.every(f => /^one (cool soft|warm) daylight from the left$/.test(f.light)));
check('every frame says what changed', list.every(f => f.change && f.change.length > 10));

// The ORDER is the story's: the setup, then the turn.
check('frame 01 is the setup', list[0].slug === 'alone');
check('frame 02 is the turn', list[1].slug === 'the-boat');
check('frame 01 has empty paws', /paws resting empty at its sides/.test(list[0].detail));
check('frame 02 holds the paper boat', /paws around the boat/.test(list[1].detail));
check('frame 02 opens on the boat', /^Holding a small folded paper boat/.test(list[1].opening));
check('frame 01 is cool light, frame 02 is warm light',
    /cool soft daylight/.test(list[0].light) && /warm daylight/.test(list[1].light));
check('the two frames differ in opening and detail',
    list[0].opening !== list[1].opening && list[0].detail !== list[1].detail);

// The camera PLACE is the same in both — the story is what changes, not
// where the camera is. And the word "camera" must NOT appear in the
// prose (MEASURED 2026-11-05: naming a camera in the frame renders a
// literal camera body).
check('both frames share one camera place', list[0].camera === list[1].camera);
check('no frame names a camera', list.every(f => !/\bcamera\b/i.test(f.opening + ' ' + f.detail + ' ' + f.camera)));

// ---------------------------------------------------------------------
// 3. The identity clause is CONSTANT and appears on every frame
// ---------------------------------------------------------------------
console.log('\n3. the identity clause');

// The clause is built against the ACTUAL reference: the source PROMPT
// asks for an outfit, the source RENDER has none.
check('the identity clause denies the outfit the prompt asked for',
    /no clothing/.test(reg.identity) && /no accessories/.test(reg.identity));
check('it denies a scarf and a hat', /no scarf/.test(reg.identity) && /no hat/.test(reg.identity));
check('it keeps the bare-wool claim', /bare cream wool/.test(reg.identity));

const prompts = buildPrompts({ reg });
check('every frame carries the identity clause verbatim',
    prompts.every(p => p.includes(reg.identity)));
check('the identity clause appears exactly once per frame',
    prompts.every(p => p.split(reg.identity).length - 1 === 1));

// The CHARACTER clause is the constant that makes the two frames the
// same rabbit rather than two similar ones.
check('every frame carries the character clause verbatim',
    prompts.every(p => p.includes(characterClause(reg))));
check('the character clause names the felt surface',
    /velvety fuzzy edges/.test(characterClause(reg)));
check('the character clause names the button nose',
    /tiny button nose/.test(characterClause(reg)));

// ---------------------------------------------------------------------
// 4. The DNA is on every frame, and is the same DNA
// ---------------------------------------------------------------------
console.log('\n4. the visual DNA');

check('every frame carries the DNA clause', prompts.every(p => p.includes(dnaClause(reg))));
check('the DNA names the felt surface', /felt surface/.test(dnaClause(reg)));
check('the DNA names the pale backdrop', /pale cream backdrop/.test(dnaClause(reg)));
check('the DNA names the storybook aesthetic', /storybook toy aesthetic/.test(dnaClause(reg)));
check('every frame carries the negation', prompts.every(p => /no text/.test(p)));

// ---------------------------------------------------------------------
// 5. THE FLAGS — each resolved exactly once
// ---------------------------------------------------------------------
console.log('\n5. the flags');

check('the prompt carries exactly one --ar', prompts.every(p => countFlag(p, '--ar') === 1));
check('the prompt carries exactly one --v', prompts.every(p => countFlag(p, '--v') === 1));
check('the prompt carries exactly one --edit', prompts.every(p => countFlag(p, '--edit') === 1));
// MEASURED 2026-11-05: this account REFUSES --cref and ACCEPTS --edit,
// so the anchor must not regress to the flag the account rejects.
check('the prompt carries NO --cref (this account refuses it)',
    prompts.every(p => countFlag(p, '--cref') === 0));
check('the prompt carries NO --oref', prompts.every(p => countFlag(p, '--oref') === 0));
check('the prompt carries NO --sref', prompts.every(p => countFlag(p, '--sref') === 0));
check('the anchor is the source cell', prompts.every(p => p.includes(reg.source.cellUrl)));

// The source's own ratio wins, and it is LAST (MJ honours the LAST of a
// duplicated flag).
check('the source\'s ratio survives', prompts.every(p => /--ar 2:3/.test(p)));
check('the ratio is the last flag',
    prompts.every(p => /--ar 2:3$/.test(p.trim())));
check('the account\'s engine survives', prompts.every(p => /--v 8\.2/.test(p)));
// --v 7 was MEASURED soft-banned on this account (sprint 0.61).
check('the prompt does not carry --v 7', prompts.every(p => !/--v\s+7(?:\s|$)/.test(p)));
// No --stylize and no --profile: the source's panel reads stylization
// 100 / weirdness 0, which are the defaults. Naming them would pin an
// accident (sprint 0.98).
check('the prompt carries no --stylize', prompts.every(p => countFlag(p, '--stylize') === 0 && countFlag(p, '--s') === 0));
check('the prompt carries no --profile', prompts.every(p => countFlag(p, '--profile') === 0));
check('the prompt carries no --hd', prompts.every(p => countFlag(p, '--hd') === 0));

// The config's Kišna-soba master must NOT ride along. Its prose would
// fight the felt surface, and its `--edit https://s.mj.run/3Hv2HR2n3Zs`
// (the artist's own face anchor) would REPLACE this story's anchor: MJ
// honours the LAST of a duplicated flag.
//
// Two defences, and BOTH are asserted here:
//
//   1. the composer drops the defaults' --edit when the prompt names its
//      own (lib/mj-flags.js, fixed 2026-11-10);
//   2. mj-web.js composes with `--defaults ''` for a pack that carries
//      its own complete suffix, so the master's prose never arrives.
const CONFIG_MASTER = 'handmade 2D bedtime animation still, linocut print texture, deep blue and warm red ink on cream paper, no text --chaos 5 --ar 16:9 --raw --profile a13mc1d --edit https://s.mj.run/3Hv2HR2n3Zs --stylize 21 --hd --v 8.2';

// (1) the composer drops the master's --edit when the prompt has its own.
const withMaster = prompts.map(p => buildFullPrompt(p, null, CONFIG_MASTER));
check('the master\'s --edit is dropped when the prompt names its own',
    withMaster.every(c => (c.match(/--edit\s+\S+/g) || []).length === 1));
check('the surviving --edit is THIS story\'s anchor',
    withMaster.every(c => c.includes(reg.source.cellUrl)));
check('the master\'s face anchor never reaches the command',
    withMaster.every(c => !c.includes('s.mj.run/3Hv2HR2n3Zs')));
check('the composed command carries exactly one --ar',
    withMaster.every(c => countFlag(c, '--ar') === 1));
check('the composed command keeps the source\'s ratio',
    withMaster.every(c => /--ar 2:3/.test(c)));
check('the composed command does NOT carry the master\'s ratio',
    withMaster.every(c => !/--ar 16:9/.test(c)));

// (2) the pack's OWN composition — what mj-web.js builds with
// `--defaults ''` — carries no master prose at all.
const own = prompts.map(p => buildFullPrompt(p, null, ''));
check('the pack\'s own composition carries no master prose',
    own.every(c => !/linocut print texture/.test(c)));
check('the pack\'s own composition carries no master face anchor',
    own.every(c => !c.includes('s.mj.run/3Hv2HR2n3Zs')));
check('the pack\'s own composition carries exactly one --ar',
    own.every(c => countFlag(c, '--ar') === 1));
check('the pack\'s own composition keeps the felt anchor',
    own.every(c => c.includes(reg.source.cellUrl)));

// ---------------------------------------------------------------------
// 6. The pack round-trips through the SUBMITTER'S OWN parser
// ---------------------------------------------------------------------
console.log('\n6. the pack');

const pack = buildPack({ reg });
const tmp = path.join(REPO, '.felt-bunny-pack-test.md');
fs.writeFileSync(tmp, pack);
const extracted = extractPrompts(tmp);
fs.unlinkSync(tmp);

check('the pack parses to two prompts', extracted.length === 2);
check('every parsed prompt carries the identity clause',
    extracted.every(e => e.text.includes(reg.identity)));
check('every parsed prompt carries the DNA',
    extracted.every(e => e.text.includes(dnaClause(reg))));
// extractPrompts pulls --ar off the prose into its own `ar` field
// (the submitter re-appends it), so the ratio is asserted there and
// the remaining flags in the text.
check('every parsed prompt carries the source\'s ratio',
    extracted.every(e => e.ar === '2:3'));
check('every parsed prompt carries the anchor',
    extracted.every(e => e.text.includes(reg.source.cellUrl)));
check('every parsed prompt carries the engine',
    extracted.every(e => /--v 8\.2/.test(e.text)));

// The openings must be DISTINCT — a shared prefix collapses the
// acceptance matcher's excerpt and N prompts get attributed to a few
// task ids (measured 2026-09-24 → 2026-11-01).
const openings = extracted.map(e => e.text.slice(0, 64));
check('the 64-character openings are unique', new Set(openings).size === 2);

// ---------------------------------------------------------------------
// 7. The IDENTITY LINT — the repo's own, through its own parser
// ---------------------------------------------------------------------
console.log('\n7. the identity lint');

{
    const { execFileSync } = require('node:child_process');
    const tmp2 = path.join(REPO, '.felt-bunny-lint-test.md');
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
// 8. The doc renders, and carries the source
// ---------------------------------------------------------------------
console.log('\n8. the doc');

const doc = renderDoc({ reg });
check('the doc names both frames', list.every(f => doc.includes(f.title)));
check('the doc carries the source job id', doc.includes(reg.source.jobId));
check('the doc carries the anchor', doc.includes(reg.source.cellUrl));
check('the doc carries the source\'s own prompt', /needle-felted wool/.test(doc));
check('the doc states what changed in each frame',
    list.every(f => doc.includes(f.change)));
check('the doc shows the composed command', list.every(f => doc.includes(buildFrame(f.n, { reg }))));

// ---------------------------------------------------------------------
// 9. Lookup helpers
// ---------------------------------------------------------------------
console.log('\n9. lookup');

check('frame() finds by number', frame(1, reg).slug === 'alone');
check('bySlug() finds by slug', bySlug('the-boat', reg).n === 2);
check('frame() returns null for a missing frame', frame(99, reg) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
