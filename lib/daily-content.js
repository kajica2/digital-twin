#!/usr/bin/env node
'use strict';

// lib/daily-content.js
//
// The daily content run: one collection a day, rendered on Midjourney,
// published as marketplace plates.
//
//   daily-content/<date>/<collection>.md      the prompt pack (work product)
//   daily-content/<date>/<collection>/         mj-web's output + the download
//   assets/marketplace/daily/<date>/           the published bundle
//   assets/marketplace/daily/index.json        the catalogue the page reads
//
// The run is:
//   1. pick a collection from lib/daily-collections.json (deterministic:
//      day-of-year, so the same date always carries the same collection)
//   2. write its prompts as an MJ pack (the format the submitter parses)
//   3. submit them on Midjourney through lib/mj-web.js — the same
//      submitter the watcher uses, so the acceptance evidence and the
//      prompt composition are identical
//   4. download the accepted job's grid cell through a real browser (the
//      CDN answers curl and headless clients with 403) and convert it to
//      the marketplace's JPG
//   5. publish the bundle plus the catalogue index
//   6. commit and push it (--no-publish to stop at step 5)
//
// Nothing here invents copy: the caption, the alt text and the prompt
// all come from the library, so the page can never drift from the art.
//
// Pure Node, no deps beyond the repo's own puppeteer.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { slugify } = require('./mj-submitter.js');
const { imageSize } = require('./image-size.js');

const REPO = path.resolve(__dirname, '..');
const LIBRARY_PATH = path.join(__dirname, 'daily-collections.json');
const COLLECTIONS_DIR = path.join(REPO, 'assets', 'marketplace', 'daily');
const INDEX_PATH = path.join(COLLECTIONS_DIR, 'index.json');
const WORK_ROOT = path.join(REPO, 'daily-content');
const PROFILE_LOCAL = path.join(__dirname, 'mj-profile.local.json');

// The paths a publish is allowed to touch. The guard refuses to commit
// anything else — a daily job that swallows a colleague's uncommitted
// work is worse than a daily job that does nothing.
const PUBLISH_ALLOW = ['assets/marketplace/daily/'];

const AR = '16:9';
const MAX_WIDTH = 1280;

function log(msg) { process.stdout.write(`[daily-content] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[daily-content] ${msg}\n`); }
function fail(msg, code = 1) {
    process.stderr.write(`[daily-content] ERROR: ${msg}\n`);
    process.exit(code);
}

// -------------------- pure helpers (unit-testable) --------------------

/** 'YYYY-MM-DD' in local time. */
function formatDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Day of year, 1..366. */
function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
}

/** Parse 'YYYY-MM-DD' (local time). Returns null when malformed. */
function parseLocalDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
    return d;
}

/**
 * The collection for a date: deterministic by day-of-year, unless the
 * caller names one. The cycle wraps, so a year of daily runs keeps
 * producing content without the library having to be endless.
 */
function pickCollection(library, date, overrideId) {
    const list = (library && library.collections) || [];
    if (!list.length) return null;
    if (overrideId) {
        const found = list.find(c => c.id === overrideId);
        if (!found) return null;
        return found;
    }
    const idx = (dayOfYear(date) - 1) % list.length;
    return list[idx];
}

/**
 * The MJ pack for a collection: one top-level bullet per plate, each
 * ending in --ar. Conforms to PROMPT-EXPANSION-FORMAT.md, so the
 * submitter parses it with the same extractor the watcher uses.
 *
 * `profileCodes` are appended to every prompt but are NOT stored in the
 * library: they are the account's own style identifiers, and the library
 * is tracked.
 */
function buildPromptPack(collection, count, ar = AR, profileCodes = []) {
    const plates = (collection.plates || []).slice(0, Math.max(1, count));
    const tail = profileCodes && profileCodes.length ? ` --profile ${profileCodes.join(' ')}` : '';
    const prompts = plates.map(p => {
        const base = String(p.prompt || '').trim().replace(/\s+--ar\s+\S+$/i, '');
        return `${base}${tail} --ar ${ar}`;
    });
    const lines = [
        `# ${collection.title} — daily collection`,
        '',
        `Collection: ${collection.id}`,
        `Badge: ${collection.badge}`,
        '',
    ];
    for (const t of prompts) lines.push(`- ${t}`);
    lines.push('');
    return { markdown: lines.join('\n'), prompts, plates };
}

