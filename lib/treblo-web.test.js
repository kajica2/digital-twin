#!/usr/bin/env node
// lib/treblo-web.test.js — the browser-path helpers, with no browser.
//
// No network, no credentials, no CDP. The assertions are about the pure
// parts of tools/treblo-web.js: how the cookie jar is parsed, and — the
// bug this file exists for — that the CDP `call()` signature forwards its
// PARAMS instead of dropping them.
//
// THE BUG (found 2026-11-07)
//   tools/treblo-web.js's `call()` was `(method, { params, ms })` while
//   every caller passed the CDP params in that slot. The real params were
//   destructured as if they were an options object, so `params` was
//   always `{}` and Chrome answered "Invalid parameters" for every call
//   that needed them. That one mistake is what made docs/TREBLO.md
//   record "Network.setCookie refuses EVERY parameter set on this
//   Chrome" — it did not; the params never arrived.
//
//   The suite below pins the signature, because a signature that can
//   silently discard an argument is a signature that will do so again.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'tools', 'treblo-web.js');
const { sessionToken, sessionCookieChunks, bestSession } = require(WEB);

let passed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed++;
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (e) {
        failures.push({ name, err: e });
        process.stdout.write(`  ✗ ${name}\n     ${e.message}\n`);
    }
}

// A jar with the CHUNKED session, written the way the browser exports it.
//
// The chunk values are a REAL base64 payload, split across two lines, so
// the fixture exercises the actual join-then-decode path.
const PAYLOAD = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: 1794066799,
};
const BLOB = 'base64-' + Buffer.from(JSON.stringify(PAYLOAD)).toString('base64');
// Split it so the join is meaningful: "base64-" + first half, second half.
const CHUNK0 = BLOB.slice(0, Math.ceil(BLOB.length / 2));
const CHUNK1 = BLOB.slice(Math.ceil(BLOB.length / 2));
const JAR = path.join(os.tmpdir(), `treblo-web-test-${process.pid}.txt`);
fs.writeFileSync(JAR, [
    '# Netscape HTTP Cookie File',
    '# This is a generated file!  Do not edit.',
    '',
    'treblo.com\tFALSE\t/\tFALSE\t1828623200\tsb-db-auth-token.1\t' + CHUNK1,
    'treblo.com\tFALSE\t/\tFALSE\t1828623200\tsb-db-auth-token.0\t' + CHUNK0,
    'treblo.com\tFALSE\t/\tFALSE\t1828532500\tsb-db-auth-token-flow-abc-code-verifier\tXYZ',
    '.treblo.com\tTRUE\t/\tTRUE\t1825599416\tph_phc_1_posthog\t%7B%7D',
    '',
].join('\n'));

// A SECOND session in the same jar — on a different domain, with a LATER
// expiry and DIFFERENT values.
//
// MEASURED 2026-11-07: a real export carried the chunked pair on BOTH
// `.treblo.com` (expired) and `treblo.com` (valid). A reader that keeps
// one value per chunk index and lets the last row win picks a session by
// ROW ORDER, so a reordered export silently yields the expired one.
const NEWER = {
    access_token: 'newer-access-token',
    refresh_token: 'newer-refresh-token',
    expires_at: 1794073195,
};
const NEWER_BLOB = 'base64-' + Buffer.from(JSON.stringify(NEWER)).toString('base64');
const NEWER_0 = NEWER_BLOB.slice(0, Math.ceil(NEWER_BLOB.length / 2));
const NEWER_1 = NEWER_BLOB.slice(Math.ceil(NEWER_BLOB.length / 2));

/** A jar holding BOTH sessions, in the given row order. */
function twoSessionJar(order) {
    const rows = {
        old0: '.treblo.com\tTRUE\t/\tTRUE\t0\tsb-db-auth-token.0\t' + CHUNK0,
        old1: '.treblo.com\tTRUE\t/\tTRUE\t0\tsb-db-auth-token.1\t' + CHUNK1,
        new0: 'treblo.com\tFALSE\t/\tFALSE\t1828629595\tsb-db-auth-token.0\t' + NEWER_0,
        new1: 'treblo.com\tFALSE\t/\tFALSE\t1828629595\tsb-db-auth-token.1\t' + NEWER_1,
    };
    const file = path.join(os.tmpdir(), `treblo-two-${process.pid}-${order.join('')}.txt`);
    fs.writeFileSync(file, ['# Netscape HTTP Cookie File', '', ...order.map(k => rows[k])].join('\n') + '\n');
    return file;
}

