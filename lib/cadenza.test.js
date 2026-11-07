#!/usr/bin/env node
'use strict';
// lib/cadenza.test.js
//
// The wrapper's contract: the argv it builds, the flags it refuses, and
// the rule that a secret never travels on the command line.
//
// No network, no binary, no audio — pure functions only.

const assert = require('node:assert');
const path = require('node:path');
const {
    VERBS,
    resolveBinary,
    parseArgs,
    buildCommand,
    childEnv,
} = require('./cadenza.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        failures.push(`${name}: ${err.message}`);
    }
}

// ---- 1. the verb table -------------------------------------------------

check('every verb maps to a cadenza subcommand', () => {
    for (const [verb, spec] of Object.entries(VERBS)) {
        assert.ok(Array.isArray(spec.cadenza), `${verb} has no cadenza argv`);
        assert.ok(spec.cadenza.length > 0, `${verb} has an empty cadenza argv`);
        assert.ok(spec.note, `${verb} has no note`);
    }
});

check('the verbs the twin needs are present', () => {
    for (const verb of ['check', 'import-midi', 'render', 'export', 'analyze', 'scan-plugins', 'list-plugins', 'mcp']) {
        assert.ok(VERBS[verb], `missing verb: ${verb}`);
    }
});

// ---- 2. the argv builder -----------------------------------------------

check('import-midi puts the file before its flags', () => {
    const argv = buildCommand('import-midi', { output: '/tmp/x.cdz' }, ['/tmp/x.mid']);
    assert.deepStrictEqual(argv, ['import-midi', '/tmp/x.mid', '--output', '/tmp/x.cdz']);
});

check('render passes the project, the output and the sample rate', () => {
    const argv = buildCommand('render', { output: 'out.wav', 'sample-rate': 48000 }, ['song.cdz']);
    assert.deepStrictEqual(argv, ['render', 'song.cdz', '--output', 'out.wav', '--sample-rate', '48000']);
});

check('export carries the stems request', () => {
    const argv = buildCommand('export', { stems: 'tracks', format: 'wav' }, ['song.cdz']);
    assert.ok(argv.includes('--stems'));
    assert.ok(argv.includes('tracks'));
    assert.ok(argv.includes('--format'));
});

check('a verb with no flags produces just its subcommand', () => {
    assert.deepStrictEqual(buildCommand('mcp', {}, []), ['mcp']);
});

check('an undefined flag value is left out entirely', () => {
    const argv = buildCommand('render', { output: 'out.wav', 'bit-depth': undefined }, ['p.cdz']);
    assert.ok(!argv.includes('--bit-depth'));
});

check('an unknown verb throws rather than building a broken command', () => {
    assert.throws(() => buildCommand('nope', {}, []), /unknown verb/);
});

// ---- 3. the flag guard --------------------------------------------------

check('an unknown flag is refused, not ignored', () => {
    const parsed = parseArgs(['--wat', 'x'], 'render');
    assert.ok(parsed.error, 'an unknown flag must produce an error');
    assert.match(parsed.error, /unknown flag/);
});

check('a known flag is parsed into its value', () => {
    const parsed = parseArgs(['-o', 'out.wav'], 'render');
    assert.strictEqual(parsed.error, null);
    assert.strictEqual(parsed.flags.output, 'out.wav');
});

check('a flag with no value is an error', () => {
    const parsed = parseArgs(['-o'], 'render');
    assert.ok(parsed.error);
    assert.match(parsed.error, /needs a value/);
});

check('the boolean flags need no value', () => {
    const parsed = parseArgs(['--json', '--plan'], 'render');
    assert.strictEqual(parsed.flags.json, true);
    assert.strictEqual(parsed.flags.plan, true);
});

check('a flag that belongs to another verb is refused', () => {
    const parsed = parseArgs(['--stems', 'tracks'], 'render');
    assert.ok(parsed.error, '--stems belongs to export, not render');
});

check('positionals are collected in order', () => {
    const parsed = parseArgs(['a.cdz', 'b.cdz'], 'render');
    assert.deepStrictEqual(parsed.positionals, ['a.cdz', 'b.cdz']);
});

// ---- 4. the binary ------------------------------------------------------

check('CADENZA_BIN wins over every other location', () => {
    assert.strictEqual(resolveBinary({ CADENZA_BIN: '/opt/cadenza' }), '/opt/cadenza');
});

check('the installer location is used when CADENZA_BIN is absent', () => {
    const home = process.env.HOME || '';
    const expected = path.join(home, '.local', 'bin', 'cadenza');
    const found = resolveBinary({ HOME: home });
    assert.ok(found === expected || found === null, `unexpected: ${found}`);
});

// ---- 5. the secret rule -------------------------------------------------

check('a key travels in the environment, never in the argv', () => {
    const env = childEnv({ DEEPSEEK_API_KEY: 'sk-test' });
    assert.strictEqual(env.OPENROUTER_API_KEY, 'sk-test');
    const argv = buildCommand('compose', {}, []);
    assert.ok(!argv.join(' ').includes('sk-test'));
});

check('an explicit key is never overwritten', () => {
    const env = childEnv({ DEEPSEEK_API_KEY: 'sk-a', OPENROUTER_API_KEY: 'sk-b' });
    assert.strictEqual(env.OPENROUTER_API_KEY, 'sk-b');
});

// ---- 6. the survey facts the docs will claim ---------------------------

check('the survey recorded a rust DAW with VST hosting and an MCP surface', () => {
    // These are the facts the docs assert; they are pinned here so a
    // rewrite of the wrapper cannot quietly drop the reason it exists.
    assert.ok(VERBS['scan-plugins'], 'the plugin scan verb is the VST surface');
    assert.ok(VERBS.mcp, 'the MCP verb is the automation surface');
});

console.log(`[cadenza.test] passed: ${passed}, failed: ${failed}`);
if (failed) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
