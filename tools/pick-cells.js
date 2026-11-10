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
//   the MEDIAN of the four, and never a blown one.
//
//   CONTENT CONFIRMS. A luma check cannot see that one cell has three
//   lamps lit when the brief said one. So this script SCREENS and prints
//   the candidates; the eye picks. It writes a 2x2 contact sheet so the
//   four are comparable in a single frame.
//
// WHAT "BLOWN" MEANS, AND WHY IT IS NOT A LUMA NUMBER
//
//   The old test was "mean luma > 90", an ABSOLUTE threshold. It was
//   calibrated on a dark film set whose four takes ran 66-120 luma, so
//   on that set it excluded the bright take and picked the darkest
//   survivor — the OPPOSITE of "closest to the median".
//
//   MEASURED 2026-11-10 across every set on disk (76 cells):
//     * the old rule produced NO pick at all on 14 of 19 prompts, and
//       every cell of a bright set was called blown. The repo's own
//       reference sheets (means 163-222) and its own 4:3 set (means
//       99-135) were entirely unscreenable;
//     * the cells it called blown had ~0.1% CLIPPED pixels — they were
//       well-exposed frames that happened to be bright.
//
//   A blown cell is one whose HIGHLIGHTS ARE CLIPPED. So the test is
//   the FRACTION of pixels at or above 250, not the mean. Measured on
//   the same 76 cells, the distribution separates cleanly: 34 cells
//   clip 0.00%, and the ones that clip at all form a tail (0.01% to
//   1.6%), then a separate group at 12-80%. The 12-80% cells are the
//   genuinely washed-out ones.
//
//   The threshold is 2% of pixels clipped: the tail under it is
//   specular glints, the group above it is a blown frame.
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
const CELLS = ['0_0', '0_1', '0_2', '0_3'];

// A cell is blown when this fraction of its pixels are clipped at the
// top of the range. Measured, not guessed — see the header.
const BLOWN_CLIP = 0.02;

// The luma at which a pixel counts as clipped.
const CLIP_LEVEL = 250;


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

/**
 * Exposure of one cell: its mean luma AND the fraction of pixels
 * clipped at the top of the range.
 *
 * The mean comes from ffmpeg's signalstats; the clipping fraction is
 * counted on a downscaled grayscale copy (160px wide is plenty to find
 * a blown region, and it keeps the read cheap).
 */
function exposureOf(file) {
    const out = execFileSync('ffmpeg', [
        '-v', 'error', '-i', file,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f', 'null', '-',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/YAVG=([\d.]+)/);
    const mean = m ? Number(m[1]) : null;

    let clip = 0;
    try {
        const raw = execFileSync('ffmpeg', [
            '-v', 'error', '-i', file,
            '-vf', 'scale=160:-1,format=gray',
            '-f', 'rawvideo', '-',
        ], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
        let clipped = 0;
        for (let i = 0; i < raw.length; i++) if (raw[i] >= CLIP_LEVEL) clipped++;
        clip = raw.length ? clipped / raw.length : 0;
    } catch (e) {
        // A cell ffmpeg cannot decode has no measured clipping, so it is
        // treated as clean here and caught by the eye.
    }
    return { mean, clip };
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
        if (fs.existsSync(f)) cells[c] = exposureOf(f);
    }
    if (!Object.keys(cells).length) { warn(`${d}: no cells`); continue; }

    const vals = Object.values(cells).map(v => v.mean);
    const med = median(vals);
    const blown = Object.entries(cells).filter(([, v]) => v.clip > BLOWN_CLIP).map(([k]) => k);
    const usable = Object.entries(cells).filter(([, v]) => v.clip <= BLOWN_CLIP).map(([k]) => k);
    // Closest to the median among the NOT-blown cells.
    //
    // `usable` holds CELL NAMES, so the pick is the first element — an
    // extra `[0]` here would take the first CHARACTER of the name and
    // report "0" instead of "0_0".
    const pick = usable.length
        ? usable.sort((a, b) => Math.abs(cells[a].mean - med) - Math.abs(cells[b].mean - med))[0]
        : null;

    report.push({ prompt: d, cells, median: med, blown, pick });

    const cellStr = Object.entries(cells)
        .map(([k, v]) => `${k}=${v.mean.toFixed(1)}/${(v.clip * 100).toFixed(1)}%`)
        .join('  ');
    log(`${d}  ${cellStr}   median=${med.toFixed(1)}  blown=[${blown.join(',')}]  -> screen pick ${pick}`);
    log(`        (mean luma / clipped pixels)`);
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
