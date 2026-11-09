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
const submitter = require('./treblo-upload.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(`${name}${detail ? ': ' + detail : ''}`);
    }
}

(async () => {
    // ---- the key ---------------------------------------------------------

    // ---- the arguments ---------------------------------------------------

    const parsed = submitter.parseArgs(['a.mp3', '--json', 'b.mp3']);
    check('files and flags are told apart', parsed.files.length === 2 && parsed.flags.json === true);

    const bad = submitter.parseArgs(['--wat']);
    check('an unknown flag is refused, not ignored', Boolean(bad.error), bad.error);

    const noValue = submitter.parseArgs(['--out']);
    check('a flag with no value is an error', Boolean(noValue.error), noValue.error);

    check('the report path has a default', submitter.parseArgs([]).flags.out.endsWith(path.join('data', 'treblo', 'uploads.json')));

    // ---- the request -----------------------------------------------------

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
    const file = path.join(tmp, 'a.mp3');
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    let seen = null;
    const okFetch = async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, text: async () => JSON.stringify({ audio_upload_id: 'abc' }) };
    };
    const result = await submitter.uploadOne(file, 'sk-test', { fetchImpl: okFetch });
    check('the upload posts multipart to /uploads', seen.url.endsWith('/uploads'), seen.url);
    check('the upload carries the bearer key', seen.opts.headers.Authorization === 'Bearer sk-test');
    check('the upload sends a multipart body', seen.opts.body instanceof FormData);
    check('the upload sends the file field', Boolean(seen.opts.body.get('file')));
    check('the upload reads the audio_upload_id', result.id === 'abc', result.id);
    fs.rmSync(tmp, { recursive: true, force: true });

    const missing = await submitter.uploadOne('/nope/missing.mp3', 'sk-test', {
        fetchImpl: async () => { throw new Error('must not be called'); },
    });
    check('a missing file is reported, not uploaded', missing.id === null && /no such file/.test(missing.error));

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
    const file2 = path.join(tmp2, 'b.mp3');
    fs.writeFileSync(file2, Buffer.from([1]));
    const serverError = await submitter.uploadOne(file2, 'sk-test', {
        fetchImpl: async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ detail: 'bad file' }) }),
    });
    check('a server error is reported with its detail', /HTTP 422: bad file/.test(serverError.error), serverError.error);

    const noId = await submitter.uploadOne(file2, 'sk-test', {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    });
    check('a response with no id is a failure', noId.id === null && /no audio_upload_id/.test(noId.error));
    fs.rmSync(tmp2, { recursive: true, force: true });

    // ---- the batch -------------------------------------------------------

    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-upload-'));
    const good = path.join(tmp3, 'good.mp3');
    fs.writeFileSync(good, Buffer.from([1]));
    const results = await submitter.uploadAll([good, '/nope/missing.mp3'], 'sk-test', {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ audio_upload_id: 'x' }) }),
    });
    check('a batch continues past one failure', results.length === 2 && results[0].id === 'x' && Boolean(results[1].error));
    fs.rmSync(tmp3, { recursive: true, force: true });

    // ---- the connection check -------------------------------------------

    const state = await submitter.checkConnection({
        apiKey: 'sk-test',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ num_credits: 200 }) }),
        cookieFile: '/nope/no-jar',
    });
    check('the check reads the credits from the API', state.api.ok && state.api.credits === 200, JSON.stringify(state.api));
    check('a missing cookie jar is reported, not thrown', state.session.ok === false, JSON.stringify(state.session));

    const noKey = await submitter.checkConnection({
        apiKey: null,
        fetchImpl: async () => { throw new Error('must not be called'); },
        cookieFile: '/nope/no-jar',
    });
    check('no key is reported without a call', noKey.api.ok === false, JSON.stringify(noKey.api));

    console.log(`[treblo-upload.test] passed: ${passed}, failed: ${failed}`);
    if (failed) {
        for (const f of failures) console.log(`  ✗ ${f}`);
        process.exit(1);
    }
})();
