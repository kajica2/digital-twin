#!/usr/bin/env node
/**
 * SWR LM Client — one interface for several model providers.
 *
 * Providers: MiniMax, DeepSeek, Claude, OpenAI.
 *
 * Two changes from the earlier version:
 *   - it imported `node:fetch`, a module that no longer exists in Node 22
 *     (the global `fetch` has been in Node since 18). The import threw
 *     ERR_UNKNOWN_BUILTIN_MODULE before a single call could be made, and
 *     nothing in the repo imported this file, so the breakage was silent.
 *   - it is CommonJS now, like every other module under lib/.
 *
 * The keys come from the environment. A missing key fails loudly with a
 * message that says which variable to set — a silent 401 from a provider
 * reads like a bad prompt.
 *
 * Plain Node, no dependencies. CommonJS.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG = {
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || process.env.MINIMAX_TOKEN,
    keyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-M2.5',
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    keyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
};

/**
 * Read a key file, so a launchd-launched agent can be model-backed
 * without the key travelling through a plist or the shell.
 *
 * Accepted shapes:
 *   minimax=…            one `provider=key` per line (providers: the
 *   deepseek=…           names in PROVIDERS)
 *   …or a bare key       which is applied to the active provider
 *
 * The file lives outside the repo (default ~/.swr-lm-key, mode 0600 —
 * the same place every other jar in this repo lives), and a missing file
 * is not an error: the environment is still consulted first, and an
 * unconfigured twin falls back to its rule engine.
 */
function loadKeyFile(file) {
  const target = file || process.env.SWR_LM_KEY_FILE || path.join(os.homedir(), '.swr-lm-key');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return { file: target, used: [], missing: true };
  }

  const used = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const name = trimmed.slice(0, eq).trim();
      const key = trimmed.slice(eq + 1).trim();
      if (CONFIG[name] && key && !CONFIG[name].apiKey) {
        CONFIG[name].apiKey = key;
        used.push(name);
      }
      continue;
    }
    // A bare key belongs to the active provider.
    const bare = trimmed.replace(/^["']|["']$/g, '');
    if (CONFIG[currentProvider] && !CONFIG[currentProvider].apiKey) {
      CONFIG[currentProvider].apiKey = bare;
      used.push(currentProvider);
    }
  }
  return { file: target, used, missing: false };
}

let currentProvider = process.env.SWR_LM_PROVIDER || 'minimax';

let keyFileStatus = { file: null, used: [], missing: true };

/** The provider names this client knows. */
const PROVIDERS = Object.keys(CONFIG);

keyFileStatus = loadKeyFile();

/**
 * Switch the active provider.
 *
 * @param {string} provider
 * @returns {string} a human-readable confirmation (or the rejection).
 */
function setProvider(provider) {
  if (CONFIG[provider]) {
    currentProvider = provider;
    return `Switched to ${provider}`;
  }
  return `Unknown provider: ${provider}. Available: ${PROVIDERS.join(', ')}`;
}

/** @returns {string} the active provider. */
function getProvider() {
  return currentProvider;
}

/**
 * The providers that currently have a key set.
 *
 * @returns {{provider: string, hasKey: boolean, keyEnv: string}[]}
 */
function providerStatus() {
  return PROVIDERS.map((name) => ({
    provider: name,
    hasKey: Boolean(CONFIG[name].apiKey),
    keyEnv: CONFIG[name].keyEnv,
  }));
}

/**
 * The first provider that has a key, or null. The hub's agents ask this
 * once at startup so they can say which mode they are in.
 *
 * @returns {string|null}
 */
function configuredProvider() {
  const hit = PROVIDERS.find((name) => CONFIG[name].apiKey);
  return hit || null;
}

/** Where the key came from, for a startup line. Never the key itself. */
function keySource() {
  return { file: keyFileStatus.file, usedFromFile: keyFileStatus.used, missing: keyFileStatus.missing };
}

/**
 * Require a key before making a request.
 *
 * @param {string} provider
 */
function requireKey(provider) {
  const cfg = CONFIG[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!cfg.apiKey) {
    throw new Error(`No API key for ${provider}. Set ${cfg.keyEnv} in the environment.`);
  }
  return cfg;
}

async function callChatCompletions(cfg, messages, options, headers) {
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model: options.model || cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${cfg.model || 'provider'} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.choices?.[0]?.message?.content || '';
}

async function callMinimax(messages, options = {}) {
  const cfg = requireKey('minimax');
  const response = await fetch(`${cfg.baseUrl}/text/chatcompletion_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`minimax HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.choices?.[0]?.message?.content || data.error?.message || '';
}

async function callDeepSeek(messages, options = {}) {
  const cfg = requireKey('deepseek');
  return callChatCompletions(cfg, messages, options, { Authorization: `Bearer ${cfg.apiKey}` });
}

async function callOpenAI(messages, options = {}) {
  const cfg = requireKey('openai');
  return callChatCompletions(cfg, messages, options, { Authorization: `Bearer ${cfg.apiKey}` });
}

async function callClaude(messages, options = {}) {
  const cfg = requireKey('claude');
  const response = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: options.model || cfg.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`claude HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.content?.[0]?.text || '';
}

/**
 * Send a conversation to the active (or given) provider.
 *
 * @param {{role: string, content: string}[]} messages
 * @param {{provider?: string, model?: string, temperature?: number, maxTokens?: number}} [options]
 * @returns {Promise<string>}
 */
async function chat(messages, options = {}) {
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

/**
 * A one-shot completion.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @returns {Promise<string>}
 */
async function complete(prompt, options = {}) {
  return chat([{ role: 'user', content: prompt }], options);
}

/** Agent-specific prompts, used when a provider is asked to role-play an agent. */
const AGENT_PROMPTS = {
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
Commands: file <path>, claim <statement>, test, diff <pattern>`,
};

module.exports = {
  configuredProvider,
  keySource,
  loadKeyFile, chat, complete, setProvider, getProvider, providerStatus, AGENT_PROMPTS, PROVIDERS };
module.exports.default = module.exports;
