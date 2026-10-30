// lib/render/images-to-mp4.test.mjs
//
// Tests for the stills-to-MP4 path: the set planner (`sets.mjs`), the shared
// render plan (`plan.mjs`) and the server executor (`server.mjs`).
//
// The graph is where the bugs live — it is a string with arithmetic in it, and
// the failures do not name their cause:
//   * `scale=1920x1080` (instead of `1920:1080`) parses as one bad expression,
//     and ffmpeg answers "could not open encoder before EOF";
//   * a wrong xfade offset renders fine and shows two images colliding;
//   * a loop that expands the file list without expanding the durations falls
//     back to the uniform value and quietly renders the wrong length.
// Each of those has an assertion here.
//
// The last section renders for real and probes the file, because "the graph is
// valid" and "the file plays" are different claims.
//
//   node lib/render/images-to-mp4.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  naturalSort,
  parseSize,
  collectImages,
  planDurations,
  SIZE_PRESETS,
} from './sets.mjs';
import { buildRenderPlan, loopOrder, DEFAULTS, TRANSITIONS } from './plan.mjs';
import { renderImagesToMp4, withAudio, ffmpegPath } from './server.mjs';

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
async function throws(label, fn, fragment) {
  try {
    await fn();
    failures.push({ label, actual: 'did not throw', expected: fragment || 'throw' });
    process.stderr.write(`  ✗ ${label} (did not throw)\n`);
  } catch (e) {
    assertTrue(label, !fragment || String(e.message).includes(fragment));
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'img2mp4-'));
const BASE = { width: 1080, height: 1080, fps: 30, kenBurns: 'none' };

// ------------------------------------------------------------- 1. ordering
process.stderr.write('1. a set sorts the way a person reads it\n');
{
  assert('numeric runs compare as numbers',
    naturalSort(['frame-10.jpg', 'frame-2.jpg', 'frame-1.jpg']),
    ['frame-1.jpg', 'frame-2.jpg', 'frame-10.jpg']);
  assert('zero-padded names keep working',
    naturalSort(['03-x.png', '01-x.png', '02-x.png']),
    ['01-x.png', '02-x.png', '03-x.png']);
  assert('a prefix does not hide the number',
    naturalSort(['system-error-10.jpg', 'system-error-9.jpg']),
    ['system-error-9.jpg', 'system-error-10.jpg']);
}

// ------------------------------------------------------------------ 2. size
process.stderr.write('2. sizes are presets or WxH, and always even\n');
{
  assert('16:9 is 1920x1080', parseSize('16:9'), { width: 1920, height: 1080 });
  assert('9:16 is 1080x1920', parseSize('9:16'), { width: 1080, height: 1920 });
  assert('explicit WxH is honoured', parseSize('1280x720'), { width: 1280, height: 720 });
  assert('an odd dimension is rounded down', parseSize('1281x721'), { width: 1280, height: 720 });
  assertTrue('the presets include a vertical reel size', Boolean(SIZE_PRESETS['9:16']));
  await throws('a nonsense size is refused', () => parseSize('wide'), 'unknown size');
  await throws('a tiny size is refused', () => parseSize('8x8'), 'too small');
}

// -------------------------------------------------------------- 3. timeline
process.stderr.write('3. durations are arithmetic, not a guess\n');
{
  assert('per-image honours --each', planDurations({ count: 10, fps: 30, each: 2.5 }).each, 2.5);
  const total = planDurations({ count: 4, fps: 30, each: 99, total: 10 });
  assert('--total wins and back-computes the segment', total.each, 2.5);
  const faded = planDurations({ count: 3, fps: 30, total: 10, transition: 'crossfade', fade: 1 });
  assert('--total accounts for the overlaps it will subtract',
    Number((faded.each * 3 - 2 * 1).toFixed(3)), 10);
  assert('a segment is never shorter than two frames',
    Number(planDurations({ count: 10, fps: 30, each: 0.01 }).each.toFixed(6)), 0.066667);
  await throws('zero images is refused', () => planDurations({ count: 0 }), 'at least one image');
  await throws('a zero duration is refused', () => planDurations({ count: 2, each: 0 }), 'not a duration');
}

