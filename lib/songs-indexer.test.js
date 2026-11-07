#!/usr/bin/env node
'use strict';
// lib/songs-indexer.test.js
//
// The indexer's tag readers, on bytes rather than on files.
//
// The bug this exists for: an ID3v2 text frame is NUL-terminated inside
// the frame, and `String.trim()` does not remove a NUL — so every tag
// read from a file the splitter wrote ended in "\0" and the Songs panel
// showed "Track 3/29".

const assert = require('node:assert');
const { parseId3v2, readId3v1 } = require('./songs-indexer.js');

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

/** One ID3v2.3 text frame. */
function id3v2Frame(frameId, text) {
    const body = Buffer.concat([
        Buffer.from(frameId, 'latin1'),
        Buffer.from([0, 0, 0, 0]),      // size (patched below)
        Buffer.from([0, 0]),              // flags
        Buffer.from([0x03]),             // encoding: UTF-8
        Buffer.from(text, 'utf8'),
        Buffer.from([0x00]),             // the NUL terminator
    ]);
    body.writeUInt32BE(body.length - 10, 4);
    return body;
}

/** A minimal ID3v2.3 tag holding the given frames. */
function id3v2(...frames) {
    const body = Buffer.concat(frames.map(([id, text]) => id3v2Frame(id, text)));
    const header = Buffer.concat([
        Buffer.from('ID3', 'latin1'),
        Buffer.from([3, 0]),             // version 2.3
        Buffer.from([0]),                // flags
        Buffer.from([0, 0, 0, 0]),       // size (patched below)
    ]);
    header.writeUInt32BE(body.length, 6);
    return Buffer.concat([header, body]);
}

check('an ID3 title is read without its NUL terminator', () => {
    const buf = id3v2(['TIT2', 'Pleasant Wind']);
    const tags = parseId3v2(buf);
    assert.strictEqual(tags.title, 'Pleasant Wind');
    assert.ok(!tags.title.includes('\0'), 'the NUL must be gone');
});

check('every ID3 text frame is trimmed the same way', () => {
    const buf = id3v2(
        ['TIT2', 'Title'],
        ['TPE1', 'Artist'],
        ['TALB', 'Album'],
        ['TRCK', '3/29'],
    );
    const tags = parseId3v2(buf);
    assert.strictEqual(tags.title, 'Title');
    assert.strictEqual(tags.artist, 'Artist');
    assert.strictEqual(tags.album, 'Album');
    assert.strictEqual(tags.track, '3/29');
    for (const value of Object.values(tags)) {
        assert.ok(!String(value).includes('\0'), `a tag still carries a NUL: ${value}`);
    }
});

check('a non-Latin title survives the read', () => {
    const buf = id3v2(['TIT2', 'Традиционална музика']);
    const tags = parseId3v2(buf);
    assert.strictEqual(tags.title, 'Традиционална музика');
});

check('an ID3v1 tag is read without its NUL padding', () => {
    const tag = Buffer.alloc(128, 0);
    tag.write('TAG', 0, 'latin1');          // the magic
    tag.write('My Title', 3, 'latin1');
    tag.write('My Artist', 33, 'latin1');
    tag.write('My Album', 63, 'latin1');
    tag.write('2026', 93, 'latin1');
    const tags = readId3v1(tag);
    assert.strictEqual(tags.title, 'My Title');
    assert.strictEqual(tags.artist, 'My Artist');
    assert.strictEqual(tags.album, 'My Album');
    assert.strictEqual(tags.year, '2026');
});

check('an empty tag yields nothing rather than a NUL string', () => {
    const buf = id3v2(['TIT2', '']);
    const tags = parseId3v2(buf);
    assert.ok(!tags.title, `expected no title, got ${JSON.stringify(tags.title)}`);
});

console.log(`[songs-indexer.test] passed: ${passed}, failed: ${failed}`);
if (failed) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
