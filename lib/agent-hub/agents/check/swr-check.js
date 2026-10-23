#!/usr/bin/env node
/**
 * SWR-Check (Verifier Agent) — background process.
 *
 * Two inputs:
 *   - a command queue (lib/agent-hub/check/commands/) — one file per
 *     command
 *   - its own inbox   (lib/agent-hub/check/inbox/) — one file per
 *     message, "Verify: <claim>" requests from ops and the twin
 *
 * Two outputs:
 *   - the ledger      (lib/agent-hub/check/verifications.md)
 *   - messages into ops' inbox — the verdict, with its evidence
 *
 * The result shapes live in ../../lib/check-brain.js so they can be
 * unit-tested without starting the process.
 *
 * Plain Node, no dependencies. CommonJS.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const hub = require('../../lib/hub-runtime.js');
const brain = require('../../lib/check-brain.js');
const claimSearch = require('../../lib/claim-search.js');

const ROOT = hub.resolveRoot();
const REPO_DIR = process.env.SWR_REPO || path.join(process.env.HOME || '', 'Documents', 'sainted-word-records');
const VERIFY_FILE = path.join(ROOT, 'check', 'verifications.md');

function log(msg) {
  const line = `[${new Date().toISOString()}] [CHECK] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(ROOT, 'check', 'logs.txt'), line + '\n');
  } catch {
    /* the log is a convenience, never a reason to die */
  }
}

function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    // No shell: the args are passed as argv. A shell would word-split a
    // claim with spaces in it, and grep would search for its first word
    // alone — which is how a check "passed" on an unrelated file.
    const proc = spawn(cmd, args, { cwd: REPO_DIR, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function verifyFile(filePath) {
  const fullPath = path.join(REPO_DIR, filePath);
  const exists = fs.existsSync(fullPath);
  log(`File check: ${filePath} → ${exists ? 'EXISTS' : 'MISSING'}`);
  return brain.buildResult('file', filePath, exists, exists ? fullPath : `not found: ${fullPath}`);
}

async function verifyTests() {
  log('Running tests...');
  const result = await runCmd('npm', ['run', 'check', '--silent']);
  const evidence = (result.stdout || result.stderr || '').trim().slice(-300);
  return brain.buildResult('tests', 'npm run check', result.code === 0, evidence || `exit ${result.code}`);
}

async function verifyClaim(claim) {
  // A claim is a statement of fact ("the reel pipeline is documented").
  // A task is an instruction ("write liner notes for ..."). Grepping for
  // an instruction finds nothing, and a grep that happens to match the
  // instruction's first word is how a false PASS happened. Refuse it.
  if (brain.isTaskShaped(claim)) {
    return refuseTask(claim);
  }
  log(`Verifying: "${claim}"`);
  const search = claimSearch.searchClaim(claim, REPO_DIR);
  return brain.buildResult('claim', claim, search.found, search.evidence);
}

/**
 * A request to do a TASK is not a claim, and it is not a file check
 * either. There is nothing to check: the work has not happened yet.
 * The honest verdict is a refusal with a reason, not a grep that
 * happens to match something.
 */
function refuseTask(task) {
  const result = brain.refuseTask(task);
  log(`Cannot verify: "${task}" — ${result.evidence}`);
  return result;
}

async function verifyDiff(target) {
  const result = await runCmd('git', ['status', '--short']);
  const changed = result.stdout.trim();
  return brain.buildResult('diff', target || 'working tree', changed.length > 0, changed || 'clean');
}

function saveVerification(result) {
  const entry = brain.renderLedgerEntry(result);
  fs.mkdirSync(path.dirname(VERIFY_FILE), { recursive: true });
  const content = fs.existsSync(VERIFY_FILE) ? fs.readFileSync(VERIFY_FILE, 'utf8') : '# Verifications\n';
  fs.writeFileSync(VERIFY_FILE, content + entry);
  log(brain.renderResult(result));
}

function sendToOps(message) {
  return hub.appendMessage(ROOT, 'check', 'ops', message);
}

/**
 * Verify a request and report the verdict back to ops.
 */
async function verifyAndReport(request) {
  const { type, target } = brain.classifyRequest(request);

  let result;
  switch (type) {
    case 'file':
      result = await verifyFile(target);
      break;
    case 'test':
      result = await verifyTests();
      break;
    case 'claim':
      result = await verifyClaim(target);
      break;
    case 'diff':
      result = await verifyDiff(target);
      break;
    default:
      // A bare sentence is either a task to be done (not checkable) or
      // a claim to be looked for. A task gets an honest refusal; a
      // claim gets searched for as ONE phrase.
      if (brain.isTaskShaped(request)) {
        result = refuseTask(target || String(request).trim());
      } else {
        result = await verifyClaim(target || String(request).trim());
      }
      break;
  }

  saveVerification(result);
  sendToOps(`Verified: ${result.passed ? 'PASS' : 'FAIL'} — ${result.target || result.evidence}`);
  return result;
}

function processCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return Promise.resolve();

  const { type, target } = brain.classifyRequest(text);

  if (type === 'status') {
    const content = fs.existsSync(VERIFY_FILE) ? fs.readFileSync(VERIFY_FILE, 'utf8') : '';
    const count = brain.countVerifications(content);
    console.log(`\n=== Verifications: ${count} ===`);
    console.log(content.slice(-500) || 'No verifications yet');
    return Promise.resolve();
  }

  if (type === 'unknown') {
    console.log(`Unknown: ${text}`);
    return Promise.resolve();
  }

  return verifyAndReport(text);
}

async function tick() {
  const cmd = hub.takeCommand(ROOT, 'check');
  if (cmd) await processCommand(cmd);

  for (const msg of hub.takeMessages(ROOT, 'check')) {
    const body = msg.body.trim();
    const request = body.replace(/^verify:\s*/i, '');
    log(`Request from ${msg.from.toUpperCase()}: ${request}`);
    await verifyAndReport(request);
  }
}

async function main() {
  hub.ensureLayout(ROOT);
  log('SWR-Check starting...');
  log(`Repo: ${REPO_DIR}`);
  console.log('[CHECK] Ready. Use the CLI or the commands/ queue.');

  setInterval(() => {
    tick().catch((err) => log(`Error: ${err.message}`));
  }, 500);
}

main();
