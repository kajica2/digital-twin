#!/usr/bin/env node
// lib/mj-watcher.js
//
// Sprint X — Midjourney prompt watcher.
//
// Polls prompts-inbox/ for new .md prompt files. For each new file,
// invokes lib/mj-submitter.js to submit the prompt to Midjourney
// via Discord web (Chrome DevTools Protocol), captures the result
// image, and moves the input to prompts-inbox/processed/.
//
// Same proven pattern as lib/chart-watcher.js and lib/songs-watcher.js:
//   * 2-second poll loop (fs.watch / FSEvents has known reliability
//     gaps under GUI LaunchAgents).
//   * Lockfile-based concurrency guard (`.processing-<sha1>`).
//   * Stale-lock detection by mtime (handles "replace file at
//     same path").
//   * Retry-once on transient failure.
//   * SIGTERM-clean shutdown.
//
// Usage:
//   node lib/mj-watcher.js                 # default: poll every 2s
//   node lib/mj-watcher.js --interval 5    # poll every 5s
//   node lib/mj-watcher.js --once          # process all pending, then exit
//   node lib/mj-watcher.js --dry-run       # validate prompts without submitting

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------- CLI parsing ----------
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const DRY_RUN = ARGV.includes('--dry-run');
const INTERVAL_IDX = ARGV.indexOf('--interval');
const INTERVAL_MS = INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]
    ? Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000)
    : 2000;

// ---------- Paths ----------
const REPO = path.resolve(__dirname, '..');
const TEST_DIR = process.env.WATCHER_TEST_DIR || null;
const INBOX = TEST_DIR ? path.join(TEST_DIR, 'prompts-inbox') : path.join(REPO, 'prompts-inbox');
const LOGDIR = TEST_DIR ? path.join(TEST_DIR, 'logs') : path.join(REPO, 'logs');
const LOG = path.join(LOGDIR, 'mj-watcher.log');
const PROCESSED = path.join(INBOX, 'processed');
const SUBMITTER = path.join(REPO, 'lib', 'mj-submitter.js');

// Supported prompt file extensions
const SUPPORTED_EXTS = ['.md'];

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

function lockFor(promptPath) {
    const h = crypto.createHash('sha1')
        .update('mj-watcher:')
        .update(promptPath)
        .digest('hex')
        .slice(0, 12);
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
        } catch { /* ignore */ }
    }
}

function acquireLock(promptPath) {
    const lock = lockFor(promptPath);
    try {
        fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
        return lock;
    } catch (e) {
        if (e.code === 'EEXIST') return null;
        throw e;
    }
}

function releaseLock(lock) {
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
}

// ---------- Submit runner ----------
//
// runSubmit() is the seam between the watcher's queue logic and the
// actual MJ submitter. Default: shell out. Tests override.
function runSubmit(promptPath, extraArgs = []) {
    const args = [SUBMITTER, '--prompt-file', promptPath, '--output', path.join(REPO, 'mj-output'), ...extraArgs];
    if (DRY_RUN) args.push('--dry-run');
    execFileSync(process.execPath, args, {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000, // 5 min hard cap — MJ generations can take a while
    });
}

// Module exports for the test harness.
module.exports = {
    INBOX, PROCESSED, LOGDIR, LOG, REPO,
    lockFor, listPending, submitOne,
    pruneStaleLocks,
    runSubmit,
    setRunSubmit: (fn) => { runSubmit = fn; },
    ensureDirs,
};

// ---------- Process one dropped prompt ----------
function submitOne(promptPath) {
    const lock = acquireLock(promptPath);
    if (!lock) return { skipped: true };

    try {
        return submitWithRetry(promptPath, lock);
    } finally {
        releaseLock(lock);
    }
}

function submitWithRetry(promptPath, lock) {
    const fileName = path.basename(promptPath);
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
            runSubmit(promptPath);
            // Move to processed on success
            try {
                fs.renameSync(promptPath, moveTo);
            } catch (e) {
                fs.copyFileSync(promptPath, moveTo);
                fs.unlinkSync(promptPath);
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
    return entries
        .filter(e => SUPPORTED_EXTS.includes(path.extname(e).toLowerCase()))
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
    for (const f of listPending()) submitOne(f);
}

function main() {
    ensureDirs();
    pruneStaleLocks();
    appendLog(`[boot]  mj-watcher started (interval=${INTERVAL_MS}ms once=${ONCE} dry-run=${DRY_RUN})`);

    if (ONCE) {
        tick();
        appendLog(`[exit]  --once mode, exiting`);
        return;
    }

    let running = true;
    const stop = () => {
        if (!running) return;
        running = false;
        appendLog(`[exit]  mj-watcher stopped (signal)`);
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    tick(); // immediate first pass
    const loop = setInterval(() => {
        if (!running) { clearInterval(loop); return; }
        tick();
    }, INTERVAL_MS);
}

if (require.main === module) main();