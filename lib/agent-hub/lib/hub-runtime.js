#!/usr/bin/env node
/**
 * SWR Agent Hub — shared runtime.
 *
 * One place that owns:
 *   - where the hub's state lives (the ROOT), so a second instance in a
 *     different directory cannot collide with this one
 *   - the message envelope format
 *   - the inbox protocol (append / take)
 *
 * The message envelope is the contract between the three agents:
 *
 *   [OPS→TWIN] New task: build the reel pipeline
 *
 * A message is written to the RECIPIENT's inbox. It is never written to
 * the sender's. That is the whole protocol: the sender appends, the
 * recipient takes. (An earlier coordinator "routed" lines between
 * inboxes and deleted the source file — which destroyed every message
 * it touched. The hub has no router at all now; each agent polls its
 * own inbox.)
 *
 * Pure logic lives here so it can be unit-tested without spawning
 * anything; the filesystem helpers are thin wrappers over it.
 *
 * Plain Node, no dependencies. CommonJS, like the rest of lib/.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The three agents the hub runs. */
const AGENT_IDS = ['ops', 'twin', 'check'];

/**
 * Default root: the hub's own directory (lib/agent-hub).
 *
 * This file lives in lib/agent-hub/lib, so the hub's directory is ONE
 * level up. Two levels up is lib/ — the agents then looked for their
 * task board in lib/tasks/ and loaded zero tasks.
 */
const DEFAULT_ROOT = path.join(__dirname, '..');

/**
 * Resolve the hub root.
 *
 * SWR_HUB_ROOT lets a second hub instance run out of its own directory
 * (its own pids, logs, inboxes, task board and memory) without touching
 * this one — the answer to "can several agent harnesses coexist without
 * interfering".
 *
 * @param {string} [root] explicit root; falls back to the env var.
 * @returns {string} absolute path.
 */
function resolveRoot(root) {
  const chosen = root || process.env.SWR_HUB_ROOT || DEFAULT_ROOT;
  return path.resolve(chosen);
}

/** True when `id` is one of the three known agents. */
function isAgentId(id) {
  return AGENT_IDS.includes(String(id || '').toLowerCase());
}

/**
 * Format a message envelope.
 *
 * @param {string} from sender id.
 * @param {string} to recipient id.
 * @param {string} body message text.
 * @returns {string} the envelope line (no trailing newline).
 */
function formatMessage(from, to, body) {
  const text = String(body == null ? '' : body).replace(/\s+$/, '');
  return `[${String(from).toUpperCase()}→${String(to).toUpperCase()}] ${text}`;
}

/**
 * Parse a message envelope.
 *
 * @param {string} line one line of an inbox.
 * @returns {{from: string, to: string, body: string}|null} null when the
 *   line is not an envelope (blank lines, notes, foreign formats).
 */
function parseMessage(line) {
  // The input is trimmed first: a message read from a FILE carries its
  // trailing newline, and `$` without the multiline flag does not match
  // before it — so a perfectly good envelope read off disk would parse
  // as null.
  const text = String(line == null ? '' : line).trim();
  const m = /^\s*\[([A-Za-z0-9_-]+)→([A-Za-z0-9_-]+)\]\s*(.*)$/.exec(text);
  if (!m) return null;
  return { from: m[1].toLowerCase(), to: m[2].toLowerCase(), body: m[3].trim() };
}

/**
 * Directory holding an agent's inbox — ONE FILE PER MESSAGE.
 *
 * The inbox used to be a single shared `inbox.txt` that the sender
 * appended to and the recipient rewrote (read → filter → temp file →
 * rename). That is a read-modify-write on a shared mutable file: any
 * append landing between the read and the rename was silently
 * destroyed. Under concurrent load the hub ate messages with no error
 * anywhere — the exact failure a three-agent runtime cannot have.
 *
 * One file per message removes the shared mutable file entirely. The
 * sender creates a new uniquely-named file; the reader claims each file
 * with an atomic rename. There is no window in which a message can be
 * overwritten, because nothing is ever overwritten.
 */
