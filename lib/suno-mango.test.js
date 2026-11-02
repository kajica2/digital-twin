#!/usr/bin/env node
'use strict';
// lib/suno-mango.test.js — the Mango decryptor's pure half, against
// SYNTHETIC fixtures. No browser, no account, no network.
//
// The contract this pins:
//   - the GCM unwrap is the shape the live server hands out
//     (iv(12) || ciphertext || tag(16), AAD = the clip id)
//   - the CTR round-trip restores the plaintext EXACTLY
//   - a wrong key is caught by the ftyp brand check, not by a
//     "wrote a file" line
//   - the rights fetch parses a real payload and refuses a junk one
//
//   node lib/suno-mango.test.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    MEDIA_BASE,
    RIGHTS_PATH,
    gcmUnwrap,
    ctrAlgoFor,
    ctrDecrypt,
    deriveCtrKeyIv,
    decryptMedia,
    mediaUrlFor,
    fetchRights,
} = require('./suno-mango.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        console.log(`  ✗ ${label}`);
        console.log(`    expected: ${e}`);
        console.log(`    got:      ${a}`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: 'false', expected: 'true' });
        console.log(`  ✗ ${label}`);
    }
}
function assertThrows(label, fn, re) {
    try {
        fn();
        failed++; failures.push({ label, actual: 'no throw', expected: String(re) });
        console.log(`  ✗ ${label}`);
        console.log(`    expected a throw matching ${re}`);
    } catch (e) {
        if (re.test(String(e && e.message))) { passed++; console.log(`  ✓ ${label}`); }
        else {
            failed++; failures.push({ label, actual: String(e && e.message), expected: String(re) });
            console.log(`  ✗ ${label}`);
            console.log(`    got: ${e && e.message}`);
        }
    }
}

/**
 * Build a synthetic rights payload for one clip — the exact shape the
 * live server returns, wrapped so that gcmUnwrap() can unwrap it.
 */
function makeFixture({ clipId = 'clip-under-test', glt = 'glt.token.value', keyLen = 16 } = {}) {
    const gcmKey = crypto.createHash('sha256').update(glt, 'utf8').digest();
    const ctrKey = crypto.randomBytes(keyLen);
    const ctrIv = crypto.randomBytes(16);

    const wrap = (secret) => {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', gcmKey, iv);
        c.setAAD(Buffer.from(clipId, 'utf8'));
        const ct = Buffer.concat([c.update(secret), c.final()]);
        const tag = c.getAuthTag();
        return Buffer.concat([iv, ct, tag]).toString('base64');
    };

    return {
        clipId,
        glt,
        rights: { key: wrap(ctrKey), iv: wrap(ctrIv), glt },
        ctrKey,
        ctrIv,
        gcmKey,
    };
}

/** A minimal, valid-looking MP4 family header. */
function fakeMedia(size = 4096) {
    const buf = Buffer.alloc(size, 0);
    buf.writeUInt32BE(24, 0);                       // box size
    buf.write('ftyp', 4, 'latin1');                 // box type
    buf.write('M4A ', 8, 'latin1');                 // major brand
    buf.write('isom', 16, 'latin1');                // compatible brand
    for (let i = 32; i < size; i++) buf[i] = i % 251;
    return buf;
}

console.log('\n1. gcmUnwrap — the live blob shape');

{
    const fx = makeFixture({ glt: 'glt-abc' });
    const blob = Buffer.from(fx.rights.key, 'base64');
    assert('the blob carries a 12-byte iv', blob.subarray(0, 12).length, 12);
    assert('the blob is at least iv+tag', blob.length >= 12 + 16, true);
    const out = gcmUnwrap(blob, fx.clipId, fx.gcmKey);
    assert('the unwrapped blob is the CTR key', out.length, fx.ctrKey.length);
    assert('the unwrapped blob matches', out.toString('hex'), fx.ctrKey.toString('hex'));
}

