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

let board = brain.emptyBoard();

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

function sendToTwin(message) {
  return hub.appendMessage(ROOT, 'ops', 'twin', message);
}

function sendToCheck(message) {
  return hub.appendMessage(ROOT, 'ops', 'check', message);
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
    if (passed && subject) {
      // The verified task leaves the board — it is done, and now proven.
      const applied = brain.completeTask(board, subject);
      board = applied.board;
      saveTasks();
      log(applied.message);
    }
    return;
  }

  if (msg.from === 'twin') {
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
        // it can act on, not the bare task text.
        sendToCheck(`Verify: ${checkBrain.verificationRequest(applied.task)}`);
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
