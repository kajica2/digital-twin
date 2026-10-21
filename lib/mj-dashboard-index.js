#!/usr/bin/env node
// Build the data behind pages/midjourney-dashboard.html.
//
// The twin's Midjourney history lives in mj-output/<pack>/prompt-NN/meta.json:
// one file per generation, holding the prompt, the MJ task id, the timestamp
// and the CDN URLs of the 4-up grid.
//
// The CDN URLs are the record of the images. cdn.midjourney.com serves them
// to a real browser (verified 2026-10-21: 640x358 and 1141x640 pixels), but
// it answers curl and headless clients with a Cloudflare bot challenge
// (HTTP 403). The index therefore ships the REAL urls and the page degrades
// honestly to a labelled tile when a client is challenged.
//
// Writes data/mj/index.json. Run: node lib/mj-dashboard-index.js
//
// The pure helpers below are exported so lib/mj-dashboard-index.test.js can
// cover them without the 469-generation corpus being present.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractPrompts } = require('./mj-submitter.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'mj', 'index.json');
const MJ_OUT = path.join(ROOT, 'mj-output');
const PROMPT_DIR = path.join(ROOT, 'assets', 'mural-prompts');

// Prompt text is published as-is up to this length. The longest prompt in
// the corpus is 1026 chars, so nothing is truncated today; if a longer one
// ever lands it is truncated AND the fact is recorded in the index
// (totals.promptsTruncated) rather than silently cut.
const MAX_PROMPT = 2000;

// Documentation files that live in the prompt pack directory. They are NOT
// prompt packs: they describe the format and the style registry. Counting
// them inflates the headline by their example bullets, so they are excluded
// by name — an explicit list, not a fuzzy heuristic.
const DOC_PROMPT_FILES = new Set([
    'PROMPT-EXPANSION-FORMAT.md',  // the file-format specification
    'STYLE-PRESETS.md',            // the style registry
]);

const walk = (dir, out = []) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
};

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');

// ---------- pure helpers (exported — unit-tested) ----------

// True for a documentation file that must not be counted as a prompt pack.
function isDocPromptFile(fileName) {
    return DOC_PROMPT_FILES.has(path.basename(fileName));
}

// Redact external urls from PUBLISHED prompt text.
//
// The published prompts carry the artist's face-reference photo urls (the
// `--cref https://d.uguu.se/…` uploads) — private images that must not be
// published. The flag name is kept so the prompt still reads correctly:
//   `--cref https://d.uguu.se/x.jpg`  ->  `--cref [redacted-url]`
//
// This only ever touches the free-text prompt. The imageUrls array keeps its
// cdn.midjourney.com urls — those are what the page renders.
function redactExternalUrls(text) {
    if (!text) return text;
    return String(text).replace(/https?:\/\/[^\s]+/g, (match) => {
        // Keep trailing sentence punctuation out of the redacted token.
        const trail = match.match(/[.,;:!?)\]]+$/);
        const core = trail ? match.slice(0, match.length - trail[0].length) : match;
        return '[redacted-url]' + (trail ? trail[0] : '');
    });
}

// Derive the 4-up grid from the raw imageUrls array.
//
// meta.json stores every url the CDN handed back, which is not always the
// 4-up grid: some generations carry 8 urls (the grid at 640 AND at 384),
// some carry an upscale (.jpeg) next to the grid, some carry a 128px
// preview. The grid is the four slots 0..3, one url each, at the highest
// resolution available for that slot.
//
// Filename shapes:
//   `<job>_<slot>_<size>_N.webp`  -> slot + size
//   `<job>_<slot>.jpeg`            -> slot, full resolution
function deriveGridUrls(urls) {
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
    const bySlot = new Map();
    const unparsed = [];
    for (const url of list) {
        let file = url;
        try { file = new URL(url).pathname.split('/').filter(Boolean).pop() || url; }
        catch { /* not a url — treat the raw string as the filename */ }
        let m = /^(\d+)_(\d+)_(\d+)_N\.\w+$/.exec(file);
        if (m) {
            const slot = Number(m[2]);
            const size = Number(m[3]);
            const prev = bySlot.get(slot);
            if (!prev || size > prev.size) bySlot.set(slot, { url, size });
            continue;
        }
        m = /^(\d+)_(\d+)\.(jpe?g|png|webp)$/i.exec(file);
        if (m) {
            const slot = Number(m[2]);
            const prev = bySlot.get(slot);
            if (!prev) bySlot.set(slot, { url, size: 4096 });
            continue;
        }
        unparsed.push(url);
    }
    const grid = [...bySlot.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v.url);
    // Urls whose filename carries no slot are kept at the end, in order.
    return grid.concat(unparsed);
}

