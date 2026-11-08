#!/usr/bin/env node
'use strict';
// tools/watched-man-mutations.js
//
// DO THE WATCHED MAN TESTS ACTUALLY BITE? — mutation check.
//
// WHY A MUTATION CHECK
//
//   The repo's own rule: "a verification test that cannot fail is
//   worse than no test". So each mutation below breaks the code in one
//   specific way, and the check asserts the suite GOES RED.
//
//   The mutants are built in a SCRATCH DIRECTORY — the repo's source
//   is never edited, so there is no window in which the working tree
//   holds a broken module. The mutant's relative requires are
//   rewritten to absolute paths so it can live outside lib/.
//
// Usage:
//   node tools/watched-man-mutations.js
//
// Exit: 0 every mutation was caught · 2 a mutation survived

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'lib', 'watched-man.js');
const JSON_SRC = path.join(REPO, 'lib', 'watched-man.json');
const TEST = path.join(REPO, 'lib', 'watched-man.test.js');

const source = fs.readFileSync(SRC, 'utf8');
const registry = fs.readFileSync(JSON_SRC, 'utf8');

/**
 * The mutations.
 *
 * Each one is a real bug class the registry is supposed to prevent,
 * and each is paired with the assertion that must catch it.
 */
const MUTATIONS = [
    {
        name: 'the style reference is dropped',
        why: 'the registry stops carrying the artist\'s measured --sref',
        file: 'js',
        from: 'if (opts.ref !== false && reg.styleReference) {',
        to: 'if (false) {',
    },
    {
        name: '--ar comes first instead of last',
        why: 'MJ honours the LAST --ar it sees, so the ratio must be emitted last',
        file: 'js',
        from: 'text += ` ${reg.flags}`;',
        to: 'text = `--ar 16:9 ${text}`;',
    },
    {
        name: 'the style reference is emitted AFTER the flags',
        why: 'a doubled flag resolves to the last one, so the order is load-bearing',
        file: 'js',
        from: 'text += ` ${flag} ${reg.styleReference}`;',
        to: 'text += ` ${reg.flags}`; text += ` ${flag} ${reg.styleReference}`;',
    },
    {
        name: 'the DNA is replaced by the identity clause',
        why: 'the two clauses are different and both must be present',
        file: 'js',
        from: 'return r.dnaProse;',
        to: 'return r.identity;',
    },
    {
        name: 'the camera clause is dropped',
        why: 'the camera clause is what the camera obeys — the whole point of the set',
        file: 'js',
        from: '        f.camera,\n',
        to: '',
    },
    {
        name: 'the identity clause is dropped',
        why: 'the wardrobe must be constant across the set',
        file: 'js',
        from: '        identityClause(reg),\n',
        to: '',
    },
    {
        name: 'the style reference URL is wrong',
        why: 'the reference is the artist\'s own, recovered from the feed',
        file: 'json',
        from: '"styleReference": "https://s.mj.run/cATLXOMsR-o"',
        to: '"styleReference": "https://s.mj.run/WRONG"',
    },
    {
        name: 'a --profile is pinned into the flags',
        why: 'the account default rides on 6 of 200 jobs; pinning a default pins an accident',
        file: 'json',
        from: '"flags": "--ar 16:9 --raw --v 8.2"',
        to: '"flags": "--ar 16:9 --raw --v 8.2 --profile ub2pnlv"',
    },
    {
        name: 'the camera clause asks for a DISTANCE',
        why: 'a distance clause is measured to be ignored',
        file: 'json',
        from: '"camera": "the clock and the hand on the metal table filling the picture, the rest of the wall plain and empty behind them, the camera at the height of the tabletop"',
        to: '"camera": "an extreme close-up of the clock and the hand on the metal table, the camera at the height of the tabletop"',
    },
    {
        name: 'the camera clause asks for an ORIENTATION',
        why: 'an orientation clause is measured to be ignored — the picture comes back level',
        file: 'json',
        from: '"camera": "seen from the landing above, the man small under the ceiling fixture, the floor plan visible, the corridor\'s doorways as rectangles below"',
        to: '"camera": "seen from directly overhead, the man small under the ceiling fixture, the floor plan visible, the corridor\'s doorways as rectangles below"',
    },
    {
        name: 'a frame names TWO light sources',
        why: 'a second source confused the render',
        file: 'json',
        from: '"light": "one tungsten lamp on the floor beside him, everything else black"',
        to: '"light": "one tungsten lamp on the floor beside him and one street light through the window"',
    },
    {
        name: 'the prose names a camera as a subject',
        why: 'the word "camera" in the prose renders a literal camera body',
        file: 'json',
        from: '"prose": "A man walking slowly down a bare institutional corridor',
        to: '"prose": "A man walking slowly down a bare corridor past a security camera',
    },
    {
        name: 'a frame is deleted',
        why: 'the set is twelve frames',
        file: 'json',
        from: '        {\n            "n": 12,',
        to: '        {\n            "n": 99,',
    },
];

