#!/usr/bin/env node
'use strict';

// lib/boot.js — the digital-twin boot core. Fires at login via
// ~/Library/LaunchAgents/com.kaidjuric.digital-twin.boot.plist, which
// runs boot-launcher.sh, which execs this file.
//
// WHY NODE AND NOT BASH
// ---------------------
// launchd's spawn context on Sequoia cannot exec *or even read* a
// script under $HOME/Documents: TCC grants filesystem access per
// binary, and /bin/bash has no grant for that tree. The old
// bin/boot.sh died on every login with
//
//   /bin/bash: .../bin/boot.sh: Operation not permitted   (exit 126)
//
// Node (from ~/.hermes/node) does have the grant — that is the same
// reason lib/serve.js exists (AGENTS.md sprint 0.27) and the same
// shape every watcher launcher uses. The boot sequence therefore runs
// here, in Node, and bin/boot.sh is gone.
//
// Steps, in order:
//   1. auto-update  — fetch, fast-forward, reload agents whose code moved
//   2. server       — ensure the server LaunchAgent is loaded + running
//   3. health       — wait for http://127.0.0.1:$PORT/
//   4. browser      — open the Twin OS PWA
//   5. optional     — --terminal (tail the server log), --notes (status note)
//
// Calm by default: no Terminal window, no Notes app brought forward.
// Both are opt-in flags, because "opens two app windows on every
// login" is the opposite of what the twin is for.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOME = os.homedir();
const LOGDIR = path.join(REPO, 'logs');
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const LAUNCHCTL = '/bin/launchctl';
const CURL = '/usr/bin/curl';
const GIT = '/usr/bin/git';

