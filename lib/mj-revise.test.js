#!/usr/bin/env node
// lib/mj-revise.test.js — the flag composition of lib/mj-revise.js.
//
// No browser, no network, no Midjourney account. The module is
// importable for exactly this reason: requiring it used to launch
// Chrome and drive the live account, which made the composition
// untestable — and the composition is where the bugs live.
//
// The bug this file exists for
// ----------------------------
// The tool inherits the source job's flags and appends them after the
// new prompt. Midjourney resolves a doubled flag by taking the LAST
// one, so a collision does not error — it silently picks the wrong
// value and the artist never finds out.
//
// Concretely: the source job was made with `--style raw --s 21`, and
// the new pack prompt says `--style niji`. The old composition
// produced
//
//     … --style niji --style raw --s 21 --edit … --ar 16:9
//
// MJ takes the last `--style`, so the source's `raw` won and the
// prompt's `niji` was discarded. Same failure class as the duplicated
// `--ar` and `--sref` (PM-2026-09-24-dup-flags).

'use strict';

const assert = require('node:assert');

const {
    splitCommand, flagString, editUrls, carriedFor, composePrompt,
} = require('./mj-revise.js');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (e) {
        failures.push({ name, err: e });
        process.stdout.write(`  ✗ ${name}\n     ${e.message}\n`);
    }
}

// Count how many times a flag appears in a composed prompt. A flag
// appearing twice is the bug: MJ resolves it silently.
const occurrences = (text, flag) => {
    const m = String(text).match(new RegExp(`(^|\\s)${flag}(?=\\s|$)`, 'g'));
    return m ? m.length : 0;
};

const SOURCE_CMD = 'a lone figure in a red coat, underpass at night '
    + '--style raw --s 21 --ar 16:9 --edit https://cdn.midjourney.com/abc/0_0_640_N.webp '
    + '--v 8.2';
const { prose, flags } = splitCommand(SOURCE_CMD);
const ATTACH = ['https://cdn.midjourney.com/abc/0_0_640_N.webp'];

// ------------------------------------------------------------------------
console.log('\n1. splitCommand');

check('splits the prose from the flags', () => {
    assert.ok(prose.startsWith('a lone figure in a red coat'));
    assert.ok(!prose.includes('--style'));
});
check('parses every flag segment', () => {
    const names = flags.map((f) => f.flag);
    for (const f of ['--style', '--s', '--ar', '--edit', '--v']) {
        assert.ok(names.includes(f), `missing ${f}`);
    }
});
check('a flag owns the tokens up to the next flag', () => {
    const style = flags.find((f) => f.flag === '--style');
    assert.deepStrictEqual(style.values, ['raw']);
    const s = flags.find((f) => f.flag === '--s');
    assert.deepStrictEqual(s.values, ['21']);
});
check('the --edit segment holds the attachment urls', () => {
    assert.deepStrictEqual(editUrls(flags), ATTACH);
});
check('a command with no flags is all prose', () => {
    const r = splitCommand('just some prose');
    assert.strictEqual(r.prose, 'just some prose');
    assert.deepStrictEqual(r.flags, []);
});
check('a trailing flag with no value is still a flag', () => {
    const r = splitCommand('prose --style');
    assert.strictEqual(r.prose, 'prose');
    assert.deepStrictEqual(r.flags, [{ flag: '--style', values: [] }]);
});

// ------------------------------------------------------------------------
console.log('\n2. flagString — the carry set');

check('carries the carryable flags', () => {
    const out = flagString(flags);
    assert.ok(out.includes('--style raw'));
    assert.ok(out.includes('--v 8.2'));
});
check('does not carry the prose', () => {
    assert.ok(!flagString(flags).includes('red coat'));
});
check('omits what it is told to omit', () => {
    const out = flagString(flags, { omit: new Set(['--ar', '--edit']) });
    assert.ok(!out.includes('--ar'));
    assert.ok(!out.includes('--edit'));
});
check('omits by flag name, not by value', () => {
    const out = flagString(flags, { omit: new Set(['--s']) });
    assert.ok(!out.includes('--s '));
    assert.ok(out.includes('--style raw'), 'the style must survive');
});

// ------------------------------------------------------------------------
console.log('\n3. carriedFor — what survives, given the prompt');

