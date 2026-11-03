#!/usr/bin/env node
/**
 * SWR-Ops (Orchestrator Agent) — background process.
 *
 * Two inputs:
 *   - a command queue (lib/agent-hub/ops/commands/) — one file per
 *     verb + args
 *   - its own inbox   (lib/agent-hub/ops/inbox/)       — one file per
 *     message, replies from the twin and the check agent
 *
 * Two outputs:
 *   - the task board  (lib/agent-hub/tasks/swr-ops-tasks.md)
 *   - messages into the twin's and the check agent's inboxes
 *
 * The board logic lives in ../lib/ops-brain.js and the messaging in
 * ../lib/hub-runtime.js; this file is the shell around them.
 *
 * Plain Node, no dependencies. CommonJS.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const hub = require('../../lib/hub-runtime.js');
const brain = require('../../lib/ops-brain.js');
// The check agent's vocabulary — ops phrases its verification request
// in a form the check agent can act on.
const checkBrain = require('../../lib/check-brain.js');

const ROOT = hub.resolveRoot();
const TASKS_FILE = path.join(ROOT, 'tasks', 'swr-ops-tasks.md');
// The pending-verification ledger: what ops asked the check agent to
// verify, and FOR WHICH task. Runtime state — it churns on every
// dispatch, so it is gitignored like the pids and the logs.
const PENDING_FILE = path.join(ROOT, 'ops', 'pending.json');

let board = brain.emptyBoard();
let pending = brain.emptyPending();

function log(msg) {
  const line = `[${new Date().toISOString()}] [OPS] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(ROOT, 'ops', 'logs.txt'), line + '\n');
  } catch {
    /* the log is a convenience, never a reason to die */
  }
}

function saveTasks() {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  fs.writeFileSync(TASKS_FILE, brain.renderBoard(board));
}

function loadTasks() {
  if (fs.existsSync(TASKS_FILE)) {
    board = brain.parseBoard(fs.readFileSync(TASKS_FILE, 'utf8'));
  }
}

function savePending() {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, brain.renderPending(pending));
  } catch (err) {
    log(`Could not persist the pending ledger: ${err.message}`);
  }
}

function loadPending() {
  if (fs.existsSync(PENDING_FILE)) {
    try {
      pending = brain.parsePending(fs.readFileSync(PENDING_FILE, 'utf8'));
    } catch (err) {
      log(`Could not read the pending ledger: ${err.message}`);
      pending = brain.emptyPending();
    }
  }
}

function sendToTwin(message) {
  return hub.appendMessage(ROOT, 'ops', 'twin', message);
}

function sendToCheck(message) {
  return hub.appendMessage(ROOT, 'ops', 'check', message);
}

/**
 * Ask the check agent to verify a TASK, and remember which task the
 * request belongs to.
 *
 * Ops is the only dispatcher of verifications, so this is the only
 * place a verification can be tied to the task that caused it. The
 * check agent's reply carries only what it verified (a path, a claim),
 * so the dispatch record is what makes the reply unambiguous.
 *
 * The record is persisted BEFORE the request is sent: a check reply
 * can arrive while the request is still being written, and a reply
 * that arrives before its record exists falls back to the old
 * subject-matching behaviour — the misattribution this exists to fix.
 *
 * @param {string} task the board task the verification is for
 * @returns {string} the request sent to the check agent
 */
function dispatchVerification(task) {
  const request = checkBrain.verificationRequest(task);
  const target = checkBrain.classifyRequest(request).target;
  pending = brain.addPending(pending, {
    task,
    request,
    target,
    at: new Date().toISOString(),
  });
  savePending();
  sendToCheck(`Verify: ${request}`);
  return request;
}

/**
 * Handle one inbound message from the twin or the check agent.
 */
