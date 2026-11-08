#!/usr/bin/env node
'use strict';
// lib/srce-kuca.test.js
//
// The contract the renderer depends on, asserted on the registry.
//
// Pure functions, no network, no credentials — the same shape as the
// repo's other registry tests.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
    load, frames, frame, bySlug, buildFrame, buildPrompts, buildPack, renderDoc,
    dnaClause, identityClause,
} = require('./srce-kuca.js');

const { extractPrompts, buildFullPrompt } = require('./mj-submitter.js');

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

check('the registry loads', !!reg && reg.id === 'srce-kuca');
check('it names the artist', !!reg.artist);
check('it has a concept', !!reg.concept && reg.concept.length > 80);
check('it has the visual DNA', /500T/.test(reg.visualDna));
check('it has an identity clause', /no denim jacket/.test(reg.identity));
check('it is marked plain-render', reg.renderPlain === true);
check('it carries no --edit', !/--edit/.test(reg.flags));
check('it carries no --cref', !/--cref/.test(reg.flags));

// ---------------------------------------------------------------------
// 2. The artist's flags — five SEPARATE --profile lines
// ---------------------------------------------------------------------
console.log('\n2. the flags');

const countFlag = (text, flag) => (text.match(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, 'g')) || []).length;

check('the flags carry --chaos 5', /--chaos 5/.test(reg.flags));
check('the flags carry --ar 16:9', /--ar 16:9/.test(reg.flags));
check('the flags carry --raw', /--raw/.test(reg.flags));
check('the flags carry --stylize 755', /--stylize 755/.test(reg.flags));
check('the flags carry --hd', /--hd/.test(reg.flags));
check('there are FIVE --profile flags', countFlag(reg.flags, '--profile') === 5);
check('the five codes are the account\'s own',
    ['brvazka', 'mhw6dpq', 'xr39csb', 'det21e6', '67lkfw3'].every(c => reg.flags.includes(c)));

// ---------------------------------------------------------------------
// 3. Twelve shots
// ---------------------------------------------------------------------
console.log('\n3. the shots');

check('there are sixteen shots', list.length === 16);
check('they are numbered 1..16', list.every((f, i) => f.n === i + 1));
check('the slugs are unique', new Set(list.map(f => f.slug)).size === 16);
check('every shot has a title', list.every(f => f.title && f.title.length));
check('every shot has a lyric', list.every(f => f.lyric && f.lyric.length));
check('every shot has prose', list.every(f => f.prose && f.prose.length > 80));
check('every shot has a CAMERA clause', list.every(f => f.camera && f.camera.length > 30));
check('there are five acts', reg.acts.length === 5);
check('the acts cover sixteen shots', reg.acts.reduce((n, a) => n + a.frames.length, 0) === 16);

// The song's own words are the source: the lyric must appear.
const allLyrics = list.map(f => f.lyric).join(' ').toLowerCase();
check('the chorus line is in the shots', /ne diraj tišinu/.test(allLyrics));
check('the table line is in the shots', /čaša|vino/.test(allLyrics));

// ---------------------------------------------------------------------
// 4. The identity clause and the DNA are on every shot
// ---------------------------------------------------------------------
console.log('\n4. the constant clauses');

const prompts = buildPrompts({ reg });

check('every shot carries the identity clause verbatim',
    prompts.every(p => p.includes(reg.identity)));
check('every shot carries the DNA clause', prompts.every(p => p.includes(dnaClause(reg))));
check('the DNA names the film stock', /Kodak 500T/.test(dnaClause(reg)));
check('the DNA names the palette', /tobacco browns/.test(dnaClause(reg)));

// ---------------------------------------------------------------------
// 5. THE FLAGS — each resolved exactly once, the artist's winning
// ---------------------------------------------------------------------
console.log('\n5. the flags');

check('every shot carries exactly one --chaos', prompts.every(p => countFlag(p, '--chaos') === 1));
check('every shot carries exactly one --ar', prompts.every(p => countFlag(p, '--ar') === 1));
check('every shot carries exactly one --stylize', prompts.every(p => countFlag(p, '--stylize') === 1));
check('every shot carries exactly one --hd', prompts.every(p => countFlag(p, '--hd') === 1));
check('every shot carries FIVE --profile flags', prompts.every(p => countFlag(p, '--profile') === 5));
check('every shot carries no --edit', prompts.every(p => countFlag(p, '--edit') === 0));
check('every shot carries no --cref', prompts.every(p => countFlag(p, '--cref') === 0));

// The config's own default --s 21 must NOT appear — the artist's 755 wins.
check('the config\'s --s 21 never appears',
    prompts.every(p => !/--s\s+21/.test(p) && !/--stylize\s+21/.test(p)));
check('the artist\'s --stylize 755 survives', prompts.every(p => /--stylize 755/.test(p)));

// And the composed command through the repo's OWN composer.
const CONFIG_DEFAULT = '--ar 16:9 --style raw --s 21';
const composed = prompts.map(p => buildFullPrompt(p, null, CONFIG_DEFAULT));
check('the composed command has exactly one --ar', composed.every(c => countFlag(c, '--ar') === 1));
check('the composed command has exactly one --stylize',
    composed.every(c => countFlag(c, '--stylize') + countFlag(c, '--s') === 1));
check('the composed command keeps the artist\'s --stylize 755',
    composed.every(c => /--stylize 755/.test(c)));
