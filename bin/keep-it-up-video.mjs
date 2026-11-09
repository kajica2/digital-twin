#!/usr/bin/env node
'use strict';
// Assemble the KEEP IT UP video: 100 FLUX frames + 4 songs -> one film.
//
// The four songs are four movements of one night, and each has its own
// 25 frames. So the film is four sections, each cut to its own song,
// joined end to end. A hard cut between sections is the POINT: the
// room changes, the light changes, the drummer changes.
//
//   node bin/keep-it-up-video.mjs \
//     --frames assets/flux2/keep-it-up/frames \
//     --audio  assets/keep-it-up/audio \
//     --out    assets/keep-it-up/keep-it-up.mp4
//
// Per-song audio files are named by the song's slug:
//   <slug>.mp3  (or .wav / .m4a)
//
// Flags:
//   --dry-run        print the plan, render nothing
//   --each <sec>     seconds per frame (default 2.0)
//   --fade <sec>     the crossfade length (default 0.6)
//   --size <s>       16:9 | 9:16 | 1:1 | WxH (default 16:9)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const FRAMES = path.resolve(REPO, val('--frames', 'assets/flux2/keep-it-up/frames'));
const AUDIO = path.resolve(REPO, val('--audio', 'assets/keep-it-up/audio'));
const OUT = path.resolve(REPO, val('--out', 'assets/keep-it-up/keep-it-up.mp4'));
const MANIFEST = path.resolve(REPO, val('--manifest', 'assets/flux2/keep-it-up/manifest.json'));
const EACH = Number(val('--each', '2.0'));
const FADE = Number(val('--fade', '0.6'));
const SIZE = val('--size', '16:9');
const DRY = has('--dry-run');

const log = m => process.stdout.write(`${m}\n`);

// The planned length of a section: N frames of `each` seconds, less the
// crossfade overlap at each join. The renderer works this out the same
// way, so the two agree.
function plannedSeconds(section) {
  const n = section.frames.length;
  if (!n) return 0;
  const fade = Math.min(FADE, (EACH * 0.5));
  return Math.max(0, n * EACH - (n - 1) * fade);
}