function inboxDir(root, agent) {
  return path.join(resolveRoot(root), String(agent).toLowerCase(), 'inbox');
}

/** Suffix of a message file. Anything else in the inbox dir is ignored. */
const MESSAGE_EXT = '.msg';

/** Prefix of a file that is mid-claim (renamed aside, not yet read). */
const CLAIM_PREFIX = '.claimed-';

/** Prefix of a file that is mid-write (not yet renamed into place). */
const TMP_PREFIX = '.tmp-';

/**
 * Is this file a COMPLETE message, safe to read?
 *
 * Only three kinds of name exist in a message directory:
 *   - a finished message      → readable
 *   - a writer's in-flight temp (`.tmp-…`) → NOT readable
 *   - a file mid-claim        (`.claimed-…`) → NOT readable
 *
 * The temp case is a real trap, and it loses messages. A writer creates
 * `.tmp-<name>.msg`, writes into it, then renames it to `<name>.msg`.
 * A reader that treats the temp file as a message RENAMES it aside —
 * which makes the writer's own rename fail with ENOENT, killing the
 * writer mid-batch. Measured: a 300-message batch lost 297 of them,
 * and the writer died on the fourth message.
 *
 * The same trap sat in the command channel, where it also let a reader
 * consume a half-written command.
 *
 * So: a message is only a candidate when it is neither a temp file nor
 * an already-claimed one.
 */
function isCandidateName(name) {
  if (typeof name !== 'string') return false;
  if (!name.endsWith(MESSAGE_EXT)) return false;
  if (name.startsWith(TMP_PREFIX)) return false;
  if (name.startsWith(CLAIM_PREFIX)) return false;
  return true;
}

/** Per-process counter, so one process's messages keep their order. */
let messageSeq = 0;

/**
 * Allocate a unique, chronologically sortable message file name.
 *
 * The timestamp is padded so a plain lexicographic sort is chronological.
 * The pid keeps two processes from colliding inside the same
 * millisecond, and the counter keeps one process's messages in order.
 */