check('the composed command keeps all five --profile flags',
    composed.every(c => countFlag(c, '--profile') === 5));
check('the composed command keeps --hd', composed.every(c => countFlag(c, '--hd') === 1));
check('the composed command keeps --chaos 5', composed.every(c => /--chaos 5/.test(c)));
check('the composed command carries no --edit',
    composed.every(c => countFlag(c, '--edit') === 0));

// ---------------------------------------------------------------------
// 6. THE CAMERA CLAUSE COMES BEFORE THE STYLE WORDS
// ---------------------------------------------------------------------
console.log('\n6. the camera comes before the style');

check('the camera clause is positioned before the DNA',
    prompts.every((p, i) => p.indexOf(list[i].camera.slice(0, 40)) < p.indexOf(dnaClause(reg))));
check('the flags come last in every shot',
    prompts.every(p => /--hd/.test(p) && p.lastIndexOf('--profile 67lkfw3') > p.indexOf(dnaClause(reg))));

// ---------------------------------------------------------------------
// 7. The pack round-trips through the SUBMITTER'S OWN parser
// ---------------------------------------------------------------------
console.log('\n7. the pack');

const pack = buildPack({ reg });
const tmp = path.join(REPO, '.srce-pack-test.md');
fs.writeFileSync(tmp, pack);
const extracted = extractPrompts(tmp);
fs.unlinkSync(tmp);

check('the pack parses to sixteen prompts', extracted.length === 16);
check('every parsed prompt carries the identity clause',
    extracted.every(e => e.text.includes(reg.identity)));
check('every parsed prompt carries the DNA',
    extracted.every(e => e.text.includes(dnaClause(reg))));
check('every parsed prompt carries the artist\'s ratio', extracted.every(e => e.ar === '16:9'));
check('every parsed prompt carries the artist\'s remaining flags',
    extracted.every(e => /--stylize 755/.test(e.text) && /--chaos 5/.test(e.text) && /--hd/.test(e.text)));
check('every parsed prompt carries five --profile flags',
    extracted.every(e => countFlag(e.text, '--profile') === 5));

// The openings must be DISTINCT — a shared prefix collapses the
// acceptance matcher's excerpt and N prompts get attributed to a few
// task ids (measured 2026-09-24 → 2026-11-01).
const openings = extracted.map(e => e.text.slice(0, 64));
check('the 64-character openings are unique', new Set(openings).size === 16);

// ---------------------------------------------------------------------
// 8. The identity lint — the repo's own, through its own parser
// ---------------------------------------------------------------------
console.log('\n8. the identity lint');

const { execFileSync } = require('node:child_process');
const tmp2 = path.join(REPO, '.srce-lint-test.md');
fs.writeFileSync(tmp2, pack);
let lintOk = false;
try {
    execFileSync('node', [path.join(__dirname, 'prompt-lint.js'), tmp2], { stdio: 'pipe' });
    lintOk = true;
} catch { lintOk = false; }
fs.unlinkSync(tmp2);
check('the identity lint passes on the pack', lintOk);

// ---------------------------------------------------------------------
// 9. The doc renders, and the song's own words are the source
// ---------------------------------------------------------------------
console.log('\n9. the doc');

const doc = renderDoc({ reg });
check('the doc names all sixteen shots', list.every(f => doc.includes(f.title)));
check('the doc carries the flags', doc.includes(reg.flags));
check('the doc carries the artist', doc.includes(reg.artist));

// The set is SEQUENCED TO THE LYRIC, so the closing shot is the last
// chorus beat — "Ne diraj tišinu" and the two glasses.
const f16 = frame(16, reg);
check('the last shot is NE DIRAJ TIŠINU', f16.title === 'NE DIRAJ TIŠINU');
check('the last shot carries the closing lyric',
    /ne diraj tišinu/i.test(f16.lyric));
check('the last shot is an extreme close-up of the glasses',
    /Extreme close-up of two wine glasses/.test(f16.prose));

// The four NEW beats, and where the song puts them.
const NEW_SHOTS = [
  [2,  'ko-zna-sta-mislis',  'Pomeriš kosu'],
  [5,  'neka-noc-ne-prolazi', 'neka noć ne prolazi'],
  [7,  'ja-vec-nisam-tu',    'Ja već nisam tu'],
  [10, 'ti-me-pitas-nesto',  'Ti me pitaš nešto'],
];
for (const [n, slug, lyricBit] of NEW_SHOTS) {
    const f = frame(n, reg);
    check(`shot ${n} is ${slug}`, f && f.slug === slug);
    check(`shot ${n} carries its lyric ("${lyricBit}")`,
        f && f.lyric.toLowerCase().includes(lyricBit.toLowerCase()));
    check(`shot ${n} names a light source`,
        f && /lamp|light|burning|window|tungsten/i.test(f.prose + f.camera));
    check(`shot ${n} does NOT say "camera" in its camera clause`,
        f && !/\bcamera\b/i.test(f.camera));
    check(`shot ${n} has no film-stock noun in its prose`,
        f && !/35mm|analog film|film still|grainy/i.test(f.prose));
}

// ---------------------------------------------------------------------
// 10. Lookup helpers
// ---------------------------------------------------------------------
console.log('\n10. lookup');

check('frame() finds by number', frame(1, reg).slug === 'opet-si-tu');
check('bySlug() finds by slug', bySlug('ne-diraj-tisinu', reg).n === 4);
check('frame() returns null for a missing shot', frame(99, reg) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
