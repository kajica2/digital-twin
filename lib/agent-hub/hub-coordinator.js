#!/usr/bin/env node
/**
 * Hub Coordinator - Monitors all agents, coordinates messages
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '..');
const HUB_DIR = path.join(AGENT_DIR, 'hub');

function log(msg) {
  console.log(`[HUB] ${new Date().toISOString().slice(11,19)} ${msg}`);
}

// Check agent status
function checkAgent(agentName) {
  const logFile = path.join(AGENT_DIR, agentName, 'logs.txt');
  if (!fs.existsSync(logFile)) return { running: false, lastSeen: null };
  
  const stats = fs.statSync(logFile);
  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || '';
  
  // Check if recent (within 5 minutes)
  const now = Date.now();
  const fileAge = now - stats.mtimeMs;
  const running = fileAge < 5 * 60 * 1000;
  
  return {
    running,
    lastSeen: stats.mtime,
    lastActivity: lastLine.slice(0, 80)
  };
}

// Route messages between agents
function routeMessages() {
  const outboxes = ['ops', 'twin', 'check'];
  
  for (const agent of outboxes) {
    const outbox = path.join(AGENT_DIR, agent, 'outbox.txt');
    if (!fs.existsSync(outbox)) continue;
    
    const content = fs.readFileSync(outbox, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      // Parse message destination
      const match = line.match(/\[(\w+)→(\w+)/);
      if (match) {
        const [, from, to] = match;
        const inbox = path.join(AGENT_DIR, to, 'inbox.txt');
        fs.appendFileSync(inbox, line + '\n');
        log(`Route: ${from} → ${to}`);
      }
    }
    
    // Clear outbox
    fs.unlinkSync(outbox);
  }
}

// Monitor loop
async function monitor() {
  console.clear();
  console.log(`
╔═══════════════════════════════════════════════════╗
║         SWR AGENT HUB - MONITOR                  ║
╠═══════════════════════════════════════════════════╣
║  Commands: status, route, clear, quit            ║
╚═══════════════════════════════════════════════════╝
`);
  
  log('Hub coordinator started');
  
  if (!fs.existsSync(HUB_DIR)) {
    fs.mkdirSync(HUB_DIR, { recursive: true });
  }
  
  // Create outboxes for hub communication
  ['ops', 'twin', 'check'].forEach(agent => {
    const dir = path.join(AGENT_DIR, agent);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  
  // Initial status
  setInterval(() => {
    console.clear();
    console.log(`
╔═══════════════════════════════════════════════════╗
║         SWR AGENT HUB - MONITOR                   ║
╚═══════════════════════════════════════════════════╝
`);
    
    const agents = ['ops', 'twin', 'check'];
    
    console.log('\n=== Agent Status ===\n');
    
    for (const agent of agents) {
      const status = checkAgent(agent);
      const name = agent.toUpperCase();
      const icon = status.running ? '🟢' : '🔴';
      console.log(`${icon} ${name}`);
      console.log(`   Last seen: ${status.lastSeen ? status.lastSeen.toLocaleTimeString() : 'Never'}`);
      if (status.lastActivity) {
        console.log(`   Activity: ${status.lastActivity}`);
      }
      console.log('');
    }
    
    // Check for pending messages
    let pending = 0;
    ['ops', 'twin', 'check'].forEach(agent => {
      const inbox = path.join(AGENT_DIR, agent, 'inbox.txt');
      if (fs.existsSync(inbox)) {
        const lines = fs.readFileSync(inbox, 'utf-8').split('\n').filter(l => l.trim());
        pending += lines.length;
      }
    });
    
    if (pending > 0) {
      console.log(`📬 ${pending} pending messages`);
      routeMessages();
    }
    
    console.log('\nPress Ctrl+C to exit');
    
  }, 10000);
  
  // Route messages every 5 seconds
  setInterval(routeMessages, 5000);
}

monitor();