/** The published file name for the n-th plate (1-based). */
function plateFileName(index) {
    return `frame-${String(index).padStart(2, '0')}.jpg`;
}

/**
 * One catalogue entry for a published collection. The page reads this
 * and nothing else, so the entry carries the display copy AND the
 * provenance (prompt, task id, dimensions) that makes it checkable.
 */
function buildEntry({ date, collection, plates, aspect = AR }) {
    return {
        date,
        id: collection.id,
        title: collection.title,
        badge: collection.badge,
        teaser: collection.teaser,
        aspect,
        dir: `assets/marketplace/daily/${date}`,
        plates: plates.map((p, i) => ({
            file: plateFileName(i + 1),
            caption: p.caption,
            alt: p.alt,
            prompt: p.prompt,
            taskId: p.taskId,
            width: p.width,
            height: p.height,
        })),
    };
}

/** Newest first, capped at `max` collections. */
function updateIndex(index, entry, max = 30) {
    const base = (index && typeof index === 'object' && !Array.isArray(index)) ? index : {};
    const list = Array.isArray(base.collections) ? base.collections.slice() : [];
    const without = list.filter(c => c.date !== entry.date);
    without.unshift(entry);
    return {
        updatedAt: new Date().toISOString(),
        count: without.length,
        collections: without.slice(0, max),
    };
}

/**
 * The paths in a `git status --porcelain` output that a publish must NOT
 * touch. Pure: it takes the porcelain text, so the guard is testable
 * without a repository.
 *
 * Only the INDEX matters. The publish stages an explicit file list and
 * commits it, so what lands in the commit is (1) its own files plus
 * (2) anything somebody else had already staged. Unstaged work (' M')
 * and untracked files ('??') cannot be swallowed by a scoped `git add --`
 * and are not the job's business. A staged change ('M ', 'A ', ...) is
 * somebody else's commit waiting to happen — that is the case to refuse.
 */
function offendingPaths(porcelain, allow = PUBLISH_ALLOW) {
    const out = [];
    for (const line of String(porcelain || '').split('\n')) {
        if (!line.trim()) continue;
        // Porcelain v1: "XY <path>" — X is the index status, Y the worktree.
        const staged = line[0];
        if (staged === ' ' || staged === '?') continue;   // unstaged / untracked
        const p = line.slice(3).trim();
        if (!p) continue;
        const clean = p.replace(/^"|"$/g, '');
        if (!allow.some(prefix => clean === prefix.replace(/\/$/, '') || clean.startsWith(prefix))) {
            out.push(clean);
        }
    }
    return out;
}

// -------------------- the run --------------------

function loadLibrary() {
    if (!fs.existsSync(LIBRARY_PATH)) fail(`library not found: ${LIBRARY_PATH}`);
    return JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
}

/** The account's style codes, if a local (gitignored) config has them. */
function profileCodes(explicit) {
    if (explicit) return String(explicit).trim().split(/\s+/).filter(Boolean);
    if (fs.existsSync(PROFILE_LOCAL)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(PROFILE_LOCAL, 'utf8'));
            const codes = (cfg && cfg.profileCodes) || [];
            return Array.isArray(codes) ? codes.map(String).filter(Boolean) : [];
        } catch { return []; }
    }
    return [];
}

function gitStatus(repo) {
    try {
        return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    } catch { return ''; }
}