// A file's duration, measured.
function durationOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const v = Number(String(r.stdout || '').trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ---- the plan -------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const songs = [];
manifest.forEach((e, idx) => {
  const slug = e.slug || '';
  // "<song-slug>-<nn>" -> the song slug is everything before the last
  // dash-number. The manifest also carries `song`, so prefer that.
  const song = e.song || slug.replace(/-\d+$/, '');
  let s = songs.find(x => x.slug === song);
  if (!s) { s = { slug: song, frames: [] }; songs.push(s); }
  // The files are numbered GLOBALLY — 26-needle-drop-healer-01.png —
  // so the number is the manifest index + 1, NOT the position within
  // the song. (Renumbering per song found none of them.)
  s.frames.push(path.join(FRAMES, `${String(idx + 1).padStart(2, '0')}-${slug}.png`));
});

const audioFor = slug => {
  for (const ext of ['mp3', 'wav', 'm4a', 'flac']) {
    const p = path.join(AUDIO, `${slug}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiu-'));
const sections = [];
let missingFrames = 0;
let missingAudio = 0;

for (const s of songs) {
  const present = s.frames.filter(f => fs.existsSync(f));
  missingFrames += s.frames.length - present.length;
  const audio = audioFor(s.slug);
  if (!audio) missingAudio++;
  sections.push({ slug: s.slug, frames: present, expected: s.frames.length, audio });
}

log(`KEEP IT UP — assembling ${sections.length} sections`);
for (const s of sections) {
  const flag = s.frames.length === s.expected ? ' ' : '-';
  log(`  ${flag} ${s.slug.padEnd(22)} ${String(s.frames.length).padStart(2)}/${s.expected} frames` +
      `  ${s.audio ? path.basename(s.audio) : 'NO AUDIO'}`);
}
if (missingFrames) log(`  ${missingFrames} frame(s) missing — the render is still going`);
if (missingAudio) log(`  ${missingAudio} song(s) have no audio yet`);

if (DRY) {
  log('\n(dry run — nothing rendered)');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

// ---- render each section -------------------------------------------
const clips = [];
for (const s of sections) {
  if (!s.frames.length) { log(`  ${s.slug}: no frames — skipped`); continue; }
  const dir = path.join(tmp, s.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of s.frames) fs.symlinkSync(f, path.join(dir, path.basename(f)));
  const out = path.join(tmp, `${s.slug}.mp4`);
  const args = [
    path.join(REPO, 'bin/images-to-mp4.mjs'), dir,
    '--mode', 'crossfade', '--size', SIZE, '--each', String(EACH),
    '--fade', String(FADE), '--out', out,
  ];
  if (s.audio) args.push('--audio', s.audio);
  log(`  rendering ${s.slug} …`);
  const r = spawnSync('node', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    log(`  ${s.slug}: FAILED (exit ${r.status})`);
    continue;
  }

  //
  // EVERY section must carry an audio track.
  //
  // A section whose song has no audio yet (the render or the generation
  // is still running) used to be rendered as a VIDEO-ONLY clip and then
  // concatenated with clips that HAVE audio. The concat demuxer takes
  // the audio from the first clip and the video from all of them — so
  // the film ran on past the sound for exactly the length of the
  // silent section.
  //
  // Measured: the section renders were always correct (35.60 s / 1068
  // frames, video and audio both). The ASSEMBLED file was 47.40 s of
  // video against 35.62 s of audio, and the 11.8 s difference was
  // precisely the second (silent) section.
  //
  // So a section without a song gets a SILENT track of the same
  // length — the clips then share a stream layout, and the concat is
  // honest about what it is.
  let finalClip = out;
  if (!s.audio) {
    const silent = path.join(tmp, `${s.slug}.silent.m4a`);
    const seconds = plannedSeconds(s);
    const made = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(seconds), '-c:a', 'aac', '-b:a', '192k', silent],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    if (made.status === 0) {
      finalClip = path.join(tmp, `${s.slug}.with-silent.mp4`);
      // The mapping MUST be explicit.
      //
      // Without it ffmpeg takes the best audio from the FIRST input —
      // which is the section's own music, not the silent track — and
      // the film's tail plays the first song a second time instead of
      // falling silent.
      const muxed = spawnSync('ffmpeg', ['-y', '-v', 'error',
        '-i', out, '-i', silent,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', finalClip],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      if (muxed.status === 0) {
        log(`    (no song yet — a silent track of ${seconds.toFixed(1)}s keeps the layout honest)`);
      } else {
        finalClip = out;
      }
    }
  }
  clips.push(finalClip);
}

if (!clips.length) {
  log('nothing was rendered.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// ---- join -----------------------------------------------------------
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const listFile = path.join(tmp, 'concat.txt');
fs.writeFileSync(listFile, clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
log(`joining ${clips.length} section(s) -> ${path.relative(REPO, OUT)}`);
execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'inherit'] });

const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
  'stream=codec_type,duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' });
log('');
log(probe.stdout.trim());

//
// AND CHECK THAT THE SOUND AND THE PICTURE ARE THE SAME LENGTH.
//
// The film running on past its music is the failure mode this whole
// thing exists to avoid: the music is the spine, and a video longer
// than its track means silence at the end.
//
// This is the check that catches it — and the defect it catches was
// real: a section with no audio yet was concatenated with sections
// that had audio, and the demuxer took the sound from the first clip
// and the picture from all of them.
const streams = String(probe.stdout || '').trim().split('\n').map(l => l.split(','));
const video = streams.find(s => s[0] === 'video');
const audio = streams.find(s => s[0] === 'audio');
if (video && audio) {
  const v = Number(video[1]);
  const a = Number(audio[1]);
  if (Number.isFinite(v) && Number.isFinite(a) && Math.abs(v - a) > 0.5) {
    log('');
    log(`ERROR: the video is ${v.toFixed(2)}s and the audio is ${a.toFixed(2)}s —`);
    log('       the film would run on past its music.');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}
log(`done: ${path.relative(REPO, OUT)}`);
fs.rmSync(tmp, { recursive: true, force: true });
