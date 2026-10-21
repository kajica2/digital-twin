#!/usr/bin/env node
'use strict';
// lib/suno-web.test.js
//
// Tests for the Suno web client's request construction.
//
// The client is browser-bound, but the part that decides WHAT the studio
// API receives is not: the url, the headers, and the exact JSON string
// that goes into the body. Those are pinned here against a fake CDP
// transport, so a change in the request shape fails a unit test instead
// of a 422 from the server at run time.
//
// The headers matter: the studio API rejects a request without the
// `Authorization: Bearer` the SPA attaches, and the `browser-token` and
// `device-id` headers are part of the same handshake. The client reads
// all three off a request suno.com actually made rather than decoding a
// possibly-stale token out of the cookie jar.
//
//   node lib/suno-web.test.js

const path = require('node:path');
const os = require('node:os');

const { SunoClient, CONFIG, expandHome } = require('./suno-web.js');

const REPO = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: a, expected: e });
           process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`); }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[suno-web.test]\n\n`);

// ---------- 1. a fake CDP that records what the client asked for ----------

function fakeCdp(response = { status: 200, body: '{"ok":true}' }) {
    const calls = [];
    return {
        calls,
        async send(method, params) {
            calls.push({ method, params });
            return {};
        },
        async js(expr, awaitPromise) {
            calls.push({ method: 'Runtime.evaluate', params: { expression: expr, awaitPromise } });
            return response;
        },
        ws: { addEventListener() {} },
    };
}

function clientWith(cdp, overrides = {}) {
    const c = new SunoClient({ cdp, chrome: null, cfg: { ...CONFIG, ...overrides } });
    c.token = 'ACCESS-TOKEN';
    c.browserToken = 'BROWSER-TOKEN';
    c.deviceId = 'DEVICE-ID';
    return c;
}

// ---------- 2. the GET request ----------

async function main() {
{
    const cdp = fakeCdp();
    const client = clientWith(cdp);
    const r = await client.api('/api/billing/info/');
    const expr = cdp.calls[cdp.calls.length - 1].params.expression;

    assert('the response status is passed through', r.status, 200);
    assert('the response body is parsed as JSON', r.json, { ok: true });
    assertTrue('the url is the api base plus the path',
        expr.indexOf(`"${CONFIG.apiBase}/api/billing/info/"`) !== -1);
    assertTrue('the method is GET', expr.indexOf('method: "GET"') !== -1);
    assertTrue('the bearer token is sent', expr.indexOf('Bearer ACCESS-TOKEN') !== -1);
    assertTrue('the browser token is sent', expr.indexOf('"browser-token":"BROWSER-TOKEN"') !== -1);
    assertTrue('the device id is sent', expr.indexOf('"device-id":"DEVICE-ID"') !== -1);
    assertTrue('a GET carries no request body', expr.indexOf('body: "') === -1);
}

// ---------- 3. the POST request ----------

{
    const cdp = fakeCdp();
    const client = clientWith(cdp);
    const payload = { task: 'cover', duration: 198, tags: 'a, b' };
    await client.api('/api/generate/v2-web/', { method: 'POST', body: payload });
    const expr = cdp.calls[cdp.calls.length - 1].params.expression;

    assertTrue('the method is POST', expr.indexOf('method: "POST"') !== -1);
    assertTrue('the content type is JSON', expr.indexOf('"content-type":"application/json"') !== -1);
    assertTrue('the body is sent as a JSON string',
        expr.indexOf('body: "{\\"task\\":\\"cover\\"') !== -1);
    assertTrue('the body is JSON-encoded exactly once',
        expr.indexOf('body: "{\\"task') !== -1 && expr.indexOf('body: "{\\"{\\"') === -1);
}

// ---------- 4. apiOk throws on a non-2xx ----------

{
    const cdp = fakeCdp({ status: 402, body: '{"error":"insufficient_credits"}' });
    const client = clientWith(cdp);
    let msg = null;
    try {
        await client.apiOk('/api/generate/v2-web/', { method: 'POST', body: {} });
    } catch (e) { msg = e.message; }
    assertTrue('apiOk surfaces the status code', msg && msg.indexOf('402') !== -1);
    assertTrue('apiOk surfaces the server message', msg && msg.indexOf('insufficient_credits') !== -1);
}

{
    const cdp = fakeCdp({ status: 200, body: '{"ok":true}' });
    const client = clientWith(cdp);
    const r = await client.apiOk('/api/billing/info/');
    assert('apiOk returns the parsed body on success', r, { ok: true });
}

// ---------- 5. a non-JSON error page does not crash the client ----------

{
    const cdp = fakeCdp({ status: 502, body: '<html>bad gateway</html>' });
    const client = clientWith(cdp);
    const r = await client.api('/api/billing/info/');
    assert('the status is still reported', r.status, 502);
    assert('the body is still reported as text', r.body, '<html>bad gateway</html>');
    assert('the json field is null, not a throw', r.json, null);
}

// ---------- 6. expandHome ----------

assert('a tilde path expands to the home directory',
    expandHome('~/x.txt'), path.join(os.homedir(), 'x.txt'));
assert('a plain path is untouched', expandHome('/tmp/x'), '/tmp/x');
assert('an empty path stays empty', expandHome(''), '');

// ---------- 7. the configuration contract ----------

assert('the api base is the one the SPA actually calls',
    CONFIG.apiBase, 'https://studio-api-prod.suno.com');
assert('the cookie jar lives outside the repo',
    CONFIG.cookiesFile.startsWith('~'), true);
assertTrue('the cookie jar is NOT inside the repo',
    CONFIG.cookiesFile.indexOf(REPO) === -1);
assert('the captcha site key is the generation one',
    CONFIG.captchaSiteKey, '0x4AAAAAADI7xDNyj-3LcIbi');
assert('the browser runs headed — headless never gets a Turnstile token',
    CONFIG.headless, false);
assertTrue('the config records why headless cannot be used',
    /headless/i.test(CONFIG._note_headless) && /token/i.test(CONFIG._note_headless));
assertTrue('the browser binary is a real Chrome path',
    /Chrome$/.test(CONFIG.paths.webBrowserBin));

}

// ---------- report ----------

main().then(() => {
    process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
    if (failed) {
        failures.forEach(f => process.stderr.write(`  FAILED: ${f.label}\n`));
        process.exit(1);
    }
}).catch(e => { process.stderr.write(`fatal: ${e.stack}\n`); process.exit(1); });
