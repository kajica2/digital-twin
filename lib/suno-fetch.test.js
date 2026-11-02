#!/usr/bin/env node
'use strict';
// lib/suno-fetch.test.js — finding a clip's real audio URL, and fetching
// it as PLAYABLE media.
//
// MEASURED 2026-11-02 (live, on the account): a clip's `audio_url` is
// `https://studio-api.prod.suno.com/api/forbidden` — a PLACEHOLDER,
// not a refusal. The clip that was made on 2026-10-30 carries it too,
// and that one has real audio.
//
// The real address is in `media_urls`: an array of
// `{ url, content_type, delivery, encoding }`, and the URL is a
// CloudFront `.m4a` (AES256 at rest — the browser decrypts it, so
// a plain curl gets bytes that ffprobe cannot read).
//
// The old lookup only looked at `audio_url` / `song_url` / `stream_url`
// and skipped `/api/forbidden`, so it found NOTHING for these clips.
//
// The old WRITE was worse: it wrote those encrypted bytes to disk and
// called it a download. The fetch now DECRYPTS before it writes, and the
// decryptor lives in `lib/suno-mango.js`.
//
//   node lib/suno-fetch.test.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    audioUrlOf, fetchThroughBrowser, fetchMediaBytes, evaluateInPage, main,
    DEFAULT_MEDIA_TIMEOUT_MS, DEFAULT_INPAGE_TIMEOUT_MS, DEFAULT_INPAGE_CDP_TIMEOUT_MS,
} = require('./suno-fetch.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function ok(label, condition) {
    assert(label, !!condition, true);
}
async function check(label, fn) {
    try {
        const r = await fn();
        if (r === false) { failed++; failures.push({ label, actual: 'false', expected: 'true' }); process.stderr.write(`  ✗ ${label}\n`); }
        else { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    } catch (e) {
        failed++; failures.push({ label, actual: `threw: ${e && e.message}`, expected: 'no throw' });
        process.stderr.write(`  ✗ ${label}\n    threw: ${e && e.message}\n`);
    }
}

(async () => {

process.stderr.write('1. audioUrlOf — the placeholder is not an address\n');

// The shape measured on the live clip.
const LIVE = {
    status: 'complete',
    title: 'Serbian Byzantine Choir M - Dub',
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [{
        url: 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/6b348a64-5b55-4418-9706-32b1d0563281.m4a',
        content_type: 'm4a-opus',
        delivery: 'progressive',
        encoding: '1.0.0',
    }],
};

assert('the real address is found in media_urls',
    audioUrlOf(LIVE),
    'https://d2lwuy8qc234o3.cloudfront.net/1/clip/6b348a64-5b55-4418-9706-32b1d0563281.m4a');

// The placeholder alone is not an address.
assert('a placeholder-only clip has no address',
    audioUrlOf({ audio_url: 'https://studio-api.prod.suno.com/api/forbidden' }), null);

// An ordinary clip still works.
assert('a plain audio_url still wins',
    audioUrlOf({ audio_url: 'https://cdn.example.com/a.mp3' }), 'https://cdn.example.com/a.mp3');

// media_urls with several entries: the first AUDIO one wins, not the
// first one (a video entry would be useless).
const MIXED = {
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [
        { url: 'https://cdn.example.com/clip.mp4', content_type: 'video/mp4' },
        { url: 'https://cdn.example.com/clip.m4a', content_type: 'm4a-opus' },
    ],
};
assert('the first AUDIO entry wins', audioUrlOf(MIXED), 'https://cdn.example.com/clip.m4a');

// A media_urls entry with no url is skipped, not returned.
assert('an entry with no url is skipped',
    audioUrlOf({ media_urls: [{ content_type: 'm4a-opus' }, { url: 'https://cdn.example.com/x.m4a' }] }),
    'https://cdn.example.com/x.m4a');

// A null clip is null.
assert('a missing clip is null', audioUrlOf(null), null);

// The placeholder is skipped even when it is the only candidate.
assert('the placeholder is never returned',
    audioUrlOf({ audio_url: 'https://x/api/forbidden', song_url: 'https://y/api/forbidden' }), null);

/* ------------------------------------------------------------------ */

process.stderr.write('\n2. the fetch has a deadline\n');

// A plain fetch is bounded: the abort signal fires and the error says so.
await check('a hung media fetch is aborted, not waited on forever', async () => {
    const ctrl = new AbortController();
    const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    });
    let caught = null;
    try {
        await fetchMediaBytes('https://cdn.example.com/x.m4a', { timeoutMs: 30, fetchImpl });
    } catch (e) { caught = e; }
    ok('the abort surfaces as an AbortError', caught && caught.name === 'AbortError');
    ok('the abort names the deadline', caught && /aborted after 30ms/.test(caught.message));
});

// The deadline is real: the timer is armed with the requested limit.
await check('the media fetch deadline is the one that was asked for', async () => {
    let seen = null;
    const fetchImpl = (_url, opts) => {
        seen = opts.signal;
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    };
    await fetchMediaBytes('https://cdn.example.com/x.m4a', { timeoutMs: 1234, fetchImpl });
    ok('the fetch is given an abort signal', seen && typeof seen.aborted === 'boolean');
});

// A non-OK response is an error, not an empty file.
await check('a 403 is an error', async () => {
    let caught = null;
    try {
        await fetchMediaBytes('https://cdn.example.com/x.m4a', {
            fetchImpl: async () => ({ ok: false, status: 403 }),
        });
    } catch (e) { caught = e; }
    ok('the status code is named', caught && /→ 403/.test(caught.message));
});

/* ------------------------------------------------------------------ */

process.stderr.write('\n3. the in-page read is bounded twice\n');

// A fake CDP client that records what it was asked to do.
function fakeCdp(value) {
    const calls = [];
    return {
        calls,
        async send(method, params, opts) {
            calls.push({ method, params, opts });
            return { result: { value } };
        },
    };
}

// The in-page expression carries its own abort, and clears the timer
// BARE (a truthiness guard on clearTimeout is a lint-level smell the
// house rules call out).
await check('the in-page fetch carries an AbortController and a deadline', async () => {
    const cdp = fakeCdp(Buffer.from('hello').toString('base64'));
    await fetchThroughBrowser(cdp, 'https://cdn.example.com/x.m4a', null, { timeoutMs: 4321 });
    const expr = cdp.calls[0].params.expression;
    ok('the expression creates an AbortController', /new AbortController\(\)/.test(expr));
    ok('the expression aborts at the requested deadline', /setTimeout\(\(\) => ctrl\.abort\(\), 4321\)/.test(expr));
    ok('the expression clears the timer bare', /finally \{ clearTimeout\(timer\); \}/.test(expr));
    ok('the timer is not guarded by a truthiness check', !/if \(timer\)/.test(expr));
    ok('the clearTimeout call is not argument-guarded', !/clearTimeout\(timer &&/.test(expr));
});

// The CDP call that carries the body back has its own deadline.
await check('the CDP call carries a per-call timeout', async () => {
    const cdp = fakeCdp(Buffer.from('hello').toString('base64'));
    await fetchThroughBrowser(cdp, 'https://cdn.example.com/x.m4a', null, {
        timeoutMs: 1000, cdpTimeoutMs: 7777,
    });
    const call = cdp.calls[0];
    assert('the method is Runtime.evaluate', call.method, 'Runtime.evaluate');
    assert('the per-call timeout is passed', call.opts && call.opts.timeoutMs, 7777);
});

// And the default is a deadline, not "no deadline".
ok('the default in-page CDP deadline is a number',
    Number.isFinite(DEFAULT_INPAGE_CDP_TIMEOUT_MS) && DEFAULT_INPAGE_CDP_TIMEOUT_MS > 0);
ok('the default in-page deadline is a number',
    Number.isFinite(DEFAULT_INPAGE_TIMEOUT_MS) && DEFAULT_INPAGE_TIMEOUT_MS > 0);
ok('the default media deadline is a number',
    Number.isFinite(DEFAULT_MEDIA_TIMEOUT_MS) && DEFAULT_MEDIA_TIMEOUT_MS > 0);

// The bytes come back decoded.
await check('the in-page body comes back as bytes', async () => {
    const cdp = fakeCdp(Buffer.from('hello world').toString('base64'));
    const bytes = await fetchThroughBrowser(cdp, 'https://cdn.example.com/x.m4a');
    assert('the body is decoded', bytes.toString('utf8'), 'hello world');
});

// An ERR: answer is an error.
await check('an ERR: answer is an error', async () => {
    const cdp = fakeCdp('ERR:403');
    let caught = null;
    try { await fetchThroughBrowser(cdp, 'https://cdn.example.com/x.m4a'); } catch (e) { caught = e; }
    ok('the ERR: answer is surfaced', caught && /→ ERR:403/.test(caught.message));
});

// A non-string answer is an error.
await check('a non-string answer is an error', async () => {
    const cdp = fakeCdp(undefined);
    let caught = null;
    try { await fetchThroughBrowser(cdp, 'https://cdn.example.com/x.m4a'); } catch (e) { caught = e; }
    ok('a non-string answer is reported', caught && /no response from the browser/.test(caught.message));
});

// evaluateInPage surfaces a JS exception instead of returning undefined.
await check('a JS exception is surfaced', async () => {
    const cdp = {
        async send() {
            return {
                exceptionDetails: {
                    text: 'Uncaught',
                    lineNumber: 7,
                    exception: { description: 'AbortError: in-page media fetch aborted after 100ms: x' },
                },
            };
        },
    };
    let caught = null;
    try { await evaluateInPage(cdp, 'x', 100); } catch (e) { caught = e; }
    ok('the JS exception text is surfaced', caught && /JS error: AbortError/.test(caught.message));
    ok('the JS exception line is surfaced', caught && /line 7/.test(caught.message));
});

/* ------------------------------------------------------------------ */

process.stderr.write('\n4. the write is the PLAINTEXT\n');

// Build a real encrypted media body so the decrypt path is exercised for
// real: wrap a CTR key and iv in AES-GCM (as the license server does),
// then AES-CTR-encrypt an MP4-shaped plaintext.
function forgeMedia(clipId, plaintext) {
    const glt = 'glt-token-for-tests';
    const gcmKey = crypto.createHash('sha256').update(glt, 'utf8').digest();
    const ctrKey = crypto.randomBytes(16);
    const ctrIv = crypto.randomBytes(16);

    const wrap = (secret) => {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', gcmKey, iv);
        c.setAAD(Buffer.from(String(clipId), 'utf8'));
        const ct = Buffer.concat([c.update(secret), c.final()]);
        return Buffer.concat([iv, ct, c.getAuthTag()]);
    };

    const cipher = crypto.createCipheriv('aes-128-ctr', ctrKey, ctrIv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
        encrypted,
        rights: { key: wrap(ctrKey).toString('base64'), iv: wrap(ctrIv).toString('base64'), glt },
    };
}

// An MP4-shaped plaintext: 4-byte box size, then the `ftyp` box type.
const FAKE_MP4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('M4A isom'),
    Buffer.alloc(64, 0x42),
]);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-fetch-test-'));
let tmpSeq = 0;
function tmpOut() {
    return path.join(tmpRoot, `out-${tmpSeq++}.m4a`);
}

