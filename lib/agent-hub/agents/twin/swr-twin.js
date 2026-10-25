#!/usr/bin/env node
/**
 * SWR-Twin (Digital Twin Agent) — background process.
 *
 * Two inputs:
 *   - a command queue (lib/agent-hub/twin/commands/) — one file per
 *     command
 *   - its own inbox   (lib/agent-hub/twin/inbox/) — one file per
 *     message, from ops
 *
 * Two outputs:
 *   - memory          (lib/agent-hub/memory/twin-memory.md)
 *   - messages into ops' and check's inboxes
 *
 * The decision logic lives in ../../lib/twin-brain.js so it can be
 * unit-tested without starting the process.
 *
 * Plain Node, no dependencies. CommonJS.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const hub = require('../../lib/hub-runtime.js');
const brain = require('../../lib/twin-brain.js');
// The check agent's vocabulary — the twin has to phrase its request in
// a form the check agent can act on.
const checkBrain = require('../../lib/check-brain.js');
const lm = require('../../lib/lm-client.js');

const ROOT = hub.resolveRoot();
const MEMORY_FILE = path.join(ROOT, 'memory', 'twin-memory.md');

const TWIN_IDENTITY = brain.TWIN_IDENTITY;

// The model behind the planner, resolved once at startup. `null` means
// the rule engine plans alone — which is a supported mode, said out loud
// in the log rather than left to be discovered.
let MODEL = null;

let memory = {};

function log(msg) {
  const line = `[${new Date().toISOString()}] [TWIN] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(ROOT, 'twin', 'logs.txt'), line + '\n');
  } catch {
    /* the log is a convenience, never a reason to die */
  }
}

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    const content = fs.readFileSync(MEMORY_FILE, 'utf8');
    for (const entry of content.split('## ')) {
      if (!entry.trim()) continue;
      const lines = entry.split('\n');
      const key = lines[0].trim().toLowerCase();
      memory[key] = lines.slice(1).join('\n').trim();
    }
  }
  log(`Loaded ${Object.keys(memory).length} memories`);
}

function saveMemory(key, value) {
  memory[key] = value;
  let content = '# Twin Memory\n\n';
  for (const [k, v] of Object.entries(memory)) {
    content += `## ${k}\n\n${v}\n\n`;
  }
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, content);
}

function sendToOps(message) {
  return hub.appendMessage(ROOT, 'twin', 'ops', message);
}

function sendToCheck(message) {
  return hub.appendMessage(ROOT, 'twin', 'check', message);
}

/**
 * Handle one inbound message from the orchestrator.
 *
 * "New task: <task>" → the twin plans it, tells ops the plan, and asks
 * the check agent to verify the task's claim. A plan the twin is not
 * confident about is escalated rather than approved.
 */
function resolveModel() {
  const provider = lm.configuredProvider();
  if (!provider) {
    const src = lm.keySource();
    log(`Planning: rules — no provider key. Set one of MINIMAX_API_KEY, `
      + `DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or put `
      + `"<provider>=<key>" in ${src.file}`);
    return null;
  }
  const src = lm.keySource();
  const where = src.usedFromFile.includes(provider) ? src.file : 'the environment';
  log(`Planning: model (${provider}, key from ${where})`);
  return {
    provider,
    complete: (prompt) => lm.complete(prompt, { provider, temperature: 0.2, maxTokens: 300 }),
  };
}

async function handleMessage(msg) {
  const body = msg.body.trim();
  log(`Message from ${msg.from.toUpperCase()}: ${body}`);

  const taskMatch = /^new task:\s*(.+)$/i.exec(body);
  if (!taskMatch) {
    log(`No action for: ${body}`);
    return;
  }

  const task = taskMatch[1].trim();
  const plan = await brain.planForAsync(task, MODEL || {});

  const note = plan.note ? ` [${plan.source}: ${plan.note}]` : ` [${plan.source}]`;
  log(`Plan for "${task}": ${plan.verdict} (${(plan.confidence * 100).toFixed(0)}%) — ${plan.summary}${note}`);

  if (plan.verdict === 'proceed') {
    sendToOps(`Plan: proceed — ${plan.summary} (confidence ${(plan.confidence * 100).toFixed(0)}%)`);
    // The check agent gets a request it can act on — a file to check or
    // a claim to look for. Sending it the bare task made it grep for
    // one word of the task and "pass" on an unrelated file.
    sendToCheck(`Verify: ${checkBrain.verificationRequest(task)}`);
  } else {
    sendToOps(`Plan: escalate — ${plan.summary} (confidence ${(plan.confidence * 100).toFixed(0)}%)`);
  }
}

function processCommand(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return;

  // Pipe-separated commands: decide opt1,opt2 | context
  const pipeParts = text.split('|').map((p) => p.trim());
  const action = pipeParts[0];

  if (action.startsWith('decide ')) {
    const options = action.replace('decide ', '').split(',').map((o) => o.trim()).filter(Boolean);
    const context = pipeParts[1] || '';

    const result = brain.decide(options, context);

    console.log('\n=== Decision ===');
    console.log(`Choice: ${result.decision}`);
    console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    if (result.belowThreshold) console.log('⚠ Below threshold - escalation needed');
    if (result.issues.length) console.log('Voice issues:', result.issues.join(', '));
    if (result.alternatives.length) console.log('Alternatives:', result.alternatives.join(', '));
    log(`Decided: ${result.decision} (${(result.confidence * 100).toFixed(0)}%)`);
    return;
  }

  if (action.startsWith('remember ')) {
    const keyValue = action.replace('remember ', '').split(' ').filter(Boolean);
    if (keyValue.length >= 2) {
      saveMemory(keyValue[0], keyValue.slice(1).join(' '));
      console.log(`✓ Saved: ${keyValue[0]}`);
      log(`Remembered ${keyValue[0]}`);
    }
    return;
  }

  if (action.startsWith('recall ')) {
    const key = action.replace('recall ', '').trim();
    console.log('\n=== Recall ===');
    console.log(memory[key] || 'Not found');
    return;
  }

  if (action === 'voice') {
    console.log('\n=== Voice Rules ===');
    console.log(`Tone: ${TWIN_IDENTITY.voice.tone}`);
    console.log('Non-negotiables:');
    TWIN_IDENTITY.voice.nonNegotiables.forEach((n) => console.log(`  - ${n}`));
    console.log('Focus:', TWIN_IDENTITY.voice.focus.join(', '));
    return;
  }

  console.log(`Unknown: ${action}`);
}

// A model call takes seconds, so a tick is async — and a tick that is
// still running must not be re-entered by the next interval.
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cmd = hub.takeCommand(ROOT, 'twin');
    if (cmd) processCommand(cmd);

    for (const msg of hub.takeMessages(ROOT, 'twin')) {
      await handleMessage(msg);
    }
  } finally {
    busy = false;
  }
}

function main() {
  hub.ensureLayout(ROOT);
  log('SWR-Twin starting...');
  MODEL = resolveModel();
  loadMemory();
  console.log('[TWIN] Ready. Use the CLI or the commands/ queue.');

  setInterval(() => {
    tick().catch((err) => log(`Error: ${err.message}`));
  }, 500);
}

main();
