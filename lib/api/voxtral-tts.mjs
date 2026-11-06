// lib/api/voxtral-tts.mjs
//
// Voxtral TTS 3 — text to speech through the Mistral API.
//
// The model is `voxtral-mini-tts-3-0` (API names: `voxtral-mini-tts-3-0`,
// `voxtral-mini-tts-3`, `voxtral-mini-tts-latest`). The endpoint is:
//
//   POST https://api.mistral.ai/v1/audio/speech
//   Authorization: Bearer $MISTRAL_API_KEY
//   Content-Type: application/json
//
//   { "model": "voxtral-mini-tts-3-0",
//     "input": "Your order shipped this morning.",
//     "voice_id": "gb_jane_neutral",
//     "response_format": "mp3" }
//
// The response is JSON: { "audio_data": "<base64 audio>" }.
//
// This module is the whole client: one POST, base64 in, bytes out. No SDK,
// no dependencies — the repo's other API clients (lib/deepseek.js) call
// their endpoints the same way.
//
// The key comes from the MISTRAL_API_KEY environment variable and is read
// per call, so exporting it after the server starts still works. The key is
// never logged, never returned, and never echoed in an error message.
//
// Usage:
//
//   import { synthesizeSpeech } from './voxtral-tts.mjs';
//   const { audio, contentType } = await synthesizeSpeech({
//     text: 'The twin is online.',
//     voiceId: 'gb_jane_neutral',
//     responseFormat: 'mp3',
//   });

const DEFAULT_BASE_URL = 'https://api.mistral.ai';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_TIMEOUT_MS = 60_000;

// Mistral accepts these five output formats.
const FORMATS = ['mp3', 'wav', 'pcm', 'flac', 'opus'];

// Content type per format — the router serves these bytes straight back.
const CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/L16',
  flac: 'audio/flac',
  opus: 'audio/ogg',
};

/** An error that carries an HTTP status, so the router can answer with it. */
function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

/** The model this server speaks with, unless MISTRAL_TTS_MODEL says otherwise. */
export const DEFAULT_MODEL = 'voxtral-mini-tts-3-0';

/** The preset voice used when the caller does not name one. */
export const DEFAULT_VOICE_ID = 'gb_jane_neutral';

/** The API key, read fresh on every call. */
export function apiKey() {
  return String(process.env.MISTRAL_API_KEY || '').trim();
}

/** True when the server has a key to spend. */
export function isConfigured() {
  return apiKey().length > 0;
}

/** Content type for a Mistral output format. */
export function contentTypeFor(format) {
  return CONTENT_TYPES[format] || CONTENT_TYPES.mp3;
}

/**
 * Synthesize speech.
 *
 * @param {{text: string, voiceId?: string, responseFormat?: string,
 *          model?: string, baseUrl?: string, timeoutMs?: number,
 *          apiKey?: string, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{audio: Buffer, contentType: string, model: string,
 *                    voiceId: string, responseFormat: string}>}
 */
export async function synthesizeSpeech(opts = {}) {
  const key = String(opts.apiKey ?? apiKey()).trim();
  if (!key) {
    throw httpError(
      503,
      'MISTRAL_API_KEY is not set. Export it in the server environment and restart the server.'
    );
  }

  const text = typeof opts.text === 'string' ? opts.text.trim() : '';
  if (!text) {
    throw httpError(400, 'text is required');
  }
  if (text.length > 5_000) {
    throw httpError(400, `text is too long (${text.length} characters, max 5000)`);
  }

  const responseFormat = String(opts.responseFormat || DEFAULT_FORMAT).toLowerCase();
  if (!FORMATS.includes(responseFormat)) {
    throw httpError(
      400,
      `response_format must be one of: ${FORMATS.join(', ')} (got "${responseFormat}")`
    );
  }

  const model = String(opts.model || process.env.MISTRAL_TTS_MODEL || DEFAULT_MODEL);
  const voiceId = String(
    opts.voiceId || process.env.MISTRAL_TTS_VOICE || DEFAULT_VOICE_ID
  );
  const baseUrl = String(
    opts.baseUrl || process.env.MISTRAL_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const timeoutMs = Number(opts.timeoutMs ?? process.env.MISTRAL_TTS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const doFetch = opts.fetchImpl || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  let raw;
  try {
    res = await doFetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text,
        voice_id: voiceId,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (err) {
    // A network failure or an abort — never echo the key back.
    const message =
      err && err.name === 'AbortError'
        ? `Mistral TTS timed out after ${timeoutMs}ms`
        : `could not reach the Mistral API: ${err && err.message ? err.message : String(err)}`;
    throw httpError(502, message);
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // Mistral errors carry { message, type, code }. Surface the message,
    // never the key.
    const message =
      (payload && (payload.message || payload.detail)) ||
      `Mistral API returned HTTP ${res.status}`;
    throw httpError(res.status === 429 ? 429 : 502, `Mistral TTS: ${message}`);
  }

  const encoded = payload && payload.audio_data;
  if (typeof encoded !== 'string' || !encoded) {
    throw httpError(502, 'Mistral TTS: response had no audio_data');
  }

  const audio = Buffer.from(encoded, 'base64');
  if (audio.length === 0) {
    throw httpError(502, 'Mistral TTS: response audio_data decoded to zero bytes');
  }

  return {
    audio,
    contentType: contentTypeFor(responseFormat),
    model,
    voiceId,
    responseFormat,
  };
}
