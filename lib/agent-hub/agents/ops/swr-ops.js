#!/usr/bin/env node
/**
 * SWR-Ops (Orchestrator Agent)
 * Decomposes work, manages tasks, coordinates other agents
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '..');
const TASKS_FILE = path.join(AGENT_DIR, 'tasks', 'swr-ops-tasks.md');
const LOG_FILE = path.join(AGENT_DIR, 'ops', 'logs.txt');

// State
let taskQueue = [];
let completedTasks = [];
let blockedTasks = [];
let running = false;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [OPS] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadTasks() {
  if (fs.existsSync(TASKS_FILE)) {
    const content = fs.readFileSync(TASKS_FILE, 'utf-8');
    // Parse tasks from markdown
    const lines = content.split('\n');
    let currentSection = null;
    for (const line of lines) {
      if (line.includes('### Blocked')) currentSection = 'blocked';
      else if (line.includes('### In Progress')) currentSection = 'inprogress';
      else if (line.includes('### Done')) currentSection = 'done';
      else if (line.startsWith('- [ ]') && currentSection === 'blocked') {
        blockedTasks.push(line.replace('- [ ]', '').trim());
      }
      else if (line.startsWith('- [ ]') && currentSection === 'inprogress') {
        taskQueue.push(line.replace('- [ ]', '').trim());
      }
      else if (line.startsWith('- [x]') && currentSection === 'done') {
        completedTasks.push(line.replace('- [x]', '').trim());
      }
    }
  }
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

// Message passing to other agents
async function sendToTwin(message) {
  const msgFile = path.join(AGENT_DIR, 'twin', 'inbox.txt');
  fs.appendFileSync(msgFile, `[OPS→TWIN ${new Date().toISOString()}] ${message}\n`);
}

async function sendToCheck(message) {
  const msgFile = path.join(AGENT_DIR, 'check', 'inbox.txt');
  fs.appendFileSync(msgFile, `[OPS→CHECK ${new Date().toISOString()}] ${message}\n`);
}

// Read from hub
function readFromHub() {
  const hubFile = path.join(AGENT_DIR, 'hub', 'ops-outbox.txt');
  if (fs.existsSync(hubFile)) {
    const content = fs.readFileSync(hubFile, 'utf-8');
    fs.unlinkSync(hubFile);
    return content.split('\n').filter(l => l.trim());
  }
  return [];
}

// Main loop
async function main() {
  log('SWR-Ops starting...');
  
  // Load existing tasks
  loadTasks();
  log(`Loaded ${taskQueue.length} tasks, ${completedTasks.length} completed`);
  
  // Ensure directories exist
  [path.join(AGENT_DIR, 'tasks'), path.join(AGENT_DIR, 'ops')].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  
  running = true;
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  
  log('SWR-Ops ready. Commands: add, done, block, status, twin, check, help');
  
  const prompt = () => {
    rl.question('\n[OPS] > ', async (cmd) => {
      const parts = cmd.trim().split(' ');
      const action = parts[0];
      const args = parts.slice(1).join(' ');
      
      switch (action) {
        case 'add':
          if (args) {
            taskQueue.push(args);
            saveTasks();
            log(`Added task: ${args}`);
            // Notify twin for creative work
            await sendToTwin(`New task added: ${args}`);
          }
          break;
          
        case 'done':
          const doneTask = taskQueue.shift();
          if (doneTask) {
            completedTasks.push(doneTask);
            saveTasks();
            log(`Completed: ${doneTask}`);
            // Notify check to verify
            await sendToCheck(`Task completed, verify: ${doneTask}`);
          }
          break;
          
        case 'block':
          const blocked = taskQueue.shift();
          if (blocked) {
            blockedTasks.push(blocked);
            saveTasks();
            log(`Blocked: ${blocked}`);
          }
          break;
          
        case 'status':
          console.log('\n=== Task Status ===');
          console.log(`Blocked: ${blockedTasks.length}`);
          console.log(`In Progress: ${taskQueue.length}`);
          console.log(`Completed: ${completedTasks.length}`);
          break;
          
        case 'twin':
          if (args) await sendToTwin(args);
          break;
          
        case 'check':
          if (args) await sendToCheck(args);
          break;
          
        case 'help':
          console.log(`
Commands:
  add <task>     - Add new task
  done           - Mark current task done
  block          - Move current to blocked
  status         - Show task status
  twin <msg>     - Send message to Twin
  check <msg>    - Send message to Check
  help           - Show this help
`);
          break;
          
        default:
          if (action) log(`Unknown command: ${action}`);
      }
      
      // Check hub for new commands
      const hubMsgs = readFromHub();
      for (const msg of hubMsgs) {
        if (msg.includes('new task:')) {
          const task = msg.replace('new task:', '').trim();
          taskQueue.push(task);
          saveTasks();
          log(`Task from hub: ${task}`);
        }
      }
      
      prompt();
    });
  }
  
  prompt();
}

main().catch(e => {
  log(`Error: ${e.message}`);
  process.exit(1);
});
