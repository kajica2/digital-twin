#!/usr/bin/env node
// bin/mj-set-frames.mjs — stage an MJ set's CHOSEN frames, ready for the
// video pipeline.
//
// WHY THIS EXISTS
// --------------
// A Midjourney set stores four cells per prompt (`0_0`…`0_3`) and a
// `manifest.json` that records WHICH cell was picked for each frame, plus
// the camera move, the look effects and the sequence grade that were used
// for the cut. The video tool (`bin/images-to-mp4.mjs`) wants a flat,
// ordered directory of stills and a cut list — so this is the missing
// step between "MJ finished" and "the video exists".
//
// It prints the exact `images-to-mp4` command to run, so the path from a
// set to a finished film is one command and no guessing.
//
//   node bin/mj-set-frames.mjs mj-output/<set>                       # stage + print
//   node bin/mj-set-frames.mjs mj-output/<set> --out data/mp4/frames/<set>
//   node bin/mj-set-frames.mjs mj-output/<set> --audio track.mp3     # …and the
//                                                                    # render command
//   node bin/mj-set-frames.mjs mj-output/<set> --json               # machine-readable
//
// ZERO DEPENDENCIES. Node >= 18.

import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(code = 0) {
  process.stdout.write(`stage an MJ set's chosen frames, and print the video command

  node bin/mj-set-frames.mjs <set-dir> [options]

options
  --out <dir>      where to stage the frames
                   (default data/mp4/frames/<set-name>)
  --audio <file>   a track to mux; the render is cut to the track
  --mode <m>       kenburns | crossfade | cut          (default cut)
  --size <s>       16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9 | WxH (default 4:3)
  --fps <n>        frame rate (default 30)
  --total <s>      total clip length; wins over --each
  --each <s>       seconds per image (default 2.5)
  --render         run the render after staging (needs --audio)
  --json           machine-readable output
  --help           this text
`);
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`mj-set-frames: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { args._.push(a); continue; }
  const key = a.slice(2);
  if (key === 'help') usage(0);
  if (key === 'render' || key === 'json') { args[key] = true; continue; }
  const value = argv[++i];
  if (value === undefined) fail(`--${key} needs a value`);
  args[key] = value;
}

const setDir = args._[0];
if (!setDir) usage(2);
const set = resolve(setDir);
if (!existsSync(set)) fail(`no such set: ${setDir}`);

const manifestPath = join(set, 'manifest.json');
if (!existsSync(manifestPath)) fail(`no manifest.json in ${setDir}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
}

const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
if (!frames.length) fail('the manifest lists no frames');

// The cells live in a sibling directory of the set (the run's output dir);
// the manifest's `file` entries are relative to it.
const candidates = [
  manifest.framesDir,
  frames[0].file ? join(set, frames[0].file) : null,
].filter(Boolean);
let framesRoot = null;
for (const c of candidates) {
  const root = resolve(set, c);
  if (existsSync(root) && !existsSync(join(root, 'manifest.json'))) { framesRoot = root; break; }
}
if (!framesRoot) {
  // Fall back: search one level down for the directory that holds the
  // first frame's file.
  for (const name of readdirSync(set)) {
    const root = join(set, name);
    if (!existsSync(root)) continue;
    const probe = join(root, frames[0].file);
    if (existsSync(probe)) { framesRoot = root; break; }
  }
}
if (!framesRoot) fail('could not find the directory that holds the chosen frames');

const outDir = resolve(args.out || join(REPO_ROOT, 'data', 'mp4', 'frames', basename(set)));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const staged = [];
frames.forEach((frame, i) => {
  const src = join(framesRoot, frame.file);
  if (!existsSync(src)) fail(`frame ${i + 1} is missing: ${frame.file}`);
  const name = `${String(i + 1).padStart(2, '0')}-${frame.file.split('/').pop()}`;
  const dest = join(outDir, name);
  copyFileSync(src, dest);
  staged.push({ name, source: frame.file, camera: frame.camera || null, motion: frame.motion || null, fx: frame.fx || null });
});

const motions = staged.map((f) => f.motion).filter(Boolean).join(',');
const fx = staged.map((f) => f.fx).filter(Boolean).join(',');
const grade = manifest.grade || null;

const renderArgs = [
  'node bin/images-to-mp4.mjs', relative(outDir),
  '--mode', args.mode || 'cut',
  '--size', args.size || '4:3',
  '--fps', args.fps || '30',
];
if (args.audio) renderArgs.push('--audio', JSON.stringify(resolve(args.audio)));
if (args.total) renderArgs.push('--total', args.total);
if (args.each) renderArgs.push('--each', args.each);
if (motions) renderArgs.push('--motions', motions);
if (fx) renderArgs.push('--fx', fx);
if (grade) renderArgs.push('--grade', grade);
if (args.out) renderArgs.push('--out', args.out);
const command = renderArgs.join(' ');

const result = {
  set: setDir,
  framesDir: relative(framesRoot),
  stagedDir: relative(outDir),
  frames: staged.length,
  motion: motions,
  fx,
  grade,
  command,
};

if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write(`staged ${staged.length} frame(s) → ${relative(outDir)}\n`);
  for (const f of staged) process.stdout.write(`  ${f.name}  ${f.camera || ''}\n`);
  process.stdout.write(`\n${command}\n`);
}

if (args.render) {
  if (!args.audio) fail('--render needs --audio');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('sh', ['-c', command], { cwd: REPO_ROOT, stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}

function relative(p) {
  const r = resolve(p);
  return r.startsWith(REPO_ROOT + '/') ? r.slice(REPO_ROOT.length + 1) : r;
}
