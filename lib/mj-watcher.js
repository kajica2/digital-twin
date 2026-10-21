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
//
// Sprint 0.18: a single prompt file may contain 5-10 distinct
// prompts (one per top-level bullet). We pass --all-prompts so the
// submitter loops over every prompt in the file, generating one
// Discord/MJ submission per prompt. The submitter also creates a
// per-prompt output subdir (`<basename>/prompt-NN/`) so results
// land in separate folders and we can diff / re-render one without
// touching the others.
//
// Sprint 0.19: --skip-done enables per-prompt retry. The submitter
// writes `.mj-done-<N>` sidecar markers for each successful
// prompt; a re-run skips already-shipped prompts instead of
// re-submitting them all. The watcher always passes --skip-done
// and clears all markers in the inbox when the input file is
// moved to processed/.
// Sprint 0.25: the backend is configurable. `engine: "web"` drives
// midjourney.com/imagine with a headed browser + cookie jar;
// `engine: "discord"` keeps the legacy /imagine slash-command path.
// Both accept the same CLI, so this is the only place that cares.
function submitterFor(engine) {
    return engine === 'discord'
        ? path.join(REPO, 'lib', 'mj-submitter.js')
        : path.join(REPO, 'lib', 'mj-web.js');
}

function configuredEngine() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'mj-config.json'), 'utf8'));
        return cfg.engine === 'discord' ? 'discord' : 'web';
    } catch {
        return 'web';
    }
}

function runSubmit(promptPath, extraArgs = []) {
    const submitter = submitterFor(configuredEngine());
    const args = [
        submitter,
        '--prompt-file', promptPath,
        '--all-prompts',
        '--skip-done',
        '--output', path.join(REPO, 'mj-output'),
        ...extraArgs,
    ];
    if (DRY_RUN) args.push('--dry-run');
    // Bump the timeout to (5min × prompts) with a hard ceiling of
    // 90 min. 10 prompts × 5min = 50min. Each MJ 4-up grid is 30-90s
    // in practice, so this is generous.
    const promptCount = countPromptsInFile(promptPath);
    const timeout = Math.min(5 * 60 * 1000 * Math.max(1, promptCount), 90 * 60 * 1000);
    execFileSync(process.execPath, args, {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
    });
}

// Clear all `.mj-done-*` sidecar markers in the prompt file's
// directory. Called after the input moves to processed/ so a
// future drop of a same-named file starts clean. Returns the
// number of markers cleared (for logging / tests).
function clearDoneMarkers(promptPath) {
    const submitter = require('./mj-submitter.js');
    const before = submitter.readDoneIndices(promptPath).length;
    submitter.clearDoneMarkers(promptPath);
    return before;
}

// Quick count of top-level `- ` lines (mirrors the submitter's
// extractPrompts() frontmatter strip). Used to budget the timeout.
// Fallback to 1 if anything goes wrong — single-prompt files use
// the legacy timeout.
function countPromptsInFile(promptPath) {
    try {
        const txt = fs.readFileSync(promptPath, 'utf8');
        // Strip frontmatter.
        const lines = txt.split('\n');
        let body = txt;
        if (lines[0] && lines[0].trim() === '---') {
            const endIdx = lines.slice(1).findIndex(l => l.trim() === '---');
            if (endIdx >= 0) body = lines.slice(endIdx + 2).join('\n');
        }
        // Count lines starting with `- ` at column 0, ignoring
        // code fences / blockquotes.
        let inFence = false, inQuote = false, count = 0;
        for (const raw of body.split('\n')) {
            const line = raw.replace(/\s+$/, '');
            if (/^```/.test(line)) { inFence = !inFence; inQuote = false; continue; }
            if (inFence) continue;
            if (/^>/.test(line)) { inQuote = true; continue; }
            if (line.trim() === '') { inQuote = false; continue; }
            if (inQuote) continue;
            if (/^- /.test(line)) count++;
        }
        return Math.max(1, count);
    } catch { return 1; }
}

// Module exports for the test harness.
module.exports = {
    INBOX, PROCESSED, LOGDIR, LOG, REPO,
    lockFor, listPending, submitOne,
    pruneStaleLocks,
    runSubmit,
    setRunSubmit: (fn) => { runSubmit = fn; },
    configuredEngine,
    submitterFor,
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
            // Move to processed on success, then clear any
            // .mj-done-* sidecar markers in the inbox so a future
            // drop of a same-named file starts fresh.
            try {
                fs.renameSync(promptPath, moveTo);
            } catch (e) {
                fs.copyFileSync(promptPath, moveTo);
                fs.unlinkSync(promptPath);
            }
            const cleared = clearDoneMarkers(promptPath);
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