function messageName() {
  const ts = String(Date.now()).padStart(14, '0');
  const pid = String(process.pid).padStart(6, '0');
  const seq = String(messageSeq++ % 1000000).padStart(6, '0');
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${ts}-${pid}-${seq}-${rand}${MESSAGE_EXT}`;
}

/**
 * Directory holding an agent's pending commands — ONE FILE PER COMMAND.
 *
 * The command channel used to be a single `command.txt`: the CLI
 * truncated it in place and the agent read it, then unlinked it. Two
 * commands sent in quick succession destroyed the first, and a command
 * written while the agent was reading destroyed the second. One file per
 * command removes both windows — the same fix the inbox got.
 */
function commandDir(root, agent) {
  return path.join(resolveRoot(root), String(agent).toLowerCase(), 'commands');
}

/** Path of an agent's directory. */
function agentDir(root, agent) {
  return path.join(resolveRoot(root), String(agent).toLowerCase());
}

/** Ensure the directory that holds `file` exists. */
function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Append a message to the RECIPIENT's inbox.
 *
 * The message becomes its own file, written to a temp name and then
 * renamed into place — so a reader never sees a half-written message,
 * and a concurrent reader can never destroy it.
 *
 * @returns {string} the envelope that was written.
 */
function appendMessage(root, from, to, body) {
  const dir = inboxDir(root, to);
  fs.mkdirSync(dir, { recursive: true });
  const line = formatMessage(from, to, body);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = messageName();
    const tmp = path.join(dir, `${TMP_PREFIX}${name}`);
    const target = path.join(dir, name);
    try {
      fs.writeFileSync(tmp, line + '\n', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      // The temp file vanished under us. A writer must not die because
      // of a reader: take a fresh name and try again.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    return line;
  }

  throw new Error('appendMessage: could not allocate a message file');
}

/**
 * Take the messages addressed to `agent` out of its inbox.
 *
 * Every message is its own file. A file is claimed with an atomic
 * rename before it is read, so two readers never consume the same
 * message and a message is never consumed twice.
 *
 * Files that are not envelopes, or that are addressed to somebody else,
 * are left in place (they are not this agent's to consume) — a foreign
 * envelope is put back exactly where it was.
 *
 * @returns {{from: string, to: string, body: string}[]}
 */
function takeMessages(root, agent) {
  const id = String(agent).toLowerCase();
  const dir = inboxDir(root, id);

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const mine = [];
  for (const name of names.filter(isCandidateName).sort()) {
    const file = path.join(dir, name);
    const claimed = path.join(dir, `${CLAIM_PREFIX}${process.pid}-${name}`);

    try {
      fs.renameSync(file, claimed);
    } catch {
      continue; // another reader claimed it first
    }

    let parsed = null;
    try {
      parsed = parseMessage(fs.readFileSync(claimed, 'utf8'));
    } catch {
      parsed = null;
    }

    if (parsed && parsed.to === id) {
      try {
        fs.unlinkSync(claimed);
      } catch {
        /* consumed either way */
      }
      mine.push(parsed);
    } else {
      // Not ours. Put it back exactly where it was.
      try {
        fs.renameSync(claimed, file);
      } catch {
        /* another writer took the name — the message survives either way */
      }
    }
  }

  return mine;
}

/**
 * The pending command files for an agent, oldest first.
 *
 * @returns {string[]} absolute paths.
 */
function pendingCommandFiles(root, agent) {
  let names;
  try {
    names = fs.readdirSync(commandDir(root, agent));
  } catch {
    return [];
  }
  return names
    .filter(isCandidateName)
    .sort()
    .map((n) => path.join(commandDir(root, agent), n));
}

/**
 * Read an agent's oldest pending command without consuming it.
 *
 * @returns {string|null} the trimmed command, or null when absent/empty.
 */
function peekCommand(root, agent) {
  for (const file of pendingCommandFiles(root, agent)) {
    let cmd = null;
    try {
      cmd = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (cmd) return cmd;
  }
  return null;
}

/**
 * Read and consume an agent's oldest pending command.
 *
 * The file is claimed with an atomic rename before it is read, so two
 * readers never consume the same command and a command is never
 * consumed twice. The old read-then-unlink had a lost-update window:
 * a command written between the read and the unlink was deleted without
 * ever being read.
 *
 * @returns {string|null}
 */
function takeCommand(root, agent) {
  for (const file of pendingCommandFiles(root, agent)) {
    const claimed = `${file}.${CLAIM_PREFIX}${process.pid}`;

    try {
      fs.renameSync(file, claimed);
    } catch {
      continue; // another reader claimed it
    }

    let cmd = null;
    try {
      cmd = fs.readFileSync(claimed, 'utf8').trim() || null;
    } catch {
      cmd = null;
    }

    try {
      fs.unlinkSync(claimed);
    } catch {
      /* consumed either way */
    }

    if (cmd) return cmd;
  }

  return null;
}

/**
 * Queue a command for an agent (used by the CLI's counterpart in JS).
 *
 * @returns {string} the queued command text.
 */
function queueCommand(root, agent, text) {
  const dir = commandDir(root, agent);
  fs.mkdirSync(dir, { recursive: true });
  const name = messageName();
  const tmp = path.join(dir, `${TMP_PREFIX}${name}`);
  const target = path.join(dir, name);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.writeFileSync(tmp, `${String(text)}\n`, { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    return String(text);
  }

  throw new Error('queueCommand: could not allocate a command file');
}

/**
 * Append a line to an agent's log file.
 *
 * @param {string} prefix the agent tag, e.g. '[OPS]'.
 */
function logLine(root, agent, prefix, message) {
  const file = path.join(agentDir(root, agent), 'logs.txt');
  ensureDirFor(file);
  const line = `[${new Date().toISOString()}] ${prefix} ${message}`;
  fs.appendFileSync(file, line + '\n');
  return line;
}

/**
 * Migrate a legacy single-file inbox into the per-message layout.
 *
 * The hub used one `inbox.txt` per agent. Anything still sitting in
 * one is moved into the recipient's inbox dir as individual messages, so
 * a pending message survives the cutover instead of being dropped.
 *
 * @returns {number} how many messages were migrated.
 */
function migrateLegacyInbox(root, agent) {
  const legacy = path.join(agentDir(root, agent), 'inbox.txt');
  let content;
  try {
    content = fs.readFileSync(legacy, 'utf8');
  } catch {
    return 0;
  }

  let moved = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseMessage(line);
    if (!parsed) continue;
    appendMessage(root, parsed.from, parsed.to, parsed.body);
    moved += 1;
  }

  try {
    fs.unlinkSync(legacy);
  } catch {
    /* nothing to clean up */
  }
  return moved;
}

/**
 * Remove half-written and half-claimed leftovers.
 *
 * A process that dies between "rename aside" and "delete" leaves a
 * `.claimed-` file behind; a process that dies mid-write leaves a
 * `.tmp-` file. Neither is a message, and neither may be read as one.
 */
function pruneStaleFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  const cutoff = Date.now() - 60000;
  for (const name of names) {
    if (!name.startsWith(CLAIM_PREFIX) && !name.startsWith(TMP_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      // A live agent's claim exists for microseconds. Only prune what
      // has clearly been abandoned.
      if (fs.statSync(file).mtimeMs > cutoff) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* another process got there first */
    }
  }
  return removed;
}

/**
 * Migrate a legacy single-file command into the per-command directory.
 *
 * @returns {number} how many commands were migrated.
 */
function migrateLegacyCommand(root, agent) {
  const legacy = path.join(agentDir(root, agent), 'command.txt');
  let content;
  try {
    content = fs.readFileSync(legacy, 'utf8');
  } catch {
    return 0;
  }

  const text = content.trim();
  if (text) queueCommand(root, agent, text);

  try {
    fs.unlinkSync(legacy);
  } catch {
    /* nothing to clean up */
  }
  return text ? 1 : 0;
}

/**
 * Make the agent's directory tree exist.
 *
 * Also migrates a legacy `inbox.txt` / `command.txt` (see
 * migrateLegacyInbox / migrateLegacyCommand) and clears stale
 * claim/temp leftovers.
 */
function ensureLayout(root) {
  const base = resolveRoot(root);
  for (const dir of [...AGENT_IDS, 'tasks', 'memory', 'pids']) {
    fs.mkdirSync(path.join(base, dir), { recursive: true });
  }
  for (const agent of AGENT_IDS) {
    fs.mkdirSync(inboxDir(base, agent), { recursive: true });
    fs.mkdirSync(commandDir(base, agent), { recursive: true });
    migrateLegacyInbox(base, agent);
    migrateLegacyCommand(base, agent);
    pruneStaleFiles(inboxDir(base, agent));
    pruneStaleFiles(commandDir(base, agent));
    pruneStaleFiles(agentDir(base, agent));
  }
  return base;
}

module.exports = {
  AGENT_IDS,
  DEFAULT_ROOT,
  MESSAGE_EXT,
  resolveRoot,
  isAgentId,
  isCandidateName,
  formatMessage,
  parseMessage,
  inboxDir,
  commandDir,
  agentDir,
  ensureDirFor,
  appendMessage,
  takeMessages,
  peekCommand,
  takeCommand,
  queueCommand,
  logLine,
  migrateLegacyInbox,
  migrateLegacyCommand,
  pruneStaleFiles,
  ensureLayout,
};