(async () => {
    // ---- the chunk reader ------------------------------------------------

    await check('the chunk reader returns the chunked pair, VERBATIM', () => {
        const chunks = sessionCookieChunks(JAR);
        assert.strictEqual(chunks.length, 2);
        assert.strictEqual(chunks[0].name, 'sb-db-auth-token.0');
        assert.strictEqual(chunks[0].value, CHUNK0);
        assert.strictEqual(chunks[1].name, 'sb-db-auth-token.1');
        assert.strictEqual(chunks[1].value, CHUNK1);
    });

    await check('the chunk reader IGNORES the flow-verifier and the posthog cookie', () => {
        const names = sessionCookieChunks(JAR).map(c => c.name);
        assert.ok(!names.some(n => n.includes('code-verifier')));
        assert.ok(!names.some(n => n.includes('posthog')));
    });

    await check('the chunk reader orders by index, not by file order', () => {
        const chunks = sessionCookieChunks(JAR);
        assert.strictEqual(chunks[0].name, 'sb-db-auth-token.0');
        assert.strictEqual(chunks[1].name, 'sb-db-auth-token.1');
    });

    await check('the chunk reader does NOT decode the values', () => {
        // Decoding a chunk alone yields truncated JSON — the whole reason
        // the values must be carried verbatim.
        const chunks = sessionCookieChunks(JAR);
        assert.ok(chunks[0].value.startsWith('base64-'));
    });

    await check('the chunk reader throws when there is no chunked session', () => {
        const empty = path.join(os.tmpdir(), `treblo-empty-${process.pid}.txt`);
        fs.writeFileSync(empty, '# only a comment\n');
        assert.throws(() => sessionCookieChunks(empty), /no sb-db-auth-token\.N/);
        fs.unlinkSync(empty);
    });

    // ---- the session-token reader (the decode path) ---------------------
    await check('the token reader joins the chunks before decoding', () => {
        const t = sessionToken(JAR);
        assert.strictEqual(t.token, PAYLOAD.access_token);
        assert.strictEqual(t.refresh, PAYLOAD.refresh_token);
    });

    await check('the token reader surfaces the expiry', () => {
        const t = sessionToken(JAR);
        assert.strictEqual(t.expiresAt, PAYLOAD.expires_at);
    });

    await check('decoding ONE chunk alone is the failure the join avoids', () => {
        // The reason the chunks must be joined: a chunk on its own is not
        // valid base64 and decodes to garbage.
        assert.throws(() => JSON.parse(Buffer.from(CHUNK1, 'base64').toString('utf8')));
    });

    // ---- MULTI-SESSION jars: the selection must be by VALIDITY ----------

    await check('a jar with TWO sessions picks the one with the LATER expiry', () => {
        const f = twoSessionJar(['old0', 'old1', 'new0', 'new1']);
        const t = sessionToken(f);
        assert.strictEqual(t.token, NEWER.access_token);
        assert.strictEqual(t.expiresAt, NEWER.expires_at);
        fs.unlinkSync(f);
    });

    await check('the pick does NOT depend on the ROW ORDER', () => {
        // The old reader keyed a Map by chunk index and let the last row
        // win — so this order yielded the EXPIRED session.
        const f = twoSessionJar(['new0', 'new1', 'old0', 'old1']);
        const t = sessionToken(f);
        assert.strictEqual(t.token, NEWER.access_token,
            'the expired session won because it was last — the pick must be by expiry');
        fs.unlinkSync(f);
    });

    await check('the COOKIES to install come from the SAME session as the token', () => {
        // The token and the installed cookies must not disagree, or the
        // browser would be given a different session than the one the
        // tool reports.
        const f = twoSessionJar(['old0', 'old1', 'new0', 'new1']);
        const t = sessionToken(f);
        const chunks = sessionCookieChunks(f);
        const joined = chunks.map(c => c.value).join('');
        const payload = JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64').toString('utf8'));
        assert.strictEqual(payload.access_token, t.token);
        assert.strictEqual(payload.expires_at, t.expiresAt);
        fs.unlinkSync(f);
    });

    await check('the installed cookies are the NEWER session, not the older one', () => {
        const f = twoSessionJar(['old0', 'old1', 'new0', 'new1']);
        const chunks = sessionCookieChunks(f);
        assert.ok(chunks.every(c => c.value.includes(NEWER_0) || c.value.includes(NEWER_1)));
        assert.ok(!chunks.some(c => c.value === CHUNK0 || c.value === CHUNK1),
            'the OLD session leaked into the installed cookies');
        fs.unlinkSync(f);
    });

    await check('bestSession reports WHICH domain won', () => {
        const f = twoSessionJar(['old0', 'old1', 'new0', 'new1']);
        const b = bestSession(f);
        assert.strictEqual(b.domain, 'treblo.com');
        fs.unlinkSync(f);
    });

    // ---- THE REGRESSION: the CDP call() signature ------------------------
    //
    // The signature is asserted against the SOURCE, because the bug was
    // invisible at runtime: the old form still "worked" for the calls
    // that need no params (Page.enable, Network.enable), so a smoke test
    // passed while every call that DID need params failed.

    await check('the CDP call() takes params as its SECOND argument', () => {
        const src = fs.readFileSync(WEB, 'utf8');
        assert.ok(
            /const call = \(method, params = \{\}, \{ ms = \d+ \} = \{\}\)/.test(src),
            'call() must be (method, params, { ms }) — the old ' +
            '(method, { params, ms }) destructured the caller\'s params ' +
            'as an options object and silently dropped them');
    });

    await check('the CDP call() does NOT destructure params out of the second argument', () => {
        const src = fs.readFileSync(WEB, 'utf8');
        assert.ok(
            !/const call = \(method, \{ params/.test(src),
            'the dropped-params signature is back');
    });

    await check('a CDP error names the METHOD that failed', () => {
        const src = fs.readFileSync(WEB, 'utf8');
        assert.ok(
            /p\.rj\(new Error\(`\$\{p\.method\}/.test(src),
            'a bare "Invalid parameters" hides which call was rejected');
    });

    // ---- the install contract (the shadowing fix) -----------------------

    await check('installSession deletes the stale flat cookie before installing', () => {
        const src = fs.readFileSync(WEB, 'utf8');
        const fn = src.slice(src.indexOf('async function installSession'));
        const delAt = fn.indexOf('Network.deleteCookies');
        const setAt = fn.indexOf('Network.setCookie');
        assert.ok(delAt !== -1, 'installSession must delete the candidate cookies');
        assert.ok(setAt !== -1, 'installSession must install the chunked pair');
        assert.ok(delAt < setAt, 'the delete must come BEFORE the install');
        assert.ok(
            fn.includes("'sb-db-auth-token'") && fn.includes("'sb-db-auth-token.0'"),
            'the stale FLAT cookie is the one that shadows the pair');
    });

    await check('installSession installs the CHUNKED names, not a flat one', () => {
        const src = fs.readFileSync(WEB, 'utf8');
        const fn = src.slice(src.indexOf('async function installSession'));
        assert.ok(!/name:\s*'sb-db-auth-token',\s*\n\s*value:\s*blob/.test(fn),
            'a flat cookie does not sign in — MEASURED 2026-11-07');
    });

    // ---- cleanup ---------------------------------------------------------

    fs.unlinkSync(JAR);

    console.log('');
    console.log(`[treblo-web.test] passed: ${passed}, failed: ${failures.length}`);
    if (failures.length) {
        for (const f of failures) console.log(`  FAILED: ${f.name}\n    ${f.err.stack}`);
        process.exit(1);
    }
    process.exit(0);
})();
