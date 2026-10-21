#!/usr/bin/env node
'use strict';
// lib/mj-contact-sheet.js
//
// Build a 12-up comparison contact sheet from a Midjourney pack's outputs.
//
// WHY A BROWSER AND NOT `curl`
//
// The MJ CDN (cdn.midjourney.com) answers curl and headless clients with
// a Cloudflare bot challenge (HTTP 403) — verified 2026-10-21. A real
// browser gets the pixels. So this script drives Chrome (headed, the same
// constraint the web backend honours) and renders the sheet as HTML, then
// screenshots it.
//
// The sheet tiles are THUMBNAILS of each variant's first grid image, with
// a caption carrying the variant's distinctive clause — the comparison the
// pack was built for.
//
// Usage:
//   node lib/mj-contact-sheet.js --pack <name> [--out <file.png>]
//        [--cols 4] [--rows 3] [--thumb 480] [--slot 0]
//
//   --pack   directory name under mj-output/ (the pack's slug)
//   --out    output PNG (default mj-output/<pack>/contact-sheet.png)
//   --cols/--rows  grid shape (default 4x3 = 12 up)
//   --thumb  thumbnail width in CSS px (default 480)
//   --slot   which image of the 4-up grid to use (default 0)
//
// Exit: 0 sheet written · 2 bad input · 3 render failure

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(REPO, 'mj-output');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PACK = argVal('--pack', null);
const OUT = argVal('--out', null);
const TITLE = argVal('--title', null);
const MANIFEST = argVal('--manifest', null);
const TILES = argVal('--tiles', null);
const COLS = Number(argVal('--cols', 4));
const ROWS = Number(argVal('--rows', 3));
const THUMB = Number(argVal('--thumb', 480));
const SLOT = Number(argVal('--slot', 0));

