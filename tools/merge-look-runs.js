#!/usr/bin/env node
'use strict';
// tools/merge-look-runs.js
//
// MERGE THE TWO HALVES OF A SPLIT LOOK SWEEP.
//
// WHY: a 30-prompt sweep does not fit in one unattended run — the batch
// dies or the session ends, and the tool numbers its outputs from 1.
// So the sweep was run in two passes (prompts 1-3, then 4-30) and each
// pass numbered its own outputs from 1.
//
// This merges them into ONE directory whose `prompt-NN` is the REGISTRY
// number, so the comparison sheet reads the right caption against the
// right image.
//
// Usage:
//   node tools/merge-look-runs.js <target-dir> <source-dir>:<offset> ...
//
//   e.g. node tools/merge-look-runs.js out/ a/prompt:0 b/prompt:3
//
// The source is a directory whose names are `prompt-NN`; the offset is
// added to NN to get the registry number.
//
// Exit: 0 merged · 2 bad input · 3 nothing to merge

const fs = require('node:fs');
const path = require('node:path');

const ARGV = process.argv.slice(2);
function log(m) { process.stdout.write(`[merge-look-runs] ${m}\n`); }
function warn(m) { process.stderr.write(`[merge-look-runs] ${m}\n`); }

if (ARGV.length < 2) {
    warn('usage: merge-look-runs.js <target-dir> <source-dir>:<offset> ...');
    process.exit(2);
}
const TARGET = path.resolve(ARGV[0]);
const sources = ARGV.slice(1).map(spec => {
    const i = spec.lastIndexOf(':');
    if (i === -1) { warn(`bad source (need <dir>:<offset>): ${spec}`); process.exit(2); }
    return { dir: path.resolve(spec.slice(0, i)), offset: Number(spec.slice(i + 1)) };
});
for (const s of sources) {
    if (!Number.isInteger(s.offset)) { warn(`bad offset in: ${spec}`); process.exit(2); }
    if (!fs.existsSync(s.dir)) { warn(`no such source: ${s.dir}`); process.exit(2); }
}

fs.mkdirSync(TARGET, { recursive: true });
let moved = 0, skipped = 0;

for (const s of sources) {
    for (const d of fs.readdirSync(s.dir)) {
        const m = d.match(/^prompt-(\d+)$/);
        if (!m) continue;
        const n = Number(m[1]) + s.offset;
        const from = path.join(s.dir, d);
        const to = path.join(TARGET, `prompt-${String(n).padStart(2, '0')}`);
        if (fs.existsSync(to)) {
            // The first pass's numbers are already correct (offset 0),
            // so a collision means the same prompt rendered twice. Keep
            // the one that is already there and note it.
            log(`skip ${d} -> prompt-${String(n).padStart(2, '0')} (already there)`);
            skipped++;
            continue;
        }
        // COPY, do not move. MEASURED 2026-11-06: the first version
        // renamed the directories, which took them out from under the
        // RUNNING batch — the tool was writing `prompt-10/meta.json`
        // when the merge renamed it, and the run died with ENOENT.
        //
        // A merge that reads a live output directory must not mutate
        // it. So the files are copied, and the source is left exactly
        // as the renderer left it.
        fs.cpSync(from, to, { recursive: true });
        moved++;
    }
}

log(`${moved} merged · ${skipped} skipped · into ${TARGET}`);
if (!moved && !skipped) { warn('nothing to merge'); process.exit(3); }
