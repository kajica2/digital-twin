#!/usr/bin/env node
'use strict';
// lib/nema-me-u-meni.test.js
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
    dnaClause, identityClause,
} = require('./nema-me-u-meni.js');

const { extractPrompts } = require('./mj-submitter.js');
const { buildFullPrompt } = require('./mj-submitter.js');

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { pass++; process.stdout.write(`  ✓ ${label}\n`); }
    else { fail++; process.stdout.write(`  ✗ ${label}\n`); }
}

const reg = load();
const list = frames(reg);

// ---------------------------------------------------------------------
// 1. The registry's shape
// ---------------------------------------------------------------------
console.log('\n1. the registry');

check('the registry loads', !!reg && reg.id === 'nema-me-u-meni');
check('it has a title', !!reg.title && reg.title.length > 0);
check('it has the visual DNA', !!reg.visualDna && /500T/.test(reg.visualDna));
check('it has a character reference URL', /^https:\/\//.test(reg.characterRef));
check('it has an identity clause', /no red coat/.test(reg.identity));
check('it has the artist\'s flags', /--ar 16:9/.test(reg.flags) && /--s 75/.test(reg.flags) && /--chaos 8/.test(reg.flags));

// ---------------------------------------------------------------------
// 2. Twelve frames, numbered 1..12, three acts of four
// ---------------------------------------------------------------------
console.log('\n2. the frames');

check('there are twelve frames', list.length === 12);
check('they are numbered 1..12', list.every((f, i) => f.n === i + 1));
check('the slugs are unique', new Set(list.map(f => f.slug)).size === 12);
check('every frame has a title', list.every(f => f.title && f.title.length));
check('every frame has a quote', list.every(f => f.quote && f.quote.length));
check('every frame has prose', list.every(f => f.prose && f.prose.length > 80));
check('there are three acts', reg.acts.length === 3);
check('the acts cover 12 frames', reg.acts.reduce((n, a) => n + a.frames.length, 0) === 12);
check('every frame belongs to an act', reg.acts.flatMap(a => a.frames).sort((a, b) => a - b)
    .every((n, i) => n === i + 1));

// ---------------------------------------------------------------------
// 3. The identity clause is CONSTANT and appears on every frame
// ---------------------------------------------------------------------
console.log('\n3. the identity clause');

check('the identity clause denies the reference\'s red coat', /no red coat/.test(reg.identity));
check('the identity clause denies the house jackets', /no denim jacket/.test(reg.identity) && /no leather jacket/.test(reg.identity));
check('the identity clause denies the necklace', /no necklace/.test(reg.identity));
check('it keeps the positive haircut claim', /shaved very short haircut/.test(reg.identity));

const prompts = buildPrompts({ reg });
check('every frame carries the identity clause verbatim',
    prompts.every(p => p.includes(reg.identity)));

// ---------------------------------------------------------------------
// 4. The DNA is on every frame, and is the same DNA
// ---------------------------------------------------------------------
console.log('\n4. the visual DNA');

check('every frame carries the DNA clause', prompts.every(p => p.includes(dnaClause(reg))));
check('the DNA names the film stock', /Kodak 500T/.test(dnaClause(reg)));
check('the DNA names the palette', /tobacco browns/.test(dnaClause(reg)) && /dirty teal/.test(dnaClause(reg)));
check('the DNA names the realism', /documentary realism/.test(dnaClause(reg)));

// ---------------------------------------------------------------------
// 5. THE FLAGS — each resolved exactly once, the artist's winning
// ---------------------------------------------------------------------
console.log('\n5. the flags');

check('the prompt carries exactly one --ar', prompts.every(p => (p.match(/--ar\b/g) || []).length === 1));
check('the prompt carries exactly one --style', prompts.every(p => (p.match(/--style\b/g) || []).length === 1));
// A flag boundary, not a bare word: "--s" must be counted as a FLAG,
// so it cannot match the "s" inside "--cw" or the "s" of "s.mj.run".
const countFlag = (text, flag) => (text.match(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, 'g')) || []).length;
check('the prompt carries exactly one --s', prompts.every(p => countFlag(p, '--s') + countFlag(p, '--stylize') === 1));
check('the prompt carries exactly one --chaos', prompts.every(p => countFlag(p, '--chaos') === 1));
// MEASURED 2026-11-04: this account REFUSES --cref and ACCEPTS --edit,
// so the reference rides as --edit. The template must not regress to the
// flag the account rejects.
check('the prompt carries exactly one --edit', prompts.every(p => countFlag(p, '--edit') === 1));
check('the prompt carries NO --cref (this account refuses it)',
    prompts.every(p => countFlag(p, '--cref') === 0));
check('the registry names --edit as the reference flag', reg.characterRefFlag === '--edit');

// The config's own default --s 21 must NOT appear — the artist's 75 wins.
check('the config\'s --s 21 never appears', prompts.every(p => !/--s\s+21/.test(p) && !/--stylize\s+21/.test(p)));
check('the artist\'s --s 75 survives', prompts.every(p => /--s 75/.test(p)));
check('the artist\'s --chaos 8 survives', prompts.every(p => /--chaos 8/.test(p)));

// And the composed command through the repo's OWN composer — the one
// the watcher and mj-web.js both use — must not reintroduce the
// config's --s. This is the measured bug class (two --s flags, MJ
// honours the LAST one).
const CONFIG_DEFAULT = '--ar 16:9 --style raw --s 21';
const composed = prompts.map(p => buildFullPrompt(p, null, CONFIG_DEFAULT));
check('the composed command carries exactly one --s',
    composed.every(c => countFlag(c, '--s') + countFlag(c, '--stylize') === 1));
