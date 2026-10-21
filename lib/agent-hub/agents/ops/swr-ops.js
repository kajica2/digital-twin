#!/usr/bin/env node
/**
 * SWR-Ops (Orchestrator Agent) - Non-interactive version
 * For use as background process with IPC
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.join(__dirname, '../..');
const TASKS_FILE = path.join(AGENT_ROOT, 'tasks', 'swr-ops-tasks.md');
const LOG_FILE = path.join(AGENT_ROOT, 'ops', 'logs.txt');

let taskQueue = [];
let completedTasks = [];
let blockedTasks = [];

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [OPS] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function saveTasks() {
  const content = `# SWR-Ops Task Board

### Blocked
${blockedTasks.map(t => `- [ ] ${t}`).join('\n')}

### In Progress
${taskQueue.map(t => `- [ ] ${t}`).join('\n')}

### Done
${completedTasks.map(t => `- [x] ${t}`).join('\n')}

---
Last updated: ${new Date().toISOString()}
`;
  fs.writeFileSync(TASKS_FILE, content);
}

function loadTasks() {
  if (fs.existsSync(TASKS_FILE)) {
    const content = fs.readFileSync(TASKS_FILE, 'utf-8');
    taskQueue = content.match(/- \[ \] (.+)/g)?.map(t => t.replace('- [ ]', '').trim()) || [];
  }
}

async function sendToTwin(message) {
  const msgFile = path.join(AGENT_ROOT, 'twin', 'inbox.txt');
  fs.appendFileSync(msgFile, `[OPS→TWIN] ${message}\n`);
}

async function sendToCheck(message) {
  const msgFile = path.join(AGENT_ROOT, 'check', 'inbox.txt');
  fs.appendFileSync(msgFile, `[OPS→CHECK] ${message}\n`);
}

function readCommand() {
  const cmdFile = path.join(AGENT_ROOT, 'ops', 'command.txt');
  if (fs.existsSync(cmdFile)) {
    const cmd = fs.readFileSync(cmdFile, 'utf-8').trim();
    fs.unlinkSync(cmdFile);
    return cmd;
  }
  return null;
}

function processCommand(cmd) {
  const parts = cmd.trim().split(' ');
  const action = parts[0];
  const args = parts.slice(1).join(' ');
  
  switch (action) {
    case 'add':
      if (args) {
        taskQueue.push(args);
        saveTasks();
        log(`Added task: ${args}`);
        sendToTwin(`New task: ${args}`);
        console.log(`✓ Added: ${args}`);
      }
      break;
      
    case 'done':
      const doneTask = taskQueue.shift();
      if (doneTask) {
        completedTasks.push(doneTask);
        saveTasks();
        log(`Completed: ${doneTask}`);
        sendToCheck(`Verify: ${doneTask}`);
        console.log(`✓ Done: ${doneTask}`);
      }
      break;
      
    case 'block':
      const blocked = taskQueue.shift();
      if (blocked) {
        blockedTasks.push(blocked);
        saveTasks();
        log(`Blocked: ${blocked}`);
        console.log(`⚠ Blocked: ${blocked}`);
      }
      break;
      
    case 'status':
      console.log(`\n=== Status ===`);
      console.log(`Blocked: ${blockedTasks.length}`);
      console.log(`In Progress: ${taskQueue.length}`);
      console.log(`Completed: ${completedTasks.length}`);
      break;
      
    case 'twin':
      if (args) {
        sendToTwin(args);
        console.log(`→ Twin: ${args}`);
      }
      break;
      
    case 'check':
      if (args) {
        sendToCheck(args);
        console.log(`→ Check: ${args}`);
      }
      break;
      
    case 'tasks':
      console.log('\n=== Tasks ===');
      if (taskQueue.length === 0) console.log('(none)');
      taskQueue.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      break;
      
    default:
      if (action) console.log(`Unknown: ${action}`);
  }
}

async function main() {
  // Ensure directories exist FIRST
  const opsDir = path.join(AGENT_ROOT, 'ops');
  const tasksDir = path.join(AGENT_ROOT, 'tasks');
  const twinDir = path.join(AGENT_ROOT, 'twin');
  const checkDir = path.join(AGENT_ROOT, 'check');
  
  for (const d of [opsDir, tasksDir, twinDir, checkDir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
  
  log('SWR-Ops starting...');
  loadTasks();
  
  
  
  log(`Ready. ${taskQueue.length} tasks loaded.`);
  console.log('[OPS] Ready. Use command.txt or CLI.');
  
  // Process loop
  setInterval(() => {
    const cmd = readCommand();
    if (cmd) {
      processCommand(cmd);
    }
  }, 1000);
}

main().catch(e => {
  log(`Error: ${e.message}`);
  process.exit(1);
});
