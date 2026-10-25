#!/usr/bin/env node
// lib/boot.test.js — the pure half of lib/boot.js.
//
// No launchd, no browser, no network, no git. Everything that decides
// something (flag parsing, the launchd state reader, which agents a
// pull needs to reload) is a pure function precisely so it can be
// tested here: the boot agent runs at login, where a failure is
// expensive to notice and impossible to debug by hand.
//
// The bug this file exists for
// ----------------------------
// bin/boot.sh ran at login for months and never worked:
//
//   /bin/bash: .../bin/boot.sh: Operation not permitted   (exit 126)
//
// launchd's spawn context cannot read anything under $HOME/Documents
// (per-binary TCC grant; bash has none). `launchctl print` said
// `state = not running` and the only trace was in a log nobody read.
// So the boot sequence moved to Node — and the first assertion below
// is that the old bash entry point is gone, because a second boot path
// that silently fails is exactly how this hid for so long.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    REPO, AGENTS, formatStamp, dayKey,
    parseLaunchctlState, reloadTargets, parseArgs, usage,
} = require('./boot.js');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
        failures.push({ name, err });
        process.stdout.write(`FAIL ${name}\n`);
    }
}

// ---------------------------------------------------------------------------
// 1. the old entry point is gone (one boot path, not two)
// ---------------------------------------------------------------------------
check('bin/boot.sh is gone — lib/boot.js is the only boot path', () => {
    const old = path.join(REPO, 'bin', 'boot.sh');
    assert.strictEqual(fs.existsSync(old), false, `${old} still exists`);
});

check('lib/boot.js exists where the launcher shim points', () => {
    assert.strictEqual(fs.existsSync(path.join(REPO, 'lib', 'boot.js')), true);
});

check('bin/auto-update.sh delegates to lib/boot.js --update-only', () => {
    const text = fs.readFileSync(path.join(REPO, 'bin', 'auto-update.sh'), 'utf8');
    assert.ok(text.includes('lib/boot.js'), 'no reference to lib/boot.js');
    assert.ok(text.includes('--update-only'), 'not invoked with --update-only');
});

// ---------------------------------------------------------------------------
// 2. timestamps and the log file name
// ---------------------------------------------------------------------------
check('formatStamp pads every field', () => {
    const d = new Date(2026, 0, 5, 4, 7, 9);
    assert.strictEqual(formatStamp(d), '2026-01-05 04:07:09');
});

