#!/usr/bin/env node
/**
 * Hub Coordinator - Monitors all agents, coordinates messages, LM switching
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.join(__dirname, '..');

function log(msg) {
  console.log(`[HUB] ${new Date().toISOString().slice(11,19)} ${msg}`);
}

// Check agent status via PID files
function checkAgent(agentName) {
  const pidsDir = path.join(AGENT_ROOT, 'pids');
  const pidFile = path.join(pidsDir, `${agentName}.pid`);
  const logFile = path.join(pidsDir, `${agentName}.log`);
  
  if (!fs.existsSync(pidFile)) {
    return { running: false, pid: null };
  }
  
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
  
  // Try to check if process exists
  try {
    process.kill(pid, 0);
    // Check log file for last activity
    let lastActivity = '';
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      lastActivity = lines[lines.length - 1]?.slice(0, 60) || '';
    }
    return { running: true, pid, lastActivity };
  } catch (e) {
    return { running: false, pid: null };
  }
}

// Route messages between agents
function routeMessages() {
  const agents = ['ops', 'twin', 'check'];
  
  for (const from of agents) {
    const inbox = path.join(AGENT_ROOT, from, 'inbox.txt');
    if (!fs.existsSync(inbox)) continue;
    
    const content = fs.readFileSync(inbox, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      const match = line.match(/\[(\w+)→(\w+)/);
      if (match) {
        const [, fromAgent, toAgent] = match;
        const destInbox = path.join(AGENT_ROOT, toAgent, 'inbox.txt');
        fs.appendFileSync(destInbox, line + '\n');
        log(`Route: ${fromAgent} → ${toAgent}`);
      }
    }
    
    fs.unlinkSync(inbox);
  }
}

// Monitor loop
async function monitor() {
  console.clear();
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SWR AGENT HUB - MONITOR                    ║
╠═══════════════════════════════════════════════════════════╣
║  Agents: ops | twin | check                               ║
║  LM: minimax (set SWR_LM_PROVIDER to switch)            ║
║  Commands: lm <provider>, quit                            ║
╚═══════════════════════════════════════════════════════════╝
`);
  
  log('Hub coordinator started');
  
  // Ensure directories
  ['ops', 'twin', 'check'].forEach(agent => {
    const dir = path.join(AGENT_ROOT, agent);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  
  // Monitor interval
  setInterval(() => {
    console.clear();
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SWR AGENT HUB - MONITOR                    ║
╠═══════════════════════════════════════════════════════════╣
║  LM: ${process.env.SWR_LM_PROVIDER || 'minimax'}                                        ║
╚═══════════════════════════════════════════════════════════╝
`);
    
    const agents = [
      { name: 'OPS', icon: '🔵', desc: 'Orchestrator' },
      { name: 'TWIN', icon: '🟣', desc: 'Digital Twin' },
      { name: 'CHECK', icon: '🟢', desc: 'Verifier' }
    ];
    
    console.log('\n=== Agent Status ===\n');
    
    for (const agent of agents) {
      const status = checkAgent(agent.name.toLowerCase());
      const icon = status.running ? '🟢' : '🔴';
      console.log(`${icon} ${agent.icon} ${agent.name} - ${agent.desc}`);
      if (status.running) {
        console.log(`   PID: ${status.pid}`);
        if (status.lastActivity) {
          console.log(`   Activity: ${status.lastActivity}`);
        }
      }
      console.log('');
    }
    
    // Route messages
    routeMessages();
    
  }, 5000);
  
  // Route messages every 3 seconds
  setInterval(routeMessages, 3000);
}

monitor();
