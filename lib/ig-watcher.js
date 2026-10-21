#!/usr/bin/env node
'use strict';
// lib/ig-watcher.js
//
// Instagram watcher — watches for post-ready reels and posts them to Instagram.
//
// Watches the processed/ output of reel-watcher.js and posts each reel
// to Instagram automatically.
//
// Usage:
//   node lib/ig-watcher.js              # default: poll every 2s
//   node lib/ig-watcher.js --once      # process all pending, then exit
//   node lib/ig-watcher.js --interval 5
//
// The companion LaunchAgent would launch this script.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ---------- Config ----------
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'ig-config.json'), 'utf8'));

const INBOX = path.join(__dirname, '..', 'reel-inbox', 'processed');
const POSTED = path.join(__dirname, '..', CONFIG.post?.outputDir || 'reel-inbox', 'posted');
const LOCK_DIR = path.join(__dirname, '..', '.ig-locks');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'ig-watcher.log');

// CLI
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const INTERVAL_IDX = ARGV.indexOf('--interval');
const INTERVAL_MS = INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]
    ? Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000)
    : 2000;

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5000;

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    process.stdout.write(line + '\n');
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// Ensure directories exist
[INBOX, POSTED, LOCK_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---------- Helpers ----------

function listPending() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return []; }
    return entries
        .map(e => {
            const full = path.join(INBOX, e);
            try {
                const stat = fs.statSync(full);
                if (!stat.isDirectory()) return null;
            } catch {
                return null;
            }
            return {
                name: e,
                path: full,
                mp4: findFile(full, ['.mp4', '.mov', '.m4v']),
                cover: findFile(full, ['.jpg', '.jpeg']),
                postMd: fs.existsSync(path.join(full, 'POST.md')),
            };
        })
        .filter(e => e && e.mp4 && e.postMd);
}

function findFile(dir, exts) {
    const files = fs.readdirSync(dir);
    for (const ext of exts) {
        const found = files.find(f => f.toLowerCase().endsWith(ext));
        if (found) return found;
    }
    return null;
}

function acquireLock(name) {
    const lock = path.join(LOCK_DIR, `.processing-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`);
    if (fs.existsSync(lock)) {
        // Check if stale (older than 5 minutes)
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
            fs.unlinkSync(lock);
        } else {
            return null;
        }
    }
    fs.writeFileSync(lock, JSON.stringify({ started: Date.now() }));
    return lock;
}

function releaseLock(lock) {
    if (lock && fs.existsSync(lock)) fs.unlinkSync(lock);
}

// ---------- Poster integration ----------

function runPoster(reelDir) {
    return new Promise((resolve, reject) => {
        const args = [path.join(__dirname, 'ig-poster.js'), reelDir];
        if (ARGV.includes('--dry-run')) args.push('--dry-run');
        
        const proc = spawn('node', args, {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env },
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        
        proc.on('close', code => {
            if (code === 0) {
                resolve({ ok: true, stdout, stderr });
            } else {
                reject(new Error(`Exit ${code}: ${stderr || stdout}`));
            }
        });
        
        proc.on('error', reject);
    });
}

// ---------- Main loop ----------

async function processOne(dirInfo) {
    const { name, path: dirPath } = dirInfo;
    const lock = acquireLock(name);
    
    if (!lock) {
        log(`[skip] ${name} - already being processed`);
        return { skipped: true };
    }
    
    log(`[start] ${name}`);
    const t0 = Date.now();
    
    let attempt = 0;
    let lastErr;
    
    while (attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
            const result = await runPoster(dirPath);
            
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            log(`[done] ${name} → ${sec}s`);
            
            releaseLock(lock);
            return { ok: true, sec, attempts: attempt };
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_ATTEMPTS) {
                log(`[retry] ${name} attempt ${attempt} failed: ${e.message}`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    log(`[fail] ${name} after ${sec}s: ${lastErr.message}`);
    
    releaseLock(lock);
    return { ok: false, error: lastErr.message, attempts: MAX_ATTEMPTS };
}

async function loop() {
    log(`[boot] Instagram watcher started (interval ${INTERVAL_MS}ms)`);
    
    while (true) {
        const pending = listPending();
        
        for (const item of pending) {
            await processOne(item);
        }
        
        if (ONCE) {
            log('[exit] --once mode, no more items');
            break;
        }
        
        await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
}

// Handle signals
process.on('SIGTERM', () => {
    log('[stop] SIGTERM received');
    process.exit(0);
});
process.on('SIGINT', () => {
    log('[stop] SIGINT received');
    process.exit(0);
});

// Start
loop().catch(e => {
    log(`[fatal] ${e.message}`);
    process.exit(1);
});