// ---------------------------------------------------------- 4. the shared plan
process.stderr.write('4. the shared plan still serves both executors\n');
{
  // Backwards compatibility: the browser page and the local API call it with
  // the original options and must keep getting the same shape.
  const legacy = buildRenderPlan({ inputNames: ['a.jpg', 'b.jpg'], width: 1080, height: 1080 });
  assertTrue('the original keys are all still returned',
    ['args', 'filterComplex', 'outputName', 'width', 'height', 'frames', 'duration', 'fps', 'kenBurns', 'container']
      .every((k) => k in legacy));
  assert('a uniform render keeps one duration per image', legacy.durations, [DEFAULTS.duration, DEFAULTS.duration]);
  assert('the default transition is none', legacy.transition, 'none');
  assertTrue('none means concat', legacy.filterComplex.includes('concat=n=2:v=1:a=0[out]'));
  assertTrue('scale and crop take a COLON separator', legacy.filterComplex.includes('scale=1080:1080:'));
  assertTrue('… and never the WxH form, which parses as one bad expression',
    !legacy.filterComplex.includes('scale=1080x1080'));
  // A per-image cut list: each shot moves differently, and a 'none' entry
// stays still. Without this a 12-shot montage pushes in on every frame,
// which reads as a slideshow rather than as camera work.
const perImage = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], kenBurns: ['zoom-in', 'pan-left', 'none'] });
assertTrue('a per-image list pushes in on the first shot', perImage.filterComplex.includes("zoompan=z='min(1+0.2*on/"));
assertTrue('a per-image list pans on the second shot', perImage.filterComplex.includes("zoompan=z='1.15'"));
assertTrue('a per-image list leaves a none shot still',
  perImage.filterComplex.includes('[2:v]') && !/\[2:v\][^\[]*zoompan/.test(perImage.filterComplex));
assertTrue('a per-image list is still one joined output', perImage.filterComplex.includes('[out]'));

// Look effects. One entry means every shot; a list means one per shot; a
// shot stacks them with '+'. Measured on the installed ffmpeg before any
// name entered the registry, so a render cannot fail on a missing filter.
const fxAll = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg'], kenBurns: ['none', 'none'], fx: 'grain+vignette' });
assertTrue('one fx entry applies to every shot',
  (fxAll.filterComplex.match(/noise=alls=16/g) || []).length === 2);
assertTrue('stacked effects both land', fxAll.filterComplex.includes('vignette=angle='));
const fxPer = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], kenBurns: ['none', 'none', 'none'], fx: ['chroma', 'none', 'blur'] });
assertTrue('a per-shot fx list lands on its own shot',
  /\[0:v\][^\[]*chromashift/.test(fxPer.filterComplex));
assertTrue('a per-shot none stays clean',
  /\[1:v\][^;]*format=yuv420p\[v1\]/.test(fxPer.filterComplex) && !/\[1:v\][^;]*(chromashift|noise|gblur)/.test(fxPer.filterComplex));
assertTrue('a third shot carries its own effect',
  /\[2:v\][^\[]*gblur/.test(fxPer.filterComplex));
let rejectedFx = false;
try { buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], kenBurns: 'none', fx: 'sparkle' }); } catch { rejectedFx = true; }
assertTrue('an unknown fx name is refused', rejectedFx);

// A sequence-wide grade runs ONCE, after the join — which a per-shot fx
// cannot express (twelve shot vignettes stack; one graded vignette does not).
const graded = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg'], kenBurns: 'none', grade: 'vignette' });
assertTrue('the grade runs after the join', /\[out\]vignette=[^;]*\[graded\]/.test(graded.filterComplex));
assertTrue('the graded stream is handed back as [out]', /\[graded\]null\[out\]/.test(graded.filterComplex));
assert('the map still points at [out]', graded.args[graded.args.indexOf('-map') + 1], '[out]');
assertTrue('no grade leaves the graph untouched', !/\[graded\]/.test(
  buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], kenBurns: 'none' }).filterComplex));
let rejectedGrade = false;
try { buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], kenBurns: 'none', grade: 'sparkle' }); } catch { rejectedGrade = true; }
assertTrue('an unknown grade is refused', rejectedGrade);

let rejectedList = false;
try { buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], kenBurns: ['wobble'] }); } catch { rejectedList = true; }
assertTrue('an unknown motion in the list is refused', rejectedList);

assertTrue('zoompan takes the WxH form for its frame size',
    buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], kenBurns: 'zoom-in' }).filterComplex.includes('s=1080x1080'));
  assertTrue('every branch is limited range, or blacks render milky',
    legacy.filterComplex.includes('out_range=tv'));
  assertTrue('every branch normalises SAR', (legacy.filterComplex.match(/setsar=1/g) || []).length >= 2);
  assertTrue('every branch normalises pixel format', (legacy.filterComplex.match(/format=yuv420p/g) || []).length >= 2);
  assertTrue('the graph ends on the label the mapper asks for', legacy.filterComplex.endsWith('[out]'));

  const single = buildRenderPlan({ ...BASE, inputNames: ['a.jpg'] });
  assertTrue('a single image needs no join at all', single.filterComplex.includes('null[out]'));
  assertTrue('… and no concat', !single.filterComplex.includes('concat='));

  assert('transitions are declared', TRANSITIONS, ['none', 'crossfade']);
  await throws('an unknown transition is refused',
    () => buildRenderPlan({ ...BASE, inputNames: ['a.jpg'], transition: 'wipe' }), 'unknown transition');
  await throws('durations must match the image list',
    () => buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg'], durations: [1] }), 'one entry per image');
}

