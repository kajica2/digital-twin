#!/usr/bin/env node
'use strict';
// tools/pick-sheet.js
//
// Build a 12-up sheet of ONE CHOSEN CELL PER FRAME, captioned with the
// frame's number, title and camera.
//
// The 4-up contact sheet compares four takes of ONE frame. This compares
// the TWELVE frames of the set — so the camera grid itself can be judged:
// did each beat land on its assigned camera position, and do the twelve
// read as one film?
//
// Usage:
//   node tools/pick-sheet.js <pack-dir> [--cells 0_0,0_2,...] [--out <png>]
//
//   --cells  a comma-separated cell per frame (frame 1..12), or the
//            literal "screen" to use each frame's screen pick
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
const CELLS_ARG = argVal('--cells', 'screen');

function log(m) { process.stdout.write(`[pick-sheet] ${m}\n`); }
function warn(m) { process.stderr.write(`[pick-sheet] ${m}\n`); }

if (!PACK_DIR) { warn('usage: pick-sheet.js <pack-dir> [--cells screen|0_0,...] [--out <png>]'); process.exit(2); }
const abs = path.resolve(PACK_DIR);
if (!fs.existsSync(abs)) { warn(`no such directory: ${abs}`); process.exit(2); }

// The registry, if it is there — for the frame titles and camera names.
let reg = null;
const regPath = path.resolve(abs, '../../../lib/nema-me-u-meni-camera-grid.json');
if (fs.existsSync(regPath)) {
    try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch (e) { reg = null; }
}

// The screen picks, from the measurement file.
let screen = null;
const measPath = path.join(abs, 'cell-measurements.json');
if (fs.existsSync(measPath)) {
    const m = JSON.parse(fs.readFileSync(measPath, 'utf8'));
    screen = new Map(m.map(r => [r.prompt, r.pick]));
}

const promptDirs = fs.readdirSync(abs).filter(d => /^prompt-\d+$/.test(d)).sort();
if (!promptDirs.length) { warn(`no prompt-NN directories in ${abs}`); process.exit(2); }

let cells;
if (CELLS_ARG === 'screen') {
    cells = promptDirs.map(d => screen ? screen.get(d) : null);
    if (cells.some(c => !c)) { warn('no screen picks available — run pick-cells.js first'); process.exit(2); }
} else {
    const parts = CELLS_ARG.split(',').map(s => s.trim());
    if (parts.length !== promptDirs.length) {
        warn(`--cells needs ${promptDirs.length} entries, got ${parts.length}`); process.exit(2);
    }
    cells = parts;
}

const tiles = promptDirs.map((d, i) => {
    const cell = cells[i];
    const f = path.join(abs, d, `${cell}.webp`);
    if (!fs.existsSync(f)) return `<figure><figcaption>${d} — MISSING ${cell}</figcaption></figure>`;
    const b64 = fs.readFileSync(f).toString('base64');
    const n = i + 1;
    const fr = reg ? (reg.frames || []).find(x => x.n === n) : null;
    const cam = reg && fr ? (reg.cameras || []).find(c => c.n === fr.cameraN) : null;
    const cap = [
        `${String(n).padStart(2, '0')} · ${fr ? fr.title : d}`,
        cam ? `CAMERA ${String(cam.n).padStart(2, '0')} — ${cam.name}` : '',
        `cell ${cell}`,
    ].filter(Boolean).join('  |  ');
    return `<figure><img src="data:image/webp;base64,${b64}"><figcaption>${cap}</figcaption></figure>`;
}).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0d0d0f;color:#eee;font:12px/1.45 -apple-system,sans-serif;padding:12px}
  .g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  figure{margin:0} img{width:100%;display:block;border:1px solid #2a2a2e}
  figcaption{padding:4px 0;color:#c9c9cf}
</style><div class="g">${tiles}</div>`;

const htmlPath = path.join(abs, '_sheet.html');
fs.writeFileSync(htmlPath, html);
const sheet = OUT || path.join(abs, 'picked-sheet.png');
try {
    execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['--headless', '--disable-gpu', '--hide-scrollbars',
         '--screenshot=' + sheet, '--window-size=2000,2400',
         'file://' + htmlPath],
        { stdio: 'ignore' });
    log(`sheet -> ${sheet}`);
} catch (e) {
    warn(`sheet render failed: ${e.message}`);
    process.exit(3);
}