{
    const fx = makeFixture({ clipId: 'clip-a' });
    const blob = Buffer.from(fx.rights.key, 'base64');
    assertThrows(
        'the clip id is the AAD — a different clip fails',
        () => gcmUnwrap(blob, 'clip-b', fx.gcmKey),
        /unable to authenticate|bad decrypt|unsupported/i
    );
}

{
    const fx = makeFixture();
    const blob = Buffer.from(fx.rights.key, 'base64');
    assertThrows(
        'a blob that is too short is refused, not padded',
        () => gcmUnwrap(blob.subarray(0, 8), fx.clipId, fx.gcmKey),
        /too short/
    );
}

console.log('\n2. ctrDecrypt — the round trip');

{
    const plain = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const enc = crypto.createCipheriv('aes-128-ctr', key, iv);
    enc.setAutoPadding(false);
    const cipherText = Buffer.concat([enc.update(plain), enc.final()]);
    const back = ctrDecrypt(cipherText, key, iv);
    assert('CTR restores the plaintext exactly', back.toString('utf8'), plain.toString('utf8'));
    assert('CTR preserves the byte length', back.length, plain.length);
}

{
    const plain = crypto.randomBytes(1000);
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const enc = crypto.createCipheriv('aes-128-ctr', key, iv);
    enc.setAutoPadding(false);
    const cipherText = Buffer.concat([enc.update(plain), enc.final()]);
    const back = ctrDecrypt(cipherText, key, iv);
    assert('a 1000-byte payload round-trips byte for byte', back.equals(plain), true);
}

{
    assert('a 16-byte key is aes-128-ctr', ctrAlgoFor(Buffer.alloc(16)), 'aes-128-ctr');
    assert('a 24-byte key is aes-192-ctr', ctrAlgoFor(Buffer.alloc(24)), 'aes-192-ctr');
    assert('a 32-byte key is aes-256-ctr', ctrAlgoFor(Buffer.alloc(32)), 'aes-256-ctr');
}

console.log('\n3. deriveCtrKeyIv');

{
    const fx = makeFixture({ keyLen: 16 });
    const d = deriveCtrKeyIv(fx.rights, fx.clipId);
    assert('the CTR key is the unwrapped secret', d.ctrKey.toString('hex'), fx.ctrKey.toString('hex'));
    assert('the CTR iv is the unwrapped secret', d.ctrIv.toString('hex'), fx.ctrIv.toString('hex'));
    assert('the algorithm follows the key length', d.algo, 'aes-128-ctr');
    assert('the GCM key is SHA-256 of the glt', d.gcmKey.toString('hex'), fx.gcmKey.toString('hex'));
}

{
    const fx = makeFixture();
    assertThrows(
        'rights without a glt are refused',
        () => deriveCtrKeyIv({ key: fx.rights.key, iv: fx.rights.iv }, fx.clipId),
        /missing key\/iv\/glt/
    );
}

console.log('\n4. decryptMedia — the ftyp brand check');

{
    const fx = makeFixture({ clipId: 'clip-brand' });
    const plain = fakeMedia(2048);
    const enc = crypto.createCipheriv('aes-128-ctr', fx.ctrKey, fx.ctrIv);
    enc.setAutoPadding(false);
    const encrypted = Buffer.concat([enc.update(plain), enc.final()]);

    const out = decryptMedia(encrypted, { clipId: fx.clipId, ...fx.rights });
    assert('the decrypted bytes are the original media', out.plain.equals(plain), true);
    assert('the brand is reported', out.brand, 'ftyp');
    assert('the algorithm is reported', out.algo, 'aes-128-ctr');
}

{
    // The wrong key: the same pipeline, a different glt. The plaintext
    // comes out as plausible-looking garbage — the brand check is the
    // only thing that catches it.
    const fx = makeFixture({ clipId: 'clip-wrong' });
    const other = makeFixture({ clipId: 'clip-wrong' });
    const plain = fakeMedia(512);
    const enc = crypto.createCipheriv('aes-128-ctr', other.ctrKey, other.ctrIv);
    enc.setAutoPadding(false);
    const encrypted = Buffer.concat([enc.update(plain), enc.final()]);

    assertThrows(
        'the wrong key is caught by the brand check',
        () => decryptMedia(encrypted, { clipId: fx.clipId, ...fx.rights }),
        /ftyp/
    );
}

