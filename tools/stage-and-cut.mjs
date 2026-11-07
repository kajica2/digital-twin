#!/usr/bin/env node
'use strict';
// tools/stage-and-cut.mjs — stage a Kišna soba episode set and cut it.
//
//   node tools/stage-and-cut.mjs <set-dir> <slug> [--each 5] [--motions a,b,c]
//
// The staging copies the chosen cell of every frame into frames/ and
// writes manifest.json; the cut is the repo's images-to-mp4 with one
// gentle motion per shot and one grade over the whole cut (a per-shot
// vignette would stack twelve times).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const setDir = args[0];
const slug = args[1];
let each = 5;
let motions = null;
for (let i = 2; i < args.length; i++) {
    if (args[i] === '--each') each = Number(args[++i]);
    if (args[i] === '--motions') motions = args[++i];
}

if (!setDir || !slug) {
    console.error('usage: node tools/stage-and-cut.mjs <set-dir> <slug> [--each 5] [--motions a,b,c]');
    process.exit(2);
}

const abs = path.resolve(setDir);
const framesDir = path.join(abs, 'frames');
fs.mkdirSync(framesDir, { recursive: true });

const prompts = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^prompt-\d+$/.test(d.name))
    .map(d => d.name)
    .sort();

const manifest = { title: slug, frames: [] };
for (const name of prompts) {
    const dir = path.join(abs, name);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const cell = fs.existsSync(path.join(dir, '0_0.webp')) ? 0 : 1;
    const src = path.join(dir, `0_${cell}.webp`);
    if (!fs.existsSync(src)) continue;
    const n = name.replace('prompt-', '');
    fs.copyFileSync(src, path.join(framesDir, `${n}.webp`));
    manifest.frames.push({ frame: Number(n), cell, taskId: meta.taskId, jobType: meta.jobType });
}
fs.writeFileSync(path.join(abs, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`staged ${manifest.frames.length} frame(s)`);

const list = manifest.frames.map(f => String(f.frame).padStart(2, '0')).sort();
if (!list.length) process.exit(1);
const motionList = motions
    ? motions.split(',')
    : list.map((_, i) => (i % 5 === 4 ? 'zoom-out' : i % 3 === 1 ? 'pan-left' : 'zoom-in'));
while (motionList.length < list.length) motionList.push('zoom-in');
motionList.length = list.length;

const out = path.join(abs, `${slug}-cut.mp4`);
const cmd = [
    'node', path.resolve('bin/images-to-mp4.mjs'), framesDir,
    '--mode', 'kenburns', '--each', String(each), '--size', '1920x1080',
    '--motions', motionList.join(','), '--grade', 'vignette', '--out', out,
];
const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