// Keep only the files that are tracked in the commit. `git ls-tree -r HEAD`
// is the set GitHub Pages actually serves: `git ls-files` would also list
// staged-but-uncommitted files, which do not exist on the deployed site.
function filterTracked(relPaths, tracked) {
    return relPaths.filter((p) => tracked.has(p));
}

// Loud failure guard: an index with no tracked files would be an empty
// dashboard published to the world. Fail instead of writing it.
function assertTrackedSet(tracked) {
    if (!tracked || tracked.size === 0) {
        throw new Error(
            'mj-dashboard-index: no tracked files found (git ls-tree -r HEAD returned nothing). ' +
            'Refusing to write an index with zero images.');
    }
    return tracked;
}

// Count the prompts in a pack with the SUBMITTER's parser. extractPrompts
// is the single source of truth for what a prompt is — the dashboard used
// to keep its own counter, which disagreed by 2. The --ar values come from
// the parsed prompts too, never from a regex over the raw file (which used
// to pick up the format doc's examples and produce garbage like
// "16:9 16:9 <value> 16:9").
function countPackPrompts(filePath) {
    const parsed = extractPrompts(filePath);
    const ars = [...new Set(parsed.map((p) => p.ar).filter(Boolean))];
    return { prompts: parsed.length, ars, parsed };
}

// Build the prompt library from parsed packs.
//
// `entries` is [{ file, name, prompts: <count>, ar: <string|null> }] — the
// parsed summary of each pack. `tracked` is the set of tracked repo-relative
// paths.
//
// Excluded packs are REPORTED, never silently dropped: documentation files,
// untracked files (they would 404 on Pages) and empty packs each carry a
// reason.
function buildPromptLibrary(entries, tracked) {
    const library = [];
    const excluded = [];
    for (const entry of entries) {
        const name = path.basename(entry.file);
        if (isDocPromptFile(name)) {
            excluded.push({ file: entry.file, reason: 'documentation, not a prompt pack' });
            continue;
        }
        if (!tracked.has(entry.file)) {
            excluded.push({ file: entry.file, reason: 'not tracked in HEAD — would 404 on the deployed site' });
            continue;
        }
        if (!entry.prompts) {
            excluded.push({ file: entry.file, reason: 'no prompts found' });
            continue;
        }
        library.push({
            file: entry.file,
            name: entry.name || name,
            prompts: entry.prompts,
            ar: entry.ar || null,
        });
    }
    library.sort((a, b) => b.prompts - a.prompts || (a.file < b.file ? -1 : 1));
    return { library, excluded };
}

// ---------- git state ----------

// The tracked set: what the commit contains, and therefore what the
// deployed site serves.
function readTrackedFiles() {
    const out = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
        cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    });
    return new Set(out.split('\n').filter(Boolean));
}

// Files that exist on disk but are NOT in the commit, split into the ones
// git ignores and the ones that are merely untracked (never committed).
function readUntrackedFiles() {
    const ignored = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], {
        cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    });
    const plain = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    });
    return {
        ignored: new Set(ignored.split('\n').filter(Boolean)),
        untracked: new Set(plain.split('\n').filter(Boolean)),
    };
}

// ---------- generations ----------

