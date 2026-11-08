#!/usr/bin/env node
'use strict';
// tools/write-registry-artifacts.js
//
// WRITE A REGISTRY'S GENERATED ARTIFACTS — pack and doc.
//
// WHY A WRITER RATHER THAN A SHELL REDIRECT
//
//   The repo's other registries are written by npm scripts that
//   redirect the CLI's stdout into a file:
//
//     "nema:pack": "node lib/nema-me-u-meni.js pack > assets/…"
//
//   That is fine in package.json, but the shell form is exactly what
//   the agent's command parser refuses (a redirect is an
//   "unparseable inline payload" to it), so the artifacts could not be
//   generated from a session at all.
//
//   This writer does the same thing in Node: run the generator, write
//   its stdout to the file. It also VERIFIES what it wrote — the
//   prompt count, and that the file is not empty — because a silent
//   zero-byte write is worse than no write.
//
// Usage:
//   node tools/write-registry-artifacts.js <module> <packPath> <docPath>
//
//   e.g. node tools/write-registry-artifacts.js watched-man \
//          assets/mural-prompts/watched-man.md docs/WATCHED-MAN.md
//
// Exit: 0 both artifacts written and verified · 2 bad input · 3 the generator failed

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);

function log(m) { process.stdout.write(`[write-registry] ${m}\n`); }
function warn(m) { process.stderr.write(`[write-registry] ${m}\n`); }

const [moduleName, packRel, docRel] = ARGV;
if (!moduleName || !packRel || !docRel) {
    warn('usage: write-registry-artifacts.js <module> <packPath> <docPath>');
    process.exit(2);
}

const modulePath = path.join(REPO, 'lib', moduleName + '.js');
if (!fs.existsSync(modulePath)) {
    warn(`no such registry module: ${modulePath}`);
    process.exit(2);
}

/**
 * Run the generator and write its stdout.
 *
 * The output is verified before it is written: a generator that
 * prints nothing must fail loudly, not leave a zero-byte pack that
 * the watcher would later treat as a valid file.
 */
function generate(cmd) {
    const out = execFileSync(process.execPath, [modulePath, cmd], {
        encoding: 'utf8',
        cwd: REPO,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (!out || !out.trim()) {
        throw new Error(`the generator printed nothing for "${cmd}"`);
    }
    return out;
}

function write(rel, content, label) {
    const abs = path.resolve(REPO, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const size = fs.statSync(abs).size;
    if (!size) throw new Error(`${label} was written empty`);
    log(`${label} -> ${rel}  (${size} bytes)`);
    return abs;
}

try {
    const pack = generate('pack');
    const doc = generate('doc');

    const packAbs = write(packRel, pack, 'pack');
    const docAbs = write(docRel, doc, 'doc');

    // The pack's own contract: one top-level bullet per prompt.
    const bullets = (pack.match(/^- /gm) || []).length;
    if (!bullets) throw new Error('the pack has no top-level bullets');
    log(`the pack carries ${bullets} prompt(s)`);

    // The doc's contract: a heading per frame.
    const headings = (doc.match(/^### \d{2} — /gm) || []).length;
    log(`the doc carries ${headings} frame section(s)`);

    // Read the pack back through the SUBMITTER'S OWN parser, so the
    // artifact is verified by the same code that will submit it.
    const { extractPrompts } = require(path.join(REPO, 'lib', 'mj-submitter.js'));
    const parsed = extractPrompts(packAbs);
    if (parsed.length !== bullets) {
        throw new Error(`the parser read ${parsed.length} prompt(s) but the pack has ${bullets} bullet(s)`);
    }
    log(`the submitter's parser reads ${parsed.length} prompt(s) back`);

    const { findViolations } = require(path.join(REPO, 'lib', 'prompt-lint-core.js'));
    const violations = parsed.flatMap(p => findViolations(p.text));
    if (violations.length) {
        throw new Error(`the identity lint found ${violations.length} violation(s): ${violations[0].match}`);
    }
    log('the identity lint is clean');

    log('done');
} catch (err) {
    warn(`failed: ${err.message}`);
    process.exit(3);
}
