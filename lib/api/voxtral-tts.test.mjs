// lib/api/voxtral-tts.test.mjs
//
// Tests for the Voxtral TTS path: the Mistral client (`voxtral-tts.mjs`)
// and the route it feeds (`POST /api/tts` in `router.mjs`).
//
// The bug this guards: a text-to-speech endpoint is the one route that
// spends an external API key. Three things have to hold at once —
//
//   * the request Mistral receives is the documented one (model, input,
//     voice_id, response_format, bearer auth);
//   * the response is DECODED from base64 and served as bytes with the
//     right content type, because a JSON body of base64 makes the browser
//     do work the server should have done;
//   * the route only answers trusted callers. The server binds 0.0.0.0, so
//     an open POST here would let anything on the LAN spend the key.
//
// No network, no key: the client takes an injected fetch, and the router
// takes an injected synthesizer.
//
//   node lib/api/voxtral-tts.test.mjs

import { PassThrough } from 'node:stream';

import {
  synthesizeSpeech,
  isConfigured,
  contentTypeFor,
  DEFAULT_MODEL,
  DEFAULT_VOICE_ID,
} from './voxtral-tts.mjs';
import { createApiRouter } from './router.mjs';

let passed = 0;
const failures = [];
function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
  else {
    failures.push({ label, actual: a, expected: e });
    process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
  }
}
function assertTrue(label, cond) {
  if (cond) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
  else { failures.push({ label, actual: 'false', expected: 'true' }); process.stderr.write(`  ✗ ${label}\n`); }
}
async function throws(label, fn, fragment) {
  try {
    await fn();
    failures.push({ label, actual: 'did not throw', expected: fragment || 'throw' });
    process.stderr.write(`  ✗ ${label} (did not throw)\n`);
  } catch (e) {
    assertTrue(label, !fragment || String(e.message).includes(fragment));
    return e;
  }
  return null;
}

/** A fetch that records the request and answers with a canned response. */
function fakeFetch(response, seen) {
  return async (url, init) => {
    seen.url = url;
    seen.init = init;
    seen.body = JSON.parse(init.body);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      text: async () => response.text,
    };
  };
}

const AUDIO_BYTES = Buffer.from('ID3fake-mp3-payload');
const AUDIO_B64 = AUDIO_BYTES.toString('base64');

const KEY = 'test-mistral-key-not-real';
const SAVED_KEY = process.env.MISTRAL_API_KEY;

// --------------------------------------------------------------- 1. the client
process.stderr.write('1. the client asks Mistral for the documented request\n');
{
  const seen = {};
  const result = await synthesizeSpeech({
    text: 'The twin is online.',
    apiKey: KEY,
    fetchImpl: fakeFetch({ text: JSON.stringify({ audio_data: AUDIO_B64 }) }, seen),
  });

  assert('the endpoint is the Mistral speech endpoint',
    seen.url, 'https://api.mistral.ai/v1/audio/speech');
  assert('the method is POST', seen.init.method, 'POST');
  assert('the key is a bearer token',
    seen.init.headers.authorization, `Bearer ${KEY}`);
  // The model and the voice are asserted as LITERALS, not as the imported
  // constants: comparing the constant to itself passes even when the
  // constant is wrong, which is exactly the mutation this file has to catch.
  assert('the model is voxtral-mini-tts-3-0', seen.body.model, 'voxtral-mini-tts-3-0');
  assert('the text is the input', seen.body.input, 'The twin is online.');
  assert('a voice is always sent', seen.body.voice_id, 'gb_jane_neutral');
  assert('the format is asked for', seen.body.response_format, 'mp3');
  assert('the audio is decoded from base64',
    result.audio.equals(AUDIO_BYTES), true);
  assert('the content type matches the format',
    result.contentType, 'audio/mpeg');
  assert('the model is reported back', result.model, 'voxtral-mini-tts-3-0');
}

process.stderr.write('\n2. the client honours the caller\n');
{
  const seen = {};
  await synthesizeSpeech({
    text: '  trimmed  ',
    voiceId: 'voice_478',
    responseFormat: 'wav',
    apiKey: KEY,
    fetchImpl: fakeFetch({ text: JSON.stringify({ audio_data: AUDIO_B64 }) }, seen),
  });
  assert('the text is trimmed', seen.body.input, 'trimmed');
  assert('the voice is the caller\'s', seen.body.voice_id, 'voice_478');
  assert('the format is the caller\'s', seen.body.response_format, 'wav');
  assert('wav has its own content type', contentTypeFor('wav'), 'audio/wav');
}

