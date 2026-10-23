#!/usr/bin/env node
'use strict';

/**
 * lib/youtube-poster.test.js — contract tests for the YouTube poster's
 * pure logic.
 *
 * The upload path itself was dead code (four separate blockers: a
 * connection argument that was not a URL, CDP calls to a method the
 * client does not have, a file upload that died on `require` inside
 * the page, and React inputs that ignore a plain `.value` write). The
 * pure parts are what decide what gets published, so they are pinned
 * here — the browser part is verified by the live run, not by a fake.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseVideoFile, generateMetadata, cdpDomains, waitForDocument, uploadToYouTube, makeClient } = require('./youtube-poster.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

// An async check that is actually awaited. A promise returned from the
// sync helper would reject silently and the assertion would pass
// vacuously.
async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-poster-test-'));

function makeVideo(name) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.alloc(1024));
    return p;
}

console.log('youtube-poster');

// ------------------------------------------------------------- parseVideoFile
check('parseVideoFile reads the timestamp out of the filename', () => {
    const p = makeVideo('sainted-word-2026-10-22T19-29-15.mp4');
    const info = parseVideoFile(p);
    assert.ok(info.date instanceof Date, 'no date was parsed');
    assert.strictEqual(info.date.toISOString().slice(0, 10), '2026-10-22');
});

check('parseVideoFile infers the mood from the filename', () => {
    const p = makeVideo('sainted-word-2026-10-22T19-29-15-dark.mp4');
    assert.strictEqual(parseVideoFile(p).mood, 'Dark');
});

check('parseVideoFile falls back to Ambient for an unrecognised name', () => {
    const p = makeVideo('seemingly-so.mp4');
    const info = parseVideoFile(p);
    assert.strictEqual(info.mood, 'Ambient');
    assert.strictEqual(info.date, null, 'a date was invented from a name with no timestamp');
    assert.strictEqual(info.basename, 'seemingly-so');
    assert.strictEqual(info.size, 1024);
});

check('parseVideoFile reports the real file size', () => {
    const p = makeVideo('seemingly-so.mp4');
    assert.strictEqual(parseVideoFile(p).size, fs.statSync(p).size);
});

// ----------------------------------------------------------- generateMetadata
check('generateMetadata builds the channel title pattern', () => {
    const p = makeVideo('sainted-word-2026-10-22T19-29-15-dark.mp4');
    const m = generateMetadata(parseVideoFile(p));
    assert.match(m.title, /^Sainted Word - /, `unexpected title: ${m.title}`);
    assert.match(m.title, /Dark$/, `unexpected title: ${m.title}`);
});

check('generateMetadata lets an explicit title win', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p), { title: 'Sainted Word - seemingly so' });
    assert.strictEqual(m.title, 'Sainted Word - seemingly so');
});

check('generateMetadata lets an explicit description win', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p), { description: 'the real description' });
    assert.strictEqual(m.description, 'the real description');
});

check('generateMetadata splits an explicit tag list and drops empty tags', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p), { tags: 'SaintedWordRecords, AIArt ,,Ambient' });
    assert.deepStrictEqual(m.tags, ['SaintedWordRecords', 'AIArt', 'Ambient']);
});

check('generateMetadata keeps the default tags and adds the mood', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p));
    assert.ok(m.tags.length > 1, 'the default tags were dropped');
    assert.ok(m.tags.includes('Ambient'), 'the mood tag was not added');
    assert.strictEqual(new Set(m.tags).size, m.tags.length, 'a tag was duplicated');
});

check('generateMetadata fills the description template', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p));
    assert.ok(m.description.length > 0, 'the description is empty');
    assert.ok(!/\{mood\}|\{filename\}|\{date\}/.test(m.description),
        `the description still has a placeholder: ${m.description}`);
});

check('generateMetadata never emits an empty title', () => {
    const p = makeVideo('seemingly-so.mp4');
    const m = generateMetadata(parseVideoFile(p), { title: '' });
    assert.ok(m.title.length > 0, 'an empty title was accepted');
});

// ---------- the CDP plumbing ----------

(async () => {

await checkAsync('cdpDomains turns CDP.Page.navigate into the Page.navigate command', async () => {
    const sent = [];
    const client = { send: async (method, params) => { sent.push([method, params]); return {}; } };
    const CDP = cdpDomains(client);
    await CDP.Page.navigate({ url: 'https://studio.youtube.com' });
    assert.deepStrictEqual(sent, [['Page.navigate', { url: 'https://studio.youtube.com' }]]);
});

await checkAsync('cdpDomains reaches every domain the upload path uses', async () => {
    const sent = [];
    const client = { send: async (method, params) => { sent.push(method); return {}; } };
    const CDP = cdpDomains(client);
    await CDP.Network.setCookies({ cookies: [] });
    await CDP.DOM.enable();
    await CDP.Runtime.evaluate({ expression: '1' });
    assert.deepStrictEqual(sent, ['Network.setCookies', 'DOM.enable', 'Runtime.evaluate']);
});

await checkAsync('cdpDomains passes the params through untouched', async () => {
    const sent = [];
    const client = { send: async (method, params) => { sent.push(params); return {}; } };
    const CDP = cdpDomains(client);
    await CDP.DOM.setFileInputFiles({ nodeId: 7, files: ['/tmp/a.mp4'] });
    assert.deepStrictEqual(sent[0], { nodeId: 7, files: ['/tmp/a.mp4'] });
});

await checkAsync('waitForDocument returns once the document is interactive', async () => {
    let calls = 0;
    const client = { js: async () => (++calls >= 2 ? 'complete' : 'loading') };
    const state = await waitForDocument(client, 5000);
    assert.strictEqual(state, 'complete');
});

await checkAsync('waitForDocument gives up instead of hanging forever', async () => {
    const client = { js: async () => 'loading' };
    const state = await waitForDocument(client, 300);
    assert.strictEqual(state, 'timeout');
});

// ---------- the whole upload path, against a fake browser ----------

// A fake that implements ONLY the client's real surface: send() and
// js(). If the upload path calls a method the client does not have —
// which is how client.getDOMain() survived in the committed code —
// this fake throws, exactly as a real client would.
function fakeClient(script) {
    const calls = [];
    let fileInputQueries = 0;
    return {
        calls,
        async js(expression) {
            calls.push(['js', expression]);
            // The channel dashboard has no file input; opening the
            // upload dialog brings one. The first query says none.
            if (String(expression).includes('input[type=file]')) {
                return fileInputQueries++ === 0 ? 0 : 1;
            }
            return 'complete';
        },
        async send(method, params) {
            calls.push([method, params]);
            if (script[method]) return script[method](params);
            if (method === 'Runtime.evaluate') {
                const e = params.expression || '';
                if (e.includes('Upload complete')) return { result: { value: { progress: 100, complete: true } } };
                if (e.includes('input[type="file"]')) return { result: { type: 'object', objectId: 'file-input-1' } };
                if (e.includes("i.name === 'title'")) return { result: { value: { set: true, value: 'T' } } };
                if (e.includes("t.name === 'description'")) return { result: { value: { set: true, len: 5 } } };
                if (e.includes("i.name?.includes('tags')")) return { result: { value: { set: true, value: 'a, b' } } };
                if (e.includes("return { state: 'radio' }")) return { result: { value: { state: 'radio' } } };
                if (e.includes('return { advanced: false }')) return { result: { value: { advanced: false } } };
                if (e.includes("'Upload videos'")) return { result: { value: { clicked: true } } };
                if (e.includes('return { clicked: false')) return { result: { value: { clicked: true, which: 'publish' } } };
                if (e.includes('return { confirmed: false }')) return { result: { value: { confirmed: true } } };
                if (e.includes('/watch?v=')) return { result: { value: { href: 'https://www.youtube.com/watch?v=ABC123', text: 'Published' } } };
                return { result: { value: true } };
            }
            if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
            if (method === 'DOM.querySelector') return { nodeId: 42 };
            if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
            return {};
        },
    };
}

await checkAsync('makeClient builds a CONNECTED client, not a WebSocket URL', async () => {
    let connected = false;
    const Fake = class {
        constructor(wsUrl) { this.wsUrl = wsUrl; }
        async connect() { connected = true; }
        async send() { return {}; }
    };
    const client = await makeClient('http://127.0.0.1:9447',
        async () => 'ws://127.0.0.1:9447/devtools/page/ABC', Fake);
    assert.strictEqual(typeof client.send, 'function',
        'the client is not usable — the WebSocket URL was used as the client');
    assert.strictEqual(connected, true, 'the client was never connected');
    assert.strictEqual(client.wsUrl, 'ws://127.0.0.1:9447/devtools/page/ABC');
});

await checkAsync('uploadToYouTube hands the video to the composer and publishes', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    const result = await uploadToYouTube(video, {
        title: 'Sainted Word - seemingly so',
        description: 'a description',
        tags: ['SaintedWordRecords', 'Ambient'],
    }, { client, sleep: async () => {}, visibility: 'public' });

    const setFiles = client.calls.find(c => c[0] === 'DOM.setFileInputFiles');
    assert.ok(setFiles, 'the video was never handed to the file input');
    assert.deepStrictEqual(setFiles[1], { objectId: 'file-input-1', files: [video] });

    assert.ok(client.calls.some(c => c[0] === 'Network.setCookies'), 'the cookies were never set');
    assert.ok(client.calls.some(c => c[0] === 'Page.navigate'), 'the browser was never navigated');
    assert.strictEqual(result.url, 'https://www.youtube.com/watch?v=ABC123');
    assert.strictEqual(result.visibilitySet, true, 'the visibility was not applied');
});

await checkAsync('uploadToYouTube opens the upload dialog before handing over the file', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    await uploadToYouTube(video, { title: 'T', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'public' });

    // The login check also mentions 'Upload videos', so the click is
    // matched by the code that actually clicks it.
    const click = client.calls.find(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes("label(e) === 'Upload videos'"));
    assert.ok(click, 'the Upload videos entry was never clicked');
    const files = client.calls.find(c => c[0] === 'DOM.setFileInputFiles');
    const clickAt = client.calls.indexOf(click);
    const filesAt = client.calls.indexOf(files);
    assert.ok(clickAt < filesAt, 'the file was handed over before the dialog was opened');
});

await checkAsync('uploadToYouTube tells the page the file arrived', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    await uploadToYouTube(video, { title: 'T', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'public' });
    const changed = client.calls.find(c => c[0] === 'Runtime.callFunctionOn');
    assert.ok(changed, 'no change event was dispatched — the upload would never start');
    assert.ok(changed[1].functionDeclaration.includes("new Event('change'"),
        'the dispatched event is not a change event');
});

await checkAsync('uploadToYouTube asks for the visibility it was told to apply', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    await uploadToYouTube(video, { title: 'T', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'unlisted' });
    const probe = client.calls.find(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes("return { state: 'radio' }"));
    assert.ok(probe, 'the visibility control was never probed');
    assert.ok(probe[1].expression.includes('"unlisted"'),
        'the visibility probe asked for the wrong value');
});

await checkAsync('uploadToYouTube writes the title into the page', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    await uploadToYouTube(video, { title: 'Sainted Word - seemingly so', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'public' });
    const title = client.calls.find(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes("i.name === 'title'"));
    assert.ok(title, 'the title field was never touched');
    assert.ok(title[1].expression.includes('Sainted Word - seemingly so'),
        'the title was not carried into the page');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})();
