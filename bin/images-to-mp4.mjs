#!/usr/bin/env node
/**
 * bin/images-to-mp4.mjs — a set of stills becomes an MP4, from the shell.
 *
 * The render itself is NOT implemented here. `lib/render/plan.mjs` owns the
 * filter graph and the argument list, and `lib/render/server.mjs` owns running
 * ffmpeg — the same two pieces the browser page and the local API use. This
 * file is the third caller: it decides WHICH files make up a set and passes
 * them to the same executor, so a clip rendered here and a clip rendered in
 * the browser come out of one graph (see docs/MEDIA-TOOLCHAIN.md, rule 3).
 *
 *   node bin/images-to-mp4.mjs <dir-or-image>... [options]
 *
 *   --out <file>        output path (default data/mp4/<set>-<stamp>.mp4)
 *   --mode <m>          kenburns | crossfade | cut          (default kenburns)
 *   --size <s>          16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9 | WxH
 *   --fps <n>           frame rate                            (default 30)
 *   --each <seconds>    seconds per image                     (default 2.5)
 *   --total <seconds>   total clip length; wins over --each
 *   --fade <seconds>    dissolve length, crossfade only       (default 0.6)
 *   --motion <m>        kenburns only: zoom-in | zoom-out | pan-left
 *   --loop              ping-pong the set so the clip repeats without a seam
 *   --audio <file>      mux a track and cut the video to it
 *   --dry-run           print the ffmpeg command, run nothing
 *   --json              machine-readable plan
 *
 * "cut" with a small --each is a flicker loop (--each 0.12).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectImages, parseSize, planDurations, SIZE_PRESETS } from '../lib/render/sets.mjs';
import { renderImagesToMp4 } from '../lib/render/server.mjs';
import { DEFAULTS } from '../lib/render/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO, 'data', 'mp4');

const VALUE_FLAGS = new Set(['--out', '--mode', '--size', '--fps', '--each', '--total', '--fade', '--audio', '--motion']);
const BOOL_FLAGS = new Set(['--dry-run', '--json', '--help', '-h', '--loop']);

/** kenburns alternates push-in and pan so a set does not feel mechanical. */
const MODE_TO_KEN_BURNS = {
  kenburns: 'zoom-in',
  crossfade: 'none',
  cut: 'none',
};
const MOTIONS = ['zoom-in', 'zoom-out', 'pan-left'];

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[i + 1] : fallback;
};

const inputs = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (VALUE_FLAGS.has(arg)) { i += 1; continue; }
  if (BOOL_FLAGS.has(arg) || arg.startsWith('--')) continue;
  inputs.push(arg);
}

if (has('--help') || has('-h') || !inputs.length) {
  const help = `create an MP4 from a set of stills

  node bin/images-to-mp4.mjs <dir-or-image>... [options]

options
  --out <file>        output path (default data/mp4/<set>-<stamp>.mp4)
  --mode <m>          ${Object.keys(MODE_TO_KEN_BURNS).join(' | ')}   (default kenburns)
  --size <s>          ${Object.keys(SIZE_PRESETS).join(' | ')} | WxH   (default 16:9)
  --fps <n>           frame rate (default ${DEFAULTS.fps})
  --each <seconds>    seconds per image (default 2.5)
  --total <seconds>   total clip length; wins over --each
  --fade <seconds>    dissolve length, crossfade only (default ${DEFAULTS.fade})
  --motion <m>        kenburns motion: ${MOTIONS.join(' | ')} (default zoom-in)
  --loop              ping-pong the set so the clip repeats without a seam
  --audio <file>      mux a track and cut the video to it
  --dry-run           print the ffmpeg command, run nothing
  --json              machine-readable plan
`;
  process.stdout.write(help);
  process.exit(inputs.length ? 0 : 2);
}

