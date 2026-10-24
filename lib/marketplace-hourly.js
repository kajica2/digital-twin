#!/usr/bin/env node
'use strict';

// lib/marketplace-hourly.js
//
// The hourly marketplace burst: one collection an hour, for a fixed
// number of hours, rendered on Midjourney and published exactly the way
// the daily run publishes.
//
//   data/marketplace/hourly-burst.json   the burst state (gitignored)
//   assets/marketplace/daily/<key>/      the published bundle (tracked)
//
// Why a key and not a date: the daily run names its bundle after the
// day ('2026-10-24'), so a second collection on the same day would
// overwrite the first. The burst names its bundles after the hour
// ('2026-10-24T13'), and every consumer — the reel hand-off, the social
// engine, the catalogue — keys on that name.
//
// Three modes:
//   --init    write the plan (the next N hourly slots) and stop
//   --once    run the pending slot for the CURRENT hour, if the burst
//             has one — this is the launchd tick
//   --burst   stay up and run each slot when its hour arrives
//
// A slot that fails is recorded and the burst continues: one bad hour
// must not cost the other ten. A slot that already ran is skipped, so a
// restart (or a reboot) resumes rather than repeats.
//
// Nothing here invents copy and nothing here publishes to a social
// account: the burst renders, publishes and hands the plates to the reel
// pipeline; the social worker stages the posts and the posting gate
// stays shut.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO, 'data', 'marketplace', 'hourly-burst.json');
const LIBRARY_PATH = path.join(__dirname, 'daily-collections.json');
const DAILY_RUN = path.join(__dirname, 'daily-content.js');

const DEFAULT_RUNS = 11;
const DEFAULT_INTERVAL_HOURS = 1;
// The burst gets its OWN browser port and profile. The daily agent owns
// 9445, the MJ watcher owns 9444, and a calendar job typing into a
// shared composer is a collision waiting to happen.
const DEFAULT_PORT = '9448';
const DEFAULT_PROFILE = '/tmp/mj-hourly-profile';

function log(msg) { process.stdout.write(`[hourly] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[hourly] ${msg}\n`); }
function fail(msg, code = 1) {
    process.stderr.write(`[hourly] ERROR: ${msg}\n`);
    process.exit(code);
}

// -------------------- pure helpers (unit-testable) --------------------

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' in local time. */
function localDateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The bundle key of an hour: 'YYYY-MM-DDTHH'.
 *
 * The key is also the published directory name, so it must survive
 * sanitizeKey() — letters, digits, one dash and one T.
 */
function slotKey(d) {
    return `${localDateKey(d)}T${pad(d.getHours())}`;
}

/** The hour boundary at or before `d`. */
function hourFloor(d) {
    const x = new Date(d.getTime());
    x.setMinutes(0, 0, 0);
    return x;
}

/**
 * The next hour boundary at or after `d`.
 *
 * A run that starts exactly on the hour anchors on that hour (the slot
 * is due now); a run that starts mid-hour anchors on the next one.
 */
function hourCeil(d) {
    const x = hourFloor(d);
    if (x.getTime() < d.getTime()) x.setHours(x.getHours() + 1);
    return x;
}

