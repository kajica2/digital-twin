#!/usr/bin/env node
'use strict';
// tools/look-sheet.js
//
// THE 30-UP COMPARISON SHEET FOR THE LOOK-PRESET REGISTRY.
//
// WHY A LOOK SHEET IS ITS OWN TOOL: the registry is a LOOK registry, so
// the sheet has to show ONE CHOSEN CELL PER LOOK, captioned with the
// look's NAME and its group — not a camera name. The camera-grid sheet
// (`tools/pick-sheet.js`) reads a different registry's shape, so this
// one reads the look registry's.
//
// THE POINT OF THE SHEET: the thirty looks are rendered from ONE
// subject, so any difference between two tiles is the LOOK's doing.
// The sheet is the comparison the registry exists to make.
//
// THE CELL PICK: the repo's Rule 4 — measurement SCREENS (the cell
// closest to the median luma, never a blown one over 90), and Rule 6 —
// the eye CONFIRMS. This tool does the screen and builds the sheet; the
// eye reads the sheet and the result is recorded in the registry.
//
// Usage:
//   node tools/look-sheet.js <pack-dir> [--out <png>] [--cols N]
//
// Exit: 0 sheet written · 2 bad input · 3 render failure

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PACK_DIR = ARGV.find(a => !a.startsWith('--'));
const OUT = argVal('--out', null);
const COLS = Number(argVal('--cols', '5'));
const BLOWN = 90;                 // the repo's threshold
const CELLS = ['0_0', '0_1', '0_2', '0_3'];

function log(m) { process.stdout.write(`[look-sheet] ${m}\n`); }
function warn(m) { process.stderr.write(`[look-sheet] ${m}\n`); }

if (!PACK_DIR) { warn('usage: look-sheet.js <pack-dir> [--out <png>] [--cols N]'); process.exit(2); }
const abs = path.resolve(PACK_DIR);
if (!fs.existsSync(abs)) { warn(`no such directory: ${abs}`); process.exit(2); }

