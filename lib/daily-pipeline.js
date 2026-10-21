// lib/daily-pipeline.js
//
// Daily mood-journey pipeline. Once a day, on a launchd calendar
// schedule, this composes a tiny creative brief:
//
//   daily/<date>.json          structured record (date, mood, seeds)
//   daily/<date>-music.md      suno-style brief for the day's song
//   prompts-inbox/<date>-<mood>.md  two MJ prompts the existing
//                                   mj-watcher picks up and submits
//
// The mood is picked deterministically from a 12-mood cycle
// (`MOODS` below) indexed by day-of-year, so the same calendar day
// always carries the same mood across runs. Override with --mood.
//
// Idempotent: a re-run on the same date refuses to overwrite the
// daily record. Use --force to bypass.
//
// Pure Node, no deps.

'use strict';

const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { slugify } = require('./mj-prompt-generator.js');

const MOODS = [
  'still', 'dusk', 'dawn', 'drift', 'ember', 'neon',
  'hush',  'vault', 'tide', 'gloss', 'ache', 'bloom',
];

// One sentence per mood — used as the lyrical seed for the music
// brief and the visual subject for the graphics prompts. Keep
// these short and atmospheric; the prompt templates do the rest.
const MOOD_SEEDS = {
  still: 'a room held by the hum of a fan.',
  dusk:  'the last bus pulls away, the platform is yours.',
  dawn:  'city before it remembers its name.',
  drift: 'two boats, one canal, no hurry either way.',
  ember: 'campfire, the kettle argues with the wind.',
  neon:  'a 24-hour diner above the subway.',
  hush:  'library after the librarian turns off the light.',
  vault: 'cathedral just before the service starts.',
  tide:  'a wide flat beach, an even wider sky.',
  gloss: 'a doorway slick with rain at midnight.',
  ache:  'a song you can hum but cannot place.',
  bloom: 'the corner shop is open and no one is buying.',
};

// Two distinct visual subjects per mood, so the prompt pack always
// produces two distinct MJ submissions (not two near-duplicates).
const MOOD_VISUAL_PAIRS = {
  still: ['a single window lit in a sleeping building', 'a teacup cooling on a porch'],
  dusk:  ['a platform seen from the inside of a leaving bus', 'a long shadow crossing a quiet street'],
  dawn:  ['a city seen from a high window at 04:50', 'an empty crosswalk catching the first red'],
  drift: ['a small boat casting off at dawn', 'a bicycle parked against a canal wall'],
  ember: ['a kettle just before it whistles on a campfire', 'a hand turning a page by firelight'],
  neon:  ['a wet windshield lit by passing headlights', 'a coffee cup half-drunk on a formica counter'],
  hush:  ['a single lamp still lit in an empty reading room', 'a hand sliding a book back into its shelf'],
  vault: ['a nave empty at five minutes before the door closes', 'a candle just blown out in a side chapel'],
  tide:  ['the horizon seen from a tidal flat at low tide', 'a single seashell on a wide empty strand'],
  gloss: ['a wet doorway lit from inside by a yellow lamp', 'a reflection of a street sign in a puddle'],
  ache:  ['a song you can hum but cannot place', 'a single late train crossing a viaduct at dusk'],
  bloom: ['a corner shop lit at sunrise, no one in the door', 'a single flower pushing through asphalt'],
};

const DEFAULT_AR = '16:9';

// -------------------- pure helpers (unit-testable) --------------------

/** Convert a Date → 'YYYY-MM-DD' in local time. */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Day of year, 1..365/366, for deterministic mood rotation. */
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  return Math.floor(diff / 86400000);
}

/** Pick today's mood deterministically unless one is provided. */
function moodFor(date, override) {
  if (override) {
    if (!MOODS.includes(override)) {
      throw new Error(`unknown --mood "${override}". valid: ${MOODS.join(', ')}`);
    }
    return override;
  }
  // (0-indexed from 1) so day 1 = MOODS[0]. Same day → same mood.
  return MOODS[(dayOfYear(date) - 1) % MOODS.length];
}

/** A Suno-style brief for today's music. Pure text, no I/O. */
function promptForMusic(date, mood) {
  const seed = MOOD_SEEDS[mood];
  return [
    `# ${formatDate(date)} · mood: ${mood}`,
    '',
    `Start from: ${seed}`,
    '',
    `Tempo: ${tempoFor(mood)}    Length: ~${lengthFor(mood)}    Key: ${keyFor(mood)}`,
    '',
    `One musical motif that earns the silence around it.`,
    '',
    'Lyrics, if any:',
    '',
    `    ${seed}`,
    `    (a single repeated image — the room, the bus, the light)`,
    `    (no story; let the second verse echo the first)`,
    '',
  ].join('\n');
}

// Mood → suggested musical parameters. Deterministic from mood name.
function tempoFor(mood) { return {
  still: '54 bpm', dusk: '62 bpm', dawn: '70 bpm', drift: '88 bpm',
  ember: '92 bpm', neon: '104 bpm', hush: '46 bpm', vault: '58 bpm',
  tide:  '72 bpm', gloss: '110 bpm', ache: '68 bpm', bloom: '116 bpm',
}[mood]; }
function lengthFor(mood) { return {
  still: '2:30',  dusk: '3:10',  dawn: '2:50',  drift: '3:50',
  ember: '3:20',  neon: '4:10',  hush: '2:10',  vault: '3:00',
  tide:  '3:40',  gloss: '4:00',  ache: '2:40',  bloom: '3:30',
}[mood]; }
function keyFor(mood) { return {
  still: 'F minor',  dusk: 'E♭ minor',  dawn: 'D major',
  drift: 'A minor',  ember: 'G major',   neon: 'B♭ minor',
  hush:  'C major',  vault: 'D minor',   tide:  'A♭ major',
  gloss: 'F# minor', ache: 'G minor',    bloom: 'E major',
}[mood]; }

