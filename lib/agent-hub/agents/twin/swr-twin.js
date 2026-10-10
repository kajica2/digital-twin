#!/usr/bin/env node
/**
 * SWR-Twin (Digital Twin Agent) - Non-interactive version
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.join(__dirname, '../..');
const MEMORY_FILE = path.join(AGENT_ROOT, 'memory', 'twin-memory.md');
const LOG_FILE = path.join(AGENT_ROOT, 'twin', 'logs.txt');

const TWIN_IDENTITY = {
  name: 'SWR-Twin',
  confidenceThreshold: 0.85,
  voice: {
    tone: 'direct, warm, no hype, no emojis, slightly cynical but passionate',
    nonNegotiables: [
      'Never invent facts about artists',
      'Never use aggressive sales tactics',
      'Always credit sources',
      'No jargon without explanation'
    ],
    focus: ['deep house', 'lo-fi hip hop', 'vinyl culture', 'new wave']
  }
};

let memory = {};

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [TWIN] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const entries = content.split('## ');
    for (const entry of entries) {
      if (entry.trim()) {
        const lines = entry.split('\n');
        const key = lines[0].trim().toLowerCase();
        memory[key] = lines.slice(1).join('\n').trim();
      }
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
  fs.writeFileSync(MEMORY_FILE, content);
}

function checkVoice(text) {
  const issues = [];
  for (const rule of TWIN_IDENTITY.voice.nonNegotiables) {
    const ruleWord = rule.toLowerCase().replace('never ', '');
    if (text.toLowerCase().includes(ruleWord) && rule.startsWith('Never')) {
      issues.push(`Violates: ${rule}`);
    }
  }
  return issues;
}

function decide(options, context = '') {
  const scores = options.map(opt => {
    let score = 0.5;
    for (const focus of TWIN_IDENTITY.voice.focus) {
      if (opt.toLowerCase().includes(focus)) score += 0.2;
    }
    const voiceIssues = checkVoice(opt);
    if (voiceIssues.length > 0) score -= 0.3;
    return { option: opt, score: Math.min(1, score), issues: voiceIssues };
  });
  
  scores.sort((a, b) => b.score - a.score);
  const winner = scores[0];
  
  return {
    decision: winner.option,
    confidence: winner.score,
    belowThreshold: winner.score < TWIN_IDENTITY.confidenceThreshold,
    issues: winner.issues,
    alternatives: scores.slice(1, 4).map(s => s.option)
  };
}

function readCommand() {
  const cmdFile = path.join(AGENT_ROOT, 'twin', 'command.txt');
  if (fs.existsSync(cmdFile)) {
    const cmd = fs.readFileSync(cmdFile, 'utf-8').trim();
    fs.unlinkSync(cmdFile);
    return cmd;
  }
  return null;
}

function processCommand(cmd) {
  // Handle pipe-separated commands: decide opt1,opt2 | context
  const pipeParts = cmd.split('|').map(p => p.trim());
  const action = pipeParts[0];
  
  if (action.startsWith('decide ')) {
    const options = action.replace('decide ', '').split(',').map(o => o.trim());
    const context = pipeParts[1] || '';
    
    const result = decide(options, context);
    
    console.log('\n=== Decision ===');
    console.log(`Choice: ${result.decision}`);
    console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    
    if (result.belowThreshold) {
      console.log('⚠ Below threshold - escalation needed');
    }
    if (result.issues.length) {
      console.log('Voice issues:', result.issues.join(', '));
    }
    if (result.alternatives.length) {
      console.log('Alternatives:', result.alternatives.join(', '));
    }
  }
  else if (action.startsWith('remember ')) {
    const keyValue = action.replace('remember ', '').split(' ').filter(s => s);
    if (keyValue.length >= 2) {
      const key = keyValue[0];
      const value = keyValue.slice(1).join(' ');
      saveMemory(key, value);
      console.log(`✓ Saved: ${key}`);
    }
  }
  else if (action.startsWith('recall ')) {
    const key = action.replace('recall ', '').trim();
    console.log('\n=== Recall ===');
    console.log(memory[key] || 'Not found');
  }
  else if (action === 'voice') {
    console.log('\n=== Voice Rules ===');
    console.log(`Tone: ${TWIN_IDENTITY.voice.tone}`);
    console.log('Non-negotiables:');
    TWIN_IDENTITY.voice.nonNegotiables.forEach(n => console.log(`  - ${n}`));
    console.log('Focus:', TWIN_IDENTITY.voice.focus.join(', '));
  }
}

async function main() {
  // Ensure directories exist FIRST
  const twinDir = path.join(AGENT_ROOT, 'twin');
  const memDir = path.join(AGENT_ROOT, 'memory');
  const opsDir = path.join(AGENT_ROOT, 'ops');
  const checkDir = path.join(AGENT_ROOT, 'check');
  
  for (const d of [twinDir, memDir, opsDir, checkDir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
  
  log('SWR-Twin starting...');
  loadMemory();
  
  console.log('[TWIN] Ready. Use command.txt or pipe commands.');
  
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
