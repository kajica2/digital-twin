#!/usr/bin/env node
'use strict';
// tools/show-composed.js
//
// PRINT THE COMPOSED COMMAND for every prompt in a pack — the exact
// string Midjourney would receive.
//
// WHY THIS EXISTS
//
//   The house rule: a dry run that prints the exact composed text
//   costs no generation, and "verify the composed command rather than
//   assuming it" is the rule that has caught every duplicated-flag
//   bug in this repo.
//
//   So this prints the composed command per prompt, and FLAGS the
//   things that must never be true:
//
//     * two --ar flags, or an --ar that is not last
//     * two --sref flags
//     * two --style / --raw, or two --s
//     * a --ar that is missing
//
// Usage:
//   node tools/show-composed.js <pack.md> [--json]
//
// Exit: 0 every command is well-formed · 2 bad input · 3 a command is malformed

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const PACK = ARGV.find(a => !a.startsWith('--'));
const AS_JSON = ARGV.includes('--json');

function log(m) { process.stdout.write(m + '\n'); }
function warn(m) { process.stderr.write(m + '\n'); }

if (!PACK) {
    warn('usage: show-composed.js <pack.md> [--json]');
    process.exit(2);
}

const abs = path.resolve(PACK);
if (!fs.existsSync(abs)) {
    warn(`no such pack: ${abs}`);
    process.exit(2);
}

const { extractPrompts } = require(path.join(REPO, 'lib', 'mj-submitter.js'));
const { buildFullPrompt } = require(path.join(REPO, 'lib', 'mj-flags.js'));
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'mj-config.json'), 'utf8'));
const DEFAULT_ARGS = (cfg.mj && cfg.mj.defaultArgs) || '';

const parsed = extractPrompts(abs);
const rows = parsed.map((p, i) => ({
    index: i + 1,
    ar: p.ar,
    composed: buildFullPrompt(p.text, p.ar, DEFAULT_ARGS),
}));

/** The rules a composed command must satisfy. */
function problems(cmd) {
    const out = [];
    const count = (re) => (cmd.match(re) || []).length;
    if (count(/--ar/g) !== 1) out.push(`--ar appears ${count(/--ar/g)} times`);
    else if (!/--ar\s+\S+$/.test(cmd.trim())) out.push('--ar is not LAST');
    if (count(/--sref/g) > 1) out.push(`--sref appears ${count(/--sref/g)} times`);
    if (count(/--style/g) > 1) out.push(`--style appears ${count(/--style/g)} times`);
    if (count(/--raw/g) > 1) out.push(`--raw appears ${count(/--raw/g)} times`);
    if (/(^|\s)--s\s/.test(cmd) && count(/(^|\s)--s\s/g) > 1) out.push('--s appears more than once');
    return out;
}

const bad = [];
for (const r of rows) {
    const p = problems(r.composed);
    if (p.length) bad.push({ index: r.index, problems: p });
}

if (AS_JSON) {
    log(JSON.stringify({ pack: abs, defaults: DEFAULT_ARGS, prompts: rows, problems: bad }, null, 2));
    process.exit(bad.length ? 3 : 0);
}

log(`pack   : ${path.relative(REPO, abs)}`);
log(`defaults: ${DEFAULT_ARGS}`);
log(`prompts : ${rows.length}`);
log('');
for (const r of rows) {
    log(`${String(r.index).padStart(2, '0')}  ${r.composed}`);
    log('');
}
if (bad.length) {
    warn(`${bad.length} command(s) are malformed:`);
    for (const b of bad) warn(`  ${b.index}: ${b.problems.join('; ')}`);
    process.exit(3);
}
log('every command carries exactly one --ar, last, and no duplicated flags');
