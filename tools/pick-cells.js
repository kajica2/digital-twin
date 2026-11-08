#!/usr/bin/env node
'use strict';
// tools/pick-cells.js
//
// MEASURE THE CELLS, THEN LET THE EYE DECIDE.
//
// The rule this implements is the repo's own (docs/VIDEO-FRAMING.md
// §1 Rule 4 + Rule 6, and the generative-shot-registry skill):
//
//   MEASUREMENT SCREENS. The 4-up grid is four DIFFERENT TAKES, not four
//   renditions of one framing. Take the cell whose exposure is closest to
//   the MEDIAN of the four, and never a blown one (>90 luma).
//
//   CONTENT CONFIRMS. A luma check cannot see that one cell has three
//   lamps lit when the brief said one. So this script SCREENS and prints
//   the candidates; the eye picks. It writes a 2x2 contact sheet so the
//   four are comparable in a single frame.
//
// Usage:
//   node tools/pick-cells.js <pack-dir> [--out <sheet.png>]
//
// Exit: 0 measurements written · 2 bad input · 3 render failure

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
const BLOWN = 90;   // the repo's threshold
const CELLS = ['0_0', '0_1', '0_2', '0_3'];

function log(m) { process.stdout.write(`[pick-cells] ${m}\n`); }
function warn(m) { process.stderr.write(`[pick-cells] ${m}\n`); }

if (!PACK_DIR) { warn('usage: pick-cells.js <pack-dir> [--out <sheet.png>]'); process.exit(2); }
const abs = path.resolve(PACK_DIR);
if (!fs.existsSync(abs)) { warn(`no such directory: ${abs}`); process.exit(2); }

// The prompt subdirectories, in order.
const promptDirs = fs.readdirSync(abs)
    .filter(d => /^prompt-\d+$/.test(d))
    .sort();

if (!promptDirs.length) { warn(`no prompt-NN directories in ${abs}`); process.exit(2); }

/** Average luma of one image, via ffmpeg's signalstats. */
function lumaOf(file) {
    const out = execFileSync('ffmpeg', [
        '-v', 'error', '-i', file,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f', 'null', '-',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/YAVG=([\d.]+)/);
    return m ? Number(m[1]) : null;
}

/** Median of the numeric values in a list. */
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
        if (fs.existsSync(f)) cells[c] = lumaOf(f);
    }
    if (!Object.keys(cells).length) { warn(`${d}: no cells`); continue; }

    const vals = Object.values(cells);
    const med = median(vals);
    const blown = Object.entries(cells).filter(([, v]) => v > BLOWN).map(([k]) => k);
    const usable = Object.entries(cells).filter(([, v]) => v <= BLOWN);
    // Closest to the median among the NOT-blown cells.
    const pick = usable.length
        ? usable.sort((a, b) => Math.abs(a[1] - med) - Math.abs(b[1] - med))[0][0]
        : null;

    report.push({ prompt: d, cells, median: med, blown, pick });

    const cellStr = Object.entries(cells).map(([k, v]) => `${k}=${v.toFixed(1)}`).join('  ');
    log(`${d}  ${cellStr}   median=${med.toFixed(1)}  blown=[${blown.join(',')}]  -> screen pick ${pick}`);
}

// The 2x2 sheet, so the four cells are comparable in one frame.
const first = report[0];
if (first) {
    const dir = path.join(abs, first.prompt);
    const thumbs = CELLS.map(c => {
        const f = path.join(dir, `${c}.webp`);
        if (!fs.existsSync(f)) return '';
        const b64 = fs.readFileSync(f).toString('base64');
        return `<figure><img src="data:image/webp;base64,${b64}"><figcaption>${c}${first.pick === c ? ' &larr; screen pick' : ''}</figcaption></figure>`;
    }).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#111;color:#eee;font:13px/1.4 -apple-system,sans-serif;padding:10px}
      .g{display:grid;grid-template-columns:1fr 1fr;gap:6px;max-width:1500px}
      figure{margin:0} img{width:100%;display:block;border:1px solid #333}
      figcaption{padding:3px 0;color:#bbb}
    </style><div class="g">${thumbs}</div>`;
    const htmlPath = path.join(abs, '_cells.html');
    fs.writeFileSync(htmlPath, html);
    const sheet = OUT || path.join(abs, 'cells-sheet.png');
    try {
        execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            ['--headless', '--disable-gpu', '--hide-scrollbars',
             '--screenshot=' + sheet, '--window-size=1500,900',
             'file://' + htmlPath],
            { stdio: 'ignore' });
        log(`cells sheet -> ${sheet}`);
    } catch (e) {
        warn(`sheet render failed: ${e.message}`);
        process.exit(3);
    }
}

fs.writeFileSync(path.join(abs, 'cell-measurements.json'), JSON.stringify(report, null, 2));
log(`measurements -> ${path.join(abs, 'cell-measurements.json')}`);