check('formatStamp round-trips a two-digit month and day', () => {
    assert.strictEqual(formatStamp(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31 23:59:59');
});

check('dayKey is YYYYMMDD with no separators', () => {
    assert.strictEqual(dayKey(new Date(2026, 9, 25, 4, 40, 0)), '20261025');
});

// ---------------------------------------------------------------------------
// 3. the launchd state reader
// ---------------------------------------------------------------------------
const PRINT_RUNNING = `gui/501/com.kaidjuric.digital-twin.server = {
\tactive count = 1
\tpath = /Users/x/Library/LaunchAgents/com.kaidjuric.digital-twin.server.plist
\tstate = running

\tprogram = /bin/bash
\targuments = {
\t\t/bin/bash
\t}
}`;

check('parseLaunchctlState reads "running"', () => {
    assert.strictEqual(parseLaunchctlState(PRINT_RUNNING), 'running');
});

check('parseLaunchctlState reads "not running"', () => {
    assert.strictEqual(parseLaunchctlState('\tstate = not running\n'), 'not running');
});

check('parseLaunchctlState does not match a nested/indented "state" in another line', () => {
    // `state = active` appears inside endpoints; the first `state =`
    // in launchctl's own output is the agent's. Assert it picks the
    // first one rather than the last.
    const text = '\tstate = running\n\t\tstate = active\n\t\tstate = active\n';
    assert.strictEqual(parseLaunchctlState(text), 'running');
});

check('parseLaunchctlState is null for absent output', () => {
    assert.strictEqual(parseLaunchctlState(null), null);
    assert.strictEqual(parseLaunchctlState(undefined), null);
    assert.strictEqual(parseLaunchctlState(''), null);
});

check('parseLaunchctlState is null when there is no state line', () => {
    assert.strictEqual(parseLaunchctlState('Could not find service\n'), null);
});

check('parseLaunchctlState trims the value', () => {
    assert.strictEqual(parseLaunchctlState('  state =   waiting   \n'), 'waiting');
});

// ---------------------------------------------------------------------------
// 4. which agents a pull has to reload
// ---------------------------------------------------------------------------
check('a changed serve.js reloads the server', () => {
    assert.deepStrictEqual(reloadTargets(['lib/serve.js']),
        ['com.kaidjuric.digital-twin.server']);
});

check('an unrelated file reloads nothing', () => {
    assert.deepStrictEqual(reloadTargets(['pages/landing.html', 'README.md']), []);
});

check('several changed files reload several agents', () => {
    const labels = reloadTargets(['lib/chart-watcher.js', 'lib/reel-watcher.js']);
    assert.deepStrictEqual(labels, [
        'com.kaidjuric.digital-twin.chart-watcher',
        'com.kaidjuric.digital-twin.reel-watcher',
    ]);
});

check('git diff output with blank lines and \r does not reload everything', () => {
    const labels = reloadTargets(['lib/serve.js\r', '', '  ']);
    assert.deepStrictEqual(labels, ['com.kaidjuric.digital-twin.server']);
});

check('an empty change list reloads nothing', () => {
    assert.deepStrictEqual(reloadTargets([]), []);
    assert.deepStrictEqual(reloadTargets(null), []);
});

check('a changed file with no owning agent reloads nothing', () => {
    assert.deepStrictEqual(reloadTargets(['lib/boot.js']), []);
});

check('every agent entry names a lib file and a twin label', () => {
    for (const [label, file] of AGENTS) {
        assert.match(label, /^com\.kaidjuric\.digital-twin\./, `bad label: ${label}`);
        assert.match(file, /^lib\/[a-z0-9-]+\.js$/, `bad file: ${file}`);
    }
});

check('no agent is listed twice', () => {
    const labels = AGENTS.map(([l]) => l);
    const files = AGENTS.map(([, f]) => f);
    assert.strictEqual(new Set(labels).size, labels.length, 'duplicate label');
    assert.strictEqual(new Set(files).size, files.length, 'duplicate file');
});

check('the server is in the reload map', () => {
    assert.ok(AGENTS.some(([l]) => l === 'com.kaidjuric.digital-twin.server'));
});

// ---------------------------------------------------------------------------
// 5. argv
// ---------------------------------------------------------------------------
check('defaults: open the browser, no terminal, no notes, port 5173', () => {
    const o = parseArgs([]);
    assert.strictEqual(o.error, null);
    assert.strictEqual(o.open, true);
    assert.strictEqual(o.terminal, false);
    assert.strictEqual(o.notes, false);
    assert.strictEqual(o.updateOnly, false);
    assert.strictEqual(o.port, 5173);
});

check('--update-only', () => {
    assert.strictEqual(parseArgs(['--update-only']).updateOnly, true);
});

check('--no-open', () => {
    assert.strictEqual(parseArgs(['--no-open']).open, false);
});

check('--terminal and --notes are opt-in', () => {
    const o = parseArgs(['--terminal', '--notes']);
    assert.strictEqual(o.terminal, true);
    assert.strictEqual(o.notes, true);
});

check('--no-notes wins over --notes regardless of order', () => {
    assert.strictEqual(parseArgs(['--notes', '--no-notes']).notes, false);
    assert.strictEqual(parseArgs(['--no-notes', '--notes']).notes, true);
});

check('--port N', () => {
    assert.strictEqual(parseArgs(['--port', '5199']).port, 5199);
});

check('--port with no value is an error, not a silent default', () => {
    const o = parseArgs(['--port']);
    assert.ok(o.error, 'expected an error');
    assert.match(o.error, /--port/);
});

check('--port garbage is an error', () => {
    assert.match(parseArgs(['--port', 'abc']).error, /--port/);
});

check('--port out of range is an error', () => {
    assert.match(parseArgs(['--port', '70000']).error, /--port/);
    assert.match(parseArgs(['--port', '0']).error, /--port/);
});

check('an unknown flag is refused — a boot CLI must not no-op a typo', () => {
    const o = parseArgs(['--opne']);
    assert.ok(o.error);
    assert.match(o.error, /unknown flag: --opne/);
});

check('an unknown flag after a valid one is still refused', () => {
    assert.match(parseArgs(['--update-only', '--verbose']).error, /unknown flag/);
});

check('--help and -h', () => {
    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.strictEqual(parseArgs(['-h']).help, true);
});

check('--help does not swallow a later bad flag into a silent run', () => {
    const o = parseArgs(['--help', '--nope']);
    assert.ok(o.error, 'expected the unknown flag to be reported');
});

check('usage names every flag', () => {
    const u = usage();
    for (const flag of ['--update-only', '--no-open', '--terminal', '--notes', '--port']) {
        assert.ok(u.includes(flag), `usage is missing ${flag}`);
    }
});

// ---------------------------------------------------------------------------
console.log(`\n[boot.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
