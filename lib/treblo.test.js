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
    const { fetch } = fakeTransport(Array.from({ length: 50 }, () => ({ status: 200, json: { status: 'GENERATING' } })));
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
console.log(`\n[treblo.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
})().catch((e) => { process.stderr.write(`treblo.test: ${e.stack}\n`); process.exit(1); });
