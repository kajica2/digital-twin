// lib/render/audio.test.mjs
//
// Tests for the track measurement (`audio.mjs`).
//
// The bug this guards: an MP3's header is not a measurement. A VBR file with
// no Xing header makes ffmpeg ESTIMATE the duration from the bitrate, and the
// estimate was 40 seconds long on a real track — a render sized against the
// estimate comes out 40 seconds short of the song.
//
//   node lib/render/audio.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  probeAudioDuration,
  probeAudioHeaderDuration,
  measureTrack,
} from './audio.mjs';

let passed = 0;
const failures = [];
function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
  else {
    failures.push({ label, actual: a, expected: e });
    process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
  }
}
function assertTrue(label, cond) {
  if (cond) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
  else { failures.push({ label, actual: 'false', expected: 'true' }); process.stderr.write(`  ✗ ${label}\n`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-probe-'));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Make a real audio file: `seconds` long, a given codec. */
function makeTrack(name, seconds, codec = 'aac') {
  const file = path.join(TMP, name);
  const res = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', codec,
    file,
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    process.stderr.write(`  ! could not make ${name} (ffmpeg said: ${res.stderr})\n`);
    return null;
  }
  return file;
}

process.stderr.write('\n1. a real track\n');
{
  const file = makeTrack('tone.m4a', 3);
  if (file) {
    const seconds = probeAudioDuration(file);
    assertTrue('the decoded length is measured', seconds !== null);
    assertTrue('the decoded length is within a frame of 3s', Math.abs(seconds - 3) < 0.2, `got ${seconds}`);
    assertTrue('the header agrees for a well-formed file', Math.abs(probeAudioHeaderDuration(file) - seconds) < 0.2);
  }
}

process.stderr.write('\n2. a file whose header lies\n');
{
  // A VBR MP3 written WITHOUT a Xing header: ffmpeg cannot count the
  // frames, so it estimates the duration from the bitrate — and the
  // estimate is wrong. This is the exact shape of the real track that came
  // out 40 seconds off.
  const file = path.join(TMP, 'vbr-noxing.mp3');
  const made = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:a', 'libmp3lame', '-q:a', '2', '-write_xing', '0',
    file,
  ], { encoding: 'utf8' });
  if (made.status === 0 && fs.existsSync(file)) {
    const measured = probeAudioDuration(file);
    const claimed = probeAudioHeaderDuration(file);
    assertTrue('the decoded length is measured', measured !== null);
    assertTrue('the decoded length is the real one', Math.abs(measured - 20) < 0.3, `got ${measured}`);
    assertTrue('the header disagrees with the audio', claimed !== null && Math.abs(claimed - measured) > 0.5, `claimed ${claimed}, real ${measured}`);
    const m = measureTrack(file);
    assert('the difference is reported', Math.abs(m.headerOffBy) > 0.5, true);
    assert('the measurement keeps the real seconds', Math.abs(m.seconds - 20) < 0.3, true);
  } else {
    process.stderr.write(`  ! could not make the VBR fixture (${made.stderr}) — skipped\n`);
  }
}

process.stderr.write('\n3. edge cases\n');
{
  assert('a missing file measures as null', probeAudioDuration(path.join(TMP, 'nope.mp3')), null);
  assert('a missing file has no header duration', probeAudioHeaderDuration(path.join(TMP, 'nope.mp3')), null);
  const junk = path.join(TMP, 'junk.mp3');
  fs.writeFileSync(junk, 'this is not audio');
  assert('a file that is not audio measures as null', probeAudioDuration(junk), null);
  const m = measureTrack(junk);
  assert('an unmeasurable track reports no seconds', m.seconds, null);
  assert('an unmeasurable track reports no difference', m.headerOffBy, 0);
}

process.stderr.write('\n4. the CLI sizes the stills to the real track, and its dry run shows the audio\n');
{
  // A frame the tool can render, and a track whose header lies.
  const frame = path.join(TMP, 'frame.png');
  const made = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x203040:s=320x240:d=1', '-frames:v', '1', frame,
  ], { encoding: 'utf8' });
  const track = path.join(TMP, 'vbr-noxing.mp3');
  const madeTrack = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:a', 'libmp3lame', '-q:a', '2', '-write_xing', '0',
    track,
  ], { encoding: 'utf8' });
  if (made.status === 0 && madeTrack.status === 0) {
    const res = spawnSync('node', [
      path.join(REPO, 'bin', 'images-to-mp4.mjs'),
      frame, '--audio', track, '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    const out = `${res.stdout || ''}`;
    assertTrue('the dry run succeeds', res.status === 0);
    assertTrue('the dry run names the track', out.includes('vbr-noxing.mp3'));
    assertTrue('the dry run shows the audio mapping', out.includes('-c:a aac'));
    assertTrue('the dry run shows the cut to the audio', out.includes('-shortest'));
    assertTrue('the stills are sized to the DECODED track, not the header', /\b20\.\d+s/.test(out) && !/25[0-9]\.\d+s/.test(out), out.match(/\b[\d.]+s\b/)?.[0]);
    assertTrue('the operator is told the header was wrong', /header claims/.test(res.stderr || ''));
  } else {
    process.stderr.write('  ! could not make the fixtures — skipped\n');
  }
}

process.stderr.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => process.stderr.write(`  - ${f.label}\n`));
  process.exit(1);
}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
