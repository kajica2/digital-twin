#!/usr/bin/env node
/**
 * Twin Agent - Obsidian Poster
 * Consistent agent that posts updates to Obsidian
 * 
 * Usage:
 *   node twin-agent.js post "Task completed" --note "daily/2026-01-15"
 *   node twin-agent.js post "FLUX generation done" --tag "flux"
 *   node twin-agent.js context "What was I working on?"
 *   node twin-agent.js search "FLUX"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const VAULT_PATH = process.env.OBSIDIAN_VAULT || 
  path.join(process.env.HOME || '', 'Documents', 'obsidian', 'TwinOS');
const AGENT_NAME = 'TwinAgent';
const AGENT_NOTES_PATH = 'agents/twin';

// Ensure agent notes folder exists
const agentNotesDir = path.join(VAULT_PATH, AGENT_NOTES_PATH);
if (!fs.existsSync(agentNotesDir)) {
  fs.mkdirSync(agentNotesDir, { recursive: true });
}

function getTimestamp() {
  return new Date().toISOString();
}

function getDatePath() {
  return new Date().toISOString().split('T')[0];
}

// Write to Obsidian
async function writeNote(notePath, content, append = true) {
  const fullPath = path.join(VAULT_PATH, notePath + '.md');
  const dir = path.dirname(fullPath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let finalContent = content;
  if (append && fs.existsSync(fullPath)) {
    const existing = fs.readFileSync(fullPath, 'utf-8');
    finalContent = existing + '\n' + content;
  }

  fs.writeFileSync(fullPath, finalContent, 'utf-8');
  return fullPath;
}

// Post update to agent log
async function postUpdate(message, options = {}) {
  const { tag, note, timestamp = true } = options;
  
  const datePath = getDatePath();
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  
  let content = '';
  if (timestamp) {
    content = `## ${time} — ${message}`;
  } else {
    content = message;
  }
  
  if (tag) {
    content += `\n> [[tag:${tag}]]`;
  }
  
  // Default to agent daily log
  const targetNote = note || `${AGENT_NOTES_PATH}/${datePath}`;
  
  await writeNote(targetNote, '\n' + content);
  
  console.log(`✓ Posted to ${targetNote}`);
  return targetNote;
}

// Post to specific project notes
async function postToProject(projectName, message) {
  const projectPath = `projects/${projectName}`;
  const content = `\n## ${getTimestamp()} — ${message}`;
  
  await writeNote(projectPath, content);
  console.log(`✓ Posted to ${projectPath}`);
}

// Search vault
async function searchVault(query) {
  const results = [];
  
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      
      if (fs.statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else if (item.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8').toLowerCase();
        if (content.includes(query.toLowerCase()) || item.toLowerCase().includes(query.toLowerCase())) {
          const relPath = path.relative(VAULT_PATH, fullPath).replace('.md', '');
          results.push(relPath);
        }
      }
    }
  };

  walk(VAULT_PATH);
  return results;
}

// Get agent context
async function getContext(maxNotes = 5) {
  const agentLogPath = `${AGENT_NOTES_PATH}/${getDatePath()}`;
  const fullPath = path.join(VAULT_PATH, agentLogPath + '.md');
  
  if (!fs.existsSync(fullPath)) {
    return { context: 'No agent activity today', notes: [] };
  }
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  return {
    date: getDatePath(),
    log: content,
    note: agentLogPath
  };
}

// CLI
const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (command) {
    case 'post': {
      const message = args[0];
      if (!message) {
        console.error('Usage: twin-agent.js post "message" [--tag tagname]');
        process.exit(1);
      }
      
      const options = {};
      const tagIndex = args.indexOf('--tag');
      if (tagIndex > -1 && args[tagIndex + 1]) {
        options.tag = args[tagIndex + 1];
      }
      
      const noteIndex = args.indexOf('--note');
      if (noteIndex > -1 && args[noteIndex + 1]) {
        options.note = args[noteIndex + 1];
      }
      
      await postUpdate(message, options);
      break;
    }
    
    case 'project': {
      const project = args[0];
      const message = args.slice(1).join(' ');
      if (!project || !message) {
        console.error('Usage: twin-agent.js project projectname "message"');
        process.exit(1);
      }
      await postToProject(project, message);
      break;
    }
    
    case 'search': {
      const query = args.join(' ');
      if (!query) {
        console.error('Usage: twin-agent.js search "query"');
        process.exit(1);
      }
      const results = await searchVault(query);
      console.log(`\nFound ${results.length} notes:`);
      results.forEach(r => console.log(`  - ${r}`));
      break;
    }
    
    case 'context': {
      const ctx = await getContext();
      console.log(`\n=== Agent Context (${ctx.date}) ===\n`);
      console.log(ctx.log || ctx.context);
      console.log(`\nNote: ${ctx.note}`);
      break;
    }
    
    case 'init': {
      // Initialize agent vault structure
      const folders = ['agents/twin', 'projects', 'daily', 'tasks', 'ideas'];
      for (const folder of folders) {
        const fullPath = path.join(VAULT_PATH, folder);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
          console.log(`✓ Created ${folder}`);
        }
      }
      
      // Create welcome note
      const welcomePath = path.join(VAULT_PATH, 'agents/twin/welcome.md');
      if (!fs.existsSync(welcomePath)) {
        const welcome = `# Welcome to TwinAgent

Agent: ${AGENT_NAME}
Initialized: ${getTimestamp()}

## Commands

- \`twin-agent.js post "message" --tag tagname\` - Post update
- \`twin-agent.js project projectname "message"\` - Post to project
- \`twin-agent.js search "query"\` - Search vault
- \`twin-agent.js context\` - Get today's context

## Notes

- Daily logs: \`agents/twin/YYYY-MM-DD.md\`
- Project notes: \`projects/[name].md\`
- Tasks: \`tasks/\`
`;
        fs.writeFileSync(welcomePath, welcome);
        console.log('✓ Created welcome note');
      }
      console.log('\n✓ TwinAgent initialized!');
      break;
    }
    
    default:
      console.log(`
TwinAgent - Obsidian Poster

Usage:
  twin-agent.js init                          Initialize agent vault structure
  twin-agent.js post "message" [--tag X]     Post update to daily log
  twin-agent.js project "project" "message"  Post to project notes
  twin-agent.js search "query"               Search vault
  twin-agent.js context                      Get today's context

Environment:
  OBSIDIAN_VAULT=/path/to/vault
`);
  }
}

main().catch(console.error);
