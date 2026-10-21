#!/usr/bin/env node
// lib/chart-watcher.js
//
// Sprint 0.8 — chart export watcher.
//
// Polls chart-inbox/ for new .musicxml files. For each new file, runs
// the full export pipeline (bin/export-all.sh) and moves the input
// to chart-inbox/processed/. Writes a one-line summary per file to
// logs/chart-watcher.log.
//
// Why a poll loop and not fs.watch:
//   * fs.watch / FSEvents under a GUI LaunchAgent has known reliability
//     gaps on macOS — events drop, especially under network filesystem
//     mounts. A 2-second poll is boring, predictable, and matches the
//     twin's "calm, not chatty" ethos.
//   * Single in-process watcher. No job queue, no concurrency. Each
//     export takes ~10s; serial processing is the right default for a
//     personal twin. To process multiple files in parallel later, add
//     a worker pool — not now.
//
// Lockfile: chart-inbox/.processing-<sha1>. Exists while the export
// is running. The poll loop skips files that already have a lock.
// Stale lockfiles (older than 30 minutes) are removed at startup.
//
// Usage:
//   node lib/chart-watcher.js                 # default: poll every 2s
//   node lib/chart-watcher.js --interval 5    # poll every 5s
//   node lib/chart-watcher.js --once          # process all pending, then exit
//
// The companion LaunchAgent (com.kaidjuric.digital-twin.chart-watcher)
// launches this script via bin/chart-watcher.sh — that wrapper handles
// Node resolution under launchd's stripped PATH.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------- CLI parsing ----------
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const TEST = ARGV.includes('--test');
const NOTIFY = ARGV.includes('--notify-on-success'); // post Apple Notes ping
const INTERVAL_IDX = ARGV.indexOf('--interval');
const INTERVAL_MS = INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]
    ? Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000)
    : 2000;

// ---------- Paths ----------
const REPO = path.resolve(__dirname, '..');
// In --test mode the test harness sets TEST_DIR before requiring
// chart-watcher; we use it as a scratch dir for inbox / processed / log.
const TEST_DIR = process.env.WATCHER_TEST_DIR || null;
const INBOX = TEST_DIR ? path.join(TEST_DIR, 'inbox') : path.join(REPO, 'chart-inbox');
const PROCESSED = path.join(INBOX, 'processed');
const LOGDIR = TEST_DIR ? path.join(TEST_DIR, 'logs') : path.join(REPO, 'logs');
const LOG = path.join(LOGDIR, 'chart-watcher.log');
const EXPORT_SCRIPT = path.join(REPO, 'bin', 'export-all.sh');

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
// Each .musicxml gets a lockfile during export. Stale lockfiles are
// pruned in two ways:
//   1. At startup, any lockfile older than STALE_LOCK_MS is removed.
//   2. Per-tick, a lockfile is considered stale if its mtime is
//      older than the underlying file's mtime — i.e. the file at
//      that path was replaced with a newer copy. This handles the
//      "drop a new file at the same path" case where the lockfile
//      still references the old (now-deleted) file's identity.
const STALE_LOCK_MS = 5 * 60 * 1000;

