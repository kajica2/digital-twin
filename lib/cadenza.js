#!/usr/bin/env node
'use strict';
// lib/cadenza.js
//
// Cadenza — the Rust DAW with CLAP/VST3 hosting, an embedded AI arranger
// and a command API the twin can drive.
//
// WHY THIS WRAPPER EXISTS
//
// Cadenza (github.com/Pep3M/cadenza) is the only DAW found in the survey
// that is *all three* of these at once:
//   * written in Rust, hosting CLAP + VST3 plugins,
//   * driven from a script — `cadenza render`, `cadenza export --stems`,
//     `cadenza import-midi`, and an MCP server over stdio,
//   * an AI producer that speaks any OpenAI-compatible endpoint, which is
//     the shape the twin's own model clients already use.
//
// The twin's chart pipeline already produces a multi-track MIDI file
// (`lib/midi-export.js`). This module is the seam: MIDI in, a rendered
// mix and one stem per part out.
//
// WHAT WAS MEASURED (2026-11-07, Cadenza v0.3.3, macOS arm64)
//
//   * `cadenza import-midi chart.mid -o project.cdz` -> one track per
//     source track, each with its own notes. A source track with no
//     notes is skipped SILENTLY (upstream `crates/midi-io/src/smf_import.rs`:
//     `if track.notes.is_empty() { continue; }`), so a part that vanished
//     upstream never reaches the render — the twin therefore reports the
//     track count it imported and compares it against the MIDI's own.
//   * `cadenza render project.cdz -o out.wav` -> the mix plus a JSON
//     report (peak, true peak, RMS, LUFS integrated, crest factor, band
//     energy, stereo correlation).
//   * `cadenza export project.cdz --stems tracks --format wav` -> the
//     mixdown AND one file per track, next to the project in `Renders/`.
//
// TWO THINGS THAT BITE, both found by running the pipeline
//
//  1. The twin's MIDI export drops a MusicXML part whose chord markup is
//     wrong, without a warning. MusicXML says the FIRST note of a chord
//     carries no `chord` attribute and the rest do; mark them all and the
//     part parses as empty. The symptom is "Cadenza imported 3 of 4
//     parts" — the fault is upstream, in the MusicXML, not in Cadenza.
//
//  2. Program changes have no Cadenza equivalent, so every imported
//     track lands on a built-in instrument ("pick the instrument or
//     preset instead"). The twins' own instruments are therefore what
//     you hear until a track is re-pointed at a plugin.
//
// Pure Node, no deps. The binary is found via CADENZA_BIN, then
// ~/.local/bin/cadenza, then PATH.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// The verbs this wrapper speaks, and the Cadenza subcommand each maps to.
// `value` maps a twin flag name to Cadenza's long flag; `short` maps it to
// the short spelling; `bool` lists Cadenza's flags that take no value.
// The names come from Cadenza's own clap definitions (crates/cli/src/*).
const VERBS = {
    check: {
        cadenza: ['--version'],
        note: 'is the DAW here, and what version',
    },
    'scan-plugins': {
        cadenza: ['scan-plugins'],
        bool: ['--json'],
        note: 'scan installed CLAP/VST3 plugins into the catalog',
    },
    'list-plugins': {
        cadenza: ['list-plugins'],
        bool: ['--json'],
        value: { query: '--query' },
        short: { query: '-q' },
        note: 'list the plugin catalog',
    },
    'import-midi': {
        cadenza: ['import-midi'],
        value: { output: '--output', into: '--into', track: '--track', 'at-beats': '--at-beats' },
        short: { output: '-o' },
        bool: ['--split-by-channel'],
        note: 'import a MIDI file into a Cadenza project',
    },
    render: {
        cadenza: ['render'],
        value: { output: '--output', 'sample-rate': '--sample-rate', 'bit-depth': '--bit-depth', bitrate: '--bitrate' },
        short: { output: '-o' },
        note: 'render a project to an audio file',
    },
    export: {
        cadenza: ['export'],
        value: { stems: '--stems', format: '--format', range: '--range', normalize: '--normalize', 'sample-rate': '--sample-rate' },
        note: 'export the mixdown and/or the stems',
    },
    analyze: {
        cadenza: ['analyze'],
        value: { 'sample-rate': '--sample-rate' },
        note: 'analyse a project mix without writing audio',
    },
    'export-midi': {
        cadenza: ['export-midi'],
        value: { output: '--output', track: '--track' },
        short: { output: '-o' },
        note: 'export a project back to a standard MIDI file',
    },
    mcp: {
        cadenza: ['mcp'],
        note: 'run the MCP server over stdio',
    },
    compose: {
        cadenza: ['compose'],
        value: {
            out: '--out', slug: '--slug', provider: '--provider', model: '--model',
            'reasoning-effort': '--reasoning-effort', 'max-cost-usd': '--max-cost-usd',
            'max-turns': '--max-turns', genre: '--genre', 'target-lufs': '--target-lufs',
            'api-key-env': '--api-key-env', 'max-output-tokens': '--max-output-tokens',
        },
        short: { out: '-o' },
        bool: ['--plugins', '--no-stream', '--dry-run'],
        note: 'let the AI producer compose a song from a brief',
    },
    chat: {
        cadenza: ['chat'],
        value: {
            out: '--out', provider: '--provider', model: '--model', 'base-url': '--base-url',
            'reasoning-effort': '--reasoning-effort', 'max-cost-usd': '--max-cost-usd',
        },
        short: { out: '-o' },
        bool: ['--no-save', '--plugins'],
        note: 'ask the AI producer for one change to a project',
    },
    mix: {
        cadenza: ['mix'],
        value: { 'target-lufs': '--target-lufs', reference: '--reference', notes: '--notes', out: '--out' },
        short: { out: '-o' },
        bool: ['--dry-run'],
        note: 'let the AI sound engineer mix a project',
    },
    tune: {
        cadenza: ['tune'],
        value: { clip: '--clip', track: '--track', key: '--key', reference: '--reference', notes: '--notes', out: '--out' },
        short: { out: '-o' },
        bool: ['--dry-run'],
        note: 'let the AI tuning engineer tune an audio clip',
    },
};