const CLIP = '6b348a64-5b55-4418-9706-32b1d0563281';
const MEDIA_URL = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${CLIP}.m4a`;

// A fake clip: the placeholder audio_url, the real address in
// media_urls — exactly the live shape.
const FAKE_CLIP = {
    status: 'complete',
    title: 'Test Clip',
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [{ url: MEDIA_URL, content_type: 'm4a-opus' }],
};

await check('the fetch writes PLAYABLE bytes, not the encrypted body', async () => {
    const { encrypted, rights } = forgeMedia(CLIP, FAKE_MP4);
    const outPath = tmpOut();
    const client = {
        cdp: { send: async () => ({ result: { value: '' } }), js: async () => '' },
        async getClip() { return FAKE_CLIP; },
        async close() { this.closed = true; },
    };
    const code = await main(['--clip', CLIP, '--out', outPath], {
        openClient: async () => client,
        rightsFor: async () => rights,
        decrypt: require('./suno-mango.js').decryptMedia,
        fetchBytes: async () => encrypted,
        readInPage: async () => { throw new Error('the browser fallback must not be used'); },
        sleepFor: async () => {},
    });
    assert('the run succeeds', code, 0);
    ok('the output file exists', fs.existsSync(outPath));
    const written = fs.readFileSync(outPath);
    assert('the file is the plaintext', written.equals(FAKE_MP4), true);
    ok('the file is NOT the encrypted body', !written.equals(encrypted));
    // The sidecar says it is decrypted.
    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(outPath), `${CLIP}.json`), 'utf8'));
    assert('the sidecar says decrypted', sidecar.decrypted, true);
    ok('the sidecar records the algorithm', typeof sidecar.algorithm === 'string' && sidecar.algorithm.length > 0);
    ok('the session is closed', client.closed === true);
});

await check('a decryption failure leaves NO file behind', async () => {
    const { encrypted, rights } = forgeMedia(CLIP, FAKE_MP4);
    // A wrong key: the body will not decrypt to an ftyp box.
    const badRights = { ...rights, glt: 'a-different-token' };
    const outPath = tmpOut();
    const client = {
        cdp: {},
        async getClip() { return FAKE_CLIP; },
        async close() { this.closed = true; },
    };
    let caught = null;
    try {
        await main(['--clip', CLIP, '--out', outPath], {
            openClient: async () => client,
            rightsFor: async () => badRights,
            decrypt: require('./suno-mango.js').decryptMedia,
            fetchBytes: async () => encrypted,
            readInPage: async () => { throw new Error('unused'); },
            sleepFor: async () => {},
        });
    } catch (e) { caught = e; }
    ok('the run failed', caught !== null);
    ok('no file was written', !fs.existsSync(outPath));
    ok('the session was still closed', client.closed === true);
});

await check('the browser fallback is used when the plain fetch fails', async () => {
    const { encrypted, rights } = forgeMedia(CLIP, FAKE_MP4);
    const outPath = tmpOut();
    const client = {
        cdp: {},
        async getClip() { return FAKE_CLIP; },
        async close() {},
    };
    let usedBrowser = false;
    const code = await main(['--clip', CLIP, '--out', outPath], {
        openClient: async () => client,
        rightsFor: async () => rights,
        decrypt: require('./suno-mango.js').decryptMedia,
        fetchBytes: async () => { throw new Error('plain fetch refused'); },
        readInPage: async () => { usedBrowser = true; return encrypted; },
        sleepFor: async () => {},
    });
    assert('the run succeeds', code, 0);
    ok('the browser fallback was used', usedBrowser);
    ok('the file is the plaintext', fs.readFileSync(outPath).equals(FAKE_MP4));
});

await check('a clip with no audio reports 2 and writes nothing', async () => {
    const outPath = tmpOut();
    const client = {
        cdp: {},
        async getClip() { return { status: 'pending', audio_url: 'https://studio-api.prod.suno.com/api/forbidden' }; },
        async close() {},
    };
    const code = await main(['--clip', CLIP, '--out', outPath], {
        openClient: async () => client,
        rightsFor: async () => { throw new Error('must not be called'); },
        decrypt: () => { throw new Error('must not be called'); },
        fetchBytes: async () => { throw new Error('must not be called'); },
        readInPage: async () => { throw new Error('must not be called'); },
        sleepFor: async () => {},
    });
    assert('the run reports 2', code, 2);
    ok('no file was written', !fs.existsSync(outPath));
});

await check('--user-data-dir reaches the session opener', async () => {
    const { encrypted, rights } = forgeMedia(CLIP, FAKE_MP4);
    const outPath = tmpOut();
    let opened = null;
    const client = {
        cdp: {},
        async getClip() { return FAKE_CLIP; },
        async close() {},
    };
    await main(['--clip', CLIP, '--out', outPath, '--user-data-dir', '/tmp/suno-profile-x'], {
        openClient: async (opts) => { opened = opts; return client; },
        rightsFor: async () => rights,
        decrypt: require('./suno-mango.js').decryptMedia,
        fetchBytes: async () => encrypted,
        readInPage: async () => { throw new Error('unused'); },
        sleepFor: async () => {},
    });
    assert('the profile directory is passed through', opened && opened.userDataDir, '/tmp/suno-profile-x');
});

await check('the cookie file and port are passed through', async () => {
    const { encrypted, rights } = forgeMedia(CLIP, FAKE_MP4);
    const outPath = tmpOut();
    let opened = null;
    const client = {
        cdp: {},
        async getClip() { return FAKE_CLIP; },
        async close() {},
    };
    await main(['--clip', CLIP, '--out', outPath, '--cookies', '/tmp/jar.txt', '--port', '9455'], {
        openClient: async (opts) => { opened = opts; return client; },
        rightsFor: async () => rights,
        decrypt: require('./suno-mango.js').decryptMedia,
        fetchBytes: async () => encrypted,
        readInPage: async () => { throw new Error('unused'); },
        sleepFor: async () => {},
    });
    assert('the cookie file is passed through', opened && opened.cookieFile, '/tmp/jar.txt');
    assert('the port is a number', opened && opened.port, 9455);
});

// Clean up the scratch directory.
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.stderr.write(`\n[suno-fetch.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);

})().catch((e) => {
    process.stderr.write(`  ✗ the suite threw: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
});
