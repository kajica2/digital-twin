#!/usr/bin/env node
'use strict';
// tools/mj-feed-probe.mjs — read a job's command out of the live feed.
//
// The feed is the only record of what a job actually ran with. The recent
// artist jobs carry their `--edit` attachments there, and those URLs are
// short-lived: when they expire, MJ refuses every prompt that names them.
//
//   node tools/mj-feed-probe.mjs <job-id> [--port 9463]

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const feed = require('../lib/mj-feed.js');
const { cdpConnect, CDPClient } = require('../lib/mj-submitter.js');

const JOB = process.argv[2];
const PORT = Number(process.env.MJ_PROBE_PORT || 9463);
const PROFILE = process.env.MJ_PROBE_PROFILE || '/tmp/mj-flow-profile';
const CHROME = '/Applications/Comet.app/Contents/MacOS/Comet';

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.midjourney.com/imagine',
], { stdio: 'ignore', detached: true });

let cdp = null;
for (let i = 0; i < 40 && !cdp; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
        const base = await cdpConnect(`http://127.0.0.1:${PORT}`);
        cdp = new CDPClient(base);
        await cdp.connect();
    } catch (e) { /* not up yet */ }
}
if (!cdp) {
    chrome.kill('SIGKILL');
    console.error('the browser did not open');
    process.exit(1);
}
try {
    // the Imagine page has to be loaded before the feed answers
    await cdp.js(`location.href = 'https://www.midjourney.com/imagine'`, true);
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const ready = await cdp.js(`document.readyState === 'complete' && !!document.querySelector('body')`, true);
        if (ready) break;
    }
    await new Promise(r => setTimeout(r, 3000));
    const userId = await cdp.js(feed.DISCOVER_USER_ID, true);
    const res = await cdp.js(feed.FETCH_FEED(userId, 1000), true);
    const items = res.items || [];
    const today = items.filter(j => (j.enqueue_time || '').startsWith('2026-11-09'));
    console.error('the feed holds ' + items.length + ' jobs; ' + today.length + ' were queued today');
    const job = items.find(j => j.id === JOB);
    if (!job) {
        console.log(JSON.stringify({ found: false, items: (res.items || []).length }));
    } else {
        const edits = (job.full_command || '').match(/--edit\s+\S+/g) || [];
        console.log(JSON.stringify({
            found: true,
            id: job.id,
            job_type: job.job_type,
            edits,
            command: job.full_command,
        }, null, 2));
    }
} finally {
    try { cdp.close(); } catch (e) { /* ignore */ }
    try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
}