// The registry — for the look names and groups.
const REG = path.resolve(__dirname, '../lib/mj-look-presets.json');
let reg = null;
if (fs.existsSync(REG)) {
    try { reg = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { reg = null; }
}
// The registry's array is `presets` — the same key the scene registry
// uses, so the two registries read alike.
const looks = (reg && (reg.presets || reg.looks)) || [];

const promptDirs = fs.readdirSync(abs)
    .filter(d => /^prompt-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
if (!promptDirs.length) { warn(`no prompt-NN directories in ${abs}`); process.exit(2); }

/** Average luma, via ffmpeg's signalstats. */
function lumaOf(file) {
    const out = execFileSync('ffmpeg', [
        '-v', 'error', '-i', file,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f', 'null', '-',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/YAVG=([\d.]+)/);
    return m ? Number(m[1]) : null;
}
function median(nums) {
    const s = nums.filter(n => typeof n === 'number').sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const report = [];
for (const d of promptDirs) {
    const dir = path.join(abs, d);
    const cells = {};
    for (const c of CELLS) {
        const f = path.join(dir, `${c}.webp`);
        if (fs.existsSync(f)) {
            const l = lumaOf(f);
            if (l !== null) cells[c] = l;
        }
    }
    const n = Number(d.slice(7));
    const look = looks[n - 1] || null;
    if (!Object.keys(cells).length) {
        report.push({ prompt: d, n, look: look ? look.name : null, cells: {}, pick: null });
        warn(`${d} — no cells could be measured`);
        continue;
    }
    const vals = Object.values(cells);
    const med = median(vals);
    const blown = Object.entries(cells).filter(([, v]) => v > BLOWN).map(([k]) => k);
    const usable = Object.entries(cells).filter(([, v]) => v <= BLOWN);
    // Closest to the median among the NOT-blown cells.
    const pick = usable.length
        ? usable.sort((a, b) => Math.abs(a[1] - med) - Math.abs(b[1] - med))[0][0]
        : null;
    if (!pick) {
        // EVERY cell is blown. That is a FINDING, not a missing file —
        // the look rendered, and it rendered overexposed. Say so,
        // because "no cells" reads like the render failed.
        report.push({
            prompt: d, n, look: look ? look.name : null,
            cells, median: med, blown, pick: null, allBlown: true,
        });
        warn(`${d} — EVERY cell is blown (${vals.map(v => v.toFixed(0)).join('/')} luma, threshold ${BLOWN})`);
        continue;
    }
    report.push({
        prompt: d, n,
        look: look ? look.name : null,
        group: look ? look.family : null,
        cells, median: med, blown, pick,
    });
}

// The sheet. One chosen cell per look, captioned with the look's name.
const tiles = promptDirs.map((d, i) => {
    const r = report[i];
    let cell = r.pick;
    if (!cell && r.allBlown) {
        // EVERY cell is blown. The look still rendered — and an
        // overexposed look IS the look (a Thermal/Infrared frame and a
        // Polaroid frame can both be very bright). So the sheet shows
        // the LEAST-blown cell and says so in the caption, rather than
        // leaving a gap that reads like a failed render.
        cell = Object.entries(r.cells).sort((a, b) => a[1] - b[1])[0][0];
    }
    if (!cell) return `<figure class="miss"><figcaption>${String(r.n).padStart(2, '0')} — no cells</figcaption></figure>`;
    const f = path.join(abs, d, `${cell}.webp`);
    if (!fs.existsSync(f)) return `<figure class="miss"><figcaption>${d} — missing ${cell}</figcaption></figure>`;
    const b64 = fs.readFileSync(f).toString('base64');
    const luma = r.cells[cell];
    const cap = [
        `<b>${String(r.n).padStart(2, '0')}</b> ${r.look || d}`,
        `${r.group ? r.group + ' · ' : ''}cell ${cell} · luma ${luma.toFixed(1)}`
            + (r.allBlown ? ' · ALL CELLS BLOWN' : ''),
    ].join('<br>');
    return `<figure><img src="data:image/webp;base64,${b64}"><figcaption>${cap}</figcaption></figure>`;
}).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0d0d0f;color:#eee;font:12px/1.4 -apple-system,sans-serif;padding:12px}
  .g{display:grid;grid-template-columns:repeat(${COLS},1fr);gap:8px}
  figure{margin:0} img{width:100%;display:block;border:1px solid #2a2a2e}
  figcaption{padding:4px 0;color:#c9c9cf}
  .miss{border:1px dashed #555;padding:10px;color:#888}
  b{color:#f0c26a}
</style><div class="g">${tiles}</div>`;

const htmlPath = path.join(abs, '_look-sheet.html');
fs.writeFileSync(htmlPath, html);
const sheet = OUT || path.join(abs, 'look-sheet.png');
try {
    execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['--headless', '--disable-gpu', '--hide-scrollbars',
         '--screenshot=' + sheet, `--window-size=${COLS * 420},${Math.ceil(promptDirs.length / COLS) * 280}`,
         'file://' + htmlPath],
        { stdio: 'ignore' });
    log(`sheet -> ${sheet}`);
} catch (e) {
    warn(`sheet render failed: ${e.message}`);
    process.exit(3);
}

const meas = path.join(abs, 'cell-measurements.json');
fs.writeFileSync(meas, JSON.stringify(report, null, 2));
log(`measurements -> ${meas}`);
for (const r of report) {
    if (!r.pick) { warn(`${r.prompt} — no cells`); continue; }
    log(`${String(r.n).padStart(2, '0')} ${(r.look || '').padEnd(38).slice(0, 38)} cell ${r.pick}  luma ${r.cells[r.pick].toFixed(1)}  median ${(r.median || 0).toFixed(1)}  blown=[${(r.blown || []).join(',')}]`);
}