/** Commit and push the published bundle. Refuses to touch other work. */
function publish(entry, repo = REPO) {
    const porcelain = gitStatus(repo);
    const offending = offendingPaths(porcelain);
    if (offending.length) {
        warn(`refusing to publish — ${offending.length} change(s) outside the allowlist:`);
        for (const o of offending.slice(0, 10)) warn(`  ${o}`);
        return false;
    }
    const files = ['assets/marketplace/daily/index.json'];
    for (const p of entry.plates) files.push(`${entry.dir}/${p.file}`);
    files.push(`${entry.dir}/plates.json`);
    files.push(`${entry.dir}/collection.json`);
    const add = spawnSync('git', ['add', '--', ...files], { cwd: repo, encoding: 'utf8' });
    if (add.status !== 0) {
        warn(`git add failed: ${(add.stderr || '').trim()}`);
        return false;
    }
    const msg = `content(daily): ${entry.title} — ${entry.date}\n\n` +
        `${entry.plates.length} plate(s) rendered on Midjourney and published to ${entry.dir}.\n` +
        `Collection: ${entry.id} (${entry.badge}).`;
    const commit = spawnSync('git', ['-c', 'user.name=Kajica Djuric', '-c', 'user.email=kai.djuric@gmail.com',
        'commit', '-m', msg], { cwd: repo, encoding: 'utf8' });
    if (commit.status !== 0) {
        warn(`git commit failed: ${(commit.stdout || '') + (commit.stderr || '')}`.trim());
        return false;
    }
    log((commit.stdout || '').trim().split('\n')[0]);
    const push = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    if (push.status !== 0) {
        warn(`git push failed: ${(push.stderr || '').trim()}`);
        return false;
    }
    log('pushed');
    return true;
}

/** Submit the pack through the repo's own MJ web submitter. */
function submit(packPath, outputDir, extraArgs = []) {
    const cmd = [path.join(REPO, 'lib', 'mj-web.js'),
        '--prompt-file', packPath, '--all-prompts', '--output', outputDir, ...extraArgs];
    log(`submitting ${path.basename(packPath)} on Midjourney …`);
    const res = spawnSync(process.execPath, cmd, { cwd: REPO, stdio: 'inherit' });
    if (res.status !== 0) fail(`mj-web exited with ${res.status}`);
}

/** Image dimensions, read from the image header (lib/image-size.js). */

/**
 * Download the grid cell through a real browser. The CDN answers curl
 * and headless clients with 403, so a headed browser is the only way in
 * — the same reason the contact sheet saves its tiles locally.
 */
async function downloadCells(urls, outDir, slot = 0) {
    const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer'));
    const cfgPath = path.join(REPO, 'lib', 'mj-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const browser = await puppeteer.launch({
        headless: false,
        executablePath: cfg.paths && (cfg.paths.webBrowserBin || cfg.paths.chromeBin),
        args: ['--no-first-run', '--hide-scrollbars'],
    });
    try {
        const page = await browser.newPage();
        await page.goto('https://www.midjourney.com/imagine', { waitUntil: 'domcontentloaded', timeout: 45000 })
            .catch(() => {});
        const html = urls.map((u, i) => `<img id="i${i}" src="${u}">`).join('');
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const imgs = [...document.querySelectorAll('img')];
            return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
        }, { timeout: 60000 });
        const b64 = await page.evaluate(async (idx) => {
            const img = document.getElementById(`i${idx}`);
            if (!img) return null;
            const blob = await fetch(img.src).then(r => r.blob());
            return await new Promise(res => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.readAsDataURL(blob);
            });
        }, slot);
        if (!b64) return null;
        const buf = Buffer.from(b64.split(',')[1], 'base64');
        const out = path.join(outDir, 'image.webp');
        fs.writeFileSync(out, buf);
        return out;
    } finally {
        await browser.close();
    }
}

/** webp → JPG at the marketplace's quality, downscaled to fit. */
function toJpg(webpPath, jpgPath) {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', webpPath, '--out', jpgPath],
        { stdio: 'ignore' });
    let size = imageSize(jpgPath);
    if (size && size.width > MAX_WIDTH) {
        execFileSync('sips', ['-Z', String(MAX_WIDTH), jpgPath], { stdio: 'ignore' });
        size = imageSize(jpgPath);
    }
    return size;
}

