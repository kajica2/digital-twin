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

const { parseVideoFile, generateMetadata, cdpDomains, waitForDocument, uploadToYouTube, makeClient, applyVideoDetails, resolveVideoId } = require('./youtube-poster.js');

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
function fakeClient(script, opts = {}) {
    const calls = [];
    let fileInputQueries = 0;
    // What was typed, so the read-back can report it — the same
    // round-trip the live page does.
    let typed = { title: '', description: '', tags: '' };
    // Which field was focused last — the text that comes next is
    // typed into that one.
    let focused = null;
    // The tags the box holds as chips.
    const chips = [...(opts.chips || [])];
    // What the visibility control currently reads, and what the tool
    // last picked from the menu.
    let visibility = opts.visibilityClass || 'icon-grey privacy-public-icon';
    let visibilityText = opts.visibilityText || 'Public';
    let picked = null;
    return {
        calls,
        typed,
        chips,
        async js(expression) {
            calls.push(['js', expression]);
            // The channel dashboard has no file input; opening the
            // upload dialog brings one. The first query says none.
            if (String(expression).includes('input[type=file]')) {
                return fileInputQueries++ === 0 ? 0 : 1;
            }
            if (String(expression).includes('/channel/')) return 'UCu7aEOKZg64T_uAmP9oCNgg';
            return 'complete';
        },
        async send(method, params) {
            calls.push([method, params]);
            if (script[method]) return script[method](params);
            if (method === 'Input.insertText') {
                const text = params.text || '';
                if (focused === 'tags') {
                    // The tag box is a chip editor: the text waits in
                    // the input until Enter commits it.
                    typed.tags = text;
                } else if (focused) {
                    typed[focused] = text;
                }
                return {};
            }
            if (method === 'Input.dispatchKeyEvent') {
                if (params.key === 'Enter' && focused === 'tags' && typed.tags) {
                    chips.push(typed.tags);
                    typed.tags = '';
                }
                return {};
            }
            if (method === 'Runtime.evaluate') {
                const e = params.expression || '';
                if (e.includes('Upload complete')) return { result: { value: { progress: 100, complete: true } } };
                if (e.includes('input[type="file"]')) return { result: { type: 'object', objectId: 'file-input-1' } };
                if (e.includes('a#video-title[href*="/video/"]')) {
                    return { result: { value: { found: true, id: 'pg1a94SI2rY', label: 'Sainted Word - seemingly so' } } };
                }
                if (e.includes('describes your video') || e.includes('tell viewers')) {
                    const which = e.includes('describes your video') ? 'title' : 'description';
                    if (e.includes('text: el ?')) {
                        return { result: { value: { text: typed[which] } } };
                    }
                    focused = which;
                    return { result: { value: { ok: true, before: '' } } };
                }
                if (e.includes('aria-label="Tags"')) {
                    if (e.includes('i.value')) return { result: { value: { value: typed.tags } } };
                    focused = 'tags';
                    return { result: { value: { ok: true } } };
                }
                if (e.includes('ytcp-chip')) {
                    return { result: { value: { chips: [...chips] } } };
                }
                if (e.includes('aria-disabled')) {
                    return { result: { value: { state: 'idle' } } };
                }
                if (e.includes('ytcp-video-metadata-visibility #container')) {
                    if (picked) {
                        visibility = `icon-grey privacy-${picked}-icon`;
                        visibilityText = picked;
                    }
                    return { result: { value: { cls: visibility, text: visibilityText } } };
                }
                if (e.includes('picked: true')) {
                    const m = e.match(/const wanted = "(\w+)"/);
                    if (m) picked = m[1];
                    return { result: { value: { picked: true } } };
                }
                if (e.includes('all changes saved')) return { result: { value: { saved: true } } };
                if (e.includes("label(e) === 'Upload videos'")) return { result: { value: { clicked: true } } };
                if (e.includes('select-button')) return { result: { value: { clicked: true } } };
                if (e.includes('ytcp-button#save')) return { result: { value: { clicked: true } } };
                if (e.includes('show more')) return { result: { value: { clicked: true } } };
                return { result: { value: true } };
            }
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

await checkAsync('uploadToYouTube hands the video over, then edits the video it uploaded', async () => {
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

    // The URL comes from the id the tool resolved in the channel
    // list — not from a watch link scraped off the page, which is
    // how this tool once reported somebody else's video.
    assert.strictEqual(result.videoId, 'pg1a94SI2rY');
    assert.strictEqual(result.url, 'https://www.youtube.com/watch?v=pg1a94SI2rY');
    assert.strictEqual(result.visibilitySet, true, 'the visibility was not applied');

    // The details were typed, not assigned.
    const typed = client.calls.filter(c => c[0] === 'Input.insertText').map(c => c[1].text);
    assert.ok(typed.includes('Sainted Word - seemingly so'), 'the title was never typed');
    assert.ok(typed.includes('a description'), 'the description was never typed');
    // Each tag is typed on its own and committed with Enter — the tag
    // box is a chip editor, and a comma-joined string never becomes
    // a chip.
    assert.ok(typed.includes('SaintedWordRecords'), 'the first tag was never typed');
    assert.ok(typed.includes('Ambient'), 'the last tag was never typed');
    const enters = client.calls.filter(c => c[0] === 'Input.dispatchKeyEvent' &&
        c[1].key === 'Enter' && c[1].type === 'rawKeyDown');
    assert.strictEqual(enters.length, 2, `each tag needs its own Enter (saw ${enters.length} for 2 tags)`);
    // The tags exist as chips, not as text waiting in the input.
    assert.deepStrictEqual(client.chips, ['SaintedWordRecords', 'Ambient'],
        'the tags were never committed as chips');

    // The edit page is where the details live.
    const navigations = client.calls.filter(c => c[0] === 'Page.navigate').map(c => c[1].url);
    assert.ok(navigations.some(u => /\/video\/pg1a94SI2rY\/edit/.test(u)),
        `the edit page was never opened (saw: ${JSON.stringify(navigations)})`);
});

await checkAsync('uploadToYouTube does not double the tags it already has', async () => {
    const video = makeVideo('seemingly-so.mp4');
    // The video already carries one of the tags.
    const client = fakeClient({}, { chips: ['SaintedWordRecords'] });
    await uploadToYouTube(video, {
        title: 'T', description: 'D', tags: ['SaintedWordRecords', 'Ambient'],
    }, { client, sleep: async () => {}, visibility: 'public' });
    const typed = client.calls.filter(c => c[0] === 'Input.insertText').map(c => c[1].text);
    assert.ok(!typed.includes('SaintedWordRecords'),
        'the tag that was already there was typed again');
    assert.ok(typed.includes('Ambient'), 'the missing tag was not typed');
    assert.deepStrictEqual(client.chips, ['SaintedWordRecords', 'Ambient'],
        'the tags were not left as they should be');
});

await checkAsync('resolveVideoId fails loudly when the video is not in the list', async () => {
    const client = fakeClient({
        'Runtime.evaluate': () => ({ result: { value: { found: false, seen: ['some other video'] } } }),
    });
    let message = '';
    try {
        await resolveVideoId(client, cdpDomains(client), { title: 'nope' });
    } catch (e) {
        message = e.message;
    }
    assert.ok(/not in the channel list/.test(message),
        `the failure was not explained (got: ${message})`);
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

await checkAsync('uploadToYouTube applies the visibility it was told to apply', async () => {
    const video = makeVideo('seemingly-so.mp4');
    // The video is private, and it has to be made unlisted.
    const client = fakeClient({}, {
        visibilityClass: 'icon-grey privacy-private-icon',
        visibilityText: 'Private',
    });
    const result = await uploadToYouTube(video, { title: 'T', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'unlisted' });

    // The menu was opened ...
    const opened = client.calls.some(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes('select-button'));
    assert.ok(opened, 'the visibility menu was never opened');
    // ... and the wanted value was picked out of it.
    const pick = client.calls.find(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes('picked: true'));
    assert.ok(pick, 'the visibility menu was never picked from');
    assert.ok(pick[1].expression.includes('"unlisted"'),
        'the visibility pick asked for the wrong value');
    // The control was read back, not assumed.
    assert.strictEqual(result.visibilitySet, true, 'the visibility was not applied');
});

await checkAsync('uploadToYouTube writes the title into the page', async () => {
    const video = makeVideo('seemingly-so.mp4');
    const client = fakeClient({});
    await uploadToYouTube(video, { title: 'Sainted Word - seemingly so', description: 'D', tags: [] },
        { client, sleep: async () => {}, visibility: 'public' });
    // The title is a contenteditable div, so it is TYPED into.
    const focus = client.calls.find(c => c[0] === 'Runtime.evaluate' &&
        (c[1].expression || '').includes('describes your video'));
    assert.ok(focus, 'the title field was never touched');
    const typed = client.calls.filter(c => c[0] === 'Input.insertText').map(c => c[1].text);
    assert.ok(typed.includes('Sainted Word - seemingly so'),
        `the title was not typed into the field (typed: ${JSON.stringify(typed)})`);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})();