// Per-variant slot selection.
//
// Midjourney returns a 4-up grid per prompt, and the four cells are NOT
// four renditions of the same framing — they are four different takes on
// the brief. A prompt that says "overhead crane shot straight down" often
// yields one genuinely top-down cell and three eye-level ones, and a sheet
// that always shows cell 0 then silently shows the wrong angle.
//
// `--slots 02=1,03=2` picks a specific grid cell per variant (the key is
// the prompt's 1-based number). Unlisted variants use `--slot`.
const SLOTS = (() => {
    const raw = argVal('--slots', null);
    const map = new Map();
    if (!raw) return map;
    for (const pair of raw.split(',')) {
        const m = /^\s*(\d+)\s*=\s*(\d+)\s*$/.exec(pair);
        if (!m) { warn(`ignoring malformed --slots entry: ${pair}`); continue; }
        map.set(Number(m[1]), Number(m[2]));
    }
    return map;
})();
const BROWSER = argVal('--browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

function log(m) { process.stdout.write(`[mj-contact-sheet] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-contact-sheet] ${m}\n`); }

// Escape for HTML text/attribute contexts.
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The pack's variant label is the distinctive clause the prompt carries —
// the text between the shared head ("…underpass at night,") and the shared
// tail ("one overhead sodium streetlight…"). Reading it back out of the
// prompt keeps the caption and the image provably in sync: the caption IS
// the text that produced the tile.
function variantLabel(promptText) {
    const bare = String(promptText || '')
        .replace(/\s*--[\w-]+(\s+\S+)?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const head = 'underpass at night,';
    const tail = 'one overhead sodium streetlight';
    let s = bare;
    const hi = s.indexOf(head);
    if (hi >= 0) s = s.slice(hi + head.length);
    const ti = s.indexOf(tail);
    if (ti >= 0) s = s.slice(0, ti);
    s = s.replace(/,\s*$/, '').trim();
    // Cap the caption: long clauses wrap badly in a narrow tile. Cut at a
    // WORD boundary — the last separator in the kept span, not the first
    // (cutting at the first turns "overhead mirror reflection, …" into
    // "overhead…", which says nothing).
    if (s.length > 72) {
        const head = s.slice(0, 72);
        const cut = head.replace(/[\s,][^[\s,]*$/, '');
        s = (cut.length >= 24 ? cut : head).replace(/[\s,]+$/, '') + '…';
    }
    return s || bare.slice(0, 60);
}

// Pick the highest-resolution URL for one grid slot.
// Shape: `<job>_<grid>_<slot>_<size>_N.webp` (size may repeat) or
// `<job>_<grid>_<slot>.jpeg` (full resolution).
function pickSlotUrl(urls, slot) {
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
    let best = null;
    for (const url of list) {
        let file = url;
        try { file = new URL(url).pathname.split('/').filter(Boolean).pop() || url; }
        catch { /* not a url */ }
        let m = /^(\d+)_(\d+)_(\d+)_N\.\w+$/.exec(file);
        if (m) {
            if (Number(m[2]) !== slot) continue;
            const size = Number(m[3]);
            if (!best || size > best.size) best = { url, size };
            continue;
        }
        m = /^(\d+)_(\d+)\.(jpe?g|png|webp)$/i.exec(file);
        if (m && Number(m[2]) === slot && !best) best = { url, size: 4096 };
    }
    if (best) return best.url;
    // Fall back to positional indexing (the CDN order is slot order).
    return list[slot] || list[0] || null;
}

function loadPack(packDir, slotMap) {
    const items = [];
    const map = slotMap || new Map();
    const dirs = fs.readdirSync(packDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^prompt-\d+$/.test(d.name))
        .map(d => d.name)
        .sort();
    for (const name of dirs) {
        const metaPath = path.join(packDir, name, 'meta.json');
        if (!fs.existsSync(metaPath)) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
        catch { continue; }
        const n = Number(name.replace('prompt-', ''));
        const slot = map.has(n) ? map.get(n) : SLOT;
        const url = pickSlotUrl(meta.imageUrls, slot);
        if (!url) continue;
        items.push({
            dir: name,
            url,
            slot,
            label: variantLabel(meta.prompt),
            taskId: meta.taskId || '',
        });
    }
    return items;
}

function buildHtml(items) {
    const cells = items.map(it => `
      <figure class="cell">
        <div class="frame"><img src="${esc(it.url)}" alt="${esc(it.label)}" /></div>
        <figcaption>
          <span class="idx">${esc(it.dir.replace('prompt-', ''))}</span>
          <span class="lbl">${esc(it.label)}</span>
          <span class="tid">${esc(it.taskId.slice(0, 8))}</span>
        </figcaption>
      </figure>`).join('');

    // The heading is derived from the pack so the sheet is not welded to
    // one brief. `red_coat_underpass_12` → "Red Coat Underpass 12".
    const title = String(TITLE || PACK || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+\d+$/, '')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
    const count = items.length;
    const gridNote = (COLS * ROWS) === count ? '' : ` · ${count}/${COLS * ROWS} slots filled`;

    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --bg: #14161a; --fg: #e8e4dc; --muted: #8b8578; --line: #2a2d33;
    --accent: #b4643a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px; background: var(--bg); color: var(--fg);
    font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  }
  h1 { font-size: 15px; letter-spacing: .14em; text-transform: uppercase; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(${COLS}, ${THUMB}px); gap: 14px; }
  .cell { margin: 0; background: #191b20; border: 1px solid var(--line); }
  .frame { width: ${THUMB}px; height: ${Math.round(THUMB * 9 / 16)}px; background: #0f1115; overflow: hidden; }
  .frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  figcaption { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border-top: 1px solid var(--line); }
  .idx { color: var(--accent); font-weight: 700; }
  .lbl { color: var(--fg); flex: 1; }
  .tid { color: var(--muted); font-size: 10px; }
  .foot { margin-top: 18px; color: var(--muted); font-size: 10px; }
</style></head>
<body>
  <h1>${esc(title)} — ${count} up</h1>
  <p class="sub">${count} camera-angle / style variants of one brief · thumbnails · Midjourney${gridNote}</p>
  <div class="grid">${cells}</div>
  <p class="foot">tiles: first grid image of each variant · captions are the prompt clause that produced the tile</p>
</body></html>`;
}

async function main() {
    if (!PACK) { warn('--pack is required'); process.exit(2); }
    const packDir = path.join(OUTPUT_ROOT, PACK);
    if (!fs.existsSync(packDir)) { warn(`no such pack dir: ${packDir}`); process.exit(2); }

    const items = loadPack(packDir, SLOTS);
    if (items.length === 0) { warn(`no rendered prompts in ${packDir}`); process.exit(2); }
    log(`${items.length} rendered variant(s) found in ${path.basename(packDir)}`);
    if (SLOTS.size) {
        log(`slot selection: ${[...SLOTS].map(([n, s]) => `${n}->${s}`).join(' ')}`);
    }

    const html = buildHtml(items);
    const htmlPath = path.join(packDir, '_contact-sheet.html');
    fs.writeFileSync(htmlPath, html);

    const outPath = path.resolve(OUT || path.join(packDir, 'contact-sheet.png'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    // A real browser is required: the CDN 403s curl and headless clients.
    const puppeteer = require(path.join(REPO, 'node_modules', 'puppeteer'));
    const browser = await puppeteer.launch({
        headless: false,
        executablePath: BROWSER,
        args: ['--no-first-run', '--hide-scrollbars'],
        defaultViewport: { width: COLS * THUMB + (COLS + 1) * 14 + 56, height: 1200 },
    });
    try {
        const page = await browser.newPage();
        await page.goto('https://www.midjourney.com/imagine', { waitUntil: 'domcontentloaded', timeout: 45000 })
            .catch(() => {});   // referer only; the page itself is not needed
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        // Wait for every tile's image to decode, then for the layout to settle.
        await page.waitForFunction(() => {
            const imgs = [...document.querySelectorAll('.frame img')];
            return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
        }, { timeout: 60000 });
        await new Promise(r => setTimeout(r, 1200));

        const grid = await page.$('.grid');
        const el = grid || page;
        await el.screenshot({ path: outPath });
        log(`sheet written -> ${outPath}`);

        // Optionally save each tile as its own file. A shipped sheet whose
        // tiles are CDN URLs breaks the moment the CDN is unreachable, and
        // the CDN is not a stable host — it 403s curl and headless
        // clients, and MJ may expire the job. Saving the tiles locally
        // makes the artifact self-contained.
        if (TILES) {
            const tilesDir = path.resolve(TILES);
            fs.mkdirSync(tilesDir, { recursive: true });
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const buf = await page.evaluate(async (idx) => {
                    const img = document.querySelectorAll('.frame img')[idx];
                    if (!img) return null;
                    const blob = await fetch(img.src).then(r => r.blob());
                    return await new Promise(res => {
                        const fr = new FileReader();
                        fr.onload = () => res(fr.result);
                        fr.readAsDataURL(blob);
                    });
                }, i);
                if (!buf) { warn(`tile ${it.dir} could not be read back`); continue; }
                const b64 = buf.split(',')[1];
                const name = `${it.dir}.webp`;
                fs.writeFileSync(path.join(tilesDir, name), Buffer.from(b64, 'base64'));
            }
            log(`${items.length} tile(s) written -> ${tilesDir}`);
        }
    } finally {
        await browser.close();
    }

    // The provenance manifest. A shipped sheet is only trustworthy if the
    // tile↔prompt↔job mapping is recorded next to it — the same
    // evidence convention the MJ dashboard and the marketplace cover
    // manifest both use.
    if (MANIFEST) {
        const manifestPath = path.resolve(MANIFEST);
        const manifest = {
            pack: PACK,
            generatedAt: new Date().toISOString(),
            sheet: path.basename(outPath),
            count: items.length,
            grid: { cols: COLS, rows: ROWS, thumbPx: THUMB, slot: SLOT },
            variants: items.map(it => ({
                index: it.dir.replace('prompt-', ''),
                label: it.label,
                taskId: it.taskId,
                slot: it.slot,
                imageUrl: it.url,
            })),
        };
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        log(`manifest written -> ${manifestPath}`);
    }
    process.exit(0);
}

if (require.main === module) {
    main().catch(e => { warn(`fatal: ${e.message}`); process.exit(3); });
}

module.exports = { variantLabel, pickSlotUrl, loadPack, buildHtml };