check('a plain prompt carries the source style and stylize', () => {
    const out = carriedFor('a lone figure in a blue coat', flags);
    assert.ok(out.includes('--style raw'));
    assert.ok(out.includes('--s 21'));
});
check('a prompt with its own --style drops the source --style', () => {
    const out = carriedFor('a blue coat, underpass at dawn --style niji', flags);
    assert.ok(!out.includes('--style'), 'the source --style must not be carried');
    assert.ok(out.includes('--v 8.2'), 'the unrelated flags must still be carried');
});
check('a prompt with its own --style drops the source --s too', () => {
    // The source's --s is coupled to the source's --style. Carrying the
    // --s without the --style would apply the source's stylize value to
    // the prompt's own style.
    const out = carriedFor('a blue coat --style niji', flags);
    assert.ok(!/\s--s(?=\s|$)/.test(out), 'the source --s must not be carried');
});
check('--raw is the same switch as --style raw', () => {
    const out = carriedFor('a blue coat --raw', flags);
    assert.ok(!out.includes('--style'));
});
check('a prompt with its own --s drops the source --s', () => {
    const out = carriedFor('a blue coat --s 500', flags);
    assert.ok(!/\s--s(?=\s|$)/.test(out));
});
check('a bare --style in the prompt still owns the flag', () => {
    // The guard matches the FLAG, not a value — a prompt ending in a
    // bare `--style` still means the prompt owns the style.
    const out = carriedFor('a blue coat --style', flags);
    assert.ok(!out.includes('--style raw'));
});

// ------------------------------------------------------------------------
console.log('\n4. composePrompt — the regression');

check('a prompt with --style niji is not shadowed by the source --style raw', () => {
    const out = composePrompt('a blue coat, underpass at dawn --style niji', flags, '16:9', ATTACH);
    assert.strictEqual(occurrences(out, '--style'), 1, `expected one --style in: ${out}`);
    assert.ok(out.includes('--style niji'), `the prompt's style must win: ${out}`);
    assert.ok(!out.includes('--style raw'), `the source's style must be gone: ${out}`);
});
check('the composed prompt carries the prompt prose', () => {
    const out = composePrompt('a blue coat, underpass at dawn', flags, '16:9', ATTACH);
    assert.ok(out.startsWith('a blue coat, underpass at dawn'));
});
check('the attachments survive', () => {
    const out = composePrompt('a blue coat', flags, '16:9', ATTACH);
    assert.ok(out.includes(`--edit ${ATTACH[0]}`));
});
check('the ratio is emitted last, so the source ratio wins', () => {
    const out = composePrompt('a blue coat', flags, '16:9', ATTACH);
    assert.ok(out.endsWith('--ar 16:9'), `the ratio must be last: ${out}`);
    assert.strictEqual(occurrences(out, '--ar'), 1);
});
check('NEVER two flags of the same kind, for any prompt', () => {
    const prompts = [
        'plain prompt',
        'with --style niji',
        'with --raw',
        'with --s 500',
        'with --style raw --s 250',
        'with --style niji --s 100',
    ];
    for (const p of prompts) {
        const out = composePrompt(p, flags, '16:9', ATTACH);
        // At MOST one of each. Zero is fine and often correct — a
        // prompt that owns --style drops the source's --s entirely.
        // More than one is the bug: MJ takes the last one silently.
        for (const f of ['--style', '--s', '--ar', '--edit', '--v']) {
            const n = occurrences(out, f);
            assert.ok(n <= 1, `${f} appears ${n}x for "${p}" → ${out}`);
        }
    }
});
check('the prompt keeps its own --s when it names one', () => {
    const out = composePrompt('with --s 500', flags, '16:9', ATTACH);
    assert.ok(out.includes('--s 500'), `the prompt's --s must survive: ${out}`);
    assert.strictEqual(occurrences(out, '--s'), 1);
});
check('the unrelated source flags are always carried', () => {
    for (const p of ['plain', '--style niji', '--s 500']) {
        const out = composePrompt(p, flags, '16:9', ATTACH);
        assert.ok(out.includes('--v 8.2'), `--v lost for "${p}": ${out}`);
    }
});
check('a prompt with no attachments omits --edit entirely', () => {
    const out = composePrompt('a blue coat', flags, '16:9', []);
    assert.strictEqual(occurrences(out, '--edit'), 0);
    assert.ok(out.includes('--ar 16:9'));
});
check('no double spaces in the composed prompt', () => {
    const out = composePrompt('a blue coat', flags, '16:9', ATTACH);
    assert.ok(!/\s{2,}/.test(out), out);
});

// ------------------------------------------------------------------------
console.log(`\n[mj-revise.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
