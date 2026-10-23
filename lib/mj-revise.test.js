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
    splitCommand, flagString, editUrls, carriedFor, composePrompt, resolveRatio, promptRatio, stripOwnAr, gridFileName, parseDropFlags,
    parseReplaceFlags, aliasNames, sameJob,
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
// THE WEB UI'S SPELLINGS
//
// Everything above uses `--style raw --s 21` — the spelling a
// hand-written prompt uses. Midjourney's own web UI writes the same
// concepts as `--raw` and `--stylize`, and a SOURCE job read back
// from the feed carries the UI's spelling, not the prompt's.
//
// This section exists because that difference was a live bug: the
// omit set was built from `--style`/`--s`, the source said
// `--raw`/`--stylize`, neither matched, and the source's style was
// appended after the new prompt's — so MJ took the LAST one and the
// new prompt's style was silently discarded. Every assertion above
// passed while the real feed did the wrong thing.
//
// The fixture below is copied from a real feed entry.
console.log('\n5. the web UI spellings — --raw / --stylize');

const UI_SOURCE_CMD = 'Extreme close-up of a man and woman faces during a slow dance. '
    + 'Soft warm lighting, sepia grade, photorealistic '
    + '--ar 16:9 --raw --sref https://s.mj.run/wTd5kzM3CII '
    + '--profile brvazka mhw6dpq xr39csb det21e6 67lkfw3 '
    + '--stylize 21 --hd --v 8.2 --edit https://s.mj.run/S5NTExpxk04';
const uiFlags = splitCommand(UI_SOURCE_CMD).flags;
const UI_ATTACH = ['https://s.mj.run/S5NTExpxk04'];

check('the fixture really does use the UI spellings', () => {
    const names = uiFlags.map((f) => f.flag);
    assert.ok(names.includes('--raw'), 'expected --raw');
    assert.ok(names.includes('--stylize'), 'expected --stylize');
    assert.ok(!names.includes('--style'), 'the UI does not write --style');
    assert.ok(!names.includes('--s'), 'the UI does not write --s');
});
check('a plain prompt carries the UI-spelled style and stylize', () => {
    const out = carriedFor('a lone figure in a blue coat', uiFlags);
    assert.ok(out.includes('--raw'), out);
    assert.ok(out.includes('--stylize 21'), out);
});
check('a prompt with its own --style drops the source --raw', () => {
    const out = carriedFor('a blue coat, underpass at dawn --style niji', uiFlags);
    assert.ok(!/\s--raw(?=\s|$)/.test(out), `the source --raw must not be carried: ${out}`);
});
check('a prompt with its own --style drops the source --stylize too', () => {
    const out = carriedFor('a blue coat --style niji', uiFlags);
    assert.ok(!/\s--stylize(?=\s|$)/.test(out), `the source --stylize must not be carried: ${out}`);
});
check('a prompt with its own --raw drops the source --raw', () => {
    const out = carriedFor('a blue coat --raw', uiFlags);
    assert.ok(!/\s--raw(?=\s|$)/.test(out), out);
});
check('a prompt with its own --stylize drops the source --stylize', () => {
    const out = carriedFor('a blue coat --stylize 500', uiFlags);
    assert.ok(!/\s--stylize(?=\s|$)/.test(out), out);
});
check('the composed prompt is not shadowed by the UI-spelled source style', () => {
    const out = composePrompt('a blue coat, underpass at dawn --style niji', uiFlags, '16:9', UI_ATTACH);
    assert.ok(out.includes('--style niji'), `the prompt's style must win: ${out}`);
    assert.ok(!/\s--raw(?=\s|$)/.test(out), `the source's --raw must be gone: ${out}`);
    assert.ok(!/\s--stylize(?=\s|$)/.test(out), `the source's --stylize must be gone: ${out}`);
});
check('NEVER two flags of the same kind against a UI-spelled source', () => {
    const prompts = [
        'plain prompt',
        'with --style niji',
        'with --raw',
        'with --s 500',
        'with --stylize 500',
        'with --style niji --s 100',
    ];
    for (const p of prompts) {
        const out = composePrompt(p, uiFlags, '16:9', UI_ATTACH);
        // Count both spellings of each concept — the point is that the
        // CONCEPT appears at most once, however it is spelled.
        const styleCount = occurrences(out, '--style') + occurrences(out, '--raw');
        const stylizeCount = occurrences(out, '--s') + occurrences(out, '--stylize');
        assert.ok(styleCount <= 1, `style appears ${styleCount}x for "${p}" → ${out}`);
        assert.ok(stylizeCount <= 1, `stylize appears ${stylizeCount}x for "${p}" → ${out}`);
        assert.strictEqual(occurrences(out, '--ar'), 1, out);
        assert.strictEqual(occurrences(out, '--edit'), 1, out);
    }
});
check('the unrelated source flags still ride along', () => {
    const out = carriedFor('a blue coat --style niji', uiFlags);
    assert.ok(out.includes('--sref https://s.mj.run/wTd5kzM3CII'), out);
    assert.ok(out.includes('--v 8.2'), out);
    assert.ok(out.includes('--hd'), out);
});
check('--sref is not mistaken for --s', () => {
    // `--sref` starts with `--s` but is a different flag. A prompt
    // carrying `--sref` does NOT own the stylize.
    const out = carriedFor('a blue coat --sref https://s.mj.run/abc', uiFlags);
    assert.ok(out.includes('--stylize 21'), `the source stylize must survive: ${out}`);
});
check('--stylize in the prompt does not read as --style', () => {
    const out = carriedFor('a blue coat --stylize 500', uiFlags);
    assert.ok(!/\s--raw(?=\s|$)/.test(out), `a stylize is not a style: ${out}`);
});