function readGenerations() {
    const generations = [];
    for (const file of walk(MJ_OUT)) {
        if (path.basename(file) !== 'meta.json') continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        const dir = path.dirname(file);
        const pack = path.relative(MJ_OUT, dir).split(path.sep)[0];
        const rawPrompt = d.prompt || '';
        const prompt = redactExternalUrls(rawPrompt);
        const imageUrls = Array.isArray(d.imageUrls) ? d.imageUrls : [];
        const gridUrls = deriveGridUrls(imageUrls);
        generations.push({
            pack,
            index: typeof d.index === 'number' ? d.index : 0,
            prompt: trim(prompt, MAX_PROMPT),
            promptTruncated: prompt.length > MAX_PROMPT,
            promptBytes: prompt.length,
            taskId: d.taskId || null,
            submittedAt: d.submittedAt || null,
            imageCount: d.imageCount || imageUrls.length,
            // The distinct pictures in the 4-up. `imageCount` is the raw
            // number of CDN urls, which counts the 640 and the 384 copy of
            // the same frame twice — the grid count is what a viewer sees.
            gridCount: gridUrls.length,
            imageUrls,
            gridUrls,
            thumbUrl: gridUrls[0] || null,
            matchedBy: d.matchedBy || null,
            isNewestTask: d.isNewestTask === true,
            repaired: !!(d.repairedAt || d.repairedNote || d.repairNote),
            dir: rel(dir),
        });
    }
    generations.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : a.index - b.index));
    return generations;
}

// ---------- pack rollup ----------

function rollupPacks(generations) {
    const packMap = new Map();
    for (const g of generations) {
        const p = packMap.get(g.pack) || { pack: g.pack, count: 0, tasks: new Set(), images: 0, first: null, last: null, repaired: 0 };
        p.count++;
        p.tasks.add(g.taskId);
        p.images += g.imageCount;
        if (g.repaired) p.repaired++;
        const t = g.submittedAt ? Date.parse(g.submittedAt) : NaN;
        if (!Number.isNaN(t)) {
            if (p.first === null || t < Date.parse(p.first)) p.first = g.submittedAt;
            if (p.last === null || t > Date.parse(p.last)) p.last = g.submittedAt;
        }
        packMap.set(g.pack, p);
    }
    return [...packMap.values()].map((p) => ({
        pack: p.pack, count: p.count, tasks: p.tasks.size, images: p.images,
        repaired: p.repaired, first: p.first, last: p.last,
    })).sort((a, b) => b.count - a.count || (a.pack < b.pack ? -1 : 1));
}

// ---------- local artifacts ----------

// The images that survive on disk: local FLUX renders from the same prompt
// lineage, plus the shipped marketplace art.
//
// Only TRACKED files are rendered as <img>. assets/flux2/ is gitignored, so
// rendering every local file would mean hundreds of 404s on the deployed
// page — and the page's contract is zero console errors. Untracked files are
// counted and reported instead.
const ART_ROOTS = ['assets/flux2', 'data/flux', 'assets/marketplace'];
const IMG = /\.(png|jpe?g|webp|gif)$/i;

function readArtifacts(tracked, untracked) {
    const artifacts = [];
    const untrackedByRoot = {};
    const untrackedIgnored = [];
    const untrackedNotIgnored = [];
    for (const root of ART_ROOTS) {
        const onDisk = walk(path.join(ROOT, root)).filter((f) => IMG.test(f));
        const relPaths = onDisk.map(rel);
        // The tracked set decides what the deployed site can serve.
        const trackedHere = new Set(filterTracked(relPaths, tracked));
        for (const file of onDisk) {
            const r = rel(file);
            if (!trackedHere.has(r)) {
                untrackedByRoot[root] = (untrackedByRoot[root] || 0) + 1;
                if (untracked.ignored.has(r)) untrackedIgnored.push(r);
                else untrackedNotIgnored.push(r);
                continue;
            }
            let size; try { size = fs.statSync(file).size; } catch { continue; }
            artifacts.push({ file: r, root, bytes: size, group: path.dirname(r).split(path.sep).slice(0, 3).join('/') });
        }
    }
    artifacts.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : a.file < b.file ? -1 : 1));
    return {
        artifacts,
        untrackedByRoot,
        untrackedIgnored: untrackedIgnored.length,
        untrackedNotIgnored: untrackedNotIgnored.length,
    };
}

// ---------- main ----------

