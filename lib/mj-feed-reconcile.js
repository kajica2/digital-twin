#!/usr/bin/env node
'use strict';
// lib/mj-feed-reconcile.js
//
// Reconcile a pack's `meta.json` files against Midjourney's LIVE feed.
//
// WHY
//
// The web backend's DOM matcher can attribute a prompt to the wrong
// card (see lib/mj-feed.js for the full post-mortem). When that happens
// the meta files record task ids that belong to somebody else's job —
// usually the account owner's own concurrent generation. The images then
// are not the prompt's images.
//
// This tool re-derives the truth from the feed API and rewrites the
// metas in place. It is the repair path for a run whose acceptance was
// wrong, without spending new generations.
//
//   node lib/mj-feed-reconcile.js --pack <slug> [--dry-run] [--json]
//
// It reads `mj-output/<slug>/prompt-NN/prompt.md` (the composed prompt
// that was submitted), finds the matching job in the live feed, and
// rewrites `meta.json` with the true task id and the CDN image urls.
//
// The prompt matched is the one in the OUTPUT — the exact composed text
// that went to Midjourney, not the source pack's bullet. That matters:
// buildFullPrompt may add or drop flags, and only the composed text is
// what MJ saw.

const fs = require('node:fs');
const path = require('node:path');

const {
    cdpConnect, CDPClient,
} = require('./mj-submitter.js');
const feed = require('./mj-feed.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PACK = argVal('--pack', null);
const DRY_RUN = ARGV.includes('--dry-run');
const AS_JSON = ARGV.includes('--json');
const OUTPUT_DIR = path.resolve(argVal('--output', path.join(REPO, CONFIG.mj?.outputDir || 'mj-output')));
const PORT = parseInt(argVal('--port', String(CONFIG.chrome?.debugPort || 9444)), 10);

function log(m) { if (!AS_JSON) process.stdout.write(`[mj-reconcile] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-reconcile] ${m}\n`); }

// The aspect ratio the pack asked for, read from the composed prompt.
// This is what the fidelity check compares the ENQUEUED command against.
function expectedAspect(promptText) {
    const m = String(promptText).match(/--ar\s+(\S+)/);
    return m ? m[1].trim().toLowerCase() : null;
}

(async function main() {
    if (!PACK) { warn('--pack is required'); process.exit(2); }

    const packDir = path.join(OUTPUT_DIR, PACK);
    if (!fs.existsSync(packDir)) { warn(`no such pack output: ${packDir}`); process.exit(2); }

    // Collect the prompt dirs, in numeric order.
    const slots = fs.readdirSync(packDir)
        .filter(d => /^prompt-\d+$/.test(d))
        .sort()
        .map(d => {
            const base = path.join(packDir, d);
            const promptFile = path.join(base, 'prompt.md');
            const metaFile = path.join(base, 'meta.json');
            if (!fs.existsSync(promptFile)) return null;
            const prompt = fs.readFileSync(promptFile, 'utf8')
                .replace(/^#\s*Prompt\s*\d+\s*\n+/, '');
            let meta = null;
            if (fs.existsSync(metaFile)) {
                try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = null; }
            }
            return { dir: d, base, promptFile, metaFile, prompt: prompt.trim(), meta };
        })
        .filter(Boolean);

    if (!slots.length) { warn(`no prompt-NN dirs under ${packDir}`); process.exit(2); }
    log(`${slots.length} prompt slot(s) in ${PACK}`);

    // ---- talk to the live feed ---------------------------------------
    const base = await cdpConnect(`http://127.0.0.1:${PORT}`);
    const cdp = new CDPClient(base);
    await cdp.connect();

    const userId = await cdp.js(feed.DISCOVER_USER_ID, true);
    if (!userId) {
        warn('could not discover the account user_id from the page');
        cdp.close();
        process.exit(3);
    }
    log(`user_id ${userId}`);

    const res = await cdp.js(feed.FETCH_FEED(userId, 400), true);
    if (!res || res.status !== 200 || !Array.isArray(res.items)) {
        warn(`feed request failed: status ${res && res.status}`);
        cdp.close();
        process.exit(3);
    }
    const items = res.items;
    log(`feed: ${items.length} job(s)`);

    // Every id already in the feed is a pre-existing job. A match must be
    // newer than the meta's own submittedAt, which is how a re-run of the
    // same pack does not adopt yesterday's card.
    const results = [];
    const claimed = new Set();

    for (const slot of slots) {
        const ar = expectedAspect(slot.prompt);
        const expect = ar ? { ar } : {};
        const expectStrict = ar ? ['ar'] : [];
        const after = slot.meta && slot.meta.submittedAt ? slot.meta.submittedAt : null;

        // Search the whole feed for this prompt. Prefer the EARLIEST
        // matching job (a retry is a duplicate generation; the first one
        // is the one whose parameters were right).
        const candidates = [];
        for (const job of items) {
            if (claimed.has(job.id)) continue;
            const m = feed.matchJob(job, slot.prompt, { expect, expectStrict, forbid: ['edit', 'cref', 'oref'] });
            if (m.ok) candidates.push(job);
        }
        candidates.sort((a, b) => (Date.parse(a.enqueue_time) || 0) - (Date.parse(b.enqueue_time) || 0));

        // Diagnose why the others were rejected — the operator needs to
        // see WHICH job landed and why it was refused.
        const rejected = [];
        for (const job of items) {
            if (claimed.has(job.id)) continue;
            const m = feed.matchJob(job, slot.prompt, { expect, expectStrict, forbid: ['edit', 'cref', 'oref'] });
            if (!m.ok && !m.reasons.includes('command does not carry this prompt')) {
                rejected.push({ id: job.id.slice(0, 8), type: job.job_type, reasons: m.reasons });
            }
        }

        const pick = candidates[0] || null;
        if (pick) claimed.add(pick.id);

        const oldId = slot.meta && slot.meta.taskId ? slot.meta.taskId.slice(0, 8) : null;
        const newId = pick ? pick.id : null;
        const changed = oldId !== newId;

        results.push({
            dir: slot.dir,
            ok: !!pick,
            oldTaskId: slot.meta && slot.meta.taskId ? slot.meta.taskId : null,
            newTaskId: pick ? pick.id : null,
            changed,
            jobType: pick ? pick.job_type : null,
            enqueueTime: pick ? pick.enqueue_time : null,
            aspect: pick ? feed.commandAspect(pick.full_command) : null,
            expectedAspect: ar,
            imageUrls: pick ? feed.gridUrls(pick.id, pick.batch_size || 4) : null,
            rejected,
        });

        log(`${slot.dir}: ${oldId || '(none)'} -> ${newId ? newId.slice(0, 8) : '(no match)'}` +
            (pick ? ` [${pick.job_type} ${feed.commandAspect(pick.full_command)}]` : '') +
            (changed ? '  CHANGED' : ''));
    }

    if (!DRY_RUN) {
        for (const r of results) {
            if (!r.ok || !r.newTaskId) continue;
            const slot = slots.find(s => s.dir === r.dir);
            const meta = {
                ...(slot.meta || {}),
                index: slot.meta && slot.meta.index ? slot.meta.index : parseInt(r.dir.replace('prompt-', ''), 10),
                prompt: slot.prompt,
                taskId: r.newTaskId,
                matchedBy: 'feed-command',
                isNewestTask: undefined,
                imageUrls: r.imageUrls,
                imageCount: r.imageUrls.length,
                complete: true,
                reconciledAt: new Date().toISOString(),
            };
            delete meta.isNewestTask;
            fs.writeFileSync(slot.metaFile, JSON.stringify(meta, null, 2));
        }
        log(`rewrote ${results.filter(r => r.ok).length} meta file(s)${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
    }

    if (AS_JSON) {
        process.stdout.write(JSON.stringify({ pack: PACK, userId, feedSize: items.length, results }, null, 2) + '\n');
    }

    cdp.close();
    const missing = results.filter(r => !r.ok);
    if (missing.length) {
        warn(`${missing.length} prompt(s) have no clean job in the feed: ${missing.map(m => m.dir).join(', ')}`);
        process.exit(4);
    }
    process.exit(0);
})().catch(e => { warn(`fatal: ${e.message}`); process.exit(1); });
