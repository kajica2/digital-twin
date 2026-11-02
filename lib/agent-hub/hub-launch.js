#!/usr/bin/env node
'use strict';
// lib/agent-hub/hub-launch.js — the login entry point for the hub.
//
//   node lib/agent-hub/hub-launch.js        # ensure: start what is down
//   node lib/agent-hub/hub-launch.js status # what is running
//
// Why this is node and not the shell script: launchd on Sequoia grants
// filesystem access PER BINARY, and /bin/bash is not granted ~/Documents
// (every spawn of agent-hub.sh from a LaunchAgent fails with "Operation
// not permitted", exit 126). node IS granted it — the same reason
// lib/serve.js replaced `python3 -m http.server` (sprint 0.27) and the
// watcher launchers exec node directly (sprint 0.25/0.26).
//
// `ensure` is idempotent on purpose: `agent-hub.sh start` is a clean
// restart (it kills the pid files' processes first), which a RunAtLoad
// job and its StartInterval tick would do on every run even when the hub
// is healthy — and a restart drops any task a running agent had claimed.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { trimLogDir } = require('./lib/log-trim.js');

const HUB_DIR = __dirname;
const REPO = path.resolve(HUB_DIR, '..', '..');
const HUB_ROOT = process.env.SWR_HUB_ROOT || HUB_DIR;
const PID_DIR = path.join(HUB_ROOT, 'pids');

/** The processes the hub is made of: name → script, coordinator first. */
const PROCESSES = [
    { name: 'hub', script: path.join(HUB_DIR, 'hub-coordinator.js') },
    { name: 'ops', script: path.join(HUB_DIR, 'agents', 'ops', 'swr-ops.js') },
    { name: 'twin', script: path.join(HUB_DIR, 'agents', 'twin', 'swr-twin.js') },
    { name: 'check', script: path.join(HUB_DIR, 'agents', 'check', 'swr-check.js') },
];

function log(msg) { process.stdout.write(`[HUB] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[HUB] ${msg}\n`); }

function pidFile(name) {
    return path.join(PID_DIR, `${name}.pid`);
}

