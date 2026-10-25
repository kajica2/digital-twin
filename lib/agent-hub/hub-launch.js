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

function ensure({ spawnFn = spawn, statusFn = currentStatus, root = HUB_ROOT } = {}) {
    const pidDir = path.join(root, 'pids');
    fs.mkdirSync(pidDir, { recursive: true });
    for (const dir of ['ops', 'twin', 'check', 'tasks', 'memory']) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
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
    if (verb !== 'ensure') {
        warn(`unknown verb "${verb}" — usage: hub-launch.js [ensure|status]`);
        return 2;
    }
    const result = ensure();
    log(result.started.length ? `started ${result.started.length} process(es)` : 'nothing to start');
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = { PROCESSES, planEnsure, currentStatus, ensure, pidFile, readPid, isAlive, HUB_ROOT, REPO };
