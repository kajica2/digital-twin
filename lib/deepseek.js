// lib/deepseek.js — DeepSeek models in the agent routing.
//
// The DeepSeek API is OpenAI-compatible (POST /v1/chat/completions, Bearer
// auth, JSON in/out). It is NOT the same auth as the chat.deepseek.com web
// session: the web session uses a `Cookie: smidV2=...; ds_session_id=...`
// jar, and the API expects `Authorization: Bearer <DEEPSEEK_API_KEY>`. The
// two are separate accounts; the web session cookies do not authenticate
// the API. To use DeepSeek as a model in the routing, set DEEPSEEK_API_KEY
// in the environment (a real key from https://platform.deepseek.com).
//
// This module:
//   - reads the key from DEEPSEEK_API_KEY (never from a file in the repo)
//   - exposes chat() and models() with OpenAI-compatible shapes
//   - fails clearly when the key is missing or invalid
//   - never logs the key or echoes it back
//
// CLI: node bin/deepseek.js <prompt>     # one-shot chat
'use strict';

const ENDPOINT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TIMEOUT_MS = +(process.env.DEEPSEEK_TIMEOUT_MS || 60000);

function redactedKey() {
  if (!API_KEY) return '(none)';
  if (API_KEY.length <= 8) return '***';
  return API_KEY.slice(0, 4) + '…' + API_KEY.slice(-4);
}

function isConfigured() { return !!API_KEY; }

async function request(path, body) {
  if (!API_KEY) {
    const msg = 'deepseek: DEEPSEEK_API_KEY is not set. Get a key at ' +
                'https://platform.deepseek.com and export it in your shell. ' +
                'The web session cookies do NOT authenticate the API.';
    const err = new Error(msg); err.code = 'NO_KEY'; throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT + path, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }
    if (!res.ok) {
      const code = (json && json.error && json.error.code) || ('http_' + res.status);
      const type = (json && json.error && json.error.type) || 'api_error';
      const message = (json && json.error && json.error.message) || ('HTTP ' + res.status);
      const err = new Error('deepseek: ' + message);
      err.status = res.status;
      err.code = code;
      err.type = type;
      err.requestId = (json && json.error && json.error.request_id) || null;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function chat(opts) {
  if (!opts || !opts.messages) throw new Error('deepseek.chat: { messages: [...] } required');
  const body = {
    model: opts.model || DEFAULT_MODEL,
    messages: opts.messages,
    stream: !!opts.stream
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.max_tokens != null) body.max_tokens = opts.max_tokens;
  if (opts.top_p != null) body.top_p = opts.top_p;
  if (opts.stop) body.stop = opts.stop;
  if (opts.response_format) body.response_format = opts.response_format;
  return request('/v1/chat/completions', body);
}

async function models() {
  // The /v1/models endpoint accepts the same Bearer auth; the response is
  // OpenAI-shaped ({ object: 'list', data: [{ id, ... }] }). When the key
  // is unset this throws NO_KEY without making a network call.
  return request('/v1/models', {});
}

// One-shot prompt for CLI use.
async function prompt(text, opts) {
  opts = opts || {};
  const res = await chat({
    model: opts.model,
    messages: [{ role: 'user', content: text }],
    temperature: opts.temperature,
    max_tokens: opts.max_tokens
  });
  return res && res.choices && res.choices[0] && res.choices[0].message
    && res.choices[0].message.content || '';
}

module.exports = {
  ENDPOINT: ENDPOINT,
  DEFAULT_MODEL: DEFAULT_MODEL,
  isConfigured: isConfigured,
  redactedKey: redactedKey,
  chat: chat,
  models: models,
  prompt: prompt
};
