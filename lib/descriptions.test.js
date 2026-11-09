#!/usr/bin/env node
'use strict';
// lib/descriptions.test.js
//
// The copy is the product. A duplicated sentence, a missing measurement or
// a tag typed twice is a defect a reader sees and a test should catch.
//
//   node lib/descriptions.test.js
//
// Exit: 0 all passed, 1 something failed.

const assert = require('node:assert');
const { ALL, WORKS, longDescription, musicDescription, videoDescription } = require('./descriptions.js');

let _count = 0;
const _failures = [];

function check(cond, label) {
  _count += 1;
  if (cond) console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); _failures.push(label); }
}

function eq(got, want, label) {
  check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --------------------------------------------------------------------------
console.log('every work has the three lengths');
// --------------------------------------------------------------------------
for (const work of ALL) {
  check(typeof work.pitch === 'string' && work.pitch.length > 20,
    `${work.id}: the pitch says something`);
  check(typeof work.longDescription === 'string' && work.longDescription.length > 100,
    `${work.id}: the long description is a description`);
  if (work.kind === 'music') {
    check(typeof work.musicDescription === 'string' && work.musicDescription.length > 60,
      `${work.id}: the music description is a description`);
  }
}

// --------------------------------------------------------------------------
console.log('the music descriptions carry their measurements');
// --------------------------------------------------------------------------
const shadow = WORKS['geometric-shadow-box'];
const flow = WORKS['find-your-flow'];
check(/94%/.test(musicDescription(shadow)), 'the Shadow Box states its low-band share');
check(/219 Hz/.test(musicDescription(shadow)), 'the Shadow Box states its centroid');
check(/40\.3 dB/.test(musicDescription(shadow)), 'the Shadow Box states its dynamic range');
check(/96%/.test(musicDescription(flow)), 'Find Your Flow states its low-band share');
check(/16.9 dB/.test(musicDescription(flow)), 'Find Your Flow states its dynamic range');
// The tempo is in the LONG form. The short form carries what tells the
// two records apart; the tempo is metadata, not a difference.
check(/117/.test(longDescription(shadow)), 'the Shadow Box states its tempo');
check(/110/.test(longDescription(flow)), 'Find Your Flow states its tempo');

// The measured difference between the two records is the reason they read
// differently. If the numbers ever stop agreeing, the copy is lying.
check(
  shadow.facts.rangeDb > flow.facts.rangeDb * 2,
  'the Shadow Box really is the wider record (40.3 dB against 16.9 dB)');
check(
  shadow.facts.centroidHz < flow.facts.centroidHz,
  'the Shadow Box really is the darker one (219 Hz against 265 Hz)');

// --------------------------------------------------------------------------
console.log('no tag is typed twice');
// --------------------------------------------------------------------------
for (const work of ALL) {
  const seen = new Set();
  const dupes = work.tags.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
  eq(dupes.length, 0, `${work.id}: no duplicate tags${dupes.length ? ' (' + dupes + ')' : ''}`);
}

// --------------------------------------------------------------------------
console.log('the video descriptions have the shape YouTube needs');
// --------------------------------------------------------------------------
const films = ALL.find((w) => w.id === 'nov8-films');
eq(films.cuts.length, 3, 'the series has three cuts');
for (const cut of films.cuts) {
  check(cut.description.includes('#'), `${cut.id}: the description ends with hashtags`);
  check(cut.title.length <= 100, `${cut.id}: the title fits YouTube's 100 characters`);
  check(cut.description.length < 5000, `${cut.id}: the description is inside YouTube's limit`);
  check(/\bCut \d of 3\b/.test(cut.description), `${cut.id}: it says where it sits in the series`);
}

// --------------------------------------------------------------------------
console.log('nothing is said twice');
// --------------------------------------------------------------------------
for (const cut of films.cuts) {
  const sentences = cut.description
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const seen = new Set();
  const dupes = sentences.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
  eq(dupes.length, 0, `${cut.id}: no sentence appears twice${dupes.length ? ' — ' + JSON.stringify(dupes) : ''}`);
}

// The CLIP measurement belongs to the third cut ONLY. If it leaks into the
// first two, the copy is telling two different films the same thing.
const v1 = films.cuts.find((c) => c.id === 'v1-curtain').description;
const v3 = films.cuts.find((c) => c.id === 'v3-lines').description;
check(!/1\.79/.test(v1), 'the first cut does not claim the third cut\'s measurement');
check(/1\.79/.test(v3), 'the third cut does carry its own measurement');
check((v3.match(/1\.79/g) || []).length === 1, 'the measurement appears once');

// Each cut describes ITSELF, not the whole series.
for (const cut of films.cuts) {
  check(!/the third film/i.test(cut.description), `${cut.id}: it does not describe a film it is not`);
}

// --------------------------------------------------------------------------
console.log('the descriptions do not promise anything unmeasured');
// --------------------------------------------------------------------------
const BANNED = [
  /viral/i,
  /you won't believe/i,
  /part \d+ of \d+/i,
  /million views/i,
  /trending/i,
  /#fyp\b/i,
];
for (const work of ALL) {
  const texts = [work.longDescription, work.videoDescription, work.musicDescription || '']
    .concat((work.cuts || []).map((c) => c.description));
  for (const text of texts) {
    for (const pattern of BANNED) {
      check(!pattern.test(text), `${work.id}: no ${pattern} (engagement bait reads as spam)`);
    }
  }
}

// --------------------------------------------------------------------------
console.log('the descriptions say how it was made');
// --------------------------------------------------------------------------
for (const work of ALL) {
  const text = work.longDescription.toLowerCase();
  check(/midjourney|python|pillow|ffmpeg/.test(text) || work.kind === 'music',
    `${work.id}: the process is named`);
}
check(/pillow/.test(films.longDescription.toLowerCase()),
  'the films name the tools that made them');
check(/midjourney/.test(films.longDescription.toLowerCase()),
  'the films name where the frames came from');

// --------------------------------------------------------------------------
console.log('the credits are on every description');
// --------------------------------------------------------------------------
for (const work of ALL) {
  check(/sainted word records/i.test(work.longDescription), `${work.id}: the long description credits the label`);
  // Only a MUSIC work has a music description; a video does not, and
  // demanding one of it was the test's bug, not the copy's.
  if (work.kind === 'music') {
    check(/sainted word records/i.test(work.musicDescription || ''), `${work.id}: the music description credits the label`);
  }
}

// --------------------------------------------------------------------------
console.log('every measurement in the copy is a real measurement');
// --------------------------------------------------------------------------
// The copy states numbers. Those numbers live in `facts`. If a number
// appears in the prose and not in the facts, it was typed by hand and
// nothing checked it.
for (const work of ALL) {
  const factValues = Object.values(work.facts).map(String);
  const prose = work.longDescription + ' ' + (work.musicDescription || '') +
    (work.cuts || []).map((c) => c.description).join(' ');
  const numbers = prose.match(/\b\d+(\.\d+)?\b/g) || [];
  const allowed = new Set(factValues);
  // Small structural numbers (the seven lines, three cuts, 250 Hz) are
  // part of the facts or are fixed structural facts of the work.
  const structural = new Set(['7', '3', '250', '1', '2', '4', '5', '6', '8', '9', '10', '11', '12', '16', '9']);
  const orphans = [...new Set(numbers)].filter((n) => !allowed.has(n) && !structural.has(n));
  eq(orphans.length, 0,
    `${work.id}: every number in the copy is a recorded fact${orphans.length ? ' — unaccounted: ' + orphans : ''}`);
}

// --------------------------------------------------------------------------
console.log('the module renders without a CLI');
// --------------------------------------------------------------------------
check(typeof longDescription(shadow) === 'string', 'longDescription() works standalone');
check(typeof musicDescription(shadow) === 'string', 'musicDescription() works standalone');
check(typeof videoDescription(films) === 'string', 'videoDescription() works standalone');

// --------------------------------------------------------------------------
console.log();
if (_failures.length) {
  console.log(`${_failures.length} FAILED of ${_count} checks:`);
  for (const label of _failures) console.log('  - ' + label);
  process.exit(1);
}
console.log(`all ${_count} checks passed`);
