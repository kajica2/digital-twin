// lib/marketplace-hourly.test.js
//
// Pure-Node tests for the hourly marketplace burst. Same convention as
// the rest of the repo: `node:assert/strict`, a `check(name, cond)`
// helper, plain `node <file>` runner, non-zero exit on failure.
//
// The Midjourney part is not exercised here — a burst spends a real
// quota — so the tests cover the parts that decide WHEN and WHAT, and
// the parts that decide whether a burst resumes or repeats.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const hourly = require('./marketplace-hourly.js');
const {
  localDateKey, slotKey, hourFloor, hourCeil, dayOfYear,
  planSlots, rotateCollections, newState, loadState, saveState,
  slotFor, pendingSlots, slotIsStale, applySlotResult, loadLibrary,
} = hourly;

const daily = require('./daily-content.js');

const LIBRARY = JSON.parse(readFileSync(join(__dirname, 'daily-collections.json'), 'utf8'));

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}
function section(n) { console.log(`${n}.`); }
function freshDate(y, m, d, h = 0, min = 0) { return new Date(y, m - 1, d, h, min, 0); }
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-hourly-'));
  return path.join(dir, name);
}

// --------------------------------------------------------------------
section('the slot key');
// --------------------------------------------------------------------

(function () {
  check('the key is the local date and the hour', slotKey(freshDate(2026, 10, 24, 13)) === '2026-10-24T13');
  check('the hour is padded', slotKey(freshDate(2026, 10, 24, 9)) === '2026-10-24T09');
  check('the key survives the daily run sanitizer', daily.sanitizeKey(slotKey(freshDate(2026, 10, 24, 13))) === '2026-10-24T13');
  check('the key survives the sanitizer at midnight', daily.sanitizeKey(slotKey(freshDate(2026, 10, 24, 0))) === '2026-10-24T00');
  check('the local date key is the date, not the UTC date',
    localDateKey(freshDate(2026, 10, 24, 23)) === '2026-10-24');
  check('the day of year is 1 on Jan 1', dayOfYear(freshDate(2026, 1, 1)) === 1);
})();

// --------------------------------------------------------------------
section('the schedule');
// --------------------------------------------------------------------

(function () {
  const slots = planSlots({ now: freshDate(2026, 10, 24, 12, 23), runs: 11, intervalHours: 1 });
  check('eleven slots by default', slots.length === 11);
  check('the first slot is the NEXT hour (12:23 -> 13:00)', slots[0].hour === 13 && slots[0].date === '2026-10-24');
  check('the slots are one hour apart',
    slots.every((s, i) => i === 0 || s.hour === (slots[i - 1].hour + 1) % 24));
  check('the last slot is ten hours after the first',
    slots[slots.length - 1].at === '2026-10-24T23:00:00');
  check('a burst that starts late rolls into the next day',
    planSlots({ now: freshDate(2026, 10, 24, 14, 0), runs: 11 })[slots.length - 1].date === '2026-10-25');
  check('every slot carries its own key',
    new Set(slots.map(s => s.key)).size === slots.length);
  check('every key matches its date and hour',
    slots.every(s => s.key === `${s.date}T${String(s.hour).padStart(2, '0')}`));

  const exact = planSlots({ now: freshDate(2026, 10, 24, 13, 0), runs: 3 });
  check('a run that starts exactly on the hour anchors on that hour', exact[0].hour === 13);

  const every3 = planSlots({ now: freshDate(2026, 10, 24, 12, 30), runs: 4, intervalHours: 3 });
  check('a three hour interval moves three hours', every3[1].hour === 16);
  check('the slots are aligned to the hour', every3.every(s => s.at.endsWith(':00:00')));
  check('the keys stay unique under a longer interval',
    new Set(every3.map(s => s.key)).size === 4);

  check('the hour floor is the hour', hourFloor(freshDate(2026, 10, 24, 13, 45)).getHours() === 13);
  check('the hour ceil is the next hour', hourCeil(freshDate(2026, 10, 24, 13, 45)).getHours() === 14);
  check('the hour ceil of an exact hour is that hour', hourCeil(freshDate(2026, 10, 24, 13, 0)).getHours() === 13);
})();

// --------------------------------------------------------------------
section('the collection rotation');
// --------------------------------------------------------------------