// -------------------------------------------------------------- 5. crossfade
process.stderr.write('5. dissolves join where the previous join ended\n');
{
  const xf = buildRenderPlan({
    ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], duration: 2, transition: 'crossfade', fade: 0.6,
  });
  assertTrue('the first dissolve starts one fade before the segment ends', xf.filterComplex.includes('offset=1.400'));
  assertTrue('the second offsets by the same step', xf.filterComplex.includes('offset=2.800'));
  assertTrue('crossfade does not also concatenate', !xf.filterComplex.includes('concat='));
  assert('the fade is reported back', xf.fade, 0.6);
  assert('the clip is the sum minus the overlaps', Number(xf.totalDuration.toFixed(3)), 4.8);

  const ragged = buildRenderPlan({
    ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], durations: [1, 3, 2], transition: 'crossfade', fade: 0.5,
  });
  // Join 1 at 1-0.5 = 0.5; join 2 at (1+3) - 2*0.5 = 3.0.
  assertTrue('uneven segments offset by their own sums',
    ragged.filterComplex.includes('offset=0.500') && ragged.filterComplex.includes('offset=3.000'));
  assert('and the total accounts for both fades', Number(ragged.totalDuration.toFixed(3)), 5);

  const clamped = buildRenderPlan({
    ...BASE, inputNames: ['a.jpg', 'b.jpg'], duration: 1, transition: 'crossfade', fade: 9,
  });
  assert('a fade cannot swallow half a segment', clamped.fade, 0.5);
}

// ------------------------------------------------------------------ 6. loop
process.stderr.write('6. --loop ping-pongs names AND durations\n');
{
  assert('three become four — the middle comes back', loopOrder(['a', 'b', 'c']), ['a', 'b', 'c', 'b']);
  assert('two cannot ping-pong without repeating', loopOrder(['a', 'b']), ['a', 'b']);

  const looped = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], duration: 2, loop: true });
  assert('the echoed list is what ffmpeg reads', looped.inputNames, ['a.jpg', 'b.jpg', 'c.jpg', 'b.jpg']);
  assert('the timeline is echoed with it', looped.durations, [2, 2, 2, 2]);
  assert('the clip is four segments long', Number(looped.totalDuration.toFixed(3)), 8);

  const loopedRagged = buildRenderPlan({ ...BASE, inputNames: ['a.jpg', 'b.jpg', 'c.jpg'], durations: [1, 2, 3], loop: true });
  assert('an echoed frame keeps ITS OWN duration, not the fallback',
    loopedRagged.durations, [1, 2, 3, 2]);
}

// ------------------------------------------------------------------ 7. audio
process.stderr.write('7. audio is spliced, never handed to the plan\n');
{
  const args = ['-y', '-loop', '1', '-i', 'a.jpg', '-filter_complex', '[0:v]null[out]', '-map', '[out]',
    '-c:v', 'libx264', '-movflags', '+faststart', 'o.mp4'];
  const withTrack = withAudio(args, 1, '/tmp/x.mp3');
  assert('the track is an input before the graph', withTrack[withTrack.indexOf('-filter_complex') - 1], '/tmp/x.mp3');
  assert('the audio stream is mapped by its input index', withTrack[withTrack.indexOf('-map') + 3], '1:a');
  assert('audio is re-encoded, never copied', withTrack[withTrack.indexOf('-c:a') + 1], 'aac');
  assert('the video is cut to the audio', withTrack[withTrack.length - 2], '-shortest');
  assert('the output path is still last', withTrack[withTrack.length - 1], 'o.mp4');
  await throws('args without a graph are refused', () => withAudio(['-i', 'a.jpg', 'o.mp4'], 1, 'x.mp3'), 'no -filter_complex');
}

