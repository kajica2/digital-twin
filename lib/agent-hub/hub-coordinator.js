#!/usr/bin/env node
/**
 * SWR Agent Hub — coordinator.
 *
 * The coordinator is a MONITOR, not a router.
 *
 * The earlier version scanned every inbox for `[FROM→TO]` lines,
 * appended each one to the target inbox, and then DELETED the file it
 * had just read. Because the agents already write to the recipient's
 * inbox, that loop re-appended a message to the inbox it came from and
 * then unlinked the whole file — destroying every message it touched.
 * The hub needs no router: each agent polls its own inbox and consumes
 * what is addressed to it. This coordinator only watches.
 *
 * It reports, every tick:
 *   - each agent's pid, liveness and last log line
 *   - the task board's counts
 *   - the pending message count per inbox
 *
 * Plain Node, no dependencies. CommonJS.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const hub = require('./lib/hub-runtime.js');
const opsBrain = require('./lib/ops-brain.js');

const ROOT = hub.resolveRoot();
const PID_DIR = path.join(ROOT, 'pids');
const TASKS_FILE = path.join(ROOT, 'tasks', 'swr-ops-tasks.md');

/**
 * Read an agent's pid file and decide whether it is alive.
 *
 * @param {string} name
 * @returns {{running: boolean, pid: number|null, lastActivity: string|null}}
 */
function checkAgent(name) {
  const pidFile = path.join(PID_DIR, `${name}.pid`);
  const logFile = path.join(PID_DIR, `${name}.log`);

  let pid = null;
  if (fs.existsSync(pidFile)) {
    const raw = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(raw)) pid = raw;
  }

  let running = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  let lastActivity = null;
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    lastActivity = lines[lines.length - 1] || null;
  }

  return { running, pid, lastActivity };
}

/**
 * How many messages are waiting in an agent's inbox.
 *
 * The inbox is one file per message, so the depth is the number of
 * message files sitting in it. Foreign envelopes count too — they are
 * waiting, they are just not this agent's to consume.
 *
 * @param {string} name
 * @returns {number}
 */
function inboxDepth(name) {
  const dir = hub.inboxDir(ROOT, name);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  return names.filter((n) => n.endsWith(hub.MESSAGE_EXT)).length;
}

/**
 * The task board's counts.
 *
 * @returns {{blocked: number, inProgress: number, done: number, total: number}}
 */
function boardCounts() {
  if (!fs.existsSync(TASKS_FILE)) return opsBrain.boardCounts(opsBrain.emptyBoard());
  return opsBrain.boardCounts(opsBrain.parseBoard(fs.readFileSync(TASKS_FILE, 'utf8')));
}

/**
 * Render the status report.
 *
 * @returns {string}
 */
function statusReport() {
  const lines = [];
  lines.push(`=== SWR Agent Hub — ${new Date().toISOString()} ===`);
  for (const name of hub.AGENT_IDS) {
    const state = checkAgent(name);
    const mark = state.running ? 'running' : 'STOPPED';
    lines.push(`  ${name.padEnd(6)} ${mark.padEnd(8)} pid=${state.pid ?? '-'} inbox=${inboxDepth(name)}`);
    if (state.lastActivity) lines.push(`         last: ${state.lastActivity}`);
  }
  const counts = boardCounts();
  lines.push(`  board  in-progress=${counts.inProgress} blocked=${counts.blocked} done=${counts.done}`);
  return lines.join('\n');
}

function main() {
  hub.ensureLayout(ROOT);
  fs.mkdirSync(PID_DIR, { recursive: true });

  const report = statusReport();
  console.log(report);

  setInterval(() => {
    try {
      console.log(statusReport());
    } catch (err) {
      console.error(`[HUB] Error: ${err.message}`);
    }
  }, 5000);
}

main();