(function () {
  const list = LIBRARY.collections;
  const ids = rotateCollections(LIBRARY, 0, 11);
  check('eleven collections for an eleven slot burst', ids.length === 11);
  check('no collection repeats inside the burst', new Set(ids).size === 11);
  check('the rotation walks the library in order',
    ids[0] === list[0].id && ids[1] === list[1].id);
  check('the rotation wraps', rotateCollections(LIBRARY, 0, list.length + 2)[list.length] === list[0].id);
  check('a rotation longer than the library still repeats',
    new Set(rotateCollections(LIBRARY, 0, list.length + 2)).size === list.length);
  check('an offset past the end wraps', rotateCollections(LIBRARY, list.length + 1, 1)[0] === list[1].id);
  check('an empty library yields nothing', rotateCollections({ collections: [] }, 0, 5).length === 0);
})();

// --------------------------------------------------------------------
section('the burst state');
// --------------------------------------------------------------------

(function () {
  const now = freshDate(2026, 10, 24, 12, 23);
  const state = newState({ now, runs: 11, intervalHours: 1, library: LIBRARY });
  check('the state has eleven slots', state.slots.length === 11);
  check('every slot has a collection', state.slots.every(s => s.collection));
  check('no collection repeats inside the burst',
    new Set(state.slots.map(s => s.collection)).size === 11);
  check('the first slot is pending', state.slots[0].status === 'pending');
  check('every slot starts with no task ids', state.slots.every(s => s.taskIds.length === 0));
  check('the burst does not repeat the collection the daily run publishes',
    state.slots[0].collection !== daily.pickCollection(LIBRARY, now).id);

  const file = tmpFile('burst.json');
  saveState(state, file);
  const back = loadState(file);
  check('the state round-trips', Boolean(back) && back.slots.length === 11);
  check('the round-trip keeps the collections',
    Boolean(back) && back.slots[0].collection === state.slots[0].collection);

  // A second save REPLACES the file — the write must land, not merely
  // create a side file. (A write that only wrote a temp file would
  // leave the old state in place, and the burst would re-run a slot it
  // had already run.)
  applySlotResult(state, state.slots[0].key, { status: 'done' });
  saveState(state, file);
  const second = loadState(file);
  check('a second save replaces the state',
    Boolean(second) && second.slots[0].status === 'done');
  check('a second save keeps the slot count', Boolean(second) && second.slots.length === 11);
  check('no temp file is left behind', !fs.existsSync(`${file}.tmp`));

  check('a missing state file is null', loadState(path.join(path.dirname(file), 'nope.json')) === null);
  fs.writeFileSync(file, '{ this is not json');
  check('a corrupt state file is null, not a crash', loadState(file) === null);
})();

// --------------------------------------------------------------------
section('the slot lookup');
// --------------------------------------------------------------------

(function () {
  const now = freshDate(2026, 10, 24, 12, 23);
  const state = newState({ now, runs: 11, intervalHours: 1, library: LIBRARY });

  const at13 = slotFor(state, freshDate(2026, 10, 24, 13, 30));
  check('the tick finds the slot of the current hour', at13 && at13.key === '2026-10-24T13');
  check('the slot of an hour the burst does not cover is null',
    slotFor(state, freshDate(2026, 10, 26, 13, 30)) === null);
  check('a slot from another day is not matched by the hour alone',
    slotFor(state, freshDate(2026, 10, 25, 13, 30)) === null);

  check('every slot is pending at the start', pendingSlots(state).length === 11);
  applySlotResult(state, state.slots[0].key, { status: 'done' });
  check('a done slot is not pending', pendingSlots(state).length === 10);
  check('the done slot is the one that was marked',
    state.slots.find(s => s.key === state.slots[0].key).status === 'done');
  check('a slot that has not run is still pending',
    pendingSlots(state).every(s => s.status !== 'done'));
  check('applying to an unknown key changes nothing', applySlotResult(state, 'nope', { status: 'done' }).slots.length === 11);
})();

// --------------------------------------------------------------------
section('the daily run publishes under the key');
// --------------------------------------------------------------------

