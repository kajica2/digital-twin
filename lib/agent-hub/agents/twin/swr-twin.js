#!/usr/bin/env node
/**
 * SWR-Twin (Digital Twin Agent)
 * Embodies founder's voice, taste, creative decisions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '../..');
const MEMORY_FILE = path.join(AGENT_DIR, 'memory', 'twin-memory.md');
const VOICE_FILE = path.join(AGENT_DIR, 'memory', 'voice-rules.md');
const LOG_FILE = path.join(AGENT_DIR, 'twin', 'logs.txt');

// Twin identity
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
let running = false;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [TWIN] ${msg}`;
  console.log(`\n${line}`);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    // Parse memory entries
    const entries = content.split('## ');
    for (const entry of entries) {
      if (entry.trim()) {
        const lines = entry.split('\n');
        const key = lines[0].trim().toLowerCase();
        memory[key] = lines.slice(1).join('\n').trim();
      }
    }
    log(`Loaded ${Object.keys(memory).length} memory entries`);
  }
  
  if (fs.existsSync(VOICE_FILE)) {
    log('Voice rules loaded');
  }
}

function saveMemory(key, value) {
  memory[key] = value;
  let content = '# Twin Memory\n\n';
  for (const [k, v] of Object.entries(memory)) {
    content += `## ${k}\n\n${v}\n\n`;
  }
  fs.writeFileSync(MEMORY_FILE, content);
}

// Check against voice rules
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

// Make creative decision with confidence
function decide(options, context = '') {
  // Simple scoring - in production this would use embeddings
  const scores = options.map(opt => {
    let score = 0.5;
    
    // Boost for focus areas
    for (const focus of TWIN_IDENTITY.voice.focus) {
      if (opt.toLowerCase().includes(focus)) score += 0.2;
    }
    
    // Check voice
    const voiceIssues = checkVoice(opt);
    if (voiceIssues.length > 0) score -= 0.3;
    
    return { option: opt, score: Math.min(1, score), issues: voiceIssues };
  });
  
  scores.sort((a, b) => b.score - a.score);
  
  const winner = scores[0];
  const confidence = winner.score;
  
  return {
    decision: winner.option,
    confidence,
    belowThreshold: confidence < TWIN_IDENTITY.confidenceThreshold,
    issues: winner.issues,
    alternatives: scores.slice(1, 4).map(s => s.option)
  };
}

// Read from ops
function readFromOps() {
  const inboxFile = path.join(AGENT_DIR, 'ops', 'inbox.txt');
  if (fs.existsSync(inboxFile)) {
    const content = fs.readFileSync(inboxFile, 'utf-8');
    fs.unlinkSync(inboxFile);
    return content.split('\n').filter(l => l.trim());
  }
  return [];
}

// Write to ops
async function sendToOps(message) {
  const msgFile = path.join(AGENT_DIR, 'hub', 'twin-outbox.txt');
  fs.appendFileSync(msgFile, `[TWIN→OPS ${new Date().toISOString()}] ${message}\n`);
}

// Main loop
async function main() {
  log('SWR-Twin starting...');
  loadMemory();
  
  const inboxDir = path.join(AGENT_DIR, 'twin');
  if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
  
  running = true;
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  
  log('SWR-Twin ready. Commands: decide, remember, recall, voice, help');
  
  const prompt = () => {
    rl.question('\n[TWIN] > ', async (cmd) => {
      const parts = cmd.trim().split('|').map(p => p.trim());
      const action = parts[0];
      const args = parts.slice(1);
      
      switch (action) {
        case 'decide':
          if (args.length >= 2) {
            const options = args[0].split(',').map(o => o.trim());
            const context = args[1] || '';
            const result = decide(options, context);
            
            console.log('\n=== Decision ===');
            console.log(`Choice: ${result.decision}`);
            console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
            
            if (result.belowThreshold) {
              console.log('⚠️ Below threshold - escalation needed');
              await sendToOps(`ESCALATE: ${result.decision} (confidence ${result.confidence.toFixed(2)})`);
            }
            if (result.issues.length) {
              console.log('Voice issues:', result.issues);
            }
            if (result.alternatives.length) {
              console.log('Alternatives:', result.alternatives.join(', '));
            }
          }
          break;
          
        case 'remember':
          if (parts[1] && parts[2]) {
            saveMemory(parts[1], parts[2]);
            log(`Saved: ${parts[1]}`);
          }
          break;
          
        case 'recall':
          const key = args[0] || '';
          console.log('\n=== Recall ===');
          console.log(memory[key] || 'Not found');
          break;
          
        case 'voice':
          console.log('\n=== Voice Rules ===');
          console.log(`Tone: ${TWIN_IDENTITY.voice.tone}`);
          console.log('Non-negotiables:');
          TWIN_IDENTITY.voice.nonNegotiables.forEach(n => console.log(`  - ${n}`));
          console.log('Focus:', TWIN_IDENTITY.voice.focus.join(', '));
          break;
          
        case 'help':
          console.log(`
Commands:
  decide <opt1, opt2, opt3> | <context>  - Make decision with confidence
  remember <key> | <value>              - Store in memory
  recall <key>                           - Retrieve from memory
  voice                                  - Show voice rules
  help                                   - Show this help
`);
          break;
          
        default:
          // Check inbox
          if (action) log(`Unknown: ${action}`);
      }
      
      // Check inbox from ops
      const opsMsgs = readFromOps();
      for (const msg of opsMsgs) {
        if (msg.includes('task added:')) {
          const task = msg.replace('OPS→TWIN', '').replace('task added:', '').trim();
          log(`New task: ${task}`);
          // Could auto-decide or wait for input
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