// ------------------------------------------------------------------------
console.log('\n5b. the ratio is owned by exactly one side');
// PM-2026-09-24-dup-flags: MJ resolves a doubled flag by taking the
// LAST one, silently. The pack convention puts `--ar 16:9` on every
// bullet, so composing without care emitted the ratio twice and hid
// which value actually won.
check('a prompt with its own --ar does not double it', () => {
    const out = composePrompt('a red coat in an underpass --style niji --ar 16:9', uiFlags, '16:9', ['https://s.mj.run/x']);
    const count = (out.match(/(?<![\w-])--ar(?=\s|$)/g) || []).length;
    assert.strictEqual(count, 1, `one --ar only: ${out}`);
});
check("the prompt's own ratio wins over the source's", () => {
    const out = composePrompt('a red coat --ar 3:4', uiFlags, '16:9', []);
    assert.ok(out.includes('--ar 3:4'), `the prompt owns the ratio: ${out}`);
    assert.ok(!out.includes('--ar 16:9'), `the source ratio must not ride along: ${out}`);
});
check('a prompt with no ratio takes the source ratio', () => {
    const out = composePrompt('a red coat in an underpass', uiFlags, '16:9', []);
    assert.ok(out.includes('--ar 16:9'), `the source ratio is used: ${out}`);
    assert.strictEqual((out.match(/(?<![\w-])--ar(?=\s|$)/g) || []).length, 1);
});
check('the ratio is still last', () => {
    const out = composePrompt('a red coat --ar 3:4', uiFlags, '16:9', ['https://s.mj.run/x']);
    assert.ok(/--ar 3:4$/.test(out), `the ratio goes last: ${out}`);
});
check('the source ratio is not carried twice either', () => {
    const out = composePrompt('a red coat', uiFlags, '16:9', []);
    assert.strictEqual((out.match(/(?<![\w-])--ar(?=\s|$)/g) || []).length, 1, out);
});

// The ratio is resolved in two places: the composed prompt and the
// `carriedFlags` recorded in meta.json. They must agree, or the record
// misreports what was actually submitted.
check('resolveRatio is the single owner of the ratio', () => {
    assert.strictEqual(resolveRatio('a red coat --ar 3:4', '16:9'), '3:4');
    assert.strictEqual(resolveRatio('a red coat', '16:9'), '16:9');
});
check('stripOwnAr removes the ratio from the prose only', () => {
    assert.strictEqual(stripOwnAr('a red coat --ar 16:9'), 'a red coat');
    assert.strictEqual(stripOwnAr('a red coat'), 'a red coat');
    assert.strictEqual(stripOwnAr('a red coat --ar 16:9 in the rain'), 'a red coat in the rain');
});
check('the recorded carriedFlags carry the prompt own ratio', () => {
    const composed = composePrompt('a red coat --ar 3:4', uiFlags, '16:9', []);
    const recorded = `${carriedFor('a red coat --ar 3:4', uiFlags)} --ar ${resolveRatio('a red coat --ar 3:4', '16:9')}`.trim();
    assert.ok(recorded.includes('--ar 3:4'), `the record names the prompt ratio: ${recorded}`);
    assert.ok(!recorded.includes('--ar 16:9'), `the source ratio must not be recorded: ${recorded}`);
    assert.ok(composed.includes('--ar 3:4'), composed);
});