/** Flags every verb accepts (the twin's own, not Cadenza's). */
const COMMON_FLAGS = ['json', 'plan', 'help'];

/**
 * Every spelling that maps to one twin flag name: `--name`, Cadenza's long
 * flag and Cadenza's short flag.
 * @returns {Map<string,string>} spelling -> flag name
 */
function flagSpellings(verb) {
    const spec = VERBS[verb];
    const map = new Map();
    for (const key of Object.keys(spec.value || {})) {
        map.set(`--${key}`, key);
        map.set(spec.value[key], key);
        if (spec.short && spec.short[key]) map.set(spec.short[key], key);
    }
    for (const flag of spec.bool || []) map.set(flag, flag);
    return map;
}

/**
 * Find the cadenza binary.
 * @returns {string|null} an absolute path, or null when it is not installed
 */
function resolveBinary(env = process.env) {
    if (env.CADENZA_BIN) return env.CADENZA_BIN;
    const home = env.HOME || '';
    const local = path.join(home, '.local', 'bin', 'cadenza');
    if (home && fs.existsSync(local)) return local;
    const which = spawnSync('sh', ['-c', 'command -v cadenza'], { encoding: 'utf8' });
    const found = (which.stdout || '').trim();
    return found || null;
}

/**
 * Split argv into flags and positionals. Unknown flags are REFUSED, not
 * ignored: a paid-render CLI that silently drops what it does not
 * understand is how `--help` once started a real render.
 * @returns {{flags: object, positionals: string[], error: string|null}}
 */
function parseArgs(argv, verb) {
    const spec = VERBS[verb];
    const spellings = flagSpellings(verb);
    const known = new Set([...COMMON_FLAGS, ...spellings.keys()]);
    const flags = {};
    const positionals = [];
    let error = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }
        const key = spellings.get(arg) || (COMMON_FLAGS.includes(arg.replace(/^--?/, '')) ? arg.replace(/^--?/, '') : null);
        if (!key) {
            error = `unknown flag for '${verb}': ${arg} (known: ${[...known].sort().join(', ')})`;
            continue;
        }
        if (key === 'json' || key === 'plan' || key === 'help') {
            flags[key] = true;
            continue;
        }
        if ((spec.bool || []).includes(key)) {
            flags[key] = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined) {
            error = `flag ${arg} needs a value`;
            continue;
        }
        flags[key] = value;
    }
    return { flags, positionals, error };
}

/**
 * Build the argv for a cadenza call. Pure: no process is touched.
 * @returns {string[]} the argv, ready for spawn
 */
