#!/usr/bin/env node
// lib/songs-watcher.js
//
// Sprint 0.13 — drop audio files into audio-inbox/, get an updated
// data/songs/catalog.json automatically. Mirrors the chart-watcher
// pattern from lib/chart-watcher.js exactly:
//
//   * 2-second poll loop (fs.watch / FSEvents has known reliability
//     gaps under GUI LaunchAgents; see CHART-WATCHER.md).
//   * Lockfile-based concurrency guard (`.processing-<sha1>`).
//   * Stale-lock detection by mtime (handles "replace file at same
//     path").
//   * SIGTERM-clean shutdown.
//
// On a drop: copies the file to its configured root's directory
// (using the existing songs-indexer's --add mechanism) and then
// re-runs the indexer to regenerate data/songs/catalog.json.
//
// Why a separate watcher from the chart-watcher:
//   * Different inbox (audio-inbox/ vs chart-inbox/).
//   * Different export target (data/songs/catalog.json vs PDFs/MP3s).
//   * Different side effects (no mscore invocation needed).
//   * Sharing one watcher would couple unrelated pipelines.
//
// Usage:
//   node lib/songs-watcher.js                 # default: poll every 2s
//   node lib/songs-watcher.js --once          # process all pending, then exit
//
// The companion LaunchAgent (com.kaidjuric.digital-twin.songs-watcher)
// launches this script via bin/songs-watcher.sh — that wrapper handles
// Node resolution under launchd's stripped PATH (same pattern as
// bin/chart-watcher.sh).

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------- CLI parsing ----------
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const INTERVAL_IDX = ARGV.indexOf('--interval');
const INTERVAL_MS = INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]
    ? Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000)
    : 2000;

// ---------- Paths ----------
const REPO = path.resolve(__dirname, '..');
const TEST_DIR = process.env.WATCHER_TEST_DIR || null;
const INBOX = TEST_DIR ? path.join(TEST_DIR, 'audio-inbox') : path.join(REPO, 'audio-inbox');
const LOGDIR = TEST_DIR ? path.join(TEST_DIR, 'logs') : path.join(REPO, 'logs');
const LOG = path.join(LOGDIR, 'songs-watcher.log');
// songs-indexer reads lib/sources.config.json for the configured
// roots. We pass `--add <path>` for each dropped file so the indexer
// picks it up under a "manual" synthetic root (sprint 2 convention).
const INDEXER = path.join(REPO, 'lib', 'songs-indexer.js');
const SOURCES_CONFIG = path.join(REPO, 'lib', 'sources.config.json');
// Move audio files to this root when indexer doesn't need them
// anymore. Match songs-indexer's default manual label.
const PROCESSED = path.join(INBOX, 'processed');

// ---------- Setup ----------
function ensureDirs() {
    fs.mkdirSync(INBOX,     { recursive: true });
    fs.mkdirSync(PROCESSED, { recursive: true });
    fs.mkdirSync(LOGDIR,    { recursive: true });
}

function appendLog(line) {
    const stamp = new Date().toISOString();
    fs.appendFileSync(LOG, `${stamp} ${line}\n`);
}

// ---------- Lockfile management ----------
const STALE_LOCK_MS = 5 * 60 * 1000;

function lockFor(audioPath) {
    const h = crypto.createHash('sha1').update(audioPath).digest('hex').slice(0, 12);
    return path.join(INBOX, `.processing-${h}`);
}

function pruneStaleLocks() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return; }
    const now = Date.now();
    for (const e of entries) {
        if (!e.startsWith('.processing-')) continue;
        const p = path.join(INBOX, e);
        try {
            const age = now - fs.statSync(p).mtimeMs;
            if (age > STALE_LOCK_MS) fs.unlinkSync(p);
        } catch {}
    }
}

function acquireLock(audioPath) {
    const lock = lockFor(audioPath);
    try {
        fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
        return lock;
    } catch (e) {
        if (e.code === 'EEXIST') return null;
        throw e;
    }
}

function releaseLock(lock) {
    try { fs.unlinkSync(lock); } catch {}
}

// ---------- Index runner ----------
//
// runIndexer is the seam between the watcher and songs-indexer.js.
// Tests can override this. Default: shell out, regenerate catalog.
function runIndexer(audioFiles) {
    execFileSync(process.execPath, [INDEXER, '--apply', '--yes', '--add', ...audioFiles],
        { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], timeout: 2 * 60 * 1000 });
}