process.stderr.write('\n3. the client refuses bad input before spending anything\n');
{
  let called = false;
  const counting = async () => { called = true; return { ok: true, status: 200, text: async () => '' }; };

  const noKey = await throws('a missing key is a 503', () =>
    synthesizeSpeech({ text: 'hi', apiKey: '', fetchImpl: counting }),
  'MISTRAL_API_KEY is not set');
  assert('the missing key carries a 503', noKey && noKey.statusCode, 503);

  const empty = await throws('empty text is a 400', () =>
    synthesizeSpeech({ text: '   ', apiKey: KEY, fetchImpl: counting }),
  'text is required');
  assert('the empty text carries a 400', empty && empty.statusCode, 400);

  const badFormat = await throws('an unknown format is a 400', () =>
    synthesizeSpeech({ text: 'hi', responseFormat: 'aiff', apiKey: KEY, fetchImpl: counting }),
  'response_format must be one of');
  assert('the bad format carries a 400', badFormat && badFormat.statusCode, 400);

  const tooLong = await throws('over-long text is a 400', () =>
    synthesizeSpeech({ text: 'x'.repeat(5001), apiKey: KEY, fetchImpl: counting }),
  'text is too long');
  assert('the over-long text carries a 400', tooLong && tooLong.statusCode, 400);

  assertTrue('none of the bad inputs reached the network', called === false);
}

process.stderr.write('\n4. the client reports upstream failures honestly\n');
{
  const unauthorized = await throws('an upstream 401 is a 502', () =>
    synthesizeSpeech({
      text: 'hi',
      apiKey: KEY,
      fetchImpl: fakeFetch({ ok: false, status: 401, text: JSON.stringify({ message: 'Unauthorized' }) }, {}),
    }),
  'Unauthorized');
  assert('the upstream 401 carries a 502', unauthorized && unauthorized.statusCode, 502);
  assertTrue('the key is never echoed in the error',
    !String(unauthorized && unauthorized.message).includes(KEY));

  const limited = await throws('an upstream 429 stays a 429', () =>
    synthesizeSpeech({
      text: 'hi',
      apiKey: KEY,
      fetchImpl: fakeFetch({ ok: false, status: 429, text: JSON.stringify({ message: 'Rate limited' }) }, {}),
    }),
  'Rate limited');
  assert('the upstream 429 carries a 429', limited && limited.statusCode, 429);

  const emptyAudio = await throws('a response with no audio_data is a 502', () =>
    synthesizeSpeech({
      text: 'hi',
      apiKey: KEY,
      fetchImpl: fakeFetch({ text: JSON.stringify({}) }, {}),
    }),
  'no audio_data');
  assert('the missing audio_data carries a 502', emptyAudio && emptyAudio.statusCode, 502);

  const notJson = await throws('a non-JSON response is a 502', () =>
    synthesizeSpeech({
      text: 'hi',
      apiKey: KEY,
      fetchImpl: fakeFetch({ text: '<html>gateway</html>' }, {}),
    }),
  'no audio_data');
  assert('the non-JSON response carries a 502', notJson && notJson.statusCode, 502);

  const unreachable = await throws('a network failure is a 502', () =>
    synthesizeSpeech({
      text: 'hi',
      apiKey: KEY,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
  'could not reach the Mistral API');
  assert('the network failure carries a 502', unreachable && unreachable.statusCode, 502);
}

process.stderr.write('\n5. the key is read from the environment, per call\n');
{
  process.env.MISTRAL_API_KEY = KEY;
  assertTrue('the client reports itself configured', isConfigured() === true);
  delete process.env.MISTRAL_API_KEY;
  assertTrue('the client reports itself unconfigured without the key', isConfigured() === false);
  if (SAVED_KEY === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = SAVED_KEY;
}

// ---------------------------------------------------------------- 6. the route
/** A request the router can read: method, headers, socket, and a body. */
function makeReq({ method = 'POST', headers = {}, remoteAddress = '127.0.0.1', body = {} } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.end(JSON.stringify(body));
  return req;
}

/** A response that keeps the bytes, so the audio can be compared. */
function makeRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.body = Buffer.concat(chunks);
    },
    on() {}, once() {}, emit() {},
  };
}