function buildCommand(verb, flags = {}, positionals = []) {
    const spec = VERBS[verb];
    if (!spec) throw new Error(`unknown verb: ${verb}`);
    // Positional arguments come first for cadenza (e.g. `import-midi FILE -o OUT`).
    const argv = [...spec.cadenza, ...positionals];
    for (const key of Object.keys(spec.value || {})) {
        if (flags[key] === undefined || flags[key] === null) continue;
        argv.push(spec.value[key], String(flags[key]));
    }
    for (const flag of spec.bool || []) {
        if (flags[flag] === undefined || flags[flag] === null || flags[flag] === false) continue;
        argv.push(flag);
    }
    return argv;
}

/**
 * The environment a cadenza call runs with. Secrets travel in the
 * environment, never on the command line — an argv is visible to every
 * process on the machine and lands in shell history.
 */
function childEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    // The AI producer reads OPENROUTER_API_KEY and honours any
    // OpenAI-compatible base URL. If the twin's own key is present in the
    // usual places, expose it under the name cadenza reads.
    if (!env.OPENROUTER_API_KEY && env.DEEPSEEK_API_KEY) {
        env.OPENROUTER_API_KEY = env.DEEPSEEK_API_KEY;
    }
    return env;
}

/**
 * Run cadenza. Returns {code, stdout, stderr}.
 */
function run(binary, argv, opts = {}) {
    const res = spawnSync(binary, argv, {
        encoding: 'utf8',
        env: childEnv(opts.env || {}),
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs || 10 * 60 * 1000,
    });
    return {
        code: res.status === null ? 1 : res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        spawnError: res.error ? res.error.message : null,
    };
}

function usage() {
    const lines = ['cadenza — drive the Rust DAW from the twin', '', 'verbs:'];
    for (const [verb, spec] of Object.entries(VERBS)) {
        lines.push(`  ${verb.padEnd(16)} ${spec.note}`);
    }
    lines.push('', 'common flags: --json (machine output) · --plan (print the command, run nothing)');
    lines.push('binary: CADENZA_BIN, then ~/.local/bin/cadenza, then PATH');
    return lines.join('\n');
}

function main(argv) {
    const verb = argv[0];
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
        process.stdout.write(usage() + '\n');
        return 0;
    }
    if (!VERBS[verb]) {
        process.stderr.write(`cadenza: unknown verb '${verb}'\n\n${usage()}\n`);
        return 2;
    }
    const { flags, positionals, error } = parseArgs(argv.slice(1), verb);
    if (error) {
        process.stderr.write(`cadenza: ${error}\n`);
        return 2;
    }
    if (flags.help) {
        process.stdout.write(usage() + '\n');
        return 0;
    }
    const binary = resolveBinary();
    if (!binary) {
        process.stderr.write(
            'cadenza: the cadenza binary is not installed.\n' +
            '  install: curl -fsSL https://github.com/Pep3M/cadenza/releases/latest/download/install.sh | sh\n' +
            '  or set CADENZA_BIN to the binary.\n'
        );
        return 1;
    }
    const cmdArgv = buildCommand(verb, flags, positionals);
    if (flags.plan) {
        process.stdout.write(JSON.stringify({ binary, argv: cmdArgv }, null, 2) + '\n');
        return 0;
    }
    if (verb === 'check') {
        const out = run(binary, cmdArgv, { timeoutMs: 60000 });
        const version = (out.stdout || out.stderr).trim().split('\n')[0] || '';
        const payload = { binary, version, ok: out.code === 0 };
        if (flags.json) {
            process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        } else {
            process.stdout.write(`${payload.version} — ${binary}\n`);
        }
        return out.code;
    }
    const out = run(binary, cmdArgv);
    if (flags.json) {
        let parsed = null;
        try { parsed = JSON.parse(out.stdout); } catch { /* not json — keep the raw text */ }
        process.stdout.write(JSON.stringify({ code: out.code, json: parsed, stdout: parsed ? undefined : out.stdout, stderr: out.stderr }, null, 2) + '\n');
    } else {
        if (out.stdout) process.stdout.write(out.stdout);
        if (out.stderr) process.stderr.write(out.stderr);
    }
    return out.code;
}

module.exports = {
    VERBS,
    COMMON_FLAGS,
    flagSpellings,
    resolveBinary,
    parseArgs,
    buildCommand,
    childEnv,
    run,
    usage,
    REPO,
};

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