/** Local timestamp without a timezone: 'YYYY-MM-DDTHH:MM:SS'. */
function localStamp(d) {
    return `${localDateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The burst's slots: `runs` hour boundaries starting at the next one.
 *
 * Each slot carries the bundle key it will publish under, the date it
 * belongs to and the hour of the day — the three things every consumer
 * needs, and nothing that depends on the machine's timezone spelling.
 *
 * The interval is a whole number of HOURS on purpose. The bundle key is
 * the hour, so two slots inside the same hour would publish into the
 * same directory and the second would overwrite the first. A
 * sub-hourly cadence would need the key to carry minutes, and every
 * consumer (the reel hand-off, the social engine, the catalogue) keys
 * on the hour.
 */
function planSlots({ now = new Date(), runs = DEFAULT_RUNS, intervalHours = DEFAULT_INTERVAL_HOURS } = {}) {
    const anchor = hourCeil(now);
    const out = [];
    for (let i = 0; i < runs; i++) {
        const at = new Date(anchor.getTime());
        at.setHours(at.getHours() + i * intervalHours);
        out.push({
            at: localStamp(at),
            key: slotKey(at),
            date: localDateKey(at),
            hour: at.getHours(),
            collection: null,
            status: 'pending',
            startedAt: null,
            finishedAt: null,
            taskIds: [],
            error: null,
        });
    }
    return out;
}

/**
 * The collections for the slots, walking the library and wrapping.
 *
 * `offset` skips the collection the daily run already publishes that
 * day (it is picked by day-of-year), so a day carries twelve distinct
 * collections rather than one twice.
 */
function rotateCollections(library, offset = 0, count = 0) {
    const list = (library && Array.isArray(library.collections)) ? library.collections : [];
    if (!list.length || count <= 0) return [];
    const start = ((offset % list.length) + list.length) % list.length;
    const out = [];
    for (let i = 0; i < count; i++) {
        const item = list[(start + i) % list.length];
        out.push(item && item.id ? item.id : null);
    }
    return out;
}

/** The day-of-year, used to pick a collection offset. */
function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d.getTime() - start.getTime()) / 86400000);
    return days + 1;
}

/** A fresh burst: the plan plus the collections it will run. */
function newState({ now = new Date(), runs = DEFAULT_RUNS, intervalHours = DEFAULT_INTERVAL_HOURS, library = null } = {}) {
    const slots = planSlots({ now, runs, intervalHours });
    const list = (library && Array.isArray(library.collections)) ? library.collections : [];
    const ids = rotateCollections(library, dayOfYear(now) + 1, slots.length);
    slots.forEach((s, i) => { s.collection = ids[i] || null; });
    return {
        version: 1,
        createdAt: new Date().toISOString(),
        runs,
        intervalHours,
        slots,
    };
}

/**
 * The state file, or null when there is none.
 *
 * A corrupt state file is treated as no state: the burst then re-plans
 * rather than crashing a launchd tick every hour.
 */
function loadState(file = STATE_PATH) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || !Array.isArray(parsed.slots)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Write the state atomically: a served state file is never half-written. */
function saveState(state, file = STATE_PATH) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return file;
}

/**
 * The slot belonging to the current hour, or null.
 *
 * The hour is matched on the local date AND the local hour, so a slot
 * from yesterday can never be run by today's tick.
 */
function slotFor(state, now = new Date()) {
    if (!state || !Array.isArray(state.slots)) return null;
    const date = localDateKey(now);
    const hour = now.getHours();
    return state.slots.find(s => s.date === date && s.hour === hour) || null;
}

/**
 * The slots that still have to run, oldest first.
 *
 * 'pending' means exactly that. A 'done' slot is finished, a 'failed'
 * slot is RECORDED and not retried (a retry loop would quietly burn a
 * Midjourney quota on a permanent failure — the operator re-runs a slot
 * by hand), and a 'running' slot belongs to another process.
 */
function pendingSlots(state) {
    if (!state || !Array.isArray(state.slots)) return [];
    return state.slots.filter(s => s.status === 'pending');
}

/**
 * Whether a slot may be taken over.
 *
 * A slot left 'running' by a crash would otherwise never run again, so
 * a run that has been going for more than `staleMinutes` is taken over.
 */
function slotIsStale(slot, now = new Date(), staleMinutes = 90) {
    if (!slot || slot.status !== 'running') return false;
    const started = Date.parse(slot.startedAt || '');
    if (!Number.isFinite(started)) return true;
    return (now.getTime() - started) > staleMinutes * 60 * 1000;
}

/** Record what a slot did. Returns the same state object. */
function applySlotResult(state, key, patch = {}) {
    if (!state || !Array.isArray(state.slots)) return state;
    const slot = state.slots.find(s => s.key === key);
    if (!slot) return state;
    Object.assign(slot, patch);
    return state;
}

/** The library's collections, or an empty library when it cannot be read. */
function loadLibrary(file = LIBRARY_PATH) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.collections)) return parsed;
    } catch { /* fall through */ }
    return { collections: [] };
}

// -------------------- the run --------------------

/**
 * The command that runs one slot.
 *
 * Pure: the arguments are data, so the contract — WHICH date, WHICH
 * key, WHICH collection — is testable without spending a Midjourney
 * quota. The key is the whole point: the daily run publishes under it.
 */
function slotArgs(slot, { port = DEFAULT_PORT, profile = DEFAULT_PROFILE, dryRun = false } = {}) {
    const args = [
        DAILY_RUN,
        '--date', slot.date,
        '--key', slot.key,
        '--collection', slot.collection,
        '--port', String(port),
        '--profile', profile,
    ];
    if (dryRun) args.push('--dry-run');
    return args;
}

/**
 * Run one slot: the daily run, keyed by the hour.
 *
 * The daily run owns the rendering, the publishing and the reel
 * hand-off; this file only decides WHEN and WHAT. Duplicating the run
 * here would be two places to keep in step.
 */
function runSlot(slot, { port = DEFAULT_PORT, profile = DEFAULT_PROFILE, dryRun = false, timeoutMs = 45 * 60 * 1000 } = {}) {
    const args = slotArgs(slot, { port, profile, dryRun });
    const res = spawnSync(process.execPath, args, {
        cwd: REPO,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
    });
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    if (res.error) return { ok: false, code: res.error.code || 1, stdout, stderr, error: res.error.message };
    return { ok: res.status === 0, code: res.status === null ? 1 : res.status, stdout, stderr, error: null };
}

/** The task ids the published bundle carries, read back from disk. */
function publishedTaskIds(key, dir = path.join(REPO, 'assets', 'marketplace', 'daily')) {
    try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, key, 'plates.json'), 'utf8'));
        const plates = Array.isArray(doc.plates) ? doc.plates : [];
        return plates.map(p => p.taskId).filter(Boolean);
    } catch {
        return [];
    }
}

/** A human-readable plan. */
function describePlan(state) {
    if (!state || !Array.isArray(state.slots)) return '(no plan)';
    return state.slots
        .map(s => `  ${s.at}  ${s.key}  ${s.collection || '?'}  ${s.status}`)
        .join('\n');
}

// -------------------- CLI --------------------

function argVal(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
}

function sleepSync(ms) {
    // A synchronous sleep: the burst mode has nothing to await, and
    // Atomics.wait is the honest way to block a Node process without a
    // timer keeping the event loop alive.
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
}

// The flags this CLI understands. A flag that is not on this list is a
// mistake, and a mistake here costs a Midjourney generation.
const VALUE_FLAGS = ['--runs', '--interval-hours', '--port', '--profile', '--state', '--slot'];
const BOOL_FLAGS = ['--plan', '--init', '--once', '--burst', '--dry-run', '--force', '--help', '-h'];

function usage() {
    return [
        'lib/marketplace-hourly.js — the hourly marketplace burst',
        '',
        '  --plan                 print the schedule and change nothing',
        '  --init                 write the plan (the next N hourly slots) and stop',
        '  --once                 run the pending slot for THIS hour (the launchd tick)',
        '  --burst                stay up and run each slot when its hour arrives',
        "  --slot <key>           run ONE named slot (the operator's path)",
        '  --force                run a slot that already ran',
        '  --dry-run              plan only — no browser, no generations',
        `  --runs <n>             how many slots (default ${DEFAULT_RUNS})`,
        `  --interval-hours <n>   whole hours between slots (default ${DEFAULT_INTERVAL_HOURS})`,
        `  --port <port>          the browser port (default ${DEFAULT_PORT})`,
        `  --profile <dir>        the browser profile (default ${DEFAULT_PROFILE})`,
        '  --state <file>         the burst state file',
        '  --help                 this text',
    ].join('\n');
}

/** The unknown flags in argv (a value flag's own value is not a flag). */
function unknownFlags(argv = process.argv.slice(2)) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) continue;
        if (BOOL_FLAGS.includes(arg) || VALUE_FLAGS.includes(arg)) {
            if (VALUE_FLAGS.includes(arg)) i++; // skip its value
            continue;
        }
        out.push(arg);
    }
    return out;
}

function main() {
    // --help prints the usage and stops. It has to come FIRST: the
    // first version of this file ignored unknown flags, so `--help`
    // started a real render and spent a Midjourney generation.
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }
    // An unknown flag is a mistake, and this CLI spends a paid quota.
    const unknown = unknownFlags();
    if (unknown.length) fail(`unknown flag(s): ${unknown.join(', ')} — try --help`, 2);

    const dryRun = process.argv.includes('--dry-run');
    const planOnly = process.argv.includes('--plan');
    const init = process.argv.includes('--init');
    const once = process.argv.includes('--once');
    const burst = process.argv.includes('--burst');
    const runs = Number(argVal('--runs', String(DEFAULT_RUNS)));
    const intervalHours = Number(argVal('--interval-hours', String(DEFAULT_INTERVAL_HOURS)));
    const port = argVal('--port', DEFAULT_PORT);
    const profile = argVal('--profile', DEFAULT_PROFILE);
    const stateFile = argVal('--state', STATE_PATH);

    if (!Number.isFinite(runs) || runs < 1) fail(`bad --runs: ${argVal('--runs')}`);
    if (!Number.isFinite(intervalHours) || intervalHours < 1) fail(`bad --interval-hours: ${argVal('--interval-hours')} (a whole number of hours)`);

    const now = new Date();
    const library = loadLibrary();
    if (!library.collections.length) fail(`no collections in ${LIBRARY_PATH}`);

    // --plan: print the plan (the existing one if there is a burst, the
    // prospective one otherwise) and change nothing.
    if (planOnly) {
        const state = loadState(stateFile) || newState({ now, runs, intervalHours, library });
        log(`the burst (${state.slots.length} slot(s), every ${state.intervalHours} h):`);
        process.stdout.write(`${describePlan(state)}\n`);
        return 0;
    }

    // --init: write the plan. An existing burst is kept while it still
    // has slots to run — re-planning would throw away the slots that
    // already ran. A FINISHED burst (nothing pending) is replaced, so
    // the next window can be planned.
    if (init) {
        const existing = loadState(stateFile);
        if (existing && pendingSlots(existing).length) {
            log(`a burst is already planned (${existing.slots.length} slot(s)) — kept`);
            process.stdout.write(`${describePlan(existing)}\n`);
            return 0;
        }
        if (existing) log(`the burst is finished (${existing.slots.length} slot(s)) — planning a new one`);
        const state = newState({ now, runs, intervalHours, library });
        saveState(state, stateFile);
        log(`planned ${state.slots.length} slot(s) -> ${stateFile}`);
        process.stdout.write(`${describePlan(state)}\n`);
        return 0;
    }

    // --slot <key>: run ONE named slot. The operator's path — a slot
    // that failed, or one the machine missed while it was asleep.
    const slotKeyArg = argVal('--slot', null);
    if (slotKeyArg !== null) {
        let state = loadState(stateFile);
        if (!state) {
            state = newState({ now, runs, intervalHours, library });
            saveState(state, stateFile);
            log(`no burst on disk — planned one from the next hour (${state.slots.length} slot(s))`);
        }
        const slot = state.slots.find(s => s.key === slotKeyArg);
        if (!slot) {
            fail(`no slot ${slotKeyArg} in the burst`);
            return 2;
        }
        if (slot.status === 'done' && !process.argv.includes('--force')) {
            log(`${slot.key} already ran — skipped (--force to run it again)`);
            return 0;
        }
        return executeSlot(state, slot, { port, profile, dryRun, stateFile });
    }

    // --once: the launchd tick. Runs the slot belonging to THIS hour, if
    // the burst has one and it has not run yet.
    if (once) {
        let state = loadState(stateFile);
        if (!state) {
            // No burst on disk (a wiped state, a fresh machine): plan
            // one, anchored on the next hour, so the tick still works.
            state = newState({ now, runs, intervalHours, library });
            saveState(state, stateFile);
            log(`no burst on disk — planned one from the next hour (${state.slots.length} slot(s))`);
        }
        const slot = slotFor(state, now);
        if (!slot) {
            log(`no slot for ${localDateKey(now)} ${pad(now.getHours())}:00 — nothing to do`);
            return 0;
        }
        if (slot.status === 'done') {
            log(`${slot.key} already ran — skipped`);
            return 0;
        }
        if (slot.status === 'failed') {
            // Recorded, not retried: a retry loop would quietly spend a
            // Midjourney quota on a failure that will not heal itself.
            log(`${slot.key} failed earlier (${slot.error || 'no reason recorded'}) — not retried`);
            return 0;
        }
        if (slot.status === 'running' && !slotIsStale(slot, now)) {
            log(`${slot.key} is already running — skipped`);
            return 0;
        }
        if (slot.status === 'running') {
            log(`${slot.key} was left running — taken over`);
        }
        return executeSlot(state, slot, { port, profile, dryRun, stateFile });
    }

    // --burst: stay up and run each slot when its hour arrives.
    if (burst) {
        let state = loadState(stateFile);
        if (!state) {
            state = newState({ now, runs, intervalHours, library });
            saveState(state, stateFile);
            log(`planned ${state.slots.length} slot(s) -> ${stateFile}`);
        }
        log(`burst running — ${state.slots.length} slot(s), every ${state.intervalHours} h`);
        process.stdout.write(`${describePlan(state)}\n`);
        for (const slot of state.slots) {
            if (slot.status === 'done') {
                log(`${slot.key} already ran — skipped`);
                continue;
            }
            const due = new Date(`${slot.at}`);
            const waitMs = due.getTime() - Date.now();
            if (waitMs > 0) {
                log(`${slot.key} is due at ${slot.at} — waiting ${Math.round(waitMs / 60000)} min`);
                sleepSync(waitMs);
            }
            // Re-read the state: another process may have run the slot.
            state = loadState(stateFile) || state;
            const fresh = state.slots.find(s => s.key === slot.key) || slot;
            if (fresh.status === 'done') {
                log(`${slot.key} already ran — skipped`);
                continue;
            }
            executeSlot(state, fresh, { port, profile, dryRun, stateFile });
            state = loadState(stateFile) || state;
        }
        log('burst complete');
        return 0;
    }

    // No mode: show the plan. The tool is burst-driven and a bare
    // invocation must not silently spend a Midjourney quota.
    const state = loadState(stateFile) || newState({ now, runs, intervalHours, library });
    log('the burst (nothing run — use --init, --once or --burst):');
    process.stdout.write(`${describePlan(state)}\n`);
    return 0;
}

/** Run one slot and record what happened. Never throws. */
function executeSlot(state, slot, { port, profile, dryRun, stateFile }) {
    log(`${slot.key}: running ${slot.collection}`);
    const started = new Date().toISOString();
    applySlotResult(state, slot.key, { status: 'running', startedAt: started, error: null });
    saveState(state, stateFile);

    const res = runSlot(slot, { port, profile, dryRun });
    const finished = new Date().toISOString();
    const taskIds = res.ok ? publishedTaskIds(slot.key) : [];
    applySlotResult(state, slot.key, {
        status: res.ok ? 'done' : 'failed',
        finishedAt: finished,
        taskIds,
        error: res.ok ? null : (res.error || res.stderr || `exit ${res.code}`).toString().trim().slice(0, 2000),
    });
    saveState(state, stateFile);
    if (res.ok) {
        log(`${slot.key}: published ${slot.collection} (${taskIds.length} plate(s))`);
    } else {
        // One bad hour must not cost the other ten.
        warn(`${slot.key}: FAILED (exit ${res.code}) — ${(res.error || res.stderr || '').toString().trim().slice(0, 400)}`);
    }
    return res.ok ? 0 : 1;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = {
    localDateKey, slotKey, hourFloor, hourCeil, localStamp, dayOfYear,
    planSlots, rotateCollections, newState, loadState, saveState,
    slotFor, pendingSlots, slotIsStale, applySlotResult, loadLibrary, runSlot, slotArgs,
    publishedTaskIds, describePlan, usage, unknownFlags,
    STATE_PATH, LIBRARY_PATH, DEFAULT_RUNS, DEFAULT_INTERVAL_HOURS,
    DEFAULT_PORT, DEFAULT_PROFILE,
};
