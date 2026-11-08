#!/usr/bin/env node
// lib/treblo.test.js — the Treblo client, with no account.
//
// No network, no credentials, no browser. The transport is a fake, so
// every assertion is about the client's OWN behaviour: the request it
// builds, the way it reads the response, and what it does when the
// account has no credits (which is the state it is in right now).

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    Treblo, apiKey, readPrompts, slugify, generateOne, parseArgs, CREDITS_PER_GENERATION,
    normalizeStatus, IN_PROGRESS, TERMINAL, adoptOne, extOf,
    resolveStrengths, validateLengthRange, validateOutput, probeDuration, existingTracks, preflightOutDir,
} = require('./treblo.js');

let passed = 0;
const failures = [];

// The helper AWAITS. A synchronous helper around an async body does
// not report the failure: the rejection escapes as an unhandled
// rejection and the check prints as a pass. The suite would then be
// green by luck, not by coverage.
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

// A fake transport: a queue of responses, and a log of what was sent.
function fakeTransport(responses) {
    const sent = [];
    const queue = responses.slice();
    const fetch = async (url, init) => {
        sent.push({ url, init });
        const next = queue.length ? queue.shift() : { status: 200, json: {} };
        const text = next.text !== undefined ? next.text : JSON.stringify(next.json || {});
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            text: async () => text,
            arrayBuffer: async () => (next.bytes ? Buffer.from(next.bytes) : Buffer.from('')),
        };
    };
    return { fetch, sent };
}

(async () => {
// ------------------------------------------------------------------------
console.log('\n1. the pack reader');

await check('reads one prompt per top-level bullet', () => {
    const md = [
        '# A pack',
        '',
        '- first prompt',
        '- second prompt',
    ].join('\n');
    assert.deepStrictEqual(readPrompts(md), ['first prompt', 'second prompt']);
});
await check('skips frontmatter, blockquotes and code fences', () => {
    const md = [
        '---',
        'title: something',
        '---',
        '',
        '> a quoted line',
        '',
        '```',
        '- not a prompt',
        '```',
        '',
        '- the real prompt',
    ].join('\n');
    assert.deepStrictEqual(readPrompts(md), ['the real prompt']);
});
await check('a bullet with a trailing marker keeps its text', () => {
    assert.deepStrictEqual(readPrompts('- a prompt --ar 16:9\n'), ['a prompt --ar 16:9']);
});
await check('a slug is filename-safe', () => {
    assert.strictEqual(slugify('Midnight Solstice — a slow modal piece!'), 'midnight-solstice-a-slow-modal-piece');
    assert.ok(!/[^a-z0-9-]/.test(slugify('Étude #1')));
});

// ------------------------------------------------------------------------
console.log('\n2. the credentials');

await check('the environment key wins', () => {
    const key = apiKey({ env: { TREBLO_API_KEY: 'from-env' }, home: '/nonexistent' });
    assert.strictEqual(key, 'from-env');
});
await check('a missing key is a NO_KEY error, not a network error', () => {
    assert.throws(() => apiKey({ env: {}, home: '/nonexistent' }), (e) => e.code === 'NO_KEY');
});
await check('a key file is read, and a literal backslash-n is stripped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-key-'));
    const file = path.join(dir, '.treblo-api-key');
    fs.writeFileSync(file, 'abc123\\n');
    assert.strictEqual(apiKey({ env: {}, home: dir }), 'abc123');
    fs.rmSync(dir, { recursive: true, force: true });
});
await check('the key never reaches a run record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-keyrec-'));
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 'task-9' } },
        { status: 200, json: { status: 'SUCCESS' } },
        { status: 200, json: { song_paths: ['https://cdn.treblo.com/song.mp3'] } },
        { status: 200, bytes: 'AUDIO' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'super-secret-key' });
    const entry = await generateOne(client, 'a slow modal piece', { index: 0, outDir: dir, instrumental: true, format: 'mp3' });
    assert.ok(!JSON.stringify(entry).includes('super-secret-key'), 'the run record must not carry the key');
    fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------
console.log('\n3. the requests');

