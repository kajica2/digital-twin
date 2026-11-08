#!/usr/bin/env node
'use strict';
// lib/treblo-upload.test.js
//
// The upload tool's contract, with no network and no key.
//
// The upload itself is exercised for real against the live API in the
// sprint run; these tests pin the parts that decide what happens when a
// file is missing, a flag is wrong, or the server says no.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    apiKey,
    parseArgs,
    uploadOne,
    uploadAll,
    API_BASE,
} = require('./treblo-upload.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        failures.push(`${name}: ${err.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
    } catch (err) {
        failed++;
        failures.push(`${name}: ${err.message}`);
    }
}

(async () => {
    // ---- the key ---------------------------------------------------------

    check('the environment wins over the key file', () => {
        assert.strictEqual(apiKey({ TREBLO_API_KEY: 'sk-env' }), 'sk-env');
    });

    check('a missing key file yields no key', () => {
        assert.strictEqual(apiKey({ TREBLO_API_FILE: '/nope/nothing-here' }), null);
    });

    check('the key file is read from the home directory by default', () => {
        const expected = path.join(os.homedir(), '.treblo-api-key');
        assert.ok(expected.endsWith(path.join('.treblo-api-key')));
    });

    // ---- the arguments ---------------------------------------------------

    check('files and flags are told apart', () => {
        const parsed = parseArgs(['a.mp3', '--json', 'b.mp3']);
        assert.deepStrictEqual(parsed.files, ['a.mp3', 'b.mp3']);
        assert.strictEqual(parsed.flags.json, true);
    });

    check('an unknown flag is refused, not ignored', () => {
        const parsed = parseArgs(['--wat']);
        assert.ok(parsed.error, 'an unknown flag must be an error');
        assert.match(parsed.error, /unknown flag/);
    });

    check('a flag with no value is an error', () => {
        const parsed = parseArgs(['--out']);
        assert.ok(parsed.error);
        assert.match(parsed.error, /needs a value/);
    });

    check('the report path has a default', () => {
        assert.ok(parseArgs([]).flags.out.endsWith(path.join('data', 'treblo', 'uploads.json')));
    });

    // ---- the request -----------------------------------------------------

    await checkAsync('the upload posts multipart with the file field', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
        const file = path.join(tmp, 'a.mp3');
        fs.writeFileSync(file, Buffer.from([1, 2, 3]));
        let seen = null;
        const fetchImpl = async (url, opts) => {
            seen = { url, opts };
            return { ok: true, status: 200, text: async () => JSON.stringify({ audio_upload_id: 'abc' }) };
        };
        const result = await uploadOne(file, 'sk-test', { fetchImpl });
        assert.strictEqual(seen.url, `${API_BASE}/uploads`);
        assert.strictEqual(seen.opts.method, 'POST');
        assert.strictEqual(seen.opts.headers.Authorization, 'Bearer sk-test');
        assert.ok(seen.opts.body instanceof FormData);
        assert.ok(seen.opts.body.get('file'), 'the file field must be present');
        assert.strictEqual(result.id, 'abc');
        assert.strictEqual(result.error, null);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    await checkAsync('a missing file is reported, not uploaded', async () => {
        const result = await uploadOne('/nope/missing.mp3', 'sk-test', {
            fetchImpl: async () => { throw new Error('must not be called'); },
        });
        assert.strictEqual(result.id, null);
        assert.match(result.error, /no such file/);
    });

    await checkAsync('a server error is reported with its detail', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
        const file = path.join(tmp, 'a.mp3');
        fs.writeFileSync(file, Buffer.from([1]));
        const result = await uploadOne(file, 'sk-test', {
            fetchImpl: async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ detail: 'bad file' }) }),
        });
        assert.strictEqual(result.id, null);
        assert.match(result.error, /HTTP 422: bad file/);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    await checkAsync('a response with no id is a failure, not a silent success', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
        const file = path.join(tmp, 'a.mp3');
        fs.writeFileSync(file, Buffer.from([1]));
        const result = await uploadOne(file, 'sk-test', {
            fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
        });
        assert.strictEqual(result.id, null);
        assert.match(result.error, /no audio_upload_id/);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    await checkAsync('a batch continues past one failure and reports every file', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
        const good = path.join(tmp, 'good.mp3');
        fs.writeFileSync(good, Buffer.from([1]));
        const results = await uploadAll([good, '/nope/missing.mp3'], 'sk-test', {
            fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ audio_upload_id: 'x' }) }),
        });
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].id, 'x');
        assert.ok(results[1].error);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    console.log(`[treblo-upload.test] passed: ${passed}, failed: ${failed}`);
    if (failed) {
        for (const f of failures) console.log(`  ✗ ${f}`);
        process.exit(1);
    }
})();