// ---- build a mutant in a scratch directory ---------------------------

function buildMutant(m) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-mutant-'));

    let js = source;
    let jsn = registry;

    if (m.file === 'js') {
        if (!js.includes(m.from)) throw new Error('the mutation site is not in the source: ' + m.from);
        js = js.replace(m.from, m.to);
    } else {
        if (!jsn.includes(m.from)) throw new Error('the mutation site is not in the registry: ' + m.from);
        jsn = jsn.replace(m.from, m.to);
    }

    // The mutant's relative requires become absolute, so it can live
    // outside lib/ and still find the submitter and the linter.
    js = js.replace(/require\('\.\/([a-z0-9-]+)\.js'\)/g,
        (_m, name) => `require(${JSON.stringify(path.join(REPO, 'lib', name + '.js'))})`);

    const jsPath = path.join(dir, 'watched-man.js');
    const jsonPath = path.join(dir, 'watched-man.json');
    fs.writeFileSync(jsPath, js, 'utf8');
    fs.writeFileSync(jsonPath, jsn, 'utf8');
    return { dir, jsPath, jsonPath };
}

/**
 * Run the suite against a mutant.
 *
 * The test module resolves its subject by path, so the mutant is
 * installed under lib/ for the duration of the run and removed
 * afterwards. The ORIGINAL is never touched — the mutant is written to
 * a DIFFERENT name, and the test is pointed at it.
 */
function runSuite(mutant) {
    // A copy of the test that requires the mutant instead of the
    // original. The rest of the file is byte-identical, so the suite
    // that runs is the suite that ships.
    const testSrc = fs.readFileSync(TEST, 'utf8')
        .replace(/require\('\.\/watched-man\.js'\)/, `require(${JSON.stringify(mutant.jsPath)})`)
        .replace(/path\.join\(__dirname, 'watched-man\.json'\)/g, JSON.stringify(mutant.jsonPath))
        .replace(/path\.join\(__dirname, 'mj-config\.json'\)/g,
            JSON.stringify(path.join(REPO, 'lib', 'mj-config.json')))
        .replace(/require\('\.\/(mj-submitter|mj-flags|prompt-lint-core)\.js'\)/g,
            (_m, name) => `require(${JSON.stringify(path.join(REPO, 'lib', name + '.js'))})`);

    const testPath = path.join(mutant.dir, 'watched-man.test.js');
    fs.writeFileSync(testPath, testSrc, 'utf8');

    try {
        const out = execFileSync(process.execPath, [testPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { red: false, out };
    } catch (err) {
        return { red: true, out: String(err.stdout || '') + String(err.stderr || '') };
    }
}

// ---- the check --------------------------------------------------------

console.log('\n1. the UNMUTATED suite is green');
// The baseline mutant is an IDENTITY mutation — the file is copied
// and only its requires are rewritten, so the suite runs against
// byte-identical logic in a different directory.
const clean = buildMutant({ file: 'js', from: 'const REPO = path.resolve(__dirname, \'..\');', to: 'const REPO = path.resolve(__dirname, \'..\');' });
const baseline = runSuite(clean);
if (baseline.red) {
    console.log('  FAIL  the suite is red before any mutation — the baseline is broken');
    console.log(baseline.out.slice(-2000));
    process.exit(2);
}
console.log('  ok    the unmutated suite passes');

console.log('');
console.log('2. every mutation is CAUGHT');
let survived = 0;
for (const m of MUTATIONS) {
    let mutant;
    try {
        mutant = buildMutant(m);
    } catch (err) {
        console.log(`  ??    ${m.name} — ${err.message}`);
        survived++;
        continue;
    }
    const r = runSuite(mutant);
    if (r.red) {
        // Report WHICH assertion caught it, so a catch is legible.
        const line = (r.out.match(/FAIL\s+([^\n]+)/) || [])[1] || '(an assertion)';
        console.log(`  ok    ${m.name}`);
        console.log(`          caught by: ${line.trim().slice(0, 100)}`);
    } else {
        console.log(`  FAIL  ${m.name} SURVIVED — ${m.why}`);
        survived++;
    }
    fs.rmSync(mutant.dir, { recursive: true, force: true });
}
fs.rmSync(clean.dir, { recursive: true, force: true });

console.log('');
if (survived) {
    console.log(`  ${MUTATIONS.length - survived}/${MUTATIONS.length} mutations caught, ${survived} SURVIVED\n`);
    process.exit(2);
}
console.log(`  ${MUTATIONS.length}/${MUTATIONS.length} mutations caught\n`);
