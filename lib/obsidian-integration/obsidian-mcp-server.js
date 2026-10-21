#!/usr/bin/env node
/**
 * Obsidian MCP Server
 * Gives AI agents read/write access to your Obsidian vault
 * 
 * Usage: 
 *   node obsidian-mcp-server.js [--vault /path/to/vault]
 * 
 * Or run as MCP server (for Claude Code, Codex, etc.)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT || 
  path.join(process.env.HOME || '', 'Documents', 'obsidian', 'TwinOS');

// Simple MCP protocol implementation
class ObsidianMCPServer {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this.tools = this.registerTools();
  }

  registerTools() {
    return {
      'obsidian_read_note': {
        description: 'Read a note from Obsidian vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path (relative to vault, without .md)' }
          },
          required: ['path']
        }
      },
      'obsidian_write_note': {
        description: 'Write a note to Obsidian vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path (relative to vault, without .md)' },
            content: { type: 'string', description: 'Note content (markdown)' },
            append: { type: 'boolean', description: 'Append to existing note instead of overwrite' }
          },
          required: ['path', 'content']
        }
      },
      'obsidian_list_notes': {
        description: 'List notes in a folder',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder path (relative to vault)' },
            recursive: { type: 'boolean', description: 'Recursively list subfolders' }
          }
        }
      },
      'obsidian_search': {
        description: 'Search notes by filename or content',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            folder: { type: 'string', description: 'Folder to search in' }
          },
          required: ['query']
        }
      },
      'obsidian_create_daily_note': {
        description: 'Create or update a daily note',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Daily note title (YYYY-MM-DD format)' },
            content: { type: 'string', description: 'Content to append' }
          },
          required: ['title']
        }
      },
      'obsidian_get_agent_context': {
        description: 'Get context for an agent task - reads relevant notes',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description to find relevant notes' },
            maxNotes: { type: 'number', description: 'Max notes to retrieve' }
          }
        }
      }
    };
  }

  // Tool implementations
  async readNote(args) {
    const notePath = path.join(this.vaultPath, args.path + '.md');
    if (!fs.existsSync(notePath)) {
      return { error: `Note not found: ${args.path}` };
    }
    const content = fs.readFileSync(notePath, 'utf-8');
    return { path: args.path, content, exists: true };
  }

  async writeNote(args) {
    const fullPath = path.join(this.vaultPath, args.path + '.md');
    const dir = path.dirname(fullPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let content = args.content;
    if (args.append && fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, 'utf-8');
      content = existing + '\n\n' + args.content;
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    return { path: args.path, success: true, written: true };
  }

  async listNotes(args) {
    const folder = args.folder || '';
    const folderPath = path.join(this.vaultPath, folder);
    
    if (!fs.existsSync(folderPath)) {
      return { error: `Folder not found: ${folder}` };
    }

    const notes = [];
    const walk = (dir, relPath = '') => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const itemRelPath = path.join(relPath, item);
        
        if (fs.statSync(fullPath).isDirectory()) {
          if (args.recursive) {
            walk(fullPath, itemRelPath);
          }
        } else if (item.endsWith('.md')) {
          notes.push(itemRelPath.replace('.md', ''));
        }
      }
    };

    walk(folderPath, folder);
    return { folder, notes };
  }

  async search(args) {
    const results = [];
    const searchIn = args.folder ? path.join(this.vaultPath, args.folder) : this.vaultPath;
    
    if (!fs.existsSync(searchIn)) {
      return { error: `Search path not found: ${args.folder || 'vault root'}` };
    }

    const query = args.query.toLowerCase();
    
    const walk = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        
        if (fs.statSync(fullPath).isDirectory()) {
          walk(fullPath);
        } else if (item.endsWith('.md')) {
          const content = fs.readFileSync(fullPath, 'utf-8').toLowerCase();
          if (content.includes(query) || item.toLowerCase().includes(query)) {
            const relPath = path.relative(this.vaultPath, fullPath).replace('.md', '');
            results.push({ 
              path: relPath,
              match: content.includes(query) ? 'content' : 'filename'
            });
          }
        }
      }
    };

    walk(searchIn);
    return { query: args.query, results: results.slice(0, 20) };
  }

  async createDailyNote(args) {
    const title = args.title || new Date().toISOString().split('T')[0];
    const datePath = path.join('daily', title + '.md');
    const fullPath = path.join(this.vaultPath, datePath);
    const dir = path.dirname(fullPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let content = args.content || '';
    
    if (fs.existsSync(fullPath) && args.content) {
      const existing = fs.readFileSync(fullPath, 'utf-8');
      content = existing + '\n\n' + args.content;
    } else if (!fs.existsSync(fullPath)) {
      content = `# ${title}\n\n${args.content || ''}`;
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    return { path: datePath, success: true };
  }

  async getAgentContext(args) {
    // Search for relevant notes based on task
    const searchResults = await this.search({ query: args.task });
    
    if (!searchResults.results || searchResults.results.length === 0) {
      return { task: args.task, context: 'No relevant notes found', notes: [] };
    }

    const maxNotes = args.maxNotes || 5;
    const contextNotes = [];
    
    for (const result of searchResults.results.slice(0, maxNotes)) {
      const note = await this.readNote({ path: result.path });
      if (!note.error) {
        contextNotes.push({
          path: result.path,
          content: note.content.slice(0, 2000) // Limit context size
        });
      }
    }

    return {
      task: args.task,
      notes: contextNotes.length,
      context: contextNotes.map(n => `## ${n.path}\n\n${n.content}`).join('\n\n---\n\n')
    };
  }

  // MCP Protocol
  async handleRequest(tool, args) {
    switch (tool) {
      case 'obsidian_read_note': return this.readNote(args);
      case 'obsidian_write_note': return this.writeNote(args);
      case 'obsidian_list_notes': return this.listNotes(args);
      case 'obsidian_search': return this.search(args);
      case 'obsidian_create_daily_note': return this.createDailyNote(args);
      case 'obsidian_get_agent_context': return this.getAgentContext(args);
      default: return { error: `Unknown tool: ${tool}` };
    }
  }

  // JSON-RPC style communication
  async processMessage(line) {
    try {
      const msg = JSON.parse(line);
      const result = await this.handleRequest(msg.tool, msg.args || {});
      return JSON.stringify({ id: msg.id, result }) + '\n';
    } catch (e) {
      return JSON.stringify({ error: e.message }) + '\n';
    }
  }

  start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      if (line.trim()) {
        const response = await this.processMessage(line);
        process.stdout.write(response);
      }
    });

    console.error('Obsidian MCP Server running...');
    console.error(`Vault: ${this.vaultPath}`);
  }
}

// CLI
const vaultArg = process.argv.find((a, i) => process.argv[i-1] === '--vault');
const vaultPath = vaultArg ? process.argv[process.argv.indexOf(vaultArg) + 1] : DEFAULT_VAULT;

console.error(`Initializing Obsidian MCP for vault: ${vaultPath}`);

const server = new ObsidianMCPServer(vaultPath);
server.start();