const SERVER_LABEL = 'com.kaidjuric.digital-twin.server';
const SERVER_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${SERVER_LABEL}.plist`);

// Which LaunchAgents read which files. A pull that touches one of
// these needs that agent reloaded to pick the new code up — otherwise
// the running process keeps the old module in memory until the next
// login (the same trap sprint 0.46 hit with the social worker).
const AGENTS = [
  ['com.kaidjuric.digital-twin.chart-watcher', 'lib/chart-watcher.js'],
  ['com.kaidjuric.digital-twin.songs-watcher', 'lib/songs-watcher.js'],
  ['com.kaidjuric.digital-twin.mj-watcher', 'lib/mj-watcher.js'],
  ['com.kaidjuric.digital-twin.reel-watcher', 'lib/reel-watcher.js'],
  ['com.kaidjuric.digital-twin.server', 'lib/serve.js'],
  ['com.kaidjuric.digital-twin.daily-pipeline', 'lib/daily-pipeline.js'],
  ['com.kaidjuric.digital-twin.daily-content', 'lib/daily-content.js'],
  ['com.kaidjuric.digital-twin.marketplace-hourly', 'lib/marketplace-hourly.js'],
  ['com.kaidjuric.digital-twin.social-worker', 'lib/social-engine.js'],
  ['com.kaidjuric.digital-twin.gumroad-sync', 'lib/gumroad.js'],
];

// ---------------------------------------------------------------------------
// pure helpers (unit-tested without a browser, launchd or a network)
// ---------------------------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** The launchd state word from `launchctl print`, or null when absent. */
function parseLaunchctlState(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\s*state\s*=\s*(\S.*?)\s*$/m);
  return m ? m[1] : null;
}

/** Agent labels to reload given the repo-relative paths a pull touched. */
function reloadTargets(changedPaths, agents = AGENTS) {
  const changed = new Set((changedPaths || []).map((p) => String(p).trim()).filter(Boolean));
  return agents.filter(([, file]) => changed.has(file)).map(([label]) => label);
}

/** Argv → options. `error` is set for an unknown flag: this CLI opens
 *  windows and starts services, so a typo must not be a silent no-op. */
function parseArgs(argv) {
  const opts = {
    updateOnly: false,
    open: true,
    terminal: false,
    notes: false,
    port: Number(process.env.TWIN_PORT || 5173),
    help: false,
    error: null,
  };
  const args = argv || [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--update-only') opts.updateOnly = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--terminal') opts.terminal = true;
    else if (a === '--notes') opts.notes = true;
    else if (a === '--no-notes') opts.notes = false;
    else if (a === '--port') {
      const v = Number(args[i + 1]);
      if (!Number.isInteger(v) || v <= 0 || v > 65535) {
        opts.error = `--port needs a port number, got ${JSON.stringify(args[i + 1])}`;
        return opts;
      }
      opts.port = v;
      i += 1;
    } else {
      opts.error = `unknown flag: ${a}`;
      return opts;
    }
  }
  return opts;
}

function usage() {
  return [
    'usage: node lib/boot.js [--update-only] [--no-open] [--terminal] [--notes] [--port N]',
    '',
    '  --update-only   fetch + fast-forward + reload changed agents, then exit',
    '  --no-open       start the server but do not open the browser',
    '  --terminal      also open a Terminal tailing the server log',
    '  --notes         also post a status note to Apple Notes',
    '  --port N        server port (default 5173, or $TWIN_PORT)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// side effects
// ---------------------------------------------------------------------------

const LOG_FILE = () => path.join(LOGDIR, `boot-${dayKey()}.log`);

function log(line) {
  const text = `${line}\n`;
  process.stdout.write(text);
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(LOG_FILE(), text);
  } catch {
    // A boot that cannot write its log still has to boot.
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
    cwd: opts.cwd || REPO,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    out: (res.stdout || '').trim(),
    err: (res.stderr || '').trim(),
  };
}

function launchctlPrint(label) {
  const res = run(LAUNCHCTL, ['print', `gui/${UID}/${label}`], { timeout: 10000 });
  return res.ok ? res.out : null;
}

function agentLoaded(label) {
  return launchctlPrint(label) !== null;
}

function kickstart(label) {
  return run(LAUNCHCTL, ['kickstart', '-k', `gui/${UID}/${label}`], { timeout: 15000 }).ok;
}

function git(args, timeout = 60000) {
  return run(GIT, args, { timeout });
}

/** fetch, fast-forward, and report what changed. Never throws. */
function autoUpdate(branch = process.env.TWIN_UPDATE_BRANCH || 'main') {
  const result = { status: 'unknown', commits: 0, changed: [], reloaded: [], detail: '' };

  if (!git(['rev-parse', '--git-dir']).ok) {
    result.status = 'not-a-repo';
    result.detail = `${REPO} is not a git checkout`;
    return result;
  }

  const fetch = git(['fetch', 'origin', branch], 120000);
  if (!fetch.ok) {
    result.status = 'offline';
    result.detail = 'fetch failed — offline or auth? continuing at current HEAD';
    return result;
  }

  const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]);
  const count = Number(behind.out || 0);
  if (!behind.ok || count === 0) {
    result.status = 'current';
    result.detail = `up to date (HEAD = origin/${branch})`;
    return result;
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty.out) {
    result.status = 'dirty';
    result.detail = `REFUSED: ${dirty.out.split('\n').length} uncommitted change(s)`;
    return result;
  }

  const before = git(['rev-parse', 'HEAD']).out;
  const pull = git(['merge', '--ff-only', `origin/${branch}`], 180000);
  if (!pull.ok) {
    result.status = 'failed';
    result.detail = `fast-forward failed: ${pull.err.split('\n')[0] || 'not a fast-forward'}`;
    return result;
  }

  const after = git(['rev-parse', 'HEAD']).out;
  const diff = git(['diff', '--name-only', `${before}..${after}`]);
  result.status = 'updated';
  result.commits = count;
  result.changed = diff.out ? diff.out.split('\n').filter(Boolean) : [];
  result.detail = `${count} commit(s) fast-forwarded, ${result.changed.length} file(s) changed`;

  for (const label of reloadTargets(result.changed)) {
    if (!agentLoaded(label)) continue;
    if (kickstart(label)) result.reloaded.push(label);
  }
  return result;
}

/** Make sure the server agent is loaded and running. */
function ensureServer() {
  let bootstrapped = false;
  if (!agentLoaded(SERVER_LABEL)) {
    if (!fs.existsSync(SERVER_PLIST)) {
      return { ok: false, detail: `plist missing: ${SERVER_PLIST}` };
    }
    const boot = run(LAUNCHCTL, ['bootstrap', `gui/${UID}`, SERVER_PLIST], { timeout: 20000 });
    if (!boot.ok && !/already|exists/i.test(boot.err)) {
      return { ok: false, detail: `bootstrap failed: ${boot.err || boot.status}` };
    }
    bootstrapped = true;
  }
  const state = parseLaunchctlState(launchctlPrint(SERVER_LABEL) || '');
  if (state === 'running') {
    return { ok: true, detail: bootstrapped ? 'bootstrapped, running' : 'already running' };
  }
  if (kickstart(SERVER_LABEL)) {
    return { ok: true, detail: bootstrapped ? 'bootstrapped, kickstarted' : 'kickstarted' };
  }
  return { ok: false, detail: `not running (state=${state})` };
}

function probe(port) {
  return run(CURL, ['-fsS', '-o', '/dev/null', '--max-time', '1', `http://127.0.0.1:${port}/`],
    { timeout: 4000 }).ok;
}

