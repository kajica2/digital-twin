#!/usr/bin/env node
'use strict';
// tools/append-sprint-log.js
//
// APPEND A SPRINT-LOG ENTRY to AGENTS.md.
//
// WHY A WRITER AND NOT A SHELL REDIRECT
//
//   `cat entry.md >> AGENTS.md` is a shell redirect, and a redirect
//   is an unparseable inline payload to the agent's command parser —
//   so the sprint log could not be written from a session at all.
//
//   So the append is done in Node, and it VERIFIES: the file is
//   read first, the entry is appended, and the result is read back
//   to confirm the entry is present and the file grew by exactly the
//   entry's size.
//
// Usage:
//   node tools/append-sprint-log.js <entry.md> [--agents AGENTS.md]
//
// Exit: 0 the entry was appended and verified · 2 bad input · 3 the append failed

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);

function log(m) { process.stdout.write(`[append-sprint-log] ${m}\n`); }
function warn(m) { process.stderr.write(`[append-sprint-log] ${m}\n`); }

function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}

const entryPath = ARGV.find(a => !a.startsWith('--'));
if (!entryPath) {
    warn('usage: append-sprint-log.js <entry.md> [--agents AGENTS.md]');
    process.exit(2);
}

const agentsPath = path.resolve(REPO, argVal('--agents', 'AGENTS.md'));
const entryAbs = path.resolve(entryPath);

if (!fs.existsSync(entryAbs)) {
    warn(`no such entry file: ${entryAbs}`);
    process.exit(2);
}
if (!fs.existsSync(agentsPath)) {
    warn(`no such sprint log: ${agentsPath}`);
    process.exit(2);
}

const entry = fs.readFileSync(entryAbs, 'utf8').replace(/\s+$/, '') + '\n';
const before = fs.readFileSync(agentsPath, 'utf8');

// The entry must start with a sprint-log heading, or it is not one.
if (!/^### \d{4}-\d{2}-\d{2} — sprint /m.test(entry)) {
    warn('the entry does not start with a "### <date> — sprint <n>" heading');
    process.exit(2);
}

// A sprint number is written once. A duplicate entry is a mistake, and
// the repo's own log has renumbered a collision before.
const heading = (entry.match(/^### \d{4}-\d{2}-\d{2} — sprint [^\n]*/m) || [])[0];
if (before.includes(heading)) {
    warn(`the sprint log already has an entry for: ${heading}`);
    process.exit(3);
}

// The separator: a blank line between entries.
const sep = before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');

const after = before + sep + entry;
fs.writeFileSync(agentsPath, after, 'utf8');

// Verify by reading the file BACK.
const readBack = fs.readFileSync(agentsPath, 'utf8');
if (!readBack.includes(entry.trim())) {
    warn('the append did not land — the entry is not in the file');
    process.exit(3);
}
if (readBack.length !== before.length + sep.length + entry.length) {
    warn(`the file grew by ${readBack.length - before.length} bytes, expected ${sep.length + entry.length}`);
    process.exit(3);
}

log(`appended to ${path.relative(REPO, agentsPath)}`);
log(`  heading : ${heading}`);
log(`  size    : ${before.length} -> ${readBack.length} bytes (+${readBack.length - before.length})`);
log('verified by reading the file back');