process.stderr.write('\n6. the route serves the audio as bytes\n');
{
  const router = createApiRouter({
    dbPath: ':memory:',
    tts: {
      synthesize: async ({ text, voiceId, responseFormat }) => ({
        audio: AUDIO_BYTES,
        contentType: contentTypeFor(responseFormat || 'mp3'),
        model: DEFAULT_MODEL,
        voiceId: voiceId || DEFAULT_VOICE_ID,
        responseFormat: responseFormat || 'mp3',
        text,
      }),
    },
  });

  const res = makeRes();
  const handled = await router.handle(
    makeReq({ body: { text: 'The twin is online.', voiceId: 'voice_478' } }),
    res,
    new URL('http://localhost/api/tts')
  );
  assert('the route handles the request', handled, true);
  assert('the status is 200', res.statusCode, 200);
  assert('the content type is audio/mpeg', res.headers['content-type'], 'audio/mpeg');
  assert('the length header matches the body',
    res.headers['content-length'], AUDIO_BYTES.length);
  assert('the body is the audio itself', res.body.equals(AUDIO_BYTES), true);
  assert('the model is reported in a header', res.headers['x-tts-model'], DEFAULT_MODEL);
  assert('the voice is reported in a header', res.headers['x-tts-voice'], 'voice_478');

  process.stderr.write('\n7. the route refuses callers it does not trust\n');
  {
    const res2 = makeRes();
    await router.handle(
      makeReq({ remoteAddress: '203.0.113.7', body: { text: 'spend my money' } }),
      res2,
      new URL('http://localhost/api/tts')
    );
    assert('a remote caller without the admin key is refused', res2.statusCode, 401);
    // Parse defensively: if the route wrongly served the request, the body
    // is audio, not JSON, and a bare JSON.parse here would crash the suite
    // instead of reporting the failure.
    let error = '';
    try { error = JSON.parse(res2.body.toString()).error || ''; } catch { error = ''; }
    assertTrue('the refusal says why', error.includes('admin key'));
  }
  {
    const res3 = makeRes();
    await router.handle(
      makeReq({
        remoteAddress: '203.0.113.7',
        headers: { 'x-admin-key': 'dev-admin-key' },
        body: { text: 'with the admin key' },
      }),
      res3,
      new URL('http://localhost/api/tts')
    );
    assert('a remote caller with the admin key is served', res3.statusCode, 200);
  }
  {
    // The PWA on a phone on the same LAN: a different address, but the
    // page was served by this same server, so the Origin matches the Host.
    const res = makeRes();
    await router.handle(
      makeReq({
        remoteAddress: '203.0.113.7',
        headers: { origin: 'http://twin.local:5173', host: 'twin.local:5173' },
        body: { text: 'from the PWA on the LAN' },
      }),
      res,
      new URL('http://localhost/api/tts')
    );
    assert('a same-origin page on the LAN is served', res.statusCode, 200);
  }
  {
    // A page on another site, calling this server: its Origin is its own.
    const res = makeRes();
    await router.handle(
      makeReq({
        remoteAddress: '203.0.113.7',
        headers: { origin: 'https://elsewhere.example', host: 'twin.local:5173' },
        body: { text: 'from another site' },
      }),
      res,
      new URL('http://localhost/api/tts')
    );
    assert('a cross-origin page is refused', res.statusCode, 401);
  }
  {
    // THE ATTACK. The page is on another site, but it is open in a browser
    // ON THIS MACHINE, so the request arrives from 127.0.0.1 — loopback.
    // If "it came from localhost" were enough, any website could spend the
    // owner's key through their own browser. The Origin has to match.
    const res = makeRes();
    await router.handle(
      makeReq({
        remoteAddress: '127.0.0.1',
        headers: { origin: 'https://elsewhere.example', host: '127.0.0.1:5173' },
        body: { text: 'a drive-by page on localhost' },
      }),
      res,
      new URL('http://localhost/api/tts')
    );
    assert('a cross-origin page is refused even from loopback', res.statusCode, 401);
  }
  {
    // The PWA on this machine: same origin, so the browser request is fine.
    const res = makeRes();
    await router.handle(
      makeReq({
        remoteAddress: '127.0.0.1',
        headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' },
        body: { text: 'the PWA on this machine' },
      }),
      res,
      new URL('http://localhost/api/tts')
    );
    assert('a same-origin browser request from loopback is served', res.statusCode, 200);
  }
  {
    const res4 = makeRes();
    await router.handle(
      makeReq({ remoteAddress: '127.0.0.1', body: {} }),
      res4,
      new URL('http://localhost/api/tts')
    );
    assert('a request with no text is a 400', res4.statusCode, 400);
  }
  {
    const res5 = makeRes();
    await router.handle(
      makeReq({ method: 'GET', remoteAddress: '127.0.0.1' }),
      res5,
      new URL('http://localhost/api/tts')
    );
    assert('GET is not the tts route', res5.statusCode, 404);
  }

  process.stderr.write('\n8. the health endpoint reports the voice setup\n');
  {
    const res6 = makeRes();
    await router.handle(
      makeReq({ method: 'GET', remoteAddress: '127.0.0.1' }),
      res6,
      new URL('http://localhost/api/health')
    );
    const health = JSON.parse(res6.body.toString());
    assert('health names the model', health.tts.model, DEFAULT_MODEL);
    assert('health names the default voice', health.tts.voiceId, DEFAULT_VOICE_ID);
    assertTrue('health says whether the key is set',
      typeof health.tts.configured === 'boolean');
  }

  router.close();
}

process.stderr.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => process.stderr.write(`  - ${f.label}\n`));
  process.exit(1);
}
process.exit(0);