function lockFor(musicxmlPath) {
    // Hash the path. Includes a per-watcher prefix so the chart-
    // watcher's .processing-* files never collide with the songs-
    // watcher's if a future refactor shares an inbox between them.
    const h = crypto.createHash('sha1')
        .update('chart-watcher:')
        .update(musicxmlPath)
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

function acquireLock(musicxmlPath) {
    const lock = lockFor(musicxmlPath);
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

// ---------- Post-success hook ----------
//
// Optional callback fired after a successful export, before the
// input is moved to processed/. Receives {songBase, sec, attempts}
// so the hook can log / notify. Used by bin/chart-watcher.sh to
// post an Apple Notes ping (sprint 0.16).
let postSuccessHook = null;
function setPostSuccessHook(fn) { postSuccessHook = fn; }
async function maybeNotify(songBase, sec, attempts) {
    if (!postSuccessHook) return;
    try {
        await postSuccessHook({ songBase, sec, attempts });
    } catch (e) {
        appendLog(`[notify] hook failed for ${songBase}: ${e.message}`);
    }
}

// ---------- Export runner ----------
//
// runExport() is the seam between the watcher's queue logic and the
// actual chart-export pipeline. The default implementation shells out
// to bin/export-all.sh. Tests can override this (via a module-local
// assignment) to a noop or a synthetic failing implementation
// without triggering mscore.
function runExport(musicxmlPath) {
    execFileSync(EXPORT_SCRIPT, [musicxmlPath], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000, // 5 min hard cap
    });
}

// Module exports for the test harness. Kept narrow on purpose.
module.exports = {
    INBOX, PROCESSED, LOGDIR, LOG, REPO,
    lockFor, listPending, exportOne,
    pruneStaleLocks,
    runExport,
    setRunExport: (fn) => { runExport = fn; },
    setPostSuccessHook,
    ensureDirs,
};

// ---------- Default Apple Notes notifier ----------
//
// Used when --notify-on-success is passed. Spawns osascript with
// bin/chart-notes.applescript + the standard argv. One note per
// successful export in the user's "twin OS" Notes folder. Failures
// are caught + logged; the watcher doesn't break.
const CHART_NOTES_SCRIPT = path.join(REPO, 'bin', 'chart-notes.applescript');
function defaultNotify({ songBase, sec, attempts }) {
    const stamp = new Date().toISOString();
    execFileSync('osascript', [
        CHART_NOTES_SCRIPT,
        'twin OS',
        stamp,
        songBase,
        String(sec),
        String(attempts),
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
}
function exportOne(musicxmlPath) {
    const lock = acquireLock(musicxmlPath);
    if (!lock) {
        // Another instance is processing this file. Skip.
        return { skipped: true };
    }

    try {
        return exportWithRetry(musicxmlPath, lock);
    } finally {
        releaseLock(lock);
    }
}

function exportWithRetry(musicxmlPath, lock) {
    const base = path.basename(musicxmlPath, '.musicxml');
    const moveTo = path.join(PROCESSED, path.basename(musicxmlPath));
    const t0 = Date.now();

    appendLog(`[start] ${path.basename(musicxmlPath)}`);

    // Retry once on failure. Transient causes (mscore file-locks, MuseScore
    // crash mid-export, brief filesystem contention) clear within seconds.
    // Two attempts with a 5s gap covers the common cases without blocking
    // the queue for too long on real bugs.
    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 5000;
    let attempt = 0;
    let lastErr = null;

    while (attempt < MAX_ATTEMPTS) {
        attempt += 1;
        try {
            runExport(musicxmlPath);
            // Move the input to processed/ on success
            try {
                fs.renameSync(musicxmlPath, moveTo);
            } catch (e) {
                // cross-device or similar — fall back to copy + unlink
                fs.copyFileSync(musicxmlPath, moveTo);
                fs.unlinkSync(musicxmlPath);
            }
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            const tag = attempt > 1 ? `[done-retry-${attempt}]` : '[done]';
            appendLog(`${tag} ${path.basename(musicxmlPath)} → ${sec}s, moved to processed/`);
            // Fire the post-success hook (Apple Notes ping, etc.).
            // Sync wait is fine — the hook is non-blocking in practice
            // (osascript completes in <500ms), and the watcher is
            // single-process so a brief pause is acceptable.
            maybeNotify(base, sec, attempt);
            return { ok: true, sec, attempts: attempt };
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_ATTEMPTS) {
                appendLog(`[retry] ${path.basename(musicxmlPath)} attempt ${attempt} failed (${e.message}); retrying in ${RETRY_DELAY_MS / 1000}s`);
                // Sync sleep — the watcher is single-process, blocking here
                // is acceptable. Same pattern as waitForFile in chart-export.js.
                const sleptUntil = Date.now() + RETRY_DELAY_MS;
                while (Date.now() < sleptUntil) { /* spin */ }
            }
        }
    }

    // All attempts exhausted.
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const tail = (lastErr.stderr || lastErr.stdout || '').toString().split('\n').slice(-3).join(' | ');
    appendLog(`[fail]  ${path.basename(musicxmlPath)} after ${sec}s (${MAX_ATTEMPTS} attempts): ${lastErr.message} :: ${tail}`);
    return { ok: false, sec, error: lastErr.message, attempts: MAX_ATTEMPTS };
}

// ---------- Main loop ----------
function listPending() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return []; }
    const now = Date.now();
    return entries
        .filter(e => e.endsWith('.musicxml'))
        .filter(e => {
            const lock = lockFor(path.join(INBOX, e));
            if (!fs.existsSync(lock)) return true;
            // Lock exists — is it stale? Two conditions, either triggers:
            // (a) lockfile is older than STALE_LOCK_MS (likely crashed watcher)
            // (b) the underlying file has been replaced since the lock was acquired
            //     (its mtime is newer than the lockfile's mtime)
            try {
                const lockAge = now - fs.statSync(lock).mtimeMs;
                const fileMtime = fs.statSync(path.join(INBOX, e)).mtimeMs;
                const lockMtime = fs.statSync(lock).mtimeMs;
                if (lockAge > STALE_LOCK_MS) {
                    try { fs.unlinkSync(lock); } catch {}
                    return true;
                }
                if (fileMtime > lockMtime) {
                    // File replaced since the lock was acquired — stale
                    try { fs.unlinkSync(lock); } catch {}
                    return true;
                }
            } catch {}
            return false;
        })
        .map(e => path.join(INBOX, e))
        .sort(); // deterministic order
}

function tick() {
    for (const f of listPending()) {
        exportOne(f);
    }
}

function main() {
    ensureDirs();
    pruneStaleLocks();
    appendLog(`[boot]  chart-watcher started (interval=${INTERVAL_MS}ms once=${ONCE} notify=${NOTIFY})`);

    if (NOTIFY) {
        // Default hook posts to Apple Notes. Errors are caught + logged
        // inside maybeNotify; the watcher doesn't break on Notes failures.
        postSuccessHook = defaultNotify;
    }

    if (TEST) {
        // Test harness drives the assertions; nothing to do at main().
        return;
    }

    if (ONCE) {
        tick();
        appendLog(`[exit]  --once mode, exiting`);
        return;
    }

    // SIGTERM from launchd = clean shutdown.
    let running = true;
    const stop = () => {
        if (!running) return;
        running = false;
        appendLog(`[exit]  chart-watcher stopped (signal)`);
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

main();