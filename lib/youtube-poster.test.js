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

const { parseVideoFile, generateMetadata } = require('./youtube-poster.js');

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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