function handleMessage(msg) {
  log(`Message from ${msg.from.toUpperCase()}: ${msg.body}`);
  const body = msg.body.trim();

  if (msg.from === 'check') {
    // "Verified: PASS — evidence" or "Verified: FAIL — evidence"
    const passed = /^verified:\s*pass\b/i.test(body);
    const subject = body.replace(/^verified:\s*(pass|fail)\b\s*/i, '').replace(/^—\s*/, '');
    if (subject) {
      // The reply carries only WHAT was verified — a path, a claim —
      // with no correlation id. Two tasks can name the same file, so
      // the reply is resolved against the DISPATCH (the pending
      // ledger), not against the board's text. Matching the subject
      // against the board moved a task nobody had verified into Done.
      // A failed verification consumes its entry and leaves the board
      // alone; a reply with no matching dispatch (a hand-driven check)
      // keeps the old behaviour.
      const applied = brain.applyVerification(board, pending, subject, passed);
      board = applied.board;
      pending = applied.ledger;
      saveTasks();
      savePending();
      log(applied.message);
    }
    return;
  }

  if (msg.from === 'twin') {
    // "Verify task: <task>" — the twin's plan was to proceed, and the
    // verification goes out from here, through the one dispatcher.
    const verifyTask = brain.parseVerifyTask(body);
    if (verifyTask) {
      const request = dispatchVerification(verifyTask);
      log(`Verification dispatched for "${verifyTask}": ${request}`);
      return;
    }
    // "Plan: proceed — deep house (confidence 90%)"
    const plan = body.replace(/^plan:\s*/i, '');
    log(`Plan recorded: ${plan}`);
  }
}

function processCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return;

  const spaceAt = text.indexOf(' ');
  const verb = (spaceAt === -1 ? text : text.slice(0, spaceAt)).toLowerCase();
  const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();

  switch (verb) {
    case 'add':
    case 'done':
    case 'block': {
      // The board transition itself lives in ops-brain, so the tested
      // logic is the logic that runs.
      const applied = brain.applyCommand(board, text);
      board = applied.board;
      saveTasks();
      log(applied.message);
      if (applied.action === 'add' && applied.task) {
        sendToTwin(`New task: ${applied.task}`);
      } else if (applied.action === 'done' && applied.task) {
        // Same rule as the twin's plan: the check agent gets a request
        // it can act on, not the bare task text. The dispatch is
        // recorded, so the reply resolves to THIS task even when
        // another task names the same file.
        dispatchVerification(applied.task);
      }
      console.log(applied.message);
      break;
    }

    case 'status': {
      const counts = brain.boardCounts(board);
      console.log('\n=== Status ===');
      console.log(`Blocked: ${counts.blocked}`);
      console.log(`In Progress: ${counts.inProgress}`);
      console.log(`Completed: ${counts.done}`);
      break;
    }

    case 'twin': {
      if (!args) {
        console.log('Nothing to send.');
        break;
      }
      sendToTwin(args);
      log(`→ Twin: ${args}`);
      console.log(`→ Twin: ${args}`);
      break;
    }

    case 'check': {
      if (!args) {
        console.log('Nothing to send.');
        break;
      }
      sendToCheck(args);
      log(`→ Check: ${args}`);
      console.log(`→ Check: ${args}`);
      break;
    }

    case 'tasks': {
      console.log('\n=== Tasks ===');
      if (board.inProgress.length === 0) console.log('(none)');
      board.inProgress.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      break;
    }

    default:
      if (verb) console.log(`Unknown: ${verb}`);
  }
}

function tick() {
  const cmd = hub.takeCommand(ROOT, 'ops');
  if (cmd) processCommand(cmd);

  for (const msg of hub.takeMessages(ROOT, 'ops')) {
    handleMessage(msg);
  }
}

function main() {
  hub.ensureLayout(ROOT);
  log('SWR-Ops starting...');
  loadTasks();
  // The pending ledger is runtime state, but it must survive a
  // restart: a verification dispatched before the restart still has a
  // reply coming, and a ledger that started empty would resolve that
  // reply against the board's text instead of its dispatch.
  loadPending();
  const counts = brain.boardCounts(board);
  log(`Ready. ${counts.inProgress} tasks loaded.`);
  console.log('[OPS] Ready. Use the CLI or the commands/ queue.');

  setInterval(() => {
    try {
      tick();
    } catch (err) {
      log(`Error: ${err.message}`);
    }
  }, 500);
}

main();