(function () {
  const collection = LIBRARY.collections[0];
  const entry = daily.buildEntry({
    date: '2026-10-24', key: '2026-10-24T13', collection,
    plates: [{ file: 'frame-01.jpg', caption: 'c', alt: 'a', taskId: 't1', width: 1280, height: 716 }],
  });
  check('the entry carries the key', entry.key === '2026-10-24T13');
  check('the entry keeps the true date', entry.date === '2026-10-24');
  check('the entry points at the keyed directory',
    entry.dir === 'assets/marketplace/daily/2026-10-24T13');

  const legacy = daily.buildEntry({ date: '2026-10-24', collection, plates: [] });
  check('an entry without a key falls back to the date', legacy.key === '2026-10-24');
  check('the fallback directory is the date', legacy.dir === 'assets/marketplace/daily/2026-10-24');

  const one = daily.updateIndex({ collections: [] }, entry);
  const two = daily.updateIndex(one, daily.buildEntry({
    date: '2026-10-24', key: '2026-10-24T14', collection, plates: [],
  }));
  check('two collections on one date coexist', two.collections.length === 2);
  check('the newest comes first', two.collections[0].key === '2026-10-24T14');

  const replaced = daily.updateIndex(two, daily.buildEntry({
    date: '2026-10-24', key: '2026-10-24T13', collection, plates: [],
  }));
  check('the same key replaces its own entry', replaced.collections.length === 2);
  check('a legacy entry still dedupes on its date',
    daily.updateIndex({ collections: [{ date: '2026-10-24', id: 'x' }] },
      daily.buildEntry({ date: '2026-10-24', collection, plates: [] })).collections.length === 1);

  check('a bad key is refused', daily.sanitizeKey('../escape') === '');
  check('a key with a slash is refused', daily.sanitizeKey('2026/10') === '');
  check('a key with a space is refused', daily.sanitizeKey('2026 10') === '');
  check('an ordinary key passes', daily.sanitizeKey('2026-10-24T13') === '2026-10-24T13');
})();

// --------------------------------------------------------------------
section('the consumers see the slot bundles');
// --------------------------------------------------------------------

(function () {
  const reels = require('./daily-reels.js');
  const engine = require('./social-engine.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-bundles-'));
  const dailyRoot = path.join(dir, 'daily');
  fs.mkdirSync(path.join(dailyRoot, '2026-10-24T13'), { recursive: true });
  fs.mkdirSync(path.join(dailyRoot, '2026-10-25'), { recursive: true });
  fs.mkdirSync(path.join(dailyRoot, 'not-a-bundle'), { recursive: true });
  fs.writeFileSync(path.join(dailyRoot, '2026-10-24T13', 'plates.json'), JSON.stringify({
    pack: 'relay', title: 'Relay', badge: 'cyberpunk / hk',
    plates: [{ file: 'frame-01.jpg', caption: 'A pylon at dawn', alt: 'A pylon at dawn', prompt: 'a pylon at dawn, no text' }],
  }));
  fs.writeFileSync(path.join(dailyRoot, '2026-10-25', 'plates.json'), JSON.stringify({
    pack: 'daily', plates: [{ file: 'frame-01.jpg', caption: 'A plate', alt: 'A plate', prompt: 'a plate, no text' }],
  }));
  const days = reels.listDays(dailyRoot);
  check('the hour bundle is listed', days.includes('2026-10-24T13'));
  check('the date bundle is still listed', days.includes('2026-10-25'));
  check('a directory that is not a bundle is ignored', !days.includes('not-a-bundle'));

  // The real discovery path: a bundle directory becomes a product.
  const found = engine.discoverCatalogue({ sources: { catalogue: { dir } } });
  const hourlyProduct = found.find(p => p.id.includes('2026-10-24t13'));
  check('the social engine makes a product of the hour bundle', Boolean(hourlyProduct));
  check('the hour product keeps the bundle date', Boolean(hourlyProduct) && hourlyProduct.meta.date === '2026-10-24T13');
  check('the date bundle still becomes a product', found.some(p => p.id.includes('2026-10-25')));
  check('a directory that is not a bundle becomes nothing', found.length === 2);
})();

// --------------------------------------------------------------------
section('the slot statuses');
// --------------------------------------------------------------------

(function () {
  const st = newState({ now: freshDate(2026, 10, 24, 12, 23), runs: 11, intervalHours: 1, library: LIBRARY });
  check('a fresh burst has pending slots', pendingSlots(st).length === 11);

  applySlotResult(st, st.slots[0].key, { status: 'done' });
  check('a done slot is not pending', pendingSlots(st).length === 10);

  applySlotResult(st, st.slots[1].key, { status: 'failed', error: 'boom' });
  check('a failed slot is not pending', pendingSlots(st).length === 9);
  check('a failed slot keeps its reason', st.slots[1].error === 'boom');

  applySlotResult(st, st.slots[2].key, { status: 'running', startedAt: new Date().toISOString() });
  check('a running slot is not pending', pendingSlots(st).length === 8);
  check('a fresh running slot is not stale',
    !slotIsStale(st.slots[2], new Date()));
  check('a running slot from long ago is stale',
    slotIsStale({ status: 'running', startedAt: '2026-10-24T09:00:00.000Z' },
      new Date('2026-10-24T12:00:00.000Z')));
  check('a done slot is never stale', !slotIsStale({ status: 'done' }, new Date()));
  check('a pending slot is never stale', !slotIsStale({ status: 'pending' }, new Date()));
})();