// -------------------- CLI --------------------

function argVal(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    // --no-publish: stop after the renders (nothing written, nothing pushed).
    // --no-git: write the bundle and the catalogue, but do not commit.
    const noPublish = process.argv.includes('--no-publish');
    const noGit = process.argv.includes('--no-git');
    const dateStr = argVal('--date', formatDate(new Date()));
    const date = parseLocalDate(dateStr);
    if (!date) fail(`bad --date: ${dateStr} (expected YYYY-MM-DD)`);
    const iso = formatDate(date);
    const count = Number(argVal('--count', '3'));
    const slot = Number(argVal('--slot', '0'));
    const codes = profileCodes(argVal('--profile-codes'));
    // The daily run gets its OWN browser port and profile. The shared
    // session on 9444 belongs to the watcher and to whatever is driving
    // it by hand; a calendar job that types into a shared composer is a
    // collision waiting for a night.
    const port = argVal('--port', '9445');
    const profile = argVal('--profile', '/tmp/mj-daily-profile');

    const library = loadLibrary();
    const collection = pickCollection(library, date, argVal('--collection'));
    if (!collection) fail(`no collection for ${iso} (use --collection <id>)`);
    const { markdown, prompts, plates } = buildPromptPack(collection, count, library.aspect || AR, codes);

    const workDir = path.join(WORK_ROOT, iso);
    fs.mkdirSync(workDir, { recursive: true });
    const packName = `${collection.id}-${iso}.md`;
    const packPath = path.join(workDir, packName);
    fs.writeFileSync(packPath, markdown);
    log(`collection ${collection.id} — ${collection.title} (${collection.badge})`);
    log(`pack: ${packPath}`);
    for (const p of prompts) log(`  · ${p}`);

    if (dryRun) {
        log('dry run — nothing submitted, nothing published');
        return 0;
    }

    // A calendar job must not re-render a day it already published —
    // that is how a daily run quietly burns a quota.
    const bundleDir = path.join(COLLECTIONS_DIR, iso);
    const bundleManifest = path.join(bundleDir, 'plates.json');
    if (fs.existsSync(bundleManifest) && !process.argv.includes('--force')) {
        log(`${iso} is already published (${bundleDir}) — nothing to render (--force to re-render)`);
        // The plates exist; the reels may not. A run that died after the
        // publish left the day's reels unqueued, and the hand-off is
        // free (no quota, no Midjourney) — so it still runs.
        if (!process.argv.includes('--no-reels')) {
            try {
                const { queueDay } = require('./daily-reels.js');
                const result = queueDay(iso);
                if (result) {
                    const made = result.queued.filter(r => !r.skipped).length;
                    log(`${made} reel(s) queued for ${iso}${made ? '' : ' (already done)'}`);
                }
            } catch (e) {
                warn(`reel hand-off failed: ${e && e.message ? e.message : e}`);
            }
        }
        return 0;
    }

    // 1. submit. --resume keeps the prompts that already have a done
    // marker, so a run that died half way does not pay for the same
    // generation twice.
    const resume = process.argv.includes('--resume');
    submit(packPath, workDir, ['--port', port, '--user-data-dir', profile,
        ...(resume ? ['--skip-done'] : [])]);

    // 2. collect the accepted jobs
    // mj-web names its output directory after the pack's slugified name
    // (dashes become underscores), so the collector has to look in the
    // same place the submitter wrote.
    const outDir = path.join(workDir, slugify(path.basename(packName, '.md')));
    const collected = [];
    for (let i = 0; i < plates.length; i++) {
        const dir = path.join(outDir, `prompt-${String(i + 1).padStart(2, '0')}`);
        const metaPath = path.join(dir, 'meta.json');
        if (!fs.existsSync(metaPath)) { warn(`no meta for prompt ${i + 1} — skipped`); continue; }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const urls = meta.imageUrls || [];
        if (!urls.length) { warn(`no image urls for prompt ${i + 1} — skipped`); continue; }
        // Prefer the largest cell the CDN serves; fall back down the sizes.
        const candidates = [];
        for (const u of urls.slice(0, 4)) {
            candidates.push(u.replace(/_640_/, '_2048_'));
            candidates.push(u.replace(/_640_/, '_1280_'));
            candidates.push(u);
        }
        let saved = null;
        for (const c of candidates) {
            saved = await downloadCells([c], dir, 0);
            if (saved) break;
        }
        if (!saved) { warn(`could not download prompt ${i + 1}`); continue; }
        const jpg = path.join(dir, 'image.jpg');
        const size = toJpg(saved, jpg);
        collected.push({
            plate: plates[i],
            meta,
            jpg,
            width: size ? size.width : null,
            height: size ? size.height : null,
        });
        log(`plate ${i + 1}: ${meta.taskId} -> ${size ? `${size.width}x${size.height}` : '?'}`);
    }
    if (!collected.length) fail('nothing was rendered — nothing published');

    // 3. publish the bundle
    if (noPublish) {
        log(`trial run — ${collected.length} plate(s) rendered, nothing written`);
        for (const c of collected) log(`  ${c.plate.caption}: ${c.meta.taskId} ${c.width}x${c.height}`);
        return 0;
    }
    fs.mkdirSync(bundleDir, { recursive: true });
    const published = [];
    for (let i = 0; i < collected.length; i++) {
        const c = collected[i];
        const file = plateFileName(i + 1);
        fs.copyFileSync(c.jpg, path.join(bundleDir, file));
        published.push({
            file,
            caption: c.plate.caption,
            alt: c.plate.alt,
            prompt: c.plate.prompt,
            taskId: c.meta.taskId,
            width: c.width,
            height: c.height,
        });
    }
    const entry = buildEntry({ date: iso, collection, plates: published });
    const platesDoc = {
        pack: collection.id,
        date: iso,
        title: collection.title,
        badge: collection.badge,
        teaser: collection.teaser,
        aspect: library.aspect || AR,
        source: 'midjourney',
        plates: published,
    };
    fs.writeFileSync(path.join(bundleDir, 'plates.json'), JSON.stringify(platesDoc, null, 2));
    fs.writeFileSync(path.join(bundleDir, 'collection.json'), JSON.stringify({
        id: collection.id, date: iso, title: collection.title, badge: collection.badge,
        teaser: collection.teaser, aspect: library.aspect || AR, source: 'midjourney',
        plates: published.map(p => p.file),
    }, null, 2));

    let index = { updatedAt: null, count: 0, collections: [] };
    if (fs.existsSync(INDEX_PATH)) {
        try { index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { /* rebuild */ }
    }
    const next = updateIndex(index, entry);
    fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
    fs.writeFileSync(INDEX_PATH, JSON.stringify(next, null, 2));
    log(`published ${published.length} plate(s) -> ${bundleDir}`);

    if (!noGit) publish(entry);

    // 5. hand the plates to the reel pipeline. The daily run's job is
    // to make content; a plate that cannot be posted is only half a
    // delivery. The reels are built from the ALREADY published plates,
    // so this costs no Midjourney quota — and the reel-inbox is
    // gitignored working state, so it must come AFTER the publish.
    if (!process.argv.includes('--no-reels')) {
        try {
            const { queueDay } = require('./daily-reels.js');
            const result = queueDay(iso);
            if (result) log(`${result.queued.length} reel(s) queued for ${iso}`);
        } catch (e) {
            // A missing ffmpeg must not undo a published day.
            warn(`reel hand-off failed: ${e && e.message ? e.message : e}`);
        }
    }
    return 0;
}

if (require.main === module) {
    main().then(code => process.exit(code)).catch((e) => {
        warn(e && e.stack ? e.stack : String(e));
        process.exit(1);
    });
}

module.exports = {
    formatDate, dayOfYear, parseLocalDate, pickCollection, buildPromptPack,
    plateFileName, buildEntry, updateIndex, offendingPaths, profileCodes,
    PUBLISH_ALLOW,
};
