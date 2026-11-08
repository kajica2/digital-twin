#!/usr/bin/env node
// lib/mj-console.test.js
//
// Tests for the MJ console's store and for the SHARED modules the
// console depends on.
//
// The shared-module parity section is the important one. The console
// (browser) and the submitter (Node) must compose prompts IDENTICALLY,
// or the console shows one command and the submitter sends another —
// the user has no way to tell, and the generation comes out wrong.
//
// So the parity check is not "the two look similar". It is: for a set
// of prompts and defaults, the browser-loaded module and the
// Node-loaded module produce byte-identical output.
//
//   node lib/mj-console.test.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./mj-console-store.js');
const flags = require('./mj-flags.js');
const lintCore = require('./prompt-lint-core.js');
const lint = require('./prompt-lint.js');
const submitter = require('./mj-submitter.js');

let passed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond, detail) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failures.push({ label, actual: String(detail || 'false'), expected: 'true' });
        process.stderr.write(`  ✗ ${label}${detail ? ' — ' + detail : ''}\n`);
    }
}
async function throws(label, fn, fragment) {
    try {
        await fn();
        failures.push({ label, actual: 'did not throw', expected: fragment || 'throw' });
        process.stderr.write(`  ✗ ${label} (did not throw)\n`);
    } catch (e) {
        assertTrue(label, !fragment || String(e.message).includes(fragment), e.message);
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-console-'));

// ---------------------------------------------------------------------------
// 1. The shared flag module
// ---------------------------------------------------------------------------
process.stderr.write('1. the shared flag module composes like the submitter\n');
{
    assert('the module exports the composer', typeof flags.buildFullPrompt, 'function');
    assert('the module exports the segment parser', typeof flags.parseFlagSegments, 'function');

    // The composer the submitter uses IS the shared one.
    assert('the submitter re-exports the shared composer',
        submitter.buildFullPrompt, flags.buildFullPrompt);

    const DEFAULTS = '--ar 3:4 --style raw --s 250';
    const countAr = (s) => (s.match(/--ar\s+\S+/g) || []).length;

    assert('one --ar', countAr(flags.buildFullPrompt('a trumpet at dawn', '16:9', DEFAULTS)), 1);
    assert('the caller ratio wins', flags.buildFullPrompt('a trumpet at dawn', '16:9', DEFAULTS),
        'a trumpet at dawn --style raw --s 250 --ar 16:9');
    assert('the prompt ratio wins over the caller',
        flags.buildFullPrompt('x --ar 1:1', '16:9', DEFAULTS), 'x --ar 1:1 --style raw --s 250');
    assert('no ratio anywhere emits none',
        countAr(flags.buildFullPrompt('x', null, '--style raw')), 0);
    assert('free text in the defaults survives',
        flags.buildFullPrompt('x', '16:9', 'cinematic --ar 16:9 --raw'),
        'x cinematic --raw --ar 16:9');
}

// ---------------------------------------------------------------------------
// 2. Shared-module parity — the browser and Node must agree
// ---------------------------------------------------------------------------
process.stderr.write('2. the browser-loaded module and the Node module agree\n');
{
    // Load lib/mj-flags.js the way a BROWSER loads it: as a classic
    // script with no module system. The file's own IIFE sets
    // `window.MJFlags` when there is no CommonJS `module` in scope.
    //
    // This is the check that matters: if the browser path and the Node
    // path ever diverge, the console lies about what it will send.
    const vm = require('node:vm');
    const src = fs.readFileSync(path.join(__dirname, 'mj-flags.js'), 'utf8');
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'mj-flags.js' });

    assertTrue('the browser load exposes window.MJFlags', !!sandbox.window.MJFlags);
    const browserFlags = sandbox.window.MJFlags;

    const CASES = [
        ['a trumpet at dawn', '16:9', '--ar 16:9 --style raw --s 21'],
        ['x --ar 1:1', '16:9', '--ar 16:9 --style raw --s 21'],
        ['x', null, '--ar 16:9 --style raw --s 21'],
        ['x', '9:16', ''],
        ['x --style raw', '16:9', '--ar 16:9 --style raw --s 21'],
        ['x --s 755', '16:9', '--ar 16:9 --style raw --s 21'],
        ['x --sref 1234567890', '16:9', '--ar 16:9 --raw --sref 6965361632'],
        ['x', '16:9', 'cinematic --ar 16:9 --raw'],
    ];
    let allMatch = true;
    for (const [prompt, ar, defaults] of CASES) {
        const nodeOut = flags.buildFullPrompt(prompt, ar, defaults);
        const browserOut = browserFlags.buildFullPrompt(prompt, ar, defaults);
        if (nodeOut !== browserOut) {
            allMatch = false;
            process.stderr.write(`    MISMATCH for ${JSON.stringify([prompt, ar, defaults])}\n`);
        }
    }
    assertTrue('browser and Node compose identically for every case', allMatch);

    // The same for the lint rule.
    const lintSrc = fs.readFileSync(path.join(__dirname, 'prompt-lint-core.js'), 'utf8');
    const lintSandbox = { window: {}, console };
    vm.createContext(lintSandbox);
    vm.runInContext(lintSrc, lintSandbox, { filename: 'prompt-lint-core.js' });
    assertTrue('the browser load exposes window.PromptLint', !!lintSandbox.window.PromptLint);

    const PROMPTS = [
        'a Black man in a red coat',
        'a man in a black coat',
        'a black-and-white portrait of a man',
        'an Asian woman at a piano',
        'a trumpet player on a dark stage',
        'white wine on a table',
        'a Nordic winter street',
    ];
    let lintMatch = true;
    for (const p of PROMPTS) {
        const a = JSON.stringify(lintCore.findViolations(p));
        const b = JSON.stringify(lintSandbox.window.PromptLint.findViolations(p));
        if (a !== b) { lintMatch = false; process.stderr.write(`    MISMATCH for ${JSON.stringify(p)}\n`); }
    }
    assertTrue('browser and Node lint identically for every case', lintMatch);

    // And the linter's own re-export is the shared rule.
    assert('the linter re-exports the shared rule', lint.findViolations, lintCore.findViolations);
}

