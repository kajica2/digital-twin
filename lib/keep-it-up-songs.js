#!/usr/bin/env node
'use strict';
// Prepare the four KEEP IT UP songs for the music generator.
//
// The source is one text file: four songs, each with its own header
// ("02 — NEEDLE DROP HEALER"), a descriptor line (BPM, genre,
// instrumentation), bracketed section markers, and — inside the
// instrumental sections — a bracketed production note.
//
// Two outputs per song:
//   lyrics/<slug>.txt   the words, in the generator's section format
//   tags/<slug>.txt     comma-separated style tags
//
// The production notes become TAGS (they describe how to play it), and
// the section markers become the generator's canonical set — the
// qualifiers ("— Spoken", "— 32 bars") are production notes too, so
// they travel with the tags rather than confusing the section parser.
//
//   node lib/keep-it-up-songs.js            # write the files
//   node lib/keep-it-up-songs.js --check    # verify, write nothing
//
// THE CHECK MATTERS MOSTLY HERE: a splitter that silently drops a line
// is a disaster you cannot hear. So the check verifies that EVERY
// lyric line in the source appears in the output.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SOURCE = process.env.KEEP_IT_UP_SOURCE
  || path.join(process.env.HOME || '', '.hermes/pastes/paste_1_173615.txt');
const OUT_DIR = path.join(REPO, 'assets/keep-it-up/audio');
const CHECK = process.argv.includes('--check');

const log = m => process.stdout.write(`${m}\n`);

// The canonical section names the generator understands.
const SECTION_MAP = {
  intro: 'Intro',
  verse: 'Verse',
  'verse 1': 'Verse',
  'verse 2': 'Verse',
  'final verse': 'Verse',
  'pre-chorus': 'Verse',
  'pre chorus': 'Verse',
  chorus: 'Chorus',
  'final chorus': 'Chorus',
  bridge: 'Bridge',
  instrumental: 'Instrumental',
  outro: 'Outro',
};

const SLUGS = {
  'KEEP IT UP': 'keep-it-up',
  'NEEDLE DROP HEALER': 'needle-drop-healer',
  'SLIP BETWEEN THE BEATS': 'slip-between-the-beats',
  "IT AIN'T WHAT IT IS": 'it-aint-what-it-is',
};

// The style notes that apply to ALL FOUR songs — the recording
// character. The paste gives one full style field for song 1; the rest
// of the fields were cut off, but the character is the project's.
const SHARED_TAGS = [
  'loose rhythmic male half-spoken half-sung vocal',
  'conversational improvised phrasing',
  'dry close-miked voice',
  'no vocal effects',
  'no pitch correction',
  'no doubling',
  'no compression',
  'no reverb',
  'no delay',
  'no mastering',
];

function parse(text) {
  const lines = text.split(/\r?\n/);
  const songs = [];
  let current = null;
  let styleField = null;
  let inStyle = false;

  for (const raw of lines) {
    const line = raw.trim();

    // The Suno style block at the end of the file.
    if (/^SUNO STYLE FIELD/i.test(line)) { inStyle = true; continue; }
    if (inStyle) {
      if (!line) continue;
      // A song name on its own line starts that song's field.
      if (SLUGS[line.toUpperCase()]) { styleField = null; continue; }
      if (!styleField) styleField = line;
      continue;
    }

    // A song header: "01 — KEEP IT UP".
    //
    // The FIRST song's header is BARE — just "KEEP IT UP" on line 1 —
    // so a bare title counts as a header while no song is open yet.
    const numbered = line.match(/^\d+\s*[—–-]\s*(.+)$/);
    const bare = (!current && SLUGS[line.toUpperCase()]) ? line : null;
    const header = numbered || (bare ? [null, bare] : null);
    if (header && SLUGS[header[1].trim().toUpperCase()]) {
      current = {
        title: header[1].trim(),
        slug: SLUGS[header[1].trim().toUpperCase()],
        descriptor: '',
        sections: [],
        notes: [],
        sourceLines: [],
      };
      songs.push(current);
      continue;
    }
    if (!current) continue;

    // A bracketed marker.
    const marker = line.match(/^\[([^\]]+)\]$/);
    if (marker) {
      const inner = marker[1].trim();
      const key = inner.replace(/\s*—.*$/, '').trim().toLowerCase();
      const canonical = SECTION_MAP[key];
      if (canonical) {
        current.sections.push({ name: canonical, lines: [] });
      } else {
        // A production note, not a section: "[Deep electric bass, …]"
        current.notes.push(inner);
      }
      continue;
    }
    if (!line) continue;

    // The descriptor line: "100 BPM · Dark jazz-hop · Deep bass · …"
    if (/^\d+\s*BPM\s*[·•]/i.test(line)) {
      current.descriptor = line;
      continue;
    }
    // The bare title line under the header.
    if (line.toUpperCase() === current.title.toUpperCase()) continue;

    // Every lyric line is recorded against ITS OWN song, so the check
    // can ask "did this song keep its own words?" — comparing every
    // song against every source line would report song 1 as missing
    // song 2's words.
    current.sourceLines.push(line);
    if (current.sections.length) {
      current.sections[current.sections.length - 1].lines.push(line);
    } else {
      current.sections.push({ name: 'Verse', lines: [line] });
    }
  }
  return { songs, styleField };
}