// -------------------------------------------------------------- 8. collecting
process.stderr.write('8. a directory becomes a sorted set\n');
{
  const dir = path.join(TMP, 'set');
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  for (const name of ['plate-10.jpg', 'plate-2.jpg', 'plate-1.JPG']) {
    fs.writeFileSync(path.join(dir, name), Buffer.from('x'));
  }
  fs.writeFileSync(path.join(nested, 'inner.png'), Buffer.from('x'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(dir, '.hidden.jpg'), Buffer.from('x'));

  const { images, missing } = collectImages([dir]);
  assert('the set is sorted naturally, directories included', images.map((p) => path.basename(p)),
    ['inner.png', 'plate-1.JPG', 'plate-2.jpg', 'plate-10.jpg']);
  assert('a non-image is not one', images.some((p) => p.endsWith('.txt')), false);
  assert('dotfiles are skipped', images.some((p) => path.basename(p).startsWith('.')), false);
  assert('nothing is missing', missing, []);

  const bad = collectImages([path.join(TMP, 'nope'), path.join(dir, 'notes.txt')]);
  assert('a missing input is reported, not silently dropped', bad.missing.length, 2);
}

// ------------------------------------------------------------- 9. a real one
process.stderr.write('9. a real render, probed\n');
{
  const dir = path.join(TMP, 'render-set');
  fs.mkdirSync(dir, { recursive: true });
  const bin = ffmpegPath();
  if (!bin) {
    process.stderr.write('  – ffmpeg not on PATH, skipping the render\n');
  } else {
    const images = [];
    ['red', 'green', 'blue'].forEach((colour, i) => {
      const out = path.join(dir, `frame-${i + 1}.png`);
      const res = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', `color=c=${colour}:s=640x360:d=1`, '-frames:v', '1', out]);
      if (res.status !== 0) throw new Error(`could not make a fixture: ${res.stderr}`);
      images.push(out);
    });

    const workDir = path.join(TMP, 'render-out');
    fs.mkdirSync(workDir, { recursive: true });
    const result = await renderImagesToMp4({
      imagePaths: images,
      width: 1080,
      height: 1080,
      fps: 24,
      durations: [0.5, 0.5, 0.5],
      duration: 1,
      kenBurns: 'none',
      container: 'mp4',
      outputName: 'out.mp4',
      workDir,
    });
    assertTrue('the file exists and is not empty', result.bytes > 2000);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,pix_fmt,color_range,color_space,r_frame_rate', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', result.outputPath], { encoding: 'utf8' });
    const fields = probe.stdout.trim().replace(/\n/g, ',').split(',');
    assert('it is H.264', fields[0], 'h264');
    assert('at the requested square size', `${fields[1]}x${fields[2]}`, '1080x1080');
    assert('in the pixel format every player accepts', fields[3], 'yuv420p');
    assert('tagged limited range', fields[4], 'tv');
    // Range and matrix are tagged together: an untagged matrix is the same
    // player-side coin flip one axis over.
    assert('tagged with the bt709 matrix', fields[5], 'bt709');
    assert('at the requested frame rate', fields[6], '24/1');
    assert('the duration is the plan\'s, not the uniform fallback', Number(Number(fields[7]).toFixed(2)), 1.5);

    // Rendering the same output twice must replace it, not silently keep the
    // old bytes (the "ffmpeg returned 0 and wrote nothing" shape).
    const second = await renderImagesToMp4({
      imagePaths: images, width: 540, height: 540, fps: 24, durations: [0.5, 0.5, 0.5], duration: 1,
      kenBurns: 'none', container: 'mp4', outputName: 'out.mp4', workDir,
    });
    const probe2 = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height', '-of', 'csv=p=0', second.outputPath], { encoding: 'utf8' });
    assert('a second render replaces the first', probe2.stdout.trim(), '540,540');

    await throws('a missing image path is refused',
      () => renderImagesToMp4({ imagePaths: [path.join(dir, 'nope.jpg')], workDir }), 'not found');
    await throws('buffers and paths are mutually exclusive',
      () => renderImagesToMp4({ images: [{ name: 'a.jpg', buffer: Buffer.from('x') }], imagePaths: [images[0]], workDir }),
      'one or the other');

    // The looped path end to end, on the real executor.
    const looped = await renderImagesToMp4({
      imagePaths: images, width: 540, height: 540, fps: 24, durations: [0.5, 0.5, 0.5], duration: 1,
      kenBurns: 'none', loop: true, container: 'mp4', outputName: 'loop.mp4', workDir,
    });
    const loopProbe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'format=duration', '-of', 'csv=p=0', looped.outputPath], { encoding: 'utf8' });
    // Three images ping-pong to four: 4 × 0.5 s.
    assert('the looped render is four segments long', Number(Number(loopProbe.stdout.trim()).toFixed(2)), 2);
  }
}

// --------------------------------------------------------------------- done
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.stderr.write(`\n[images-to-mp4.test] passed: ${passed}, failed: ${failures.length}\n`);
if (failures.length) {
  for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