// ---------------------------------------------------------------------------
// Async sections (the store's async guards)
// ---------------------------------------------------------------------------
async function main() {
    // ---------------------------------------------------------------------------
    // 3. The identity lint gate
    // ---------------------------------------------------------------------------
    process.stderr.write('3. a prompt naming the subject identity is refused\n');
    {
        const s = store.createStore(path.join(TMP, 'lint.json'));

        await throws('a racial descriptor is refused',
            () => s.add({ title: 'Bad', prompt: 'a Black man in a red coat' }),
            "race/ethnicity");
        await throws('an ethnic descriptor is refused',
            () => s.add({ title: 'Bad', prompt: 'an Asian woman at a piano' }),
            "race/ethnicity");
        await throws('"of colour" is refused',
            () => s.add({ title: 'Bad', prompt: 'a person of colour in the street' }),
            "race/ethnicity");

        // The exceptions still work — the rule is not a blunt word-ban.
        const ok = s.add({ title: 'Fine', prompt: 'a man in a black coat at a piano' });
        assertTrue('clothing is not a finding', !!ok.id);
        const ok2 = s.add({ title: 'Fine2', prompt: 'a black-and-white portrait of a man' });
        assertTrue('a photographic treatment is not a finding', !!ok2.id);

        // Nothing was written by the refused saves.
        assert('the refused prompts were not stored', s.list().totals.prompts, 2);
    }

    // ---------------------------------------------------------------------------
    // 4. The store
    // ---------------------------------------------------------------------------
    process.stderr.write('4. the store saves, lists, updates and removes\n');
    {
        const file = path.join(TMP, 'store.json');
        const s = store.createStore(file);

        assert('an empty store lists nothing', s.list().totals.prompts, 0);

        const saved = s.add({ title: 'Dawn trumpet', prompt: 'a trumpet at dawn', ar: '16:9', tags: ['Jazz', 'jazz', 'dawn'] });
        assertTrue('the saved prompt has an id', typeof saved.id === 'string' && saved.id.length > 3);
        assert('tags are lowercased and deduped', saved.tags, ['jazz', 'dawn']);
        assert('the ratio is kept separate from the text', saved.prompt, 'a trumpet at dawn');
        assert('the ratio is stored', saved.ar, '16:9');

        // The composed command is derived, never stored: it carries the
        // house defaults, and it is the shared composer's output.
        //
        // The house suffix changed on 2026-11-07: `--style raw --s 21`
        // became `--raw --stylize 21`, with `--chaos`, `--seed`, `--sref`,
        // `--profile` and `--hd` added. So the assertion is against the
        // CONFIG's defaults rather than a hardcoded string — a spelling
        // change in the house suffix must not fail the console's tests,
        // and a composer that DROPPED a default would still be caught,
        // because the config's own flags are read here.
        const house = require('./mj-config.json');
        const houseArgs = (house.mj && house.mj.defaultArgs) || '';
        const houseFlags = (houseArgs.match(/--[a-z][\w-]*/g) || [])
            .filter((f) => f !== '--ar');
        assertTrue('the composed command carries the house defaults',
            houseFlags.every((f) => saved.composed.includes(f)), saved.composed);
        assertTrue('the composed command has exactly one --ar',
            (saved.composed.match(/--ar\s+\S+/g) || []).length === 1, saved.composed);
        assertTrue('the composed command ends with --ar',
            saved.composed.slice(saved.composed.indexOf('--ar')).startsWith('--ar 16:9'), saved.composed);

        // The stored record must NOT carry a composed command — it is
        // derived on read, so it cannot go stale.
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        assertTrue('the stored record has no composed command', raw.prompts[0].composed === undefined);

        // A prompt carrying its own --ar: the ratio is split off and the
        // text keeps no --ar.
        const own = s.add({ title: 'Own ratio', prompt: 'a stage at night --ar 3:4' });
        assert('an embedded ratio is split off', own.ar, '3:4');
        assert('the text keeps no --ar', own.prompt, 'a stage at night');

        // The list derives the composed command on read.
        const listed = s.list();
        assert('the list holds both prompts', listed.totals.prompts, 2);
        assertTrue('the listed prompt carries its composed command',
            listed.prompts[0].composed.includes('--ar 16:9'));

        // Update by id.
        const updated = s.add({ id: saved.id, title: 'Dawn trumpet v2', prompt: 'a trumpet at dawn', ar: '16:9' });
        assert('the update keeps the id', updated.id, saved.id);
        assert('the update keeps the createdAt', updated.createdAt, saved.createdAt);
        assert('the update changes the title', updated.title, 'Dawn trumpet v2');
        assert('the update does not add a prompt', s.list().totals.prompts, 2);

        // Remove.
        assert('removing a known id returns true', s.remove(saved.id), true);
        assert('removing it again returns false', s.remove(saved.id), false);
        assert('the library is one shorter', s.list().totals.prompts, 1);

        // A fresh store over the same file sees the saved prompt (the file
        // is the source of truth, not the in-memory object).
        const s2 = store.createStore(file);
        assert('a second store sees the same library', s2.list().totals.prompts, 1);
    }

    // ---------------------------------------------------------------------------
    // 5. The store's guards
    // ---------------------------------------------------------------------------
    process.stderr.write('5. the store refuses bad input\n');
    {
        const s = store.createStore(path.join(TMP, 'guards.json'));

        await throws('a missing title is refused', () => s.add({ prompt: 'x' }), 'title is required');
        await throws('a missing prompt is refused', () => s.add({ title: 'x' }), 'prompt text is required');
        await throws('a malformed ratio is refused',
            () => s.add({ title: 'x', prompt: 'y', ar: 'wide' }), 'invalid aspect ratio');
        await throws('an over-long title is refused',
            () => s.add({ title: 'x'.repeat(200), prompt: 'y' }), 'too long');
        await throws('an over-long prompt is refused',
            () => s.add({ title: 'x', prompt: 'y'.repeat(5000) }), 'too long');

        assert('nothing was stored', s.list().totals.prompts, 0);
    }

    // ---------------------------------------------------------------------------
    // 6. The pack export — the bridge to the watcher
    // ---------------------------------------------------------------------------
    process.stderr.write('6. the pack export is a file the watcher can read\n');
    {
        const s = store.createStore(path.join(TMP, 'pack.json'));
        s.add({ title: 'One', prompt: 'a trumpet at dawn', ar: '16:9' });
        s.add({ title: 'Two', prompt: 'a stage at night', ar: '3:4' });

        const pack = s.toPack({ title: 'Console pack' });
        assertTrue('the pack has a heading', pack.startsWith('# Console pack — 2 prompts'), pack.slice(0, 40));
        assertTrue('every prompt is a top-level bullet',
            (pack.match(/^- /gm) || []).length === 2, pack);
        assertTrue('each bullet carries its ratio', pack.includes('- a trumpet at dawn --ar 16:9'));
        assertTrue('the second bullet carries its own ratio', pack.includes('- a stage at night --ar 3:4'));

        // THE ROUND-TRIP: the pack must parse through the SUBMITTER'S OWN
        // parser, or the watcher would not see the prompts the console
        // saved.
        const packFile = path.join(TMP, 'pack.md');
        fs.writeFileSync(packFile, pack, 'utf8');
        const parsed = submitter.extractPrompts(packFile);
        assert('the submitter parses two prompts', parsed.length, 2);
        assert('the first prompt keeps its text', parsed[0].text, 'a trumpet at dawn');
        assert('the first prompt keeps its ratio', parsed[0].ar, '16:9');
        assert('the second prompt keeps its ratio', parsed[1].ar, '3:4');

        // And the pack passes the repo's own lint.
        const scanned = lint.scanFile(packFile);
        assert('the exported pack has no lint violations', scanned.violations.length, 0);

        // A selected subset exports only the selected prompts.
        const all = s.list().prompts;
        const subset = s.toPack({ title: 'One', ids: [all[0].id] });
        assert('a selected subset exports one bullet', (subset.match(/^- /gm) || []).length, 1);
    }

    // ---------------------------------------------------------------------------
    // 7. The atomic write
    // ---------------------------------------------------------------------------
    process.stderr.write('7. the store writes atomically and survives a bad file\n');
    {
        const file = path.join(TMP, 'atomic.json');
        const s = store.createStore(file);
        s.add({ title: 'One', prompt: 'a trumpet at dawn', ar: '16:9' });

        // No temp file left behind.
        const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
        assert('no temp file is left behind', leftovers.length, 0);

        // A corrupt file is a clear error, not a crash.
        fs.writeFileSync(file, '{ this is not json', 'utf8');
        await throws('a corrupt library is a clear error', () => s.list(), 'not valid JSON');
    }

    // ---------------------------------------------------------------------------
    // 8. The id
    // ---------------------------------------------------------------------------
    process.stderr.write('8. the ids are unique and ordered\n');
    {
        const ids = new Set();
        for (let i = 0; i < 200; i++) ids.add(store.newId(1700000000000 + i));
        assert('200 ids at 1ms apart are unique', ids.size, 200);

        // Time-prefixed, so the library's natural order is its creation order.
        const earlier = store.newId(1700000000000);
        const later = store.newId(1700000001000);
        assertTrue('the id sorts by creation time', earlier < later, `${earlier} vs ${later}`);
    }


}

// ---------------------------------------------------------------------------

main().then(() => {
    process.stderr.write('\n');
    if (failures.length === 0) {
        process.stderr.write(`[mj-console.test] passed: ${passed}, failed: 0\n`);
        process.exit(0);
    } else {
        process.stderr.write(`[mj-console.test] passed: ${passed}, failed: ${failures.length}\n`);
        for (const f of failures) {
            process.stderr.write(`  ✗ ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
        }
        process.exit(1);
    }
}).catch((err) => {
    process.stderr.write(`[mj-console.test] crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
