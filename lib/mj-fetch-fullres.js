#!/usr/bin/env node
'use strict';
// lib/mj-fetch-fullres.js
//
// Fetch a Midjourney job's cells at FULL resolution.
//
// The feed's canonical url for a grid cell is the 640px PREVIEW:
//
//   https://cdn.midjourney.com/<jobId>/0_0_640_N.webp?method=shortest
//
// The CDN also serves the un-suffixed ORIGINAL at the same path:
//
//   https://cdn.midjourney.com/<jobId>/0_0.webp
//
// MEASURED 2026-11-02: the original is 1456×816 (the native MJ grid
// cell) against the preview's 1141×640 — and it is a different file,
// not a re-encode: 490 KB against 156 KB.
//
// The CDN answers curl and headless clients with a Cloudflare 403, so
// the bytes have to come through a real browser — same constraint as
// `lib/mj-download.js`, which this reuses.
//
// The upscaled variant (`0_0_U.webp`) is a THIRD thing: it only exists
// if the job was actually upscaled in the UI. It is not available for a
// fresh grid, and the CDN answers 422 for it.
//
// Usage:
//
//   node lib/mj-fetch-fullres.js <jobId> [slot ...] [--out <dir>]
//                               [--port 9444]
//
// Slots are grid cells without the `_U` suffix: `0_0` `0_1` `0_2` `0_3`.
// Default: all four.
//
// Exit: 0 all written · 2 bad input · 3 nothing could be fetched

const fs = require('node:fs');
const path = require('node:path');
const { CDPClient, cdpConnect } = require('./mj-submitter.js');
const { fetchImage } = require('./mj-download.js');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}

const JOB = ARGV[0] && !ARGV[0].startsWith('--') ? ARGV[0] : null;
const SLOTS = ARGV.slice(1).filter(a => !a.startsWith('--') && a !== argVal('--out', null));
const OUT = path.resolve(argVal('--out', path.join(__dirname, '..', 'mj-output')));
const PORT = argVal('--port', process.env.MJ_PORT || '9444');
const TRY_UPSCALE = ARGV.includes('--upscale');

// The full-resolution url for one grid cell.
//
// The path shape is the job id + the cell's own coordinate — the same
// coordinate the preview carries, minus the `_640_N` size marker.
function fullResUrl(jobId, cell, upscale) {
    const name = upscale ? `${cell}_U` : cell;
    return `https://cdn.midjourney.com/${jobId}/${name}.webp`;
}

// Which cells a job actually has.
//
// A job with a batch size of 4 has cells 0_0..0_3; a relaxed-mode
// single has one. The caller names them, so this only has to be sane.
function parseSlots(argv) {
    const seen = [];
    for (const a of argv) {
        if (a.startsWith('--')) continue;
        if (!/^\d+_\d+$/.test(a)) continue;
        if (!seen.includes(a)) seen.push(a);
    }
    return seen;
}

async function main() {
    if (!JOB) {
        process.stderr.write('usage: node lib/mj-fetch-fullres.js <jobId> [0_0 ...] [--out <dir>] [--port <n>]\n');
        process.exit(2);
    }
    if (!/^[0-9a-f-]{36}$/i.test(JOB)) {
        process.stderr.write(`not a job id: ${JOB}\n`);
        process.exit(2);
    }
    const slots = parseSlots(ARGV).length ? parseSlots(ARGV) : ['0_0', '0_1', '0_2', '0_3'];
    fs.mkdirSync(OUT, { recursive: true });

    const cdp = new CDPClient(await cdpConnect(`http://127.0.0.1:${PORT}`));
    await cdp.connect();

    let written = 0, failed = 0;
    try {
        for (const cell of slots) {
            const variants = TRY_UPSCALE ? [cell, `${cell}_U`] : [cell];
            for (const v of variants) {
                const dest = path.join(OUT, `${v}.webp`);
                const got = await fetchImage(cdp, fullResUrl(JOB, cell, v !== cell), dest,
                    { retries: 1, delayMs: 2500 });
                if (got) {
                    written++;
                    process.stdout.write(`${v}  ${(fs.statSync(got).size / 1024).toFixed(0)} KB  ${got}\n`);
                } else {
                    failed++;
                    process.stdout.write(`${v}  unavailable\n`);
                }
            }
        }
    } finally {
        try { cdp.close(); } catch { /* the browser stays up; it is headed and reusable */ }
    }
    process.stdout.write(`${written} written · ${failed} unavailable\n`);
    process.exit(written > 0 ? 0 : 3);
}

if (require.main === module) {
    main().catch(e => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(3); });
}

module.exports = { fullResUrl, parseSlots };