// --------------------------------------------------------------------
section('the slot command');
// --------------------------------------------------------------------

(function () {
  const slot = { date: '2026-10-24', key: '2026-10-24T13', collection: 'relay' };
  const args = hourly.slotArgs(slot, { port: '9448', profile: '/tmp/mj-hourly-profile' });
  const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  check('the command runs the daily run', args[0].endsWith('daily-content.js'));
  check('the command carries the date', valueOf('--date') === '2026-10-24');
  check('the command carries the KEY, not the date', valueOf('--key') === '2026-10-24T13');
  check('the key is not the date', valueOf('--key') !== valueOf('--date'));
  check('the command carries the collection', valueOf('--collection') === 'relay');
  check('the command carries its own port', valueOf('--port') === '9448');
  check('the command carries its own profile', valueOf('--profile') === '/tmp/mj-hourly-profile');
  check('a normal run is not a dry run', !args.includes('--dry-run'));
  check('a dry run says so', hourly.slotArgs(slot, { dryRun: true }).includes('--dry-run'));
})();

// --------------------------------------------------------------------
section('the library loads');
// --------------------------------------------------------------------

(function () {
  const lib = loadLibrary();
  check('the library has collections', Array.isArray(lib.collections) && lib.collections.length > 0);
  check('every collection has an id', lib.collections.every(c => c.id));
})();

// --------------------------------------------------------------------
section('the flags are guarded');
// --------------------------------------------------------------------

(function () {
  // The accident: `--help` is not a flag this CLI understood, and the
  // unknown flag was ignored — so `--help` started a real render and
  // spent a Midjourney generation. An unknown flag must now be a
  // refusal, and `--help` must print and stop.
  check('a known boolean flag is not unknown', hourly.unknownFlags(['--once']).length === 0);
  check('a known value flag is not unknown', hourly.unknownFlags(['--port', '9448']).length === 0);
  check('a value flag’s value is not read as a flag', hourly.unknownFlags(['--port', '9448']).length === 0);
  check('an unknown flag is caught', hourly.unknownFlags(['--nope']).length === 1);
  check('--help is a KNOWN flag (it prints and stops)', hourly.unknownFlags(['--help']).length === 0);
  check('an unknown flag is named', hourly.unknownFlags(['--nope']).includes('--nope'));
  check('two unknown flags are both caught', hourly.unknownFlags(['--nope', '--also']).length === 2);
  check('an unknown flag after a value flag is caught',
    hourly.unknownFlags(['--port', '9448', '--nope']).length === 1);
  check('a bare positional is not a flag', hourly.unknownFlags(['hello']).length === 0);

  const usage = hourly.usage();
  check('the usage names every mode', ['--plan', '--init', '--once', '--burst', '--slot'].every(f => usage.includes(f)));
  check('the usage names --help', usage.includes('--help'));
  check('the usage names the value flags',
    ['--runs', '--interval-hours', '--port', '--profile', '--state'].every(f => usage.includes(f)));
})();

// --------------------------------------------------------------------
section('the CLI refuses to spend quota on a mistake');
// --------------------------------------------------------------------

(function () {
  // The proof that the guard is not just a helper: the CLI itself must
  // print and stop on --help, and must refuse an unknown flag, without
  // touching Midjourney.
  const cli = path.join(__dirname, 'marketplace-hourly.js');
  const run = (args) => require('node:child_process').spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 30000,
  });

  const helped = run(['--help']);
  check('--help exits 0', helped.status === 0);
  check('--help prints the usage', /hourly marketplace burst/.test(helped.stdout || ''));
  check('--help does not start a render', !/\[mj-web\]/.test(helped.stdout || ''));
  check('--help does not plan anything', !/planned/.test(helped.stdout || ''));

  const bogus = run(['--nope']);
  check('an unknown flag exits 2', bogus.status === 2);
  check('an unknown flag is named in the error', /--nope/.test(bogus.stderr || ''));
  check('an unknown flag renders nothing', !/\[mj-web\]/.test(bogus.stdout || ''));
})();

console.log(`[marketplace-hourly.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed ? 1 : 0);
