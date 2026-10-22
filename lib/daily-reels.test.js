// lib/daily-reels.test.js
//
// Pure-Node tests for the daily → reel hand-off. Same convention as
// the rest of the repo: `node:assert/strict`, a `check(name, cond)`
// helper, plain `node <file>` runner, non-zero exit on failure.
//
// The ffmpeg build is exercised for real — it takes under a second and
// it is the whole point of the module (a hand-off that produces a file
// nobody can play is not a hand-off).

'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  captionFields, reelBaseName, bandHeight, buildVerticalSource, buildTaggedAudio,
  imageSize, queuePlate, queueDay, listDays, readDay,
} = require('./daily-reels.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}
function section(n) { console.log(`${n}.`); }
function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// --------------------------------------------------------------------
section('the caption fields');
// --------------------------------------------------------------------

(function () {
  const f = captionFields({ caption: 'switchboard · lamp', artist: 'Digital Twin', album: 'Relay', genre: 'cyberpunk / hk' });
  check('the title is the caption', f.title === 'switchboard · lamp');
  check('the artist defaults to the twin', captionFields({ caption: 'x' }).artist === 'Digital Twin');
  check('the album defaults', captionFields({ caption: 'x' }).album === 'Daily Frames');
  check('the genre is kept', f.genre === 'cyberpunk / hk');
  check('the fields are trimmed', captionFields({ caption: '  a  ' }).title === 'a');
})();

// --------------------------------------------------------------------
section('the reel basename');
// --------------------------------------------------------------------

(function () {
  check('the collection id leads', reelBaseName('relay', 'switchboard · lamp').startsWith('relay-'));
  check('the caption is slugified into the name',
    reelBaseName('relay', 'switchboard · lamp') === 'relay-switchboard-lamp');
  check('a middot does not survive', !reelBaseName('relay', 'a · b').includes('·'));
  check('an empty caption still yields a name', reelBaseName('relay', '').startsWith('relay-'));
  check('two captions do not collide',
    reelBaseName('relay', 'switchboard lamp') !== reelBaseName('relay', 'switchboard switchboard'));
})();

// --------------------------------------------------------------------
section('the visible band');
// --------------------------------------------------------------------

(function () {
  // A 16:9 plate gives a 604px band at 1080 wide (1080 * 716 / 1280).
  check('a 16:9 plate keeps its aspect in the band', bandHeight(1280, 716) === 604);
  check('a square plate gives a square band', bandHeight(1000, 1000) === 1080);
  check('the band is never degenerate', bandHeight(4000, 10) >= 200);
  check('a missing size falls back to a sane band', bandHeight(null, null) > 100);
})();

// --------------------------------------------------------------------
section('the published days');
// --------------------------------------------------------------------

(function () {
  const days = listDays();
  check('the published days are listed', days.length >= 1);
  check('the newest day comes first', days.length < 2 || days[0] > days[1]);
  const day = readDay(days[0]);
  check('the newest day has a bundle', !!day);
  check('the bundle names its pack and its badge', !!day.pack && !!day.badge);
  check('the bundle has plates', (day.plates || []).length >= 1);
  check('a missing day reads as null', readDay('1999-01-01') === null);
})();

// --------------------------------------------------------------------
section('the build (ffmpeg, for real)');
// --------------------------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), 'daily-reels-test-'));

if (!hasFfmpeg()) {
  console.log('  (skipped — ffmpeg is not on PATH)');
} else {
  // A synthetic plate: 1280x716, so the band maths is the real one.
  const plate = join(TMP, 'plate.jpg');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x716:duration=1',
    '-frames:v', '1', plate], { stdio: 'ignore' });

  const size = imageSize(plate);
  check('the plate size is read', !!size && size.width === 1280 && size.height === 716);

  const mp3 = join(TMP, 'relay-switchboard-lamp.mp3');
  const mp4 = join(TMP, 'relay-switchboard-lamp.mp4');
  const fields = captionFields({ caption: 'switchboard · lamp', album: 'Relay', genre: 'cyberpunk / hk' });
  buildTaggedAudio(mp3, fields, 2);
  check('the audio track is written', existsSync(mp3));

  const tags = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json',
    '-show_format', mp3], { encoding: 'utf8' });
  check('the title is in the audio tags', tags.includes('switchboard'));
  check('the album is in the audio tags', tags.includes('Relay'));
  check('the genre is in the audio tags', tags.includes('cyberpunk'));

  buildVerticalSource(plate, mp4, 2, size.width, size.height);
  check('the vertical source is written', existsSync(mp4));

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json',
    '-show_streams', mp4], { encoding: 'utf8' }));
  const v = (probe.streams || []).find(s => s.codec_type === 'video');
  const a = (probe.streams || []).find(s => s.codec_type === 'audio');
  check('the source is vertical (1080x1920)', !!v && v.width === 1080 && v.height === 1920);
  check('the source carries audio', !!a);
  check('the source is h264', !!v && v.codec_name === 'h264');

  // The hand-off: both files land in the inbox under the same basename.
  const inbox = join(TMP, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const staging = join(TMP, 'staging');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'relay-switchboard-lamp.mp3'), readFileSync(mp3));
  writeFileSync(join(staging, 'relay-switchboard-lamp.mp4'), readFileSync(mp4));
  const result = queuePlate({
    plateFile: plate,
    caption: 'switchboard · lamp',
    collectionId: 'relay',
    album: 'Relay',
    genre: 'cyberpunk / hk',
    inboxDir: inbox,
    stagingDir: staging,
  });
  check('the reel is named after the collection and the caption',
    result.base === 'relay-switchboard-lamp');
  check('both files land in the inbox', result.targets.every(t => existsSync(t)));
  check('the video and the audio share a basename',
    result.targets[0].replace(/\.mp4$/, '') === result.targets[1].replace(/\.mp3$/, ''));
}

// --------------------------------------------------------------------
section('the day hand-off');
// --------------------------------------------------------------------

(function () {
  const days = listDays();
  if (!days.length) { console.log('  (skipped — no published day)'); return; }
  const inbox = join(TMP, 'inbox-day');
  mkdirSync(inbox, { recursive: true });
  const result = queueDay(days[0], { inboxDir: inbox, dryRun: true });
  check('the day queues one reel per plate',
    !!result && result.queued.length === (result.day.plates || []).length);
  check('a dry run writes nothing', !existsSync(join(inbox, 'anything.mp4')));
  // A reel the watcher already produced is left alone.
  const inbox2 = join(TMP, 'inbox-existing');
  mkdirSync(join(inbox2, 'processed'), { recursive: true });
  writeFileSync(join(inbox2, 'processed', 'relay-pylon-line.mp4'), 'x');
  const skipped = queueDay(days[0], { inboxDir: inbox2, dryRun: true });
  check('a reel that is already processed is left alone',
    !!skipped && skipped.queued.some(r => r.skipped));
  check('a forced run queues it anyway',
    !!queueDay(days[0], { inboxDir: inbox2, dryRun: true, force: true }).queued.some(r => !r.skipped));
  check('the queued reels are named after the collection',
    !!result && result.queued.every(r => r.base.startsWith(result.day.pack)));
})();

console.log(`\n[daily-reels.test] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
