#!/usr/bin/env node
/**
 * SWR LM Client - Unified interface for multiple LMs
 * Supports: MiniMax, DeepSeek, Claude, OpenAI
 */

import fetch from 'node:fetch';

const CONFIG = {
  // MiniMax (your primary)
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN,
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-M2.5'
  },
  // DeepSeek
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  // Claude (Anthropic)
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514'
  },
  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o'
  }
};

let currentProvider = process.env.SWR_LM_PROVIDER || 'minimax';

export function setProvider(provider) {
  if (CONFIG[provider]) {
    currentProvider = provider;
    return `Switched to ${provider}`;
  }
  return `Unknown provider: ${provider}. Available: ${Object.keys(CONFIG).join(', ')}`;
}

export function getProvider() {
  return currentProvider;
}

async function callMinimax(messages, options = {}) {
  const cfg = CONFIG.minimax;
  const response = await fetch(`${cfg.baseUrl}/text/chatcompletion_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096
    })
  });
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || data.error?.message;
}

async function callDeepSeek(messages, options = {}) {
  const cfg = CONFIG.deepseek;
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096
    })
  });
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || data.error?.message;
}

async function callClaude(messages, options = {}) {
  const cfg = CONFIG.claude;
  const response = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096
    })
  });
  
  const data = await response.json();
  return data.content?.[0]?.text || data.error?.message;
}

async function callOpenAI(messages, options = {}) {
  const cfg = CONFIG.openai;
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096
    })
  });
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || data.error?.message;
}

export async function chat(messages, options = {}) {
  const provider = options.provider || currentProvider;
  
  switch (provider) {
    case 'minimax':
      return callMinimax(messages, options);
    case 'deepseek':
      return callDeepSeek(messages, options);
    case 'claude':
      return callClaude(messages, options);
    case 'openai':
      return callOpenAI(messages, options);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Quick completion
export async function complete(prompt, options = {}) {
  return chat([{ role: 'user', content: prompt }], options);
}

// Agent-specific prompts
export const AGENT_PROMPTS = {
  ops: `You are SWR-Ops, orchestrator for Sainted Word Records. 
Decompose tasks into small verifiable steps. Maintain TASKS.md with: Blocked / In Progress / Done.
Rules:
- Read-only first: check existing files before assigning work
- Every task needs: owner, acceptance criteria, evidence required
- Use vertical slice: implement → test → verify → commit → next`,

  twin: `You are SWR-Twin, embodying the founder's voice (Kai Djuric).
Voice: direct, warm, no hype, slightly cynical but passionate about music.
Focus: deep house, lo-fi hip hop, vinyl culture, new wave.
Non-negotiables: Never invent facts, never aggressive sales, always credit sources.
Make decisions with confidence score. If below 0.85, escalate to human.`,

  check: `You are SWR-Check, verifier agent for Sainted Word Records.
Read-only. Validate claims with evidence. Check file:line references.
Never suggest — only verify.
Commands: file <path>, claim <statement>, test, diff <pattern>`
};

export default { chat, complete, setProvider, getProvider, AGENT_PROMPTS };