// ---------- Process one dropped file ----------
function processOne(audioPath) {
    const lock = acquireLock(audioPath);
    if (!lock) return { skipped: true };

    try {
        return indexOneWithRetry(audioPath, lock);
    } finally {
        releaseLock(lock);
    }
}

function indexOneWithRetry(audioPath, lock) {
    const fileName = path.basename(audioPath);
    const moveTo = path.join(PROCESSED, fileName);
    const t0 = Date.now();

    appendLog(`[start] ${fileName}`);

    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 5000;
    let attempt = 0;
    let lastErr = null;

    while (attempt < MAX_ATTEMPTS) {
        attempt += 1;
        try {
            runIndexer([audioPath]);
            try {
                fs.renameSync(audioPath, moveTo);
            } catch (e) {
                fs.copyFileSync(audioPath, moveTo);
                fs.unlinkSync(audioPath);
            }
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            const tag = attempt > 1 ? `[done-retry-${attempt}]` : '[done]';
            appendLog(`${tag} ${fileName} → ${sec}s, moved to processed/`);
            return { ok: true, sec, attempts: attempt };
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_ATTEMPTS) {
                appendLog(`[retry] ${fileName} attempt ${attempt} failed (${e.message}); retrying in ${RETRY_DELAY_MS / 1000}s`);
                const sleptUntil = Date.now() + RETRY_DELAY_MS;
                while (Date.now() < sleptUntil) { /* spin */ }
            }
        }
    }

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const tail = (lastErr.stderr || lastErr.stdout || '').toString().split('\n').slice(-3).join(' | ');
    appendLog(`[fail]  ${fileName} after ${sec}s (${MAX_ATTEMPTS} attempts): ${lastErr.message} :: ${tail}`);
    return { ok: false, sec, error: lastErr.message, attempts: MAX_ATTEMPTS };
}

// ---------- Main loop ----------
function listPending() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return []; }
    const now = Date.now();
    const SUPPORTED = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
    return entries
        .filter(e => SUPPORTED.includes(path.extname(e).toLowerCase()))
        .filter(e => {
            const lock = lockFor(path.join(INBOX, e));
            if (!fs.existsSync(lock)) return true;
            try {
                const lockAge = now - fs.statSync(lock).mtimeMs;
                const fileMtime = fs.statSync(path.join(INBOX, e)).mtimeMs;
                const lockMtime = fs.statSync(lock).mtimeMs;
                if (lockAge > STALE_LOCK_MS) { try { fs.unlinkSync(lock); } catch {}; return true; }
                if (fileMtime > lockMtime)   { try { fs.unlinkSync(lock); } catch {}; return true; }
            } catch {}
            return false;
        })
        .map(e => path.join(INBOX, e))
        .sort();
}

function tick() {
    for (const f of listPending()) processOne(f);
}

// Module exports for the test harness.
module.exports = {
    INBOX, PROCESSED, LOGDIR, LOG, REPO,
    lockFor, listPending, pruneStaleLocks,
    runIndexer, setRunIndexer: (fn) => { runIndexer = fn; },
    ensureDirs,
};

function main() {
    ensureDirs();
    pruneStaleLocks();
    appendLog(`[boot]  songs-watcher started (interval=${INTERVAL_MS}ms once=${ONCE})`);

    // Pre-flight check: sources.config.json must exist for the
    // indexer to walk any audio roots. If it's missing, log loudly
    // (so the LaunchAgent's stdout shows the problem) and proceed
    // anyway — manual --add invocations can still work without a
    // config (the indexer will just write a "manual" root only).
    if (!fs.existsSync(SOURCES_CONFIG)) {
        appendLog(`[boot]  WARN: ${SOURCES_CONFIG} not found — only manual --add entries will work`);
        process.stderr.write(`[songs-watcher] WARN: ${SOURCES_CONFIG} not found\n`);
    }

    if (ONCE) {
        tick();
        appendLog(`[exit]  --once mode, exiting`);
        return;
    }

    let running = true;
    const stop = () => {
        if (!running) return;
        running = false;
        appendLog(`[exit]  songs-watcher stopped (signal)`);
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    tick();
    const loop = setInterval(() => {
        if (!running) { clearInterval(loop); return; }
        tick();
    }, INTERVAL_MS);
}

if (require.main === module) main();