{
    const fx = makeFixture();
    const plain = fakeMedia(64);
    const enc = crypto.createCipheriv('aes-128-ctr', fx.ctrKey, fx.ctrIv);
    enc.setAutoPadding(false);
    const encrypted = Buffer.concat([enc.update(plain), enc.final()]);
    // Truncate: the brand is still there, so this one PASSES the check —
    // which is the point. The check proves "this is media", not "this is
    // the whole clip".
    const out = decryptMedia(encrypted.subarray(0, 32), { clipId: fx.clipId, ...fx.rights });
    assert('a truncated file still passes the brand check', out.brand, 'ftyp');
}

console.log('\n5. mediaUrlFor');

{
    assert('the media url points at the clip', mediaUrlFor('abc-123'), `${MEDIA_BASE}/abc-123.m4a`);
    assert('the media url ends in .m4a', mediaUrlFor('abc-123').endsWith('.m4a'), true);
    assert('the rights path is the one the SPA calls', RIGHTS_PATH, '/a/api/mango/rights');
}

console.log('\n6. fetchRights — against a fake CDP client');

function fakeCdp(response) {
    const calls = [];
    return {
        calls,
        async js(expression, awaitPromise) {
            calls.push({ expression, awaitPromise });
            if (typeof response === 'function') return response(expression);
            return response;
        },
    };
}

async function run() {
    {
        const cdp = fakeCdp(JSON.stringify({ key: 'a2V5', iv: 'aXY=', glt: 'glt-token' }));
        const rights = await fetchRights(cdp, 'clip-1');
        assert('a live payload comes back whole', rights.key, 'a2V5');
        assert('the iv comes back whole', rights.iv, 'aXY=');
        assert('the glt comes back whole', rights.glt, 'glt-token');
        assert('the request was awaited', cdp.calls[0].awaitPromise, true);
        assertTrue('the request carries the clip id', cdp.calls[0].expression.includes('clip-1'));
        assertTrue('the request carries the content type', /content_type:\s*['"]clip['"]/.test(cdp.calls[0].expression));
        assertTrue('the request carries a deadline', /setTimeout\(\(\) => ctrl\.abort\(\), \d+\)/.test(cdp.calls[0].expression));
        assertTrue('the deadline is cleared', cdp.calls[0].expression.includes('clearTimeout(timer)'));
    }

    {
        const cdp = fakeCdp('<html>login</html>');
        let msg = '';
        try { await fetchRights(cdp, 'clip-1'); } catch (e) { msg = String(e && e.message); }
        assertTrue('a non-JSON body is refused', /was not JSON/.test(msg));
    }

    {
        const cdp = fakeCdp(JSON.stringify({ key: 'a2V5' }));
        let msg = '';
        try { await fetchRights(cdp, 'clip-1'); } catch (e) { msg = String(e && e.message); }
        assertTrue('a payload without an iv is refused', /unexpected payload/.test(msg));
    }

    {
        const cdp = fakeCdp(null);
        let msg = '';
        try { await fetchRights(cdp, 'clip-1'); } catch (e) { msg = String(e && e.message); }
        assertTrue('no response at all is refused', /no response from the browser/.test(msg));
    }

    {
        let msg = '';
        try { await fetchRights(null, 'clip-1'); } catch (e) { msg = String(e && e.message); }
        assertTrue('a missing CDP client is refused', /needs a CDP client/.test(msg));
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed) {
        for (const f of failures) console.log(`FAILED: ${f.label}\n  expected ${f.expected}\n  got      ${f.actual}`);
        process.exit(1);
    }
}

run().catch((e) => { console.error(e); process.exit(1); });