/** The pid a pid file names, or null when there is no readable pid file. */
function readPid(file) {
    try {
        const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/**
 * What to start, from what is already running. Pure, so the decision is
 * testable without spawning anything: the coordinator is included, and
 * the order is the declared one.
 */
function planEnsure(status) {
    const running = status || {};
    return PROCESSES.filter(p => !running[p.name]);
}

/** A fingerprint of what is running now: name → pid, or null. */
function currentStatus() {
    const out = {};
    for (const p of PROCESSES) {
        const pid = readPid(pidFile(p.name));
        out[p.name] = isAlive(pid) ? pid : null;
    }
    return out;
}

/**
 * Start one process in its own session, so it survives this launcher
 * exiting (launchd's job ends the moment this script returns).
 */
function detach(p, spawnFn, pidDir = PID_DIR) {
    const logPath = path.join(pidDir, `${p.name}.log`);
    const fd = fs.openSync(logPath, 'a');
    const child = spawnFn(process.execPath, [p.script], {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: REPO,
        env: process.env,
    });
    child.unref();
    fs.closeSync(fd);
    return child.pid;
}

/**
 * Run the improvement loop, if its own gate says it is due.
 *
 * The loop (lib/improve-loop.js) is deliberately NOT a product-code
 * editor: it records a postmortem, a prevention rule and a tech-debt
 * item when it sees a recurring failure signature in the logs. Applying
 * the lesson stays a separate, deliberate act.
 *
 * The cadence belongs to the LOOP, not to this launcher: the loop keeps
 * its own state file and its own interval gate, so calling it on every
 * launchd tick (every five minutes) costs nothing most of the time. That
 * is also why no second LaunchAgent is needed.
 */
function runImprovementLoop() {
    const { readState, shouldRun, run } = require('../improve-loop.js');
    const state = readState();
    if (!shouldRun(state)) return { ran: false, reason: 'not due' };
    const result = run();
    return { ran: true, result };
}

function ensure({
    spawnFn = spawn,
    statusFn = currentStatus,
    root = HUB_ROOT,
    trimFn = trimLogDir,
    improveFn = runImprovementLoop,
} = {}) {
    const pidDir = path.join(root, 'pids');
    fs.mkdirSync(pidDir, { recursive: true });
    for (const dir of ['ops', 'twin', 'check', 'tasks', 'memory']) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
    }

    // Cap the logs BEFORE anything else. launchd runs this launcher every
    // five minutes, so this is the only trim path that actually runs:
    // bin/log-rotate.sh's own LaunchAgent dies with exit 126 (launchd
    // cannot read ~/Documents with /bin/bash) and never covers pids/.
    // The trim is IN PLACE — renaming the file would orphan the running
    // writer's O_APPEND fd (see lib/log-trim.js).
    try {
        const trimmed = trimFn(pidDir);
        for (const t of trimmed) {
            if (t.trimmed) log(`trimmed ${path.basename(t.file)} ${t.size} → ${t.after} bytes`);
        }
    } catch (e) {
        warn(`log trim failed: ${e.message}`);
    }

    // The improvement loop runs on the same tick, and BEFORE the early
    // return below — a tick that starts nothing is still a tick on which
    // a recurring failure could be recorded.
    try {
        const outcome = improveFn();
        if (outcome && outcome.ran) {
            const written = (outcome.result && outcome.result.written) || [];
            log(`improvement loop: ${written.length} lesson(s) recorded`);
            for (const w of written) log(`  ${w.id}${w.tdId ? ` → ${w.tdId}` : ''}`);
        }
    } catch (e) {
        warn(`improvement loop failed: ${e.message}`);
    }

    const status = statusFn();
    const todo = planEnsure(status);
    if (!todo.length) {
        log(`hub already running (${PROCESSES.map(p => `${p.name} ${status[p.name]}`).join(', ')})`);
        return { started: [], running: status };
    }

    const started = [];
    for (const p of todo) {
        try {
            const pid = detach(p, spawnFn, pidDir);
            fs.writeFileSync(path.join(pidDir, `${p.name}.pid`), `${pid}\n`);
            log(`${p.name} started (pid ${pid})`);
            started.push({ name: p.name, pid });
        } catch (e) {
            warn(`could not start ${p.name}: ${e.message}`);
        }
    }
    return { started, running: statusFn() };
}

function main(argv) {
    const verb = argv[0] || 'ensure';
    if (verb === 'status') {
        const status = currentStatus();
        for (const p of PROCESSES) {
            log(`${p.name}: ${status[p.name] ? `running (pid ${status[p.name]})` : 'not running'}`);
        }
        return 0;
    }
    if (verb === 'trim') {
        const results = trimLogDir(path.join(HUB_ROOT, 'pids'));
        for (const r of results) {
            log(`${path.basename(r.file)}: ${r.trimmed ? `${r.size} → ${r.after} bytes` : `${r.reason} (${r.size} bytes)`}`);
        }
        return 0;
    }
    if (verb === 'improve') {
        const outcome = runImprovementLoop();
        if (!outcome.ran) {
            log(`improvement loop: ${outcome.reason}`);
            return 0;
        }
        const written = (outcome.result && outcome.result.written) || [];
        log(`improvement loop: ${written.length} lesson(s) recorded`);
        for (const w of written) log(`  ${w.id}${w.tdId ? ` → ${w.tdId}` : ''}`);
        return 0;
    }
    if (verb !== 'ensure') {
        warn(`unknown verb "${verb}" — usage: hub-launch.js [ensure|status|trim|improve]`);
        return 2;
    }
    const result = ensure();
    log(result.started.length ? `started ${result.started.length} process(es)` : 'nothing to start');
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    PROCESSES, planEnsure, currentStatus, ensure, pidFile, readPid, isAlive,
    HUB_ROOT, REPO, trimLogDir, runImprovementLoop,
};
