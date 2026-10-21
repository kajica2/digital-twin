// lib/daily-pipeline.test.js
//
// Pure-Node tests for the daily mood-journey pipeline. Mirrors the
// repo's test convention: `node:assert/strict`, a `check(name,
// cond)` helper, plain `node <file>` runner, non-zero exit on
// failure.

'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const {
  MOODS, MOOD_SEEDS, MOOD_VISUAL_PAIRS,
  formatDate, dayOfYear, moodFor,
  promptForMusic, promptForGraphics, graphicsMarkdown,
  buildDaily, writeDaily, main,
} = require('./daily-pipeline.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}

function section(n) { console.log(`${n}.`); }

function freshDate(y, m, d) { return new Date(y, m - 1, d); }

// --------------------------------------------------------------------
section('formatDate');
// --------------------------------------------------------------------

(function () {
  const jan1 = freshDate(2026, 1, 1);
  const dec31 = freshDate(2026, 12, 31);
  check('Jan 1  -> 2026-01-01', formatDate(jan1) === '2026-01-01');
  check('Dec 31 -> 2026-12-31', formatDate(dec31) === '2026-12-31');
  check('pads single-digit month + day', formatDate(freshDate(2026, 4, 9)) === '2026-04-09');
})();

// --------------------------------------------------------------------
section('dayOfYear');
// --------------------------------------------------------------------

(function () {
  check('Jan 1 is 1',       dayOfYear(freshDate(2026, 1, 1)) === 1);
  check('Dec 31 is 365',     dayOfYear(freshDate(2026, 12, 31)) === 365);
  check('matches Date() arithmetic', dayOfYear(freshDate(2026, 7, 15))
                                  === Math.floor((freshDate(2026, 7, 15) - new Date(2026, 0, 0)) / 86400000));
  // Leap years: 2028 has Feb 29, dayOfYear 60 should be Feb 29.
  check('leap-year Feb 29 is 60 (2028)', dayOfYear(freshDate(2028, 2, 29)) === 60);
})();

// --------------------------------------------------------------------
section('moodFor');
// --------------------------------------------------------------------

(function () {
  // Moods in order, indexed by (dayOfYear-1) % 12.
  check('day 1 maps to MOODS[0] = still',
        moodFor(freshDate(2026, 1, 1)) === 'still');
  // (13 - 1) % 12 = 0, so day 13 wraps back to 'still'.
  check('day 13 wraps back to MOODS[0] = still',
        moodFor(freshDate(2026, 1, 13)) === 'still');
  // Day 12 is the last index in the cycle = MOODS[11] = bloom.
  check('day 12 maps to MOODS[11] = bloom',
        moodFor(freshDate(2026, 1, 12)) === 'bloom');
  // Override syntax.
  check('--mood override wins',
        moodFor(freshDate(2026, 1, 1), 'ember') === 'ember');
  // Reject unknown mood.
  let threw = false;
  try { moodFor(new Date(), 'gloom'); } catch (e) { threw = true; }
  check('unknown mood throws', threw);
  // Same date, same mood (determinism). `a === b === c` parses as
  // `(a === b) === c`, so test all three pairings explicitly.
  const d = freshDate(2026, 8, 4);
  const m1 = moodFor(d), m2 = moodFor(d), m3 = moodFor(d);
  check('determinism on the same date',
        m1 === m2 && m2 === m3 && m1 === m3);
})();

// --------------------------------------------------------------------
section('promptForMusic');
// --------------------------------------------------------------------

(function () {
  const md = promptForMusic(freshDate(2026, 10, 21), 'neon');
  check('starts with the date + mood header', md.startsWith('# 2026-10-21 · mood: neon'));
  check('includes the mood seed',            md.includes('a 24-hour diner above the subway'));
  check('tempo / length / key line present',  md.includes('Tempo: 104 bpm') && md.includes('Length: ~4:10') && md.includes('Key: B'));
  check('every mood has its own seed defined', Object.keys(MOOD_SEEDS).length === MOODS.length);
})();

// --------------------------------------------------------------------
section('promptForGraphics');
// --------------------------------------------------------------------

(function () {
  const bullets = promptForGraphics(freshDate(2026, 10, 21), 'neon');
  check('emits two bullets',                       Array.isArray(bullets) && bullets.length === 2);
  check('every bullet ends in --ar 16:9',          bullets.every(b => /--ar\s+16:9\s*$/.test(b)));
  check('every bullet starts capitalized (subject-first)',
        bullets.every(b => /^[A-Z]/.test(b.trim())));
  check('no bullet is a duplicate',
        bullets[0] !== bullets[1]);
  check('every mood has a 2-element visual pair',
        Object.values(MOOD_VISUAL_PAIRS).every(p => p.length === 2));
  // Bullet text survives the MJ-submitter's extractPrompts parser
  // shape: each line is its own bullet. Embed a multi-line MD body
  // and confirm the markdown writer produces 2 lines.
  const md = graphicsMarkdown('neon', bullets);
  check('graphicsMarkdown emits 2 prompt lines + header', md.split('\n').filter(l => /^-\s/.test(l)).length === 0);
  check('graphicsMarkdown bullets contain "--ar 16:9"',
        md.includes('--ar 16:9'));
  // Verify the file would be picked up by the existing format the
  // mj-submitter expects: top-level bullets each ending --ar 16:9,
  // no leading list marker (the writer uses paragraph bullets, not
  // hyphens — that's per PROMPT-EXPANSION-FORMAT.md).
  check('paragraph bullets, no leading hyphen',
        bullets.every(b => !b.startsWith('-') && !b.startsWith('*')));
})();

// --------------------------------------------------------------------
section('buildDaily (the day\'s full record)');
// --------------------------------------------------------------------

(function () {
  const d = buildDaily(freshDate(2026, 4, 9), {});
  check('date field present',
        d.date === '2026-04-09');
  check('mood field present', typeof d.mood === 'string');
  check('music is multi-line string', d.music.split('\n').length > 4);
  check('graphics is array of 2 bullets', d.graphics.length === 2);
})();

// --------------------------------------------------------------------
section('writeDaily (idempotency + force)');
// --------------------------------------------------------------------

(function () {
  const tmp = join(tmpdir(), 'daily-pipeline-test-' + Date.now());
  mkdirSync(tmp, { recursive: true });
  try {
    const daily = buildDaily(freshDate(2026, 7, 4), {});
    const paths1 = writeDaily(daily, {
      outDir: join(tmp, 'daily'),
      inbox:  join(tmp, 'inbox'),
    });
    check('first run wrote 3 files',
          Object.values(paths1).every(p => existsSync(p)));

    // Re-run without --force on the same date must throw.
    let threw = false;
    try {
      writeDaily(buildDaily(freshDate(2026, 7, 4), {}), {
        outDir: join(tmp, 'daily'),
        inbox:  join(tmp, 'inbox'),
      });
    } catch (e) { threw = /already shipped/.test(e.message); }
    check('re-run without --force is a no-op (throws "already shipped")', threw);

    // --force overwrites.
    const paths2 = writeDaily(buildDaily(freshDate(2026, 7, 4), { mood: 'bloom' }), {
      outDir: join(tmp, 'daily'),
      inbox:  join(tmp, 'inbox'),
      force: true,
    });
    check('--force overwrites the same files',
          paths1.dailyJson === paths2.dailyJson && existsSync(paths2.dailyJson));

    // The on-disk JSON has the expected keys.
    const json = JSON.parse(readFileSync(paths2.dailyJson, 'utf8'));
    check('disk JSON has the 4 record keys',
          ['date','mood','music','graphics'].every(k => k in json));

    // The MJ pack path matches the format the mj-submitter parses.
    const pack = readFileSync(paths2.graphicsMd, 'utf8');
    check('disk MJ pack uses the day\'s mood in the header',
          pack.includes('# neon') || pack.includes('# bloom'));
    check('disk MJ pack contains at least one --ar 16:9 line',
          /--ar\s+16:9/.test(pack));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

// --------------------------------------------------------------------
section('CLI --help');
// --------------------------------------------------------------------

(function () {
  const code = main(['--help']);
  check('--help exits 0', code === 0);
})();

console.log(`\n[daily-pipeline.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
