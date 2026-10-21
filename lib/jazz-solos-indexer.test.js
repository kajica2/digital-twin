#!/usr/bin/env node
// lib/jazz-solos-indexer.test.js
//
// Sprint 0.22 — test harness for the jazz-solos (MIDI corpus)
// indexer. Pure Node, no deps, `node lib/jazz-solos-indexer.test.js`.
//
// Coverage:
//   1. parseCSV: quoted fields containing commas
//   2. parseCSV: escaped quotes ("")
//   3. parseCSV: CRLF line endings
//   4. parseCSV: empty trailing field + trailing newline
//   5. repairRow: well-formed row passes through untouched
//   6. repairRow: comma inside pdf filename
//   7. repairRow: comma inside midi filename
//   8. repairRow: commas in both filenames
//   9. repairRow: bails on an unrepairable row
//  10. repairRow: the real corpus row shape (14 fields, both names split)
//  11. INSTRUMENTS: every WJazzD code present in the corpus is mapped
//  12. integration: full index() against the real corpus, if present

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const jz = require('./jazz-solos-indexer.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
  else {
    failed++;
    failures.push({ label, actual: a, expected: e });
    process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
  }
}
function assertTrue(label, cond) {
  if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
  else      { failed++; failures.push({ label, actual: 'false', expected: 'true' });
              process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[jazz-solos-indexer.test]\n\n`);

// 1–4. CSV parser
process.stderr.write(`1. parseCSV\n`);
assert('quoted field containing a comma',
  jz.parseCSV('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
assert('escaped quote inside quoted field',
  jz.parseCSV('a,"say ""hi""",c\n'), [['a', 'say "hi"', 'c']]);
assert('CRLF line endings',
  jz.parseCSV('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
assert('trailing newline does not emit an empty row',
  jz.parseCSV('a,b\n'), [['a', 'b']]);
assert('real corpus title with a right single quote preserved',
  jz.parseCSV('210,"Joe Lovano","I Can\u2019t Get Started",ts-c\n'),
  [['210', 'Joe Lovano', 'I Can\u2019t Get Started', 'ts-c']]);

// 5–10. row repair
process.stderr.write(`2. repairRow — well-formed\n`);
const HEADER_LEN = 12;
const good = ['1', 'Art Pepper', 'Anthropology', 'cl', 'Cool', '1979', '218.8', '530',
              'ArtPepper_Anthropology_FINAL.pdf', 'ArtPepper_Anthropology_FINAL.mid', 'yes', 'yes'];
const g = jz.repairRow(good, HEADER_LEN);
assert('well-formed row unchanged', g.fields, good);
assertTrue('well-formed row not marked repaired', g.repaired === false);
assertTrue('well-formed row has no reason', g.reason === undefined);

process.stderr.write(`3. repairRow — comma in pdf filename\n`);
// As the CSV parser emits it: the unquoted comma splits one filename
// into two fields, so the row arrives with 13 fields.
const commaPdf = ['2', 'X', 'Y', 'ts', 'Postbop', '2001', '300', '100',
                  'Perf_Tit', 'Le_FINAL.pdf', 'Perf_Tit_FINAL.mid', 'yes', 'yes'];
const rp = jz.repairRow(commaPdf, HEADER_LEN);
assertTrue('pdf-comma row repaired', rp.repaired === true);
assert('pdf filename rejoined', rp.fields[8], 'Perf_Tit,Le_FINAL.pdf');
assert('midi filename intact', rp.fields[9], 'Perf_Tit_FINAL.mid');
assert('field count restored', rp.fields.length, HEADER_LEN);

process.stderr.write(`4. repairRow — comma in midi filename\n`);
const commaMidi = ['3', 'X', 'Y', 'ts', 'Postbop', '2001', '300', '100',
                   'Perf_Tit_FINAL.pdf', 'Perf_Tit', 'Le_FINAL.mid', 'yes', 'yes'];
const rm = jz.repairRow(commaMidi, HEADER_LEN);
assertTrue('midi-comma row repaired', rm.repaired === true);
assert('pdf filename intact', rm.fields[8], 'Perf_Tit_FINAL.pdf');
assert('midi filename rejoined', rm.fields[9], 'Perf_Tit,Le_FINAL.mid');
assert('field count restored', rm.fields.length, HEADER_LEN);

process.stderr.write(`5. repairRow — commas in both filenames\n`);
const both = ['4', 'X', 'Y', 'ts', 'Postbop', '2001', '300', '100',
              'Perf_Ti', 't', 'Le_FINAL.pdf', 'Perf_Ti', 't', 'Le_FINAL.mid', 'yes', 'yes'];
const rb = jz.repairRow(both, HEADER_LEN);
assertTrue('both-comma row repaired', rb.repaired === true);
assert('pdf rejoined', rb.fields[8], 'Perf_Ti,t,Le_FINAL.pdf');
assert('midi rejoined', rb.fields[9], 'Perf_Ti,t,Le_FINAL.mid');
assert('field count restored', rb.fields.length, HEADER_LEN);

process.stderr.write(`6. repairRow — unrepairable\n`);
const bad = ['5', 'X', 'Y', 'ts', 'Postbop', '2001', '300', '100',
             'no-extension-here', 'also-none', 'junk', 'yes', 'yes'];
const rbad = jz.repairRow(bad, HEADER_LEN);
assertTrue('unrepairable row not marked repaired', rbad.repaired === false);
assert('unrepairable row carries a reason', rbad.reason, 'unrepairable');

process.stderr.write(`7. repairRow — real corpus row (Chris Potter id 81)\n`);
// Verbatim from manifest.csv line 82: the title is correctly quoted, but
// both filenames contain an unquoted comma, producing 14 fields.
const realRow = ['81', 'Chris Potter', 'Item 1, D.I.T.', 'ts', 'Postbop', '2001',
                 '301.0', '1631', 'ChrisPotter_Item1', 'D.I.T._FINAL.pdf',
                 'ChrisPotter_Item1', 'D.I.T._FINAL.mid', 'yes', 'yes'];
const rr = jz.repairRow(realRow, HEADER_LEN);
assertTrue('real malformed row repaired', rr.repaired === true);
assert('field count restored to 12', rr.fields.length, HEADER_LEN);
assert('pdf filename rejoined', rr.fields[8], 'ChrisPotter_Item1,D.I.T._FINAL.pdf');
assert('midi filename rejoined', rr.fields[9], 'ChrisPotter_Item1,D.I.T._FINAL.mid');
assert('has_pdf preserved', rr.fields[10], 'yes');
assert('has_midi preserved', rr.fields[11], 'yes');
assert('instrument preserved', rr.fields[3], 'ts');
assert('tones preserved', rr.fields[7], '1631');

// 11. instrument map covers the corpus
process.stderr.write(`8. INSTRUMENTS map\n`);
const CORPUS_CODES = ['as', 'ts', 'ts-c', 'bs', 'ss', 'cl', 'bcl',
                      'tp', 'cor', 'tb', 'vib', 'p', 'g'];
for (const code of CORPUS_CODES) {
  assertTrue(`instrument code "${code}" is mapped`, !!jz.INSTRUMENTS[code]);
}

// 12. integration against the real corpus (skipped when absent)
process.stderr.write(`9. integration (real corpus)\n`);
const MANIFEST = path.join(process.env.HOME || '', 'Documents', 'jazz solos', 'manifest.csv');
if (!fs.existsSync(MANIFEST)) {
  process.stderr.write(`  – skipped: ${MANIFEST} not present\n`);
} else {
  const cat = jz.index();
  const c = cat.source.counts;
  assert('manifest rows', c.manifestRows, 456);
  assert('catalog items', c.items, 456);
  assert('every row verified against disk', c.midiVerified, c.midiOnDisk);
  assert('every pdf verified against disk', c.pdfVerified, c.pdfOnDisk);
  assert('exactly one malformed row repaired', cat.source.repairs.length, 1);
  assert('repair is the Chris Potter row', cat.source.repairs[0].id, '81');
  assert('performers', cat.performers.length, 78);
  assert('styles', cat.styles.length, 8);
  assert('instruments', cat.instruments.length, 13);
  assert('no manifest/disk discrepancies', cat.source.discrepancies, []);
  assert('no manifest-orphan midi files', cat.source.orphanMidi, []);
  assert('no unmapped instrument codes', cat.source.unknownInstruments, []);
  // Spot-check a known row end-to-end.
  const anth = cat.items.find(i => i.performer === 'Art Pepper' && i.title === 'Anthropology');
  assertTrue('Art Pepper / Anthropology present', !!anth);
  assert('  instrumentName', anth.instrumentName, 'clarinet');
  assert('  tempo', anth.tempo, 218.8);
  assert('  hasMidi', anth.hasMidi, true);
  assert('  midi filename', anth.midi, 'ArtPepper_Anthropology_FINAL.mid');
  // The one known-missing MIDI (corpus README documents it).
  const blanche = cat.items.find(i => i.title === 'Blues for Blanche');
  assertTrue('Blues for Blanche present', !!blanche);
  assert('  hasMidi false (documented gap)', blanche.hasMidi, false);
  assert('  hasPdf true', blanche.hasPdf, true);
  // The repaired row's flags must agree with disk.
  const potter = cat.items.find(i => i.performer === 'Chris Potter' && i.title.includes('D.I.T'));
  assertTrue('repaired row present', !!potter);
  assert('  hasMidi true after repair', potter.hasMidi, true);
  assert('  midi filename keeps the comma', potter.midi, 'ChrisPotter_Item1,D.I.T._FINAL.mid');
}

process.stderr.write(`\n[jazz-solos-indexer.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
  for (const f of failures) {
    process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
  }
}
process.exit(failed === 0 ? 0 : 1);
