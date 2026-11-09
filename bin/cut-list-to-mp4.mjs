#!/usr/bin/env node
/**
 * bin/cut-list-to-mp4.mjs — render a cut list the director wrote.
 *
 * The director (lib/story/director.py) decides WHAT to show: which frame,
 * in which order, for how long, with which camera move and look. It does
 * not build an ffmpeg graph — that belongs to lib/render/plan.mjs, and
 * this script is its third caller (the page is the first, the server
 * executor the second).
 *
 *   node bin/cut-list-to-mp4.mjs cut.json [--out FILE] [--dry-run] [--json]
 *
 * The cut list is the contract:
 *
 *   {
 *     "images":    ["a.jpg", "b.jpg"],          // in cut order
 *     "durations": [3.0, 2.5],                  // seconds per shot
 *     "motions":  ["zoom-in", "pan-left"],      // per shot
 *     "fx":       ["grain", "grain+vignette"],  // per shot
 *     "grade":    "vignette",                   // once, over the joined cut
 *     "transition": "none",                     // none | crossfade
 *     "track":    "song.mp3"                    // optional audio
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

import { renderImagesToMp4, withAudio } from '../lib/render/server.mjs';
import { buildRenderPlan } from '../lib/render/plan.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const cutPath = argv.find((a) => !a.startsWith('--'));
const has = (flag) => argv.includes(flag);
const val = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[i + 1] : fallback;
};

if (!cutPath || has('--help') || has('-h')) {
    process.stdout.write(`render a cut list the director wrote

  node bin/cut-list-to-mp4.mjs <cut.json> [options]

options
  --out <file>     output path (default data/mp4/<name>-<stamp>.mp4)
  --dry-run        print the ffmpeg command, run nothing
  --json           machine-readable plan
`);
    process.exit(cutPath ? 0 : 2);
}

const cut = JSON.parse(fs.readFileSync(path.resolve(REPO, cutPath), 'utf8'));
const images = (cut.images || []).map((p) => path.resolve(REPO, p));
if (!images.length) {
    process.stderr.write('[cut-list] the cut list holds no images\n');
    process.exit(2);
}
const missing = images.filter((p) => !fs.existsSync(p));
if (missing.length) {
    process.stderr.write(`[cut-list] not found: ${missing.join(', ')}\n`);
    process.exit(2);
}

const durations = cut.durations && cut.durations.length === images.length ? cut.durations : undefined;
const motions = cut.motions && cut.motions.length === images.length ? cut.motions : undefined;
const fx = cut.fx && cut.fx.length === images.length ? cut.fx : undefined;
const grade = cut.grade || 'none';
const transition = cut.transition === 'crossfade' ? 'crossfade' : 'none';
const track = cut.track ? path.resolve(REPO, cut.track) : null;

const size = val('--size', '16:9');
const [width, height] = size.includes('x')
    ? size.split('x').map(Number)
    : ({ '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] })[size] || [1920, 1080];

const stamp = new Date().toISOString().slice(0, 10);
const outPath = path.resolve(REPO, val('--out', path.join('data', 'mp4', `cut-${stamp}.mp4`)));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const options = {
    imagePaths: images,
    width,
    height,
    fps: Number(val('--fps', 30)),
    duration: durations ? Math.max(1, Math.round(Math.max(...durations))) : 3,
    durations,
    kenBurns: motions || 'zoom-in',
    fx: fx || 'none',
    grade,
    transition,
    fade: Number(val('--fade', 0.6)),
    container: 'mp4',
    outputName: path.basename(outPath),
    workDir: path.dirname(outPath),
    audioPath: track,
};

if (has('--json') || has('--dry-run')) {
    const plan = buildRenderPlan({
        inputNames: images,
        width, height,
        fps: options.fps,
        duration: options.duration,
        durations,
        kenBurns: options.kenBurns,
        fx: options.fx,
        grade,
        transition,
        fade: options.fade,
        container: 'mp4',
        outputName: path.basename(outPath),
    });
    const args = [...plan.args];
    args[args.length - 1] = outPath;
    const finalArgs = track ? withAudio(args, images.length, track) : args;
    const summary = {
        count: images.length,
        size: `${width}x${height}`,
        fps: options.fps,
        durationSec: Number(plan.totalDuration.toFixed(3)),
        outPath,
        images: plan.inputNames,
        filterComplex: plan.filterComplex,
        args: finalArgs,
    };
    if (has('--json')) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
        process.stdout.write(`[cut-list] ${summary.count} shot(s) · ${summary.size} · ${summary.durationSec}s\n`);
        process.stdout.write(`[cut-list] ffmpeg ${finalArgs.map((a) => (/[^\w./:=+-]/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    }
    process.exit(0);
}

const result = await renderImagesToMp4(options);
process.stdout.write(
    `[cut-list] ${images.length} shot(s) · ${width}x${height} · ${result.plan.totalDuration.toFixed(2)}s → `
    + `${path.relative(REPO, result.outputPath)} · ${(result.bytes / 1048576).toFixed(1)} MB\n`,
);