function main() {
    const tracked = assertTrackedSet(readTrackedFiles());
    const untracked = readUntrackedFiles();

    const generations = readGenerations();
    const packs = rollupPacks(generations);

    // --- prompt library ---
    const packEntries = [];
    for (const file of walk(PROMPT_DIR)) {
        if (!file.endsWith('.md')) continue;
        const r = rel(file);
        const text = fs.readFileSync(file, 'utf8');
        const title = (text.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file, '.md');
        let summary = { prompts: 0, ars: [] };
        if (!isDocPromptFile(file)) {
            try { summary = countPackPrompts(file); } catch { summary = { prompts: 0, ars: [] }; }
        }
        packEntries.push({
            file: r, name: title,
            prompts: summary.prompts,
            ar: summary.ars.length ? summary.ars.join(' ') : null,
        });
    }
    const { library, excluded } = buildPromptLibrary(packEntries, tracked);

    const art = readArtifacts(tracked, untracked);

    // --- totals ---
    const taskIds = new Set(generations.map((g) => g.taskId).filter(Boolean));
    // The distinct pictures, not the raw url count — the 640 and the 384
    // copy of a frame are the same picture.
    const totalImages = generations.reduce((s, g) => s + g.gridCount, 0);
    const totalUrls = generations.reduce((s, g) => s + g.imageCount, 0);
    const dates = generations.map((g) => g.submittedAt).filter(Boolean).sort();
    const untrackedTotal = Object.values(art.untrackedByRoot).reduce((s, n) => s + n, 0);

    const index = {
        schema: 'mj-dashboard-index/v2',
        generated: new Date().toISOString().slice(0, 10),
        totals: {
            generations: generations.length,
            packs: packs.length,
            distinctTasks: taskIds.size,
            images: totalImages,
            imageUrls: totalUrls,
            promptPacks: library.length,
            promptLines: library.reduce((s, p) => s + p.prompts, 0),
            promptsTruncated: generations.filter((g) => g.promptTruncated).length,
            localImages: art.artifacts.length,
            localBytes: art.artifacts.reduce((s, a) => s + a.bytes, 0),
            untrackedImages: untrackedTotal,
            untrackedIgnored: art.untrackedIgnored,
            untrackedNotIgnored: art.untrackedNotIgnored,
            repaired: generations.filter((g) => g.repaired).length,
        },
        range: { first: dates[0] || null, last: dates[dates.length - 1] || null },
        cdn: {
            reachable: true,
            note: 'cdn.midjourney.com serves the 4-up grids to a real browser (verified 2026-10-21: 640x358 and 1141x640 pixels). It answers curl and headless clients with a Cloudflare bot challenge (HTTP 403), so a non-browser client may not resolve an image.',
        },
        packs,
        generations,
        promptFiles: library,
        promptExcluded: excluded,
        artifacts: art.artifacts,
        untrackedByRoot: art.untrackedByRoot,
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(index));

    // --- summary ---
    console.log(`mj-dashboard-index: ${index.totals.generations} generations, ` +
        `${index.totals.packs} packs, ${index.totals.distinctTasks} tasks, ` +
        `${index.totals.images} images`);
    console.log(`  cdn            : reachable in a browser, Cloudflare-challenged for curl/headless`);
    console.log(`  prompt library : ${index.totals.promptPacks} packs / ${index.totals.promptLines} prompts` +
        ` (counter: lib/mj-submitter.js extractPrompts)`);
    for (const ex of excluded) {
        console.log(`    excluded     : ${ex.file} — ${ex.reason}`);
    }
    console.log(`  prompt text    : ${index.totals.promptsTruncated} of ${index.totals.generations} truncated` +
        ` (cap ${MAX_PROMPT} chars), external urls redacted`);
    console.log(`  local artifacts: ${index.totals.localImages} tracked images (${(index.totals.localBytes / 1048576).toFixed(1)} MB)` +
        `, ${index.totals.untrackedImages} unpublished (${index.totals.untrackedIgnored} gitignored,` +
        ` ${index.totals.untrackedNotIgnored} untracked)`);
    console.log(`  range          : ${index.range.first || '—'} -> ${index.range.last || '—'}`);
    console.log(`  -> ${rel(OUT)}`);
}

module.exports = {
    DOC_PROMPT_FILES,
    MAX_PROMPT,
    isDocPromptFile,
    redactExternalUrls,
    deriveGridUrls,
    filterTracked,
    assertTrackedSet,
    countPackPrompts,
    buildPromptLibrary,
    readTrackedFiles,
    readUntrackedFiles,
    readGenerations,
    rollupPacks,
    readArtifacts,
    main,
};

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