check('the composed command carries exactly one --ar',
    composed.every(c => countFlag(c, '--ar') === 1));
check('the composed command carries exactly one --style',
    composed.every(c => countFlag(c, '--style') === 1));
check('the composed command keeps the artist\'s --s 75',
    composed.every(c => /--s 75/.test(c)));
check('the composed command keeps the artist\'s --chaos 8',
    composed.every(c => /--chaos 8/.test(c)));
// `--ar` LAST is only true when the PROMPT does not carry one —
// buildFullPrompt appends its own in that case and skips it otherwise
// (so the prompt's copy is the only copy). The invariant that matters
// is one of each, and the artist's value.
check('the composed command has --ar exactly once',
    composed.every(c => countFlag(c, '--ar') === 1));
check('the composed command keeps the artist\'s --ar 16:9',
    composed.every(c => /--ar 16:9/.test(c)));
check('the composed command keeps the artist\'s --style raw',
    composed.every(c => /--style raw/.test(c)));
check('the composed command carries the character reference',
    composed.every(c => /--edit https:\/\/s\.mj\.run\/7ZJU0zgoKBc/.test(c)));

// ---------------------------------------------------------------------
// 6. The pack round-trips through the SUBMITTER'S OWN parser
// ---------------------------------------------------------------------
console.log('\n6. the pack');

const pack = buildPack({ reg });
const tmp = path.join(REPO, '.nema-pack-test.md');
fs.writeFileSync(tmp, pack);
const extracted = extractPrompts(tmp);
fs.unlinkSync(tmp);

check('the pack parses to twelve prompts', extracted.length === 12);
check('every parsed prompt carries the identity clause',
    extracted.every(e => e.text.includes(reg.identity)));
check('every parsed prompt carries the DNA',
    extracted.every(e => e.text.includes(dnaClause(reg))));
// extractPrompts pulls --ar off the prose into its own `ar` field
// (the submitter re-appends it), so the ratio is asserted there and
// the remaining flags in the text.
check('every parsed prompt carries the artist\'s ratio',
    extracted.every(e => e.ar === '16:9'));
check('every parsed prompt carries the artist\'s remaining flags',
    extracted.every(e => /--s 75/.test(e.text) && /--chaos 8/.test(e.text) && /--style raw/.test(e.text)));
check('every parsed prompt carries the character reference',
    extracted.every(e => e.text.includes(reg.characterRef)));

// The openings must be DISTINCT — a shared prefix collapses the
// acceptance matcher's excerpt and N prompts get attributed to a few
// task ids (measured 2026-09-24 → 2026-11-01).
const openings = extracted.map(e => e.text.slice(0, 64));
check('the 64-character openings are unique', new Set(openings).size === 12);

// ---------------------------------------------------------------------
// 7. The IDENTITY LINT — the repo's own, through its own parser
// ---------------------------------------------------------------------
console.log('\n7. the identity lint');

const { lintPrompts } = (() => {
    // lib/prompt-lint.js exports the checker; load it directly.
    const lint = require('./prompt-lint.js');
    return { lintPrompts: lint.lintPrompts || lint.checkPrompt || null };
})();

if (lintPrompts) {
    const violations = prompts.map(p => lintPrompts(p)).filter(v => v && v.length);
    check('no frame names the subject\'s race or ethnicity', violations.length === 0);
} else {
    // Fall back to the CLI, which is the contract that matters.
    const { execFileSync } = require('node:child_process');
    const tmp2 = path.join(REPO, '.nema-lint-test.md');
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
// 8. The doc renders, and the frame-02 prose is the artist's own
// ---------------------------------------------------------------------
console.log('\n8. the doc and frame 02');

const doc = renderDoc({ reg });
check('the doc names all twelve frames', list.every(f => doc.includes(f.title)));
check('the doc carries the character reference', doc.includes(reg.characterRef));

const f2 = frame(2, reg);
check('frame 02 is NEMA NIŠTA NOVO', f2.title === 'NEMA NIŠTA NOVO');
check('frame 02 keeps the artist\'s own prose verbatim',
    f2.prose.startsWith('Extreme close-up of a dark coffee cup and silent telephone'));
check('frame 02 names the cup, the telephone, the hand and the figure',
    /coffee cup/.test(f2.prose) && /silent telephone/.test(f2.prose)
    && /hand resting motionless/.test(f2.prose) && /blurred seated figure/.test(f2.prose));
check('frame 02 names the light, the rings and the dust',
    /weak morning light/.test(f2.prose) && /coffee rings and dust/.test(f2.prose));
check('frame 02 names the shallow focus and the stillness',
    /shallow focus/.test(f2.prose) && /intimate domestic stillness/.test(f2.prose));
check('frame 02 keeps "unpolished analog film"', /unpolished analog film/.test(f2.prose));

// ---------------------------------------------------------------------
// 9. Lookup helpers
// ---------------------------------------------------------------------
console.log('\n9. lookup');

check('frame() finds by number', frame(1, reg).slug === 'opet-isto-jutro');
check('bySlug() finds by slug', bySlug('nema-nista-novo', reg).n === 2);
check('frame() returns null for a missing frame', frame(99, reg) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
