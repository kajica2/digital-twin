#!/usr/bin/env node
'use strict';
// tools/recover-metas.mjs — rebuild the missing per-prompt meta.json files
// of a Midjourney run from its own log.
//
// The run writes a meta after its job is accepted in the feed. A run that
// is killed (or whose feed window closed) leaves the job paid for and the
// meta missing, and the cells can then never be downloaded. The job id is
// in the log, and the CDN URLs are derived from the job id — so the meta
// can be rebuilt exactly.
//
//   node tools/recover-metas.mjs <output-dir> <log-file>

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const feed = require('../lib/mj-feed.js');

const [dir, logFile] = process.argv.slice(2);
if (!dir || !logFile) {
    console.error('usage: node tools/recover-metas.mjs <output-dir> <log-file>');
    process.exit(2);
}

const log = fs.readFileSync(logFile, 'utf8');
const jobs = [...log.matchAll(/submitted: job ([0-9a-f-]{36})/g)].map(m => m[1]);
if (!jobs.length) {
    console.error('no job ids in the log');
    process.exit(1);
}

// The pack's directories, in order: prompt-01, prompt-02, ...
const dirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^prompt-\d+$/.test(d.name))
    .map(d => d.name)
    .sort();

let written = 0;
for (const name of dirs) {
    const metaPath = path.join(dir, name, 'meta.json');
    if (fs.existsSync(metaPath)) continue;
    const index = Number(name.replace('prompt-', ''));
    const taskId = jobs[index - 1];
    if (!taskId) continue;
    const meta = {
        index,
        taskId,
        matchedBy: 'recovered-from-log',
        jobType: 'v8-2_edit_diffusion',
        aspect: '16:9',
        imageUrls: feed.gridUrls(taskId, 4),
        imageCount: 4,
        complete: true,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    written++;
    console.log(`recovered ${name} -> ${taskId}`);
}
console.log(`${written} meta(s) recovered`);
