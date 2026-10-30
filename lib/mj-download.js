#!/usr/bin/env node
/**
 * mj-download — fetch a Midjourney job's images through a headed browser.
 *
 * The CDN answers curl and headless clients with 403, and a cross-origin
 * fetch from another page is blocked by CORS. An in-page `fetch()` from a
 * midjourney.com tab returns the bytes, which is the only path that works
 * (the contact-sheet builder uses the same one).
 *
 * `lib/mj-revise.js` used to carry its own copy of `fetchImage`; the
 * implementation lives here now and is required from there, so there is
 * one definition rather than two that can drift.
 *
 * CLI usage:
 *
 *   node lib/mj-download.js --dir mj-output/<pack> [--port 9445]
 *   node lib/mj-download.js --dir mj-output/<pack> --slot 2 --force
 *
 * Reads every `prompt-*\/meta.json` under `--dir` and writes the job's
 * cells next to it, named `0_<slot>.<ext>` with the extension taken from
 * the URL the CDN actually served (a `.png` name over WebP bytes is a
 * lie — see the sprint-0.55 finding).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CDPClient, cdpConnect } = require('./mj-submitter.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `https://cdn.midjourney.com/<uuid>/0_2_640_N.webp?method=shortest` → `0_2.webp`
function imageFileName(url, slot) {
    const m = /(\d+)_(\d+)_\d+_N\.(webp|png|jpe?g)/i.exec(String(url || ''));
    if (m) return `${m[1]}_${m[2]}.${m[3].toLowerCase()}`;
    const ext = /\.(webp|png|jpe?g)(?:[?#]|$)/i.exec(String(url || ''));
    const base = /[^/]+$/.exec(String(url || ''));
    if (base && !/[?]/.test(String(url)) && /\.(webp|png|jpe?g)$/i.test(base[0])) return base[0];
    return `${Math.floor((slot || 0) / 4)}_${slot || 0}.${ext ? ext[1].toLowerCase() : 'webp'}`;
}

// Fetch one URL into `dest`. Returns the path, or null after exhausting
// the retries (the CDN 404s until the grid has rendered).
async function fetchImage(cdp, url, dest, { retries = 0, delayMs = 4000 } = {}) {
    let lastError = 'unknown';
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(delayMs);
        const b64 = await cdp.js(`(async () => {
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'omit', cache: 'no-store' });
            if (!r.ok) return 'ERR:' + r.status;
            const buf = await r.arrayBuffer();
            let s = ''; const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
        })()`, true);
        if (typeof b64 !== 'string') { lastError = 'no response'; continue; }
        if (b64.startsWith('ERR:')) { lastError = `fetch ${url} → ${b64}`; continue; }
        fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
        return dest;
    }
    console.error(`[mj-download] ${lastError}`);
    return null;
}

// The prompt directories under an output dir, in numeric order.
function promptDirs(dir) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && /^prompt-\d+$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
}

function readMeta(dir) {
    const file = path.join(dir, 'meta.json');
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

// Which cells to fetch: every URL the meta carries, or the slot the
// caller named (0-3 for a 4-up). A slot only exists inside its cell.
function cellsFor(urls, slot) {
    if (slot === undefined || slot === null) return urls.map((u, i) => ({ url: u, slot: i }));
    return urls.length > slot ? [{ url: urls[slot], slot }] : [];
}

async function downloadPack({ dir, port = 9445, slot = null, force = false, retries = 20, delayMs = 4000, dryRun = false, log = () => {} }) {
    const dirs = promptDirs(dir);
    if (!dirs.length) throw new Error(`no prompt-NN directories under ${dir}`);
    const plan = dirs.map((name) => {
        const promptDir = path.join(dir, name);
        const meta = readMeta(promptDir);
        const urls = meta && Array.isArray(meta.imageUrls) ? meta.imageUrls : [];
        return { name, promptDir, meta, urls, cells: cellsFor(urls, slot) };
    });

    const wanted = plan.filter((p) => p.cells.length);
    const missing = plan.filter((p) => !p.cells.length);
    for (const p of missing) log(`${p.name}: no image urls in meta.json — skipped`);
    if (dryRun) {
        for (const p of plan) {
            for (const c of p.cells) log(`${p.name}/${imageFileName(c.url, c.slot)} ← ${c.url}`);
        }
        return { written: [], skipped: missing.map((p) => p.name), plan };
    }

    let cdp = null;
    const written = [];
    const failed = [];
    for (const p of wanted) {
        for (const c of p.cells) {
            const dest = path.join(p.promptDir, imageFileName(c.url, c.slot));
            if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
                log(`${p.name}/${path.basename(dest)} — already present`);
                written.push(dest);
                continue;
            }
            if (!cdp) {
                const ws = await cdpConnect(`http://127.0.0.1:${port}`);
                cdp = new CDPClient(ws);
                await cdp.connect();
            }
            const got = await fetchImage(cdp, c.url, dest, { retries, delayMs });
            if (got) {
                written.push(got);
                log(`${p.name}/${path.basename(got)}  ${(fs.statSync(got).size / 1024).toFixed(0)} KB`);
            } else {
                failed.push(`${p.name}/${path.basename(dest)}`);
            }
        }
    }
    return { written, failed, skipped: missing.map((p) => p.name), plan };
}

const VALUE_FLAGS = new Set(['--dir', '--port', '--slot', '--retries']);
const BOOL_FLAGS = new Set(['--force', '--dry-run', '--json', '--help', '-h']);

function usage() {
    return [
        'Usage: node lib/mj-download.js --dir <output dir> [options]',
        '',
        '  --dir <path>      a directory holding prompt-NN/meta.json (required)',
        '  --port <n>        CDP port of the headed browser (default 9445)',
        '  --slot <0-3>      fetch only this cell of each job',
        '  --retries <n>     attempts per image (default 20; the CDN 404s until the grid renders)',
        '  --force           re-fetch cells that are already on disk',
        '  --dry-run         print what would be fetched, launch nothing',
        '  --json            print a JSON summary',
        '',
        'The browser must already be running on --port, headed, and logged in.',
    ].join('\n');
}

function parseArgs(argv) {
    const out = { dir: null, port: 9445, slot: null, retries: 20, force: false, dryRun: false, json: false, help: false };
    const unknown = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            const v = argv[i + 1];
            i++;
            return v;
        };
        if (a === '--dir') out.dir = val();
        else if (a === '--port') out.port = Number(val());
        else if (a === '--slot') out.slot = Number(val());
        else if (a === '--retries') out.retries = Number(val());
        else if (a === '--force') out.force = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a.startsWith('-')) unknown.push(a);
        // A bare token is the value of a flag we know; an unknown flag's
        // own value cannot be told apart from one, so only the flag is
        // reported.
    }
    return { args: out, unknown };
}

async function main() {
    const { args, unknown } = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(usage() + '\n');
        return 0;
    }
    if (unknown.length) {
        process.stderr.write(`unknown flag(s): ${unknown.join(' ')}\n\n${usage()}\n`);
        return 2;
    }
    if (!args.dir) {
        process.stderr.write(`--dir is required\n\n${usage()}\n`);
        return 2;
    }
    if (args.slot !== null && !(args.slot >= 0 && args.slot <= 3)) {
        process.stderr.write('--slot must be 0-3\n');
        return 2;
    }
    const quiet = args.json;
    try {
        const res = await downloadPack({
            dir: args.dir,
            port: args.port,
            slot: args.slot,
            force: args.force,
            retries: args.retries,
            dryRun: args.dryRun,
            log: quiet ? () => {} : (m) => console.log(`[mj-download] ${m}`),
        });
        const summary = {
            dir: args.dir,
            written: res.written.length,
            failed: res.failed.length,
            skipped: res.skipped.length,
            failedFiles: res.failed,
            skippedDirs: res.skipped,
        };
        if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        else console.log(`[mj-download] ${summary.written} written · ${summary.failed} failed · ${summary.skipped} skipped`);
        return res.failed.length ? 1 : 0;
    } catch (e) {
        process.stderr.write(`[mj-download] ${e.message}\n`);
        return 1;
    }
}

module.exports = { fetchImage, imageFileName, promptDirs, readMeta, cellsFor, downloadPack, parseArgs, usage, VALUE_FLAGS, BOOL_FLAGS };

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => {
        process.stderr.write(`[mj-download] ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    });
}