const mode = val('--mode', 'kenburns');
if (!(mode in MODE_TO_KEN_BURNS)) {
  process.stderr.write(`[images→mp4] unknown mode "${mode}" — use ${Object.keys(MODE_TO_KEN_BURNS).join(', ')}\n`);
  process.exit(2);
}
const motion = val('--motion', 'zoom-in');
if (!MOTIONS.includes(motion)) {
  process.stderr.write(`[images→mp4] unknown motion "${motion}" — use ${MOTIONS.join(', ')}\n`);
  process.exit(2);
}

try {
  const { width, height } = parseSize(val('--size', '16:9'));
  const fps = Number(val('--fps', DEFAULTS.fps));
  const fadeRaw = val('--fade', undefined);
  const fade = fadeRaw === undefined ? DEFAULTS.fade : Number(fadeRaw);

  const { images, missing } = collectImages(inputs.map((p) => path.resolve(REPO, p)));
  if (missing.length) throw new Error(`not found: ${missing.join(', ')}`);
  if (!images.length) throw new Error('no images found — point it at a directory of jpg/png/webp');

  const { each } = planDurations({
    count: images.length,
    fps,
    each: val('--each', 2.5),
    total: val('--total', undefined),
    transition: mode === 'crossfade' ? 'crossfade' : 'none',
    fade,
  });

  const first = images[0];
  const setName = path.basename(path.dirname(first)) || path.basename(first, path.extname(first));
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.resolve(REPO, val('--out', path.join(OUT_DIR, `${setName}-${mode}-${stamp}.mp4`)));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const planOptions = {
    imagePaths: images,
    width,
    height,
    fps,
    duration: Math.max(1, Math.round(each)),
    durations: images.map(() => each),
    kenBurns: mode === 'kenburns' ? motion : 'none',
    transition: mode === 'crossfade' ? 'crossfade' : 'none',
    fade,
    loop: has('--loop'),
    container: 'mp4',
    outputName: path.basename(outPath),
    workDir: path.dirname(outPath),
    audioPath: val('--audio', null) ? path.resolve(REPO, val('--audio')) : null,
  };

  if (has('--json') || has('--dry-run')) {
    // Build the plan without running ffmpeg: the same executor path, minus the
    // spawn, so what is printed is exactly what would run.
    const { buildRenderPlan } = await import('../lib/render/plan.mjs');
    const plan = buildRenderPlan({
      inputNames: images,
      width,
      height,
      fps,
      duration: planOptions.duration,
      durations: planOptions.durations,
      kenBurns: planOptions.kenBurns,
      transition: planOptions.transition,
      fade: planOptions.fade,
      loop: planOptions.loop,
      container: 'mp4',
      outputName: path.basename(outPath),
    });
    const args = [...plan.args];
    args[args.length - 1] = outPath;
    const summary = {
      mode,
      size: `${width}x${height}`,
      fps,
      count: plan.inputNames.length,
      each: Number(each.toFixed(3)),
      durationSec: Number(plan.totalDuration.toFixed(3)),
      outPath,
      images: plan.inputNames,
      filterComplex: plan.filterComplex,
      args,
    };
    if (has('--json')) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`[images→mp4] ${summary.count} image(s) · ${mode} · ${summary.size} · ${fps}fps · ${summary.durationSec}s\n`);
      process.stdout.write(`[images→mp4] ffmpeg ${args.map((a) => (/[^\w./:=+-]/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    }
    process.exit(0);
  }

  const result = await renderImagesToMp4(planOptions);
  process.stdout.write(
    `[images→mp4] ${planOptions.loop ? 'looped ' : ''}${images.length} image(s) · ${mode} · ${width}x${height} · `
    + `${fps}fps · ${result.plan.totalDuration.toFixed(2)}s → `
    + `${path.relative(REPO, result.outputPath)} · ${(result.bytes / 1048576).toFixed(1)} MB\n`,
  );
} catch (e) {
  process.stderr.write(`[images→mp4] ${e && e.message ? e.message : e}\n`);
  process.exit(2);
}