await check('a generation posts a prompt to /generations/v3', async () => {
    const { fetch, sent } = fakeTransport([{ status: 200, json: { task_id: 'abc' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const res = await client.generate({ prompt: 'a slow modal piece' });
    assert.strictEqual(res.task_id, 'abc');
    assert.ok(sent[0].url.endsWith('/generations/v3'), sent[0].url);
    assert.strictEqual(sent[0].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(sent[0].init.body), { prompt: 'a slow modal piece' });
    assert.strictEqual(sent[0].init.headers.Authorization, 'Bearer k');
});
await check('an instrumental carries the flag and no lyrics', async () => {
    const { fetch, sent } = fakeTransport([{ status: 200, json: { task_id: 'abc' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await client.generate({ prompt: 'p', instrumental: true, lyrics: 'la la la' });
    const body = JSON.parse(sent[0].init.body);
    assert.strictEqual(body.instrumental, true);
    assert.strictEqual('lyrics' in body, false, 'an instrumental must not carry lyrics');
});
await check('the output format travels when it is asked for', async () => {
    const { fetch, sent } = fakeTransport([{ status: 200, json: { task_id: 'abc' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await client.generate({ prompt: 'p', outputFormat: 'mp3', outputBitRate: 192 });
    const body = JSON.parse(sent[0].init.body);
    assert.strictEqual(body.output_format, 'mp3');
    assert.strictEqual(body.output_bit_rate, 192);
});
await check('the status and generation endpoints are the documented ones', async () => {
    const { fetch, sent } = fakeTransport([
        { status: 200, json: { status: 'SUCCESS' } },
        { status: 200, json: { song_paths: ['https://cdn/x.mp3'] } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await client.status('task-1');
    await client.generation('task-1');
    assert.ok(sent[0].url.endsWith('/generations/status/task-1'), sent[0].url);
    assert.ok(sent[1].url.endsWith('/generations/task-1'), sent[1].url);
});

// ------------------------------------------------------------------------
console.log('\n4. the failure modes');

await check('a 402 is an OUT_OF_CREDITS error naming the fix', async () => {
    const { fetch } = fakeTransport([{ status: 402, json: { detail: 'Out of credits. Please purchase more at https://treblo.com/developers.' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => client.generate({ prompt: 'p' }), (e) => {
        assert.strictEqual(e.code, 'OUT_OF_CREDITS');
        assert.ok(/developers\/account/.test(e.message), 'the error must name the page that fixes it');
        return true;
    });
});
await check('a 401 is an error, not a crash', async () => {
    const { fetch } = fakeTransport([{ status: 401, json: { detail: 'Invalid API key' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => client.generate({ prompt: 'p' }), (e) => {
        assert.strictEqual(e.status, 401);
        return true;
    });
});
await check('the key is never echoed in an error message', async () => {
    const { fetch } = fakeTransport([{ status: 500, json: { detail: 'boom' } }]);
    const client = new Treblo({ fetch, apiKey: 'sk-secret-value' });
    await assert.rejects(() => client.generate({ prompt: 'p' }), (e) => {
        assert.ok(!e.message.includes('sk-secret-value'));
        return true;
    });
});
await check('a non-JSON body does not take the client down', async () => {
    const { fetch } = fakeTransport([{ status: 502, text: '<html>bad gateway</html>' }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => client.generate({ prompt: 'p' }), (e) => e.status === 502);
});

// ------------------------------------------------------------------------
console.log('\n5. the run');

await check('waitFor stops on SUCCESS', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { status: 'RECEIVED' } },
        { status: 200, json: { status: 'GENERATING' } },
        { status: 200, json: { status: 'SUCCESS' } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const res = await client.waitFor('t1', { intervalMs: 0, sleep: async () => {} });
    assert.strictEqual(res.status, 'SUCCESS');
});
await check('waitFor stops on FAILURE', async () => {
    const { fetch } = fakeTransport([{ status: 200, json: { status: 'FAILURE' } }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const res = await client.waitFor('t1', { intervalMs: 0, sleep: async () => {} });
    assert.strictEqual(res.status, 'FAILURE');
});
await check('waitFor times out rather than polling forever', async () => {
    // A transport that ALWAYS says "still working" — a finite queue would
    // run dry and answer with an empty body, which is a different case.
    const fetch = async () => ({
        ok: true, status: 200,
        text: async () => '"GENERATING"',
        arrayBuffer: async () => Buffer.from(''),
    });
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => client.waitFor('t1', { intervalMs: 0, timeoutMs: 5, sleep: async () => {} }), (e) => e.code === 'TIMEOUT');
});
await check('one prompt → one downloaded song', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-run-'));
    const { fetch, sent } = fakeTransport([
        { status: 200, json: { task_id: 'task-9' } },
        { status: 200, json: { status: 'SUCCESS' } },
        { status: 200, json: { song_paths: ['https://cdn.treblo.com/song.mp3'] } },
        { status: 200, bytes: 'ID3AUDIOBYTES' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const entry = await generateOne(client, 'a slow modal piece', { index: 0, outDir: dir, instrumental: true, format: 'mp3' });
    assert.strictEqual(entry.taskId, 'task-9');
    assert.ok(entry.file && entry.file.endsWith('.mp3'), entry.file);
    assert.ok(fs.existsSync(entry.file), 'the audio must be on disk — the URLs expire');
    assert.strictEqual(fs.readFileSync(entry.file, 'utf8'), 'ID3AUDIOBYTES');
    assert.ok(sent.some((s) => s.url === 'https://cdn.treblo.com/song.mp3'), 'the song must be fetched');
    fs.rmSync(dir, { recursive: true, force: true });
});
await check('a SUCCESS with no song_paths is an error, not a silent success', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 'task-9' } },
        { status: 200, json: { status: 'SUCCESS' } },
        { status: 200, json: { song_paths: [] } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => generateOne(client, 'p', { index: 0, outDir: null, download: false }), /song_paths/);
});
await check('a FAILED generation does not pretend to have a song', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 'task-9' } },
        { status: 200, json: { status: 'FAILURE' } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(() => generateOne(client, 'p', { index: 0, outDir: null, download: false }), (e) => e.code === 'GENERATION_FAILED');
});

// ------------------------------------------------------------------------
console.log('\n6. the CLI');

await check('the arguments parse', () => {
    const a = parseArgs(['--prompt-file', 'p.md', '--out', 'o', '--limit', '2', '--vocal', '--format', 'ogg']);
    assert.strictEqual(a.promptFile, 'p.md');
    assert.strictEqual(a.outDir, 'o');
    assert.strictEqual(a.limit, 2);
    assert.strictEqual(a.instrumental, false);
    assert.strictEqual(a.format, 'ogg');
});
await check('instrumental is the default', () => {
    assert.strictEqual(parseArgs([]).instrumental, true);
});
await check('a generation costs 100 credits', () => {
    assert.strictEqual(CREDITS_PER_GENERATION, 100);
});


// ------------------------------------------------------------------------
// 7. the status contract — the bug the live run found
//
// The live API answers GET /generations/status/:id with a BARE JSON
// STRING ("GENERATING"), not an object. A client that reads
// `body.status` gets undefined, never matches a terminal state, and
// polls until something else kills it. The status is normalized once,
// and "terminal" is defined as "not a state that means still working".
// ------------------------------------------------------------------------
console.log('\n7. the status contract');

await check('a bare string status is read as a status', () => {
    assert.strictEqual(normalizeStatus('GENERATING'), 'GENERATING');
    assert.strictEqual(normalizeStatus(' SUCCESS '), 'SUCCESS');
});
await check('an object status is read as a status', () => {
    assert.strictEqual(normalizeStatus({ status: 'SUCCESS' }), 'SUCCESS');
    assert.strictEqual(normalizeStatus({ state: 'FAILURE' }), 'FAILURE');
});
await check('an unreadable status is UNKNOWN, never undefined', () => {
    assert.strictEqual(normalizeStatus(null), 'UNKNOWN');
    assert.strictEqual(normalizeStatus(undefined), 'UNKNOWN');
    assert.strictEqual(normalizeStatus({}), 'UNKNOWN');
    assert.notStrictEqual(normalizeStatus(null), undefined);
});
await check('the in-progress set covers the states we have seen', () => {
    for (const st of ['RECEIVED', 'PENDING', 'QUEUED', 'GENERATING', 'PROCESSING']) {
        assert.ok(IN_PROGRESS.has(st), `${st} should be in-progress`);
    }
    for (const st of ['SUCCESS', 'FAILURE']) {
        assert.ok(!IN_PROGRESS.has(st), `${st} should be terminal`);
    }
});

await check('a bare-string status endpoint is polled to SUCCESS', async () => {
    const { fetch } = fakeTransport([
        { status: 200, text: '"GENERATING"' },
        { status: 200, text: '"GENERATING"' },
        { status: 200, text: '"SUCCESS"' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const seen = [];
    const out = await client.waitFor('t1', { intervalMs: 0, sleep: async () => {}, onStatus: (st) => seen.push(st) });
    assert.strictEqual(out.status, 'SUCCESS');
    assert.deepStrictEqual(seen, ['GENERATING', 'GENERATING', 'SUCCESS']);
});
await check('a FAILURE status ends the poll instead of hanging', async () => {
    const { fetch } = fakeTransport([{ status: 200, text: '"FAILURE"' }]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const out = await client.waitFor('t2', { intervalMs: 0, sleep: async () => {} });
    assert.strictEqual(out.status, 'FAILURE');
});
await check('a MID-PIPELINE state keeps the poll alive', async () => {
    // The live vocabulary is a PIPELINE: RECEIVED → PROMPT → GENERATING
    // → SAVING → SUCCESS. A run that treated every unknown state as
    // terminal killed five live generations the moment they said
    // "PROMPT" — so a state that is not known-terminal keeps polling.
    const { fetch } = fakeTransport([
        { status: 200, text: '"RECEIVED"' },
        { status: 200, text: '"PROMPT"' },
        { status: 200, text: '"GENERATING"' },
        { status: 200, text: '"SAVING"' },
        { status: 200, text: '"SUCCESS"' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const seen = [];
    const out = await client.waitFor('t3', { intervalMs: 0, sleep: async () => {}, onStatus: (st) => seen.push(st) });
    assert.strictEqual(out.status, 'SUCCESS');
    assert.deepStrictEqual(seen, ['RECEIVED', 'PROMPT', 'GENERATING', 'SAVING', 'SUCCESS']);
});
await check('the live pipeline states are all non-terminal', () => {
    for (const st of ['RECEIVED', 'PROMPT', 'GENERATING', 'SAVING']) {
        assert.ok(!TERMINAL.has(st), `${st} must not be terminal`);
    }
    for (const st of ['SUCCESS', 'FAILURE', 'ERROR', 'CANCELLED', 'EXPIRED']) {
        assert.ok(TERMINAL.has(st), `${st} must be terminal`);
    }
});
await check('an unreadable status body ends the poll instead of hanging', async () => {
    // A body that never parses will never parse: after three
    // consecutive unreadable answers the poll stops and says so.
    const { fetch } = fakeTransport([
        { status: 200, text: 'not json at all' },
        { status: 200, text: 'not json at all' },
        { status: 200, text: 'not json at all' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(
        () => client.waitFor('t4', { intervalMs: 0, sleep: async () => {} }),
        (e) => e.code === 'UNREADABLE_STATUS',
    );
});
await check('a readable status after an unreadable one keeps the poll alive', async () => {
    const { fetch } = fakeTransport([
        { status: 200, text: 'not json at all' },
        { status: 200, text: '"GENERATING"' },
        { status: 200, text: '"SUCCESS"' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const out = await client.waitFor('t5', { intervalMs: 0, sleep: async () => {} });
    assert.strictEqual(out.status, 'SUCCESS');
});
await check('an existing task is adopted, not re-submitted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-adopt-'));
    const { fetch, sent } = fakeTransport([
        { status: 200, json: { id: 't5', status: 'GENERATING', prompt: 'a warm trumpet solo' } },
        { status: 200, text: '"SUCCESS"' },
        { status: 200, json: { id: 't5', status: 'SUCCESS', song_paths: ['https://cdn.treblo.com/song.mp3'] } },
        { status: 200, bytes: 'ID3AUDIO' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const entry = await adoptOne(client, 't5', { index: 0, outDir: dir, download: true });
    assert.strictEqual(entry.taskId, 't5');
    assert.strictEqual(entry.adopted, true);
    assert.ok(entry.file && entry.file.endsWith('.mp3'));
    // NO submission: no POST to the generations endpoint.
    const posts = sent.filter((s) => s.init && s.init.method === 'POST');
    assert.strictEqual(posts.length, 0, 'adopting must not submit a new generation');
});
await check('the file extension follows the URL, not the requested format', () => {
    // The API answers with what it answers with: a run requested as
    // mp3 can hand back an .ogg URL. A file named .mp3 that is really
    // an ogg container is a lie the player has to discover.
    assert.strictEqual(extOf('https://cdn.treblo.com/pubapi/audio_x_0.ogg'), 'ogg');
    assert.strictEqual(extOf('https://cdn.treblo.com/pubapi/audio_x_0.ogg?sig=abc'), 'ogg');
    assert.strictEqual(extOf('https://cdn.treblo.com/audio.mp3'), 'mp3');
    assert.strictEqual(extOf('https://cdn.treblo.com/audio'), 'mp3', 'no extension → the requested format');
});
await check('an adopted task that failed is reported, not retried', async () => {
    const { fetch, sent } = fakeTransport([
        { status: 200, json: { id: 't6', status: 'GENERATING', prompt: 'p' } },
        { status: 200, text: '"FAILURE"' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(
        () => adoptOne(client, 't6', { index: 0, outDir: null, download: false }),
        (e) => e.code === 'GENERATION_FAILED',
    );
    assert.strictEqual(sent.filter((s) => s.init && s.init.method === 'POST').length, 0);
});
await check('generateOne fails loudly on a failed task', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 't9' } },
        { status: 200, text: '"FAILURE"' },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    await assert.rejects(
        () => generateOne(client, 'p', { index: 0, outDir: null, download: false }),
        (e) => e.code === 'GENERATION_FAILED' && /FAILURE/.test(e.message),
    );
});
// ------------------------------------------------------------------------
// The app's create-page settings (v3-preview, prompt strength 2.57).
//
// The docs are explicit that exactly one of prompt_strength and style_scale
// may be above 1.0. The app exposes prompt strength and no style scale, so
// a client that sends only prompt_strength and leaves style_scale at its 2.3
// default is rejected — "use these settings" has to mean a valid pair.

await check('prompt strength alone drops style scale to 1.0', () => {
    const r = resolveStrengths({ promptStrength: 2.57 });
    assert.equal(r.promptStrength, 2.57);
    assert.equal(r.styleScale, 1);
    assert.match(r.notes[0], /style_scale 1\.0/);
});

await check('both raised is corrected, not sent', () => {
    const r = resolveStrengths({ promptStrength: 3, styleScale: 6 });
    assert.equal(r.styleScale, 1);
    assert.match(r.notes[0], /cannot both be > 1\.0/);
});

await check('no settings means the documented defaults', () => {
    const r = resolveStrengths({});
    assert.equal(r.promptStrength, 1);
    assert.equal(r.styleScale, 2.3);
});

await check('out-of-range strengths are refused', () => {
    assert.throws(() => resolveStrengths({ promptStrength: 0.5 }), /1\.0 - 4\.0/);
    assert.throws(() => resolveStrengths({ promptStrength: 4.1 }), /1\.0 - 4\.0/);
    assert.throws(() => resolveStrengths({ styleScale: 13 }), /1\.0 - 12\.0/);
});

await check('the request body carries the app settings', async () => {
    const { fetch, sent } = fakeTransport([
        { status: 200, json: { task_id: 't-settings' } },
        { status: 200, text: '"SUCCESS"' },
        { status: 200, json: { song_paths: ['https://cdn/x.ogg'] } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const r = resolveStrengths({ promptStrength: 2.57 });
    await generateOne(client, 'subterranean bass clarinet', {
        index: 0, outDir: null, download: false,
        promptStrength: r.promptStrength, styleScale: r.styleScale,
    });
    const body = JSON.parse(sent[0].init.body);
    assert.equal(body.prompt, 'subterranean bass clarinet');
    assert.equal(body.instrumental, true);
    assert.equal(body.prompt_strength, 2.57);
    assert.equal(body.style_scale, 1);
    assert.equal(body.tags, undefined);
    assert.equal(body.lyrics, undefined);
});

await check('length_range is validated against the documented multiples', () => {
    assert.deepEqual(validateLengthRange('90,180'), [90, 180]);
    assert.throws(() => validateLengthRange('95,180'), /multiples of 30/);
    assert.throws(() => validateLengthRange('300,330'), /min must be 0 - 270/);
    assert.throws(() => validateLengthRange('180,180'), /below max/);
});

await check('output format and bitrate are validated', () => {
    assert.deepEqual(validateOutput({ format: 'mp3', bitRate: 320 }), { format: 'mp3', bitRate: 320 });
    assert.throws(() => validateOutput({ format: 'aiff' }), /output_format must be one of/);
    assert.throws(() => validateOutput({ format: 'ogg', bitRate: 320 }), /only valid for mp3 and m4a/);
    assert.throws(() => validateOutput({ bitRate: 100 }), /output_bit_rate must be one of/);
});

await check('the CLI accepts the settings flags and the credits verb', () => {
    const args = parseArgs(['--prompt', 'x', '--prompt-strength', '2.57', '--style-scale', '1.0',
        '--length-range', '90,180', '--output-format', 'mp3', '--output-bit-rate', '320',
        '--negative-tags', 'lo-fi,noise']);
    assert.equal(args.promptStrength, 2.57);
    assert.equal(args.styleScale, 1.0);
    assert.equal(args.lengthRange, '90,180');
    assert.equal(args.outputFormat, 'mp3');
    assert.equal(args.outputBitRate, 320);
    assert.deepEqual(args.negativeTags, ['lo-fi', 'noise']);
    assert.equal(parseArgs(['--credits']).credits, true);
});

// A SUCCESS generation is not proof of a song: one real run came back as a
// 32-second fragment. The download is probed and an implausibly short track
// is named in the catalogue instead of silently kept.
await check('the duration probe reads a real file and tolerates a missing one', () => {
    const spawnSync = () => ({ status: 0, stdout: '212.4\n' });
    assert.equal(probeDuration('/tmp/whatever.ogg', spawnSync), 212.4);
    const missing = () => ({ status: 1, stdout: '' });
    assert.equal(probeDuration('/tmp/whatever.ogg', missing), null);
});

await check('a short SUCCESS generation is flagged, not shipped quietly', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 't-short' } },
        { status: 200, text: '"SUCCESS"' },
        { status: 200, json: { song_paths: ['https://cdn/x.ogg'] } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-short-'));
    // write the "downloaded" file ourselves so no network or ffmpeg is needed
    client.download = async (url, dest) => { fs.writeFileSync(dest, 'x'); return { path: dest, bytes: 1 }; };
    const entry = await generateOne(client, 'a fragment', {
        index: 0, outDir: dir, format: 'ogg',
        spawnSync: () => ({ status: 0, stdout: '32.0\n' }),
    });
    assert.equal(entry.durationSec, 32);
    assert.equal(entry.shortTrack, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

await check('a plausible duration is not flagged', async () => {
    const { fetch } = fakeTransport([
        { status: 200, json: { task_id: 't-long' } },
        { status: 200, text: '"SUCCESS"' },
        { status: 200, json: { song_paths: ['https://cdn/y.ogg'] } },
    ]);
    const client = new Treblo({ fetch, apiKey: 'k' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-long-'));
    client.download = async (url, dest) => { fs.writeFileSync(dest, 'x'); return { path: dest, bytes: 1 }; };
    const entry = await generateOne(client, 'a song', {
        index: 0, outDir: dir, format: 'ogg',
        spawnSync: () => ({ status: 0, stdout: '204.7\n' }),
    });
    assert.equal(entry.durationSec, 204.7);
    assert.equal(entry.shortTrack, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
});

// A second run into the same --out does not overwrite: the filename is
// NN-<slug>, so two prompts sharing an index but not a slug leave two
// `02-…` files and the later catalog.json orphans the earlier track.
// Measured 2026-10-25: one wasted 100-credit generation and a catalogue
// entry pointing at the wrong take.
await check('an --out holding tracks is refused, naming what is there', () => {
    const readdirSync = () => ['02-a.ogg', '01-b.mp3', 'catalog.json', 'notes.md', 'alt'];
    const pre = preflightOutDir('/x', false, readdirSync);
    assert.equal(pre.ok, false);
    assert.deepEqual(pre.already, ['01-b.mp3', '02-a.ogg']);
    assert.ok(pre.message.includes('already holds 2 track(s)'));
    assert.ok(pre.message.includes('Nothing was spent'));
    assert.ok(pre.message.includes('--force'));
});

await check('--force writes anyway, and a clean --out is not a conflict', () => {
    assert.equal(preflightOutDir('/x', true, () => ['01-b.mp3']).ok, true);
    assert.equal(preflightOutDir('/x', false, () => []).ok, true);
    assert.equal(preflightOutDir('/x', false, () => ['catalog.json']).ok, true);
    assert.deepEqual(existingTracks('/tmp', () => ['02-a.ogg', '01-b.mp3', 'catalog.json', 'notes.md', 'alt']),
        ['01-b.mp3', '02-a.ogg']);
});

console.log(`\n[treblo.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
})().catch((e) => { process.stderr.write(`treblo.test: ${e.stack}\n`); process.exit(1); });