/** Wait for the server to answer. Returns the seconds it took, or null. */
function waitForServer(port, tries = 40, stepMs = 250) {
  for (let i = 1; i <= tries; i += 1) {
    if (probe(port)) return (i * stepMs) / 1000;
    sleepSync(stepMs);
  }
  return null;
}

function openTwinOS(port) {
  const url = `http://127.0.0.1:${port}/pages/twin-os/`;
  const res = run('/usr/bin/open', [url], { timeout: 15000 });
  return { ok: res.ok, url, detail: res.ok ? 'opened' : (res.err || `open exit ${res.status}`) };
}

function runAppleScript(script, args) {
  const res = run('/usr/bin/osascript', [path.join(REPO, 'bin', script), ...args],
    { timeout: 30000 });
  return { ok: res.ok, detail: res.ok ? res.out : (res.err || `exit ${res.status}`) };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${usage()}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  log(`[${formatStamp()}] digital-twin boot start (node ${process.version}, port ${opts.port})`);

  // --- 1. auto-update ---------------------------------------------------
  const upd = autoUpdate();
  const tag = { updated: 'updated', current: 'current', dirty: 'refused', offline: 'offline',
    failed: 'FAILED', 'not-a-repo': 'FATAL' }[upd.status] || upd.status;
  log(`  auto-update: ${tag} — ${upd.detail}`);
  for (const label of upd.reloaded) log(`  reloaded ${label}`);

  if (opts.updateOnly) {
    log(`[${formatStamp()}] digital-twin boot end (update only)`);
    return upd.status === 'failed' ? 1 : 0;
  }

  // --- 2. server --------------------------------------------------------
  const server = ensureServer();
  log(`  server agent: ${server.detail}`);

  // --- 3. health --------------------------------------------------------
  let healthy = false;
  if (server.ok) {
    const secs = waitForServer(opts.port);
    healthy = secs !== null;
    log(healthy ? `  server up after ${secs.toFixed(2)}s` : '  WARN: server did not answer — continuing');
  }

  // --- 4. browser -------------------------------------------------------
  if (opts.open && healthy) {
    const opened = openTwinOS(opts.port);
    log(`  twin os: ${opened.detail} ${opened.url}`);
  } else if (!opts.open) {
    log('  twin os: skipped (--no-open)');
  }

  // --- 5. opt-in extras -------------------------------------------------
  if (opts.terminal) {
    const t = runAppleScript('terminal-log.applescript', [path.join(LOGDIR, 'server.log')]);
    log(`  terminal: ${t.detail}`);
  }
  if (opts.notes) {
    const n = runAppleScript('notes.applescript', ['twin OS', formatStamp(), String(opts.port)]);
    log(`  notes: ${n.detail}`);
  }

  log(`[${formatStamp()}] digital-twin boot end`);
  return healthy ? 0 : 1;
}

module.exports = {
  REPO,
  AGENTS,
  formatStamp,
  dayKey,
  parseLaunchctlState,
  reloadTargets,
  parseArgs,
  usage,
  autoUpdate,
  ensureServer,
  waitForServer,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