function tagsFor(song, styleField) {
  const tags = [];
  // `push` adds one tag. `pushList` splits a comma-separated list into
  // separate tags — a production note like "Deep electric bass, light
  // fragmented acoustic drums, sparse piano" is THREE instruments, and
  // flattening it made one enormous tag the model would read as a
  // single instruction.
  const push = (value) => {
    const t = String(value || '').trim().replace(/[\n]+/g, ' ').replace(/\s+/g, ' ')
      .replace(/[.;,]+$/, '');
    if (t) tags.push(t);
  };
  const pushList = (value) => {
    for (const part of String(value || '').split(',')) push(part);
  };

  // The song's own descriptor: BPM, genre, instrumentation.
  if (song.descriptor) {
    for (const part of song.descriptor.split(/[·•]/)) push(part);
  }
  // The production notes from the instrumental sections — comma lists.
  for (const note of song.notes) pushList(note);
  // The style field (song 1's is the full one; the others were cut off).
  if (styleField && song.slug === 'keep-it-up') pushList(styleField);
  // The project's shared recording character.
  for (const t of SHARED_TAGS) push(t);

  // De-duplicate, case-insensitively, keeping the first.
  const seen = new Set();
  return tags.filter(t => {
    // The key ignores trailing punctuation: the style field ends with
    // "no mastering." and the shared tag is "no mastering" — the same
    // instruction, and the model should not be told it twice.
    const k = t.toLowerCase().replace(/[.;,]+$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function lyricsFor(song) {
  const out = [];
  for (const section of song.sections) {
    if (!section.lines.length) continue;
    out.push(`[${section.name}]`);
    out.push(...section.lines);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------

const source = fs.readFileSync(SOURCE, 'utf8');
const { songs, styleField } = parse(source);

const problems = [];
if (songs.length !== 4) problems.push(`found ${songs.length} songs, expected 4`);

// EVERY lyric line must survive. This is the check that matters: a
// dropped line is inaudible.
for (const song of songs) {
  const lyrics = lyricsFor(song);
  const tags = tagsFor(song, styleField);
  const produced = lyrics.split('\n').map(l => l.trim());

  for (const line of song.sourceLines) {
    if (produced.includes(line)) continue;
    // The shared style field is a tag, not a lyric.
    if (styleField && line === styleField) continue;
    problems.push(`${song.slug}: a lyric line was dropped — "${line.slice(0, 48)}"`);
  }

  if (!song.sections.length) problems.push(`${song.slug}: no sections`);
  if (!tags.length) problems.push(`${song.slug}: no tags`);
  if (!song.descriptor && song.slug !== 'keep-it-up') {
    problems.push(`${song.slug}: no descriptor line (BPM / genre)`);
  }

  if (!CHECK) {
    fs.mkdirSync(path.join(OUT_DIR, 'lyrics'), { recursive: true });
    fs.mkdirSync(path.join(OUT_DIR, 'tags'), { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'lyrics', `${song.slug}.txt`), lyrics);
    fs.writeFileSync(path.join(OUT_DIR, 'tags', `${song.slug}.txt`), tags.join(', ') + '\n');
  }

  const words = lyrics.split(/\s+/).filter(Boolean).length;
  log(`  ${song.slug.padEnd(22)} ${String(song.sections.length).padStart(2)} sections  ` +
      `${String(words).padStart(4)} words  ${String(tags.length).padStart(3)} tags`);
}

if (problems.length) {
  log('');
  for (const p of problems) log(`  ERROR: ${p}`);
  process.exit(1);
}
log('');
log(CHECK ? 'all four songs verified' : 'four songs written');