// ------------------------------------------------------------------------
console.log('\n6. the submit path is SHARED with mj-web.js');
// The composer's submit path lives in mj-web.js, together with the
// evidence that a submission was accepted. This file used to carry its
// own copy, and that copy WAS the buggy one: it took the first
// unlabelled icon button, which is "parameters", not "send". The click
// opened a panel, nothing was submitted, and the log said it had been.
//
// These assertions read the source because the failure mode is
// structural: a second copy creeping back in is exactly the bug.
const fs = require('node:fs');
const path = require('node:path');
const reviseSource = fs.readFileSync(path.join(__dirname, 'mj-revise.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, 'mj-web.js'), 'utf8');

check('mj-revise.js has no second copy of the submit path', () => {
    assert.ok(
        !reviseSource.includes("querySelectorAll('button')"),
        'mj-revise.js must not search for the send button itself',
    );
    assert.ok(
        !reviseSource.includes('Input.dispatchKeyEvent'),
        'mj-revise.js must not dispatch its own key events',
    );
});
check('mj-revise.js uses the shared submitViaComposer', () => {
    assert.ok(
        reviseSource.includes('submitViaComposer'),
        'mj-revise.js must call the shared submitViaComposer',
    );
    assert.ok(
        /require\('\.\/mj-web\.js'\)/.test(reviseSource),
        'mj-revise.js must import it from mj-web.js',
    );
});
check('mj-web.js is the only place that drives the composer', () => {
    assert.ok(
        webSource.includes('submitViaComposer'),
        'mj-web.js must own the composer submit path',
    );
    assert.ok(
        !reviseSource.includes('Input.insertText'),
        'mj-revise.js must not type into the composer itself',
    );
});
check('the shared submit response carries the job id', () => {
    const { parseSubmitResponse } = require('./mj-web.js');
    const job = parseSubmitResponse(JSON.stringify({
        success: [{
            job_id: 'abc-123', prompt: 'p --style niji --ar 16:9',
            job_type: 'v8-2_edit_diffusion', event_type: 'diffusion',
            meta: { batch_size: 4, width: 2944, height: 1648 },
        }],
    }));
    assert.strictEqual(job.jobId, 'abc-123');
    assert.strictEqual(job.jobType, 'v8-2_edit_diffusion');
    assert.strictEqual(job.batchSize, 4);
});
check('the dead send-button path cannot come back', () => {
    const web = require('./mj-web.js');
    assert.strictEqual(typeof web.findSendButton, 'undefined');
    assert.strictEqual(typeof web.clickSendButton, 'undefined');
});
check('the recorded carriedFlags use the ratio the prompt carried', () => {
    // The record in meta.json must name the ratio the prompt actually
    // carried. It used to read the source's ratio, which MISREPORTS
    // what was submitted — a 16:9 pack was recorded as `--ar 4:3` and
    // rendered as 4:3. The ratio now comes from promptRatio(), which
    // is the pack's own `--ar` when the pack names one.
    //
    // This is behavioural, not a source-text pin: the old check asserted
    // the literal string `--ar ${resolveRatio(text, ar)}`, which is
    // exactly the line that carried the defect. A pin on the wrong
    // line is a test that guards the bug.
    assert.ok(
        reviseSource.includes('--ar ${wantRatio}'),
        'meta.json must record the ratio the prompt carried, not the source ratio',
    );
    assert.strictEqual(promptRatio({ text: 'a man in a dark studio', ar: '16:9' }, '4:3'), '16:9');
});
check('a grid file is named for the format it holds', () => {
    // Midjourney's CDN serves WebP. A file called `0_0.png` that is
    // really WebP makes the artifact lie about its own format —
    // `file` reports WebP while the extension claims PNG.
    assert.strictEqual(gridFileName('https://cdn.midjourney.com/abc/0_0_640_N.webp?method=shortest', 0), '0_0.webp');
    assert.strictEqual(gridFileName('https://cdn.midjourney.com/abc/0_1_2048_N.webp', 1), '0_1.webp');
    assert.strictEqual(gridFileName('https://cdn.midjourney.com/abc/0_0.jpeg', 0), '0_0.jpeg');
    assert.strictEqual(gridFileName('not-a-url', 2), '0_2.webp');
});
check('the grid files are recorded in the meta', () => {
    assert.ok(reviseSource.includes('gridFiles,'), 'meta.json must list the files that were written');
    assert.ok(reviseSource.includes('nativeSize,'), 'meta.json must record the job native size');
});

// ------------------------------------------------------------------------
console.log('\n8. dropping a source flag (--drop-flag)');

const SREF_CMD = 'a couple in an embrace, sepia gothic '
    + '--sref https://s.mj.run/R23NDDPH-5Q --profile aeq4jzq --stylize 0 --hd --v 8.2 '
    + '--edit https://s.mj.run/lmu98W7RiTU --ar 128:171';
const srefFlags = splitCommand(SREF_CMD).flags;
const srefAttach = editUrls(srefFlags);
const dropSref = new Set(['--sref']);
const composedNoSref = composePrompt('a couple in an embrace, re-posed from below', srefFlags, '128:171', srefAttach, dropSref);

check('the dropped flag does not travel', () => {
    assert.ok(!composedNoSref.includes('--sref'), `--sref survived the drop: ${composedNoSref}`);
});
check('the dropped flag takes its value with it', () => {
    assert.ok(!composedNoSref.includes('R23NDDPH-5Q'), 'the --sref url survived the drop');
});
check('the reference image still travels', () => {
    assert.ok(composedNoSref.includes('--edit https://s.mj.run/lmu98W7RiTU'),
        'the --edit attachment must survive a flag drop');
});
check('the other source flags still travel', () => {
    for (const f of ['--profile', '--stylize', '--hd', '--v 8.2']) {
        assert.ok(composedNoSref.includes(f), `${f} was lost with the drop`);
    }
});
check('the ratio still travels exactly once', () => {
    assert.strictEqual(occurrences(composedNoSref, '--ar'), 1);
    assert.ok(composedNoSref.includes('--ar 128:171'));
});
check('carriedFor drops the flag', () => {
    assert.ok(!carriedFor('a pose', srefFlags, dropSref).includes('--sref'));
    assert.ok(carriedFor('a pose', srefFlags).includes('--sref'), 'without a drop the --sref must still travel');
});
check('dropping a flag the source does not have is a no-op', () => {
    const composed = composePrompt('a pose', srefFlags, '128:171', srefAttach, new Set(['--oref']));
    assert.ok(composed.includes('--sref'), 'an unrelated drop must not disturb the other flags');
    assert.ok(composed.includes('--edit'));
});
check('the drop is recorded in the manifest', () => {
    assert.ok(reviseSource.includes('droppedFlags:'), 'meta.json must record which flags were dropped');
    assert.ok(reviseSource.includes('DROP_FLAGS'), 'the dropped set must reach the composition');
});
check('the CLI accepts --drop-flag', () => {
    assert.ok(reviseSource.includes("'--drop-flag'"), 'the CLI must accept --drop-flag');
});
check('the drop flags are parsed from argv', () => {
    // The bug this pins: the first parser read argv with
    // filter+flatMap, where the callback's index is the index in the
    // FILTERED array — so `--drop-flag sref` picked up the script's own
    // path, and the drop silently did nothing while the log said it
    // had dropped something.
    const argv = ['node', '/abs/path/mj-revise.js', '--source', 'abc', '--drop-flag', 'sref'];
    const drop = parseDropFlags(argv);
    assert.ok(drop.has('--sref'), `--sref was not parsed: ${[...drop].join(' ')}`);
    assert.strictEqual(drop.size, 1);
});
check('several drop flags in one value are all read', () => {
    const drop = parseDropFlags(['node', 'x.js', '--drop-flag', 'sref,style']);
    assert.ok(drop.has('--sref'));
    assert.ok(drop.has('--style'));
});
check('a drop flag may be written with its dashes', () => {
    assert.ok(parseDropFlags(['node', 'x.js', '--drop-flag', '--sref']).has('--sref'));
});
check('no drop flag means no drops', () => {
    assert.strictEqual(parseDropFlags(['node', 'x.js', '--source', 'abc']).size, 0);
});
check('a trailing --drop-flag with no value is ignored', () => {
    assert.strictEqual(parseDropFlags(['node', 'x.js', '--drop-flag']).size, 0);
});

// ------------------------------------------------------------------------
console.log('\n8b. replacing a source flag (--replace-flag)');

const P_CMD = 'side profile selfie of a man --ar 4:3 --raw --profile xy9cz8o mhw6dpq '
    + '--edit https://s.mj.run/usV0f2WYXrE --stylize 0 --v 8.2';

check('the CLI accepts --replace-flag', () => {
    assert.ok(reviseSource.includes("'--replace-flag'"), 'the CLI must accept --replace-flag');
});
check('a replacement is parsed from argv', () => {
    const rep = parseReplaceFlags(['node', 'x.js', '--replace-flag', 'p=m7507137468043532712']);
    assert.strictEqual(rep.length, 1);
    assert.strictEqual(rep[0].name, '--p');
    assert.strictEqual(rep[0].value, 'm7507137468043532712');
});
check('a replacement may be written with its dashes', () => {
    const rep = parseReplaceFlags(['node', 'x.js', '--replace-flag', '--p=abc']);
    assert.strictEqual(rep[0].name, '--p');
    assert.strictEqual(rep[0].value, 'abc');
});
check('a malformed replacement is ignored, not guessed', () => {
    assert.strictEqual(parseReplaceFlags(['node', 'x.js', '--replace-flag', 'novalue']).length, 0);
    assert.strictEqual(parseReplaceFlags(['node', 'x.js', '--replace-flag', '=abc']).length, 0);
    assert.strictEqual(parseReplaceFlags(['node', 'x.js', '--replace-flag']).length, 0);
});
check('--p and --profile are the same concept', () => {
    // MJ spells the personalization flag both ways. A replacement for
    // one must retire the other, or the source's value silently wins
    // (MJ takes the last of a doubled flag).
    assert.ok(aliasNames('--p').includes('--profile'));
    assert.ok(aliasNames('--profile').includes('--p'));
});
check('a replaced flag does not travel in the source form', () => {
    const rep = parseReplaceFlags(['node', 'x.js', '--replace-flag', 'p=m7507137468043532712']);
    const composed = composePrompt('a maker in a dark studio', splitCommand(P_CMD).flags,
        '4:3', ['https://s.mj.run/usV0f2WYXrE'], new Set(), rep);
    assert.ok(!/--profile/.test(composed), `the source's --profile survived: ${composed}`);
    assert.ok(/--p m7507137468043532712/.test(composed), `the replacement is missing: ${composed}`);
});
check('the replacement is emitted AFTER the carried flags', () => {
    // MJ resolves a doubled flag by taking the LAST one, so the
    // replacement has to come after the source's flags to apply.
    const rep = parseReplaceFlags(['node', 'x.js', '--replace-flag', 'p=m7507137468043532712']);
    const composed = composePrompt('a maker', splitCommand(P_CMD).flags,
        '4:3', ['https://s.mj.run/usV0f2WYXrE'], new Set(), rep);
    assert.ok(composed.indexOf('--p m7507') > composed.indexOf('--raw'),
        `the replacement must follow the carried flags: ${composed}`);
});
check('the carried flags are otherwise untouched by a replacement', () => {
    const rep = parseReplaceFlags(['node', 'x.js', '--replace-flag', 'p=m7507137468043532712']);
    const composed = composePrompt('a maker', splitCommand(P_CMD).flags,
        '4:3', ['https://s.mj.run/usV0f2WYXrE'], new Set(), rep);
    for (const f of ['--raw', '--stylize 0', '--v 8.2', '--ar 4:3']) {
        assert.ok(composed.includes(f), `${f} was lost: ${composed}`);
    }
});
check('without a replacement the source keeps its own --profile', () => {
    const composed = composePrompt('a maker', splitCommand(P_CMD).flags,
        '4:3', ['https://s.mj.run/usV0f2WYXrE'], new Set(), []);
    assert.ok(/--profile xy9cz8o mhw6dpq/.test(composed), `the source's profile was lost: ${composed}`);
});

// ------------------------------------------------------------------------
// 9. the reuse key
//
// The key used to be the first 60 characters of the prose, with the
// flags ignored. It reused the wrong job twice: a prompt that changed
// after its sixtieth character, and a prompt that changed only its
// --ar — which turned a 16:9 pack into the 4:3 jobs it was meant to
// replace.
const OLD_PROSE = 'A lean man in his early thirties sits hunched before a single '
    + 'glowing monitor in a dark studio, close-cropped dark hair, light stubble, '
    + 'a small scar through his left eyebrow, silver over-ear headphones on his head, '
    + 'faded black hoodie over a grey tee';
const OLD_CMD = `${OLD_PROSE} --ar 4:3 --raw --profile mhw6dpq `
    + '--edit https://s.mj.run/usV0f2WYXrE --stylize 0 --hd --v 8.2';

check('the same prompt and the same ratio IS the same job', () => {
    assert.ok(sameJob(OLD_CMD, OLD_PROSE, '4:3'),
        'the unchanged prompt must still be reusable');
});
check('a prompt that differs after its sixtieth character is NOT the same job', () => {
    const changed = OLD_PROSE.replace('faded black hoodie over a grey tee',
        'faded black hoodie over a grey tee, no denim jacket and no leather jacket');
    assert.ok(!sameJob(OLD_CMD, changed, '4:3'),
        'a reworded prompt must not reuse the old job');
});
check('a prompt that differs only in its --ar is NOT the same job', () => {
    const wide = `${OLD_PROSE} --ar 16:9`;
    assert.ok(!sameJob(OLD_CMD, wide, '16:9'),
        'a 16:9 prompt must not reuse a 4:3 job');
    assert.ok(!sameJob(OLD_CMD, OLD_PROSE, '16:9'),
        'a 16:9 request must not reuse a 4:3 job even with identical prose');
});
check('the prompt\'s own --ar is looked for in the command, not in the prose', () => {
    const wide = `${OLD_PROSE} --ar 16:9`;
    const wideCmd = `${OLD_PROSE} --ar 16:9 --raw --profile mhw6dpq `
        + '--edit https://s.mj.run/usV0f2WYXrE --stylize 0 --hd --v 8.2';
    assert.ok(sameJob(wideCmd, wide, '16:9'),
        'a 16:9 job must be reusable by the 16:9 prompt that made it');
    assert.ok(!sameJob(wideCmd, OLD_PROSE, '4:3'),
        'a 16:9 job must NOT be reusable by a 4:3 prompt');
});
check('a command that is not a command is never the same job', () => {
    assert.ok(!sameJob(undefined, OLD_PROSE, '4:3'));
    assert.ok(!sameJob('', OLD_PROSE, '4:3'));
    assert.ok(!sameJob(OLD_CMD, '', '4:3'));
});

// 10. The PACK owns the ratio.
//
// The pack convention is one `--ar` per bullet, and the shared parser
// (lib/mj-submitter.js) strips the flag out of the prose and surfaces
// it as `ar`. That field was ignored, so the source's ratio won and a
// 16:9 pack rendered as the source's 4:3 — every prompt, silently.
// The measured proof: a 16:9 pack submitted against a 4:3 source
// produced a 2544x1904 job whose meta recorded `--ar 4:3`.
check('the pack\'s own ratio wins over the source\'s', () => {
    assert.strictEqual(promptRatio({ text: OLD_PROSE, ar: '16:9' }, '4:3'), '16:9');
    assert.strictEqual(promptRatio({ text: OLD_PROSE, ar: '1:1' }, '4:3'), '1:1');
});
check('a pack that asks for no ratio inherits the source\'s', () => {
    assert.strictEqual(promptRatio({ text: OLD_PROSE }, '4:3'), '4:3');
    assert.strictEqual(promptRatio({ text: OLD_PROSE, ar: '' }, '4:3'), '4:3');
    assert.strictEqual(promptRatio({}, '4:3'), '4:3');
});
check('a ratio written in the prose wins over the pack\'s field', () => {
    assert.strictEqual(promptRatio({ text: `${OLD_PROSE} --ar 16:9`, ar: '4:3' }, '4:3'), '16:9');
});
check('the composed command carries the pack\'s ratio exactly once', () => {
    const flags = ['--raw', '--stylize', '0', '--v', '8.2', '--ar', '4:3'];
    const cmd = composePrompt(OLD_PROSE, flags, promptRatio({ text: OLD_PROSE, ar: '16:9' }, '4:3'),
        ['https://s.mj.run/usV0f2WYXrE']);
    const ars = cmd.match(/--ar\s+\S+/g) || [];
    assert.strictEqual(ars.length, 1, `one --ar only, got: ${cmd}`);
    assert.ok(ars[0].endsWith('16:9'), `the pack's ratio wins, got: ${cmd}`);
});

// ------------------------------------------------------------------------
console.log(`\n[mj-revise.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