/** Two MJ-style bullets, top-level, each ending in --ar 16:9.
 *  Conforms to PROMPT-EXPANSION-FORMAT.md so the mj-submitter
 *  (lib/mj-submitter.js → extractPrompts) parses them cleanly. */
function promptForGraphics(date, mood) {
  const pair = MOOD_VISUAL_PAIRS[mood] || [`a single image of ${mood}`, `a different image of ${mood}`];
  // subject-first per the sprint-0.32 acceptance-matcher rule.
  const sep = ', ';
  return [
    `${capitalize(pair[0])}, photographed at the moment before it changes${sep}low light${sep}quiet composition${sep}medium format film grain --ar ${DEFAULT_AR}`,
    `${capitalize(pair[1])}, photographed from across the room${sep}no people${sep}the subject holds the frame alone${sep}narrow depth of field --ar ${DEFAULT_AR}`,
  ];
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** Conforms to the MJ pack format the existing mj-watcher accepts. */
function graphicsMarkdown(mood, bullets) {
  const slug = slugify(mood);
  return [
    `# ${mood} — daily mood journey`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    ...bullets,
    '',
  ].join('\n');
}

// -------------------- builder / writer --------------------

function buildDaily(date, opts = {}) {
  const mood = moodFor(date, opts.mood);
  return {
    date: formatDate(date),
    dayOfYear: dayOfYear(date),
    mood,
    music: promptForMusic(date, mood),
    graphics: promptForGraphics(date, mood),
  };
}

/** Write the day's three artifacts. Refuses to overwrite (use --force). */
function writeDaily(daily, opts = {}) {
  const outDir = opts.outDir || join(process.cwd(), 'daily');
  const inbox = opts.inbox || join(process.cwd(), 'prompts-inbox');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(inbox, { recursive: true });

  const slug = slugify(daily.mood);
  const dailyJson = join(outDir, `${daily.date}.json`);
  const musicMd  = join(outDir, `${daily.date}-music.md`);
  const graphicsMd = join(inbox, `${daily.date}-${slug}.md`);

  if (!opts.force) {
    for (const f of [dailyJson, musicMd, graphicsMd]) {
      if (existsSync(f)) {
        throw new Error(
          `already shipped: ${f}\n  use --force to overwrite the day's content`,
        );
      }
    }
  }

  writeFileSync(dailyJson, JSON.stringify({ ...daily, writtenAt: new Date().toISOString() }, null, 2));
  writeFileSync(musicMd, daily.music);
  writeFileSync(graphicsMd, graphicsMarkdown(daily.mood, daily.graphics));

  return { dailyJson, musicMd, graphicsMd };
}

// -------------------- CLI --------------------

function parseArgs(argv) {
  const out = { force: false, apply: false, dryRun: false, date: null, mood: null };
  const eq = (key) => {
    const i = argv.indexOf('--' + key);
    return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null;
  };
  out.date = eq('date');
  out.mood = eq('mood') || (process.env.DAILY_MOOD || null);
  out.force = argv.includes('--force');
  out.apply = argv.includes('--apply');
  out.dryRun = argv.includes('--dry-run') || (!out.apply && !argv.includes('--help'));
  return out;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`\
lib/daily-pipeline.js — daily mood-journey pipeline.

Outputs:
  daily/<YYYY-MM-DD>.json          daily structured record
  daily/<YYYY-MM-DD>-music.md      Suno-style brief
  prompts-inbox/<date>-<mood>.md  MJ pack (the mj-watcher picks it up)

Options:
  --date YYYY-MM-DD     ship for that date (default: today, local time)
  --mood NAME           override the day's mood (one of ${MOODS.length} named moods)
  --apply, --yes        actually write the files (default: dry-run)
  --force               overwrite today's files if they already exist
  --help, -h            this text

The mood is determined deterministically by the day-of-year index, so the
same calendar day always carries the same mood across runs. Override with
--mood or DAILY_MOOD to relabel without changing the calendar.`);
    return 0;
  }
  const opts = parseArgs(argv);
  const date = opts.date ? parseLocalDate(opts.date) : new Date();

  const daily = buildDaily(date, { mood: opts.mood });

  if (opts.dryRun) {
    console.log(JSON.stringify(daily, null, 2));
    console.log('\n--dry-run: pass --apply to write the files.');
    return 0;
  }
  try {
    const paths = writeDaily(daily, { force: opts.force });
    for (const [k, v] of Object.entries(paths)) console.log(`${k}\t${v}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}

/** Parse 'YYYY-MM-DD' (local time). Rejects anything else. */
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) throw new Error(`invalid --date "${s}" (expected YYYY-MM-DD)`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MOODS,
  MOOD_SEEDS,
  MOOD_VISUAL_PAIRS,
  formatDate,
  dayOfYear,
  moodFor,
  promptForMusic,
  promptForGraphics,
  graphicsMarkdown,
  buildDaily,
  writeDaily,
  main,
};
