#!/usr/bin/env node
// lib/songs-watcher.test.js
//
// Sprint 0.13 — test harness for the songs-watcher's lockfile logic.
// Mirrors lib/chart-watcher.test.js pattern. Same conventions.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-watcher-test-'));
process.env.WATCHER_TEST_DIR = TEST_DIR;

const w = require('./songs-watcher.js');

// Noop the indexer so listPending tests don't run songs-indexer.js.
w.setRunIndexer(() => {});

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
    else    { failed += 1; failures.push({ label, actual, expected });
              process.stderr.write(`  ✗ ${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}\n`); }
}
function assertTrue(label, cond) {
    if (cond) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
    else      { failed += 1; process.stderr.write(`  ✗ ${label} (expected true)\n`); }
}
function resetInbox() {
    for (const dir of [w.INBOX, w.PROCESSED]) {
        try { for (const e of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, e)); } catch {} } } catch {}
    }
}
function touch(filePath, mtimeMs) {
    fs.writeFileSync(filePath, '<x/>');
    if (mtimeMs !== undefined) { const t = new Date(mtimeMs); fs.utimesSync(filePath, t, t); }
}
function lockFile(p, mtimeMs) {
    const lock = w.lockFor(p);
    fs.writeFileSync(lock, `${process.pid}\n`);
    if (mtimeMs !== undefined) { const t = new Date(mtimeMs); fs.utimesSync(lock, t, t); }
    return lock;
}

w.ensureDirs();
process.stderr.write(`\n[songs-watcher.test] test dir: ${TEST_DIR}\n\n`);

process.stderr.write(`1. empty inbox\n`);
resetInbox();
assert('listPending([]) when inbox empty', w.listPending(), []);

process.stderr.write(`2. supported extensions only\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp3'));
touch(path.join(w.INBOX, 'b.wav'));
touch(path.join(w.INBOX, 'c.m4a'));
touch(path.join(w.INBOX, 'd.txt'));
touch(path.join(w.INBOX, 'e.docx'));
const got2 = w.listPending().map(p => path.basename(p));
assert('audio files only, sorted', got2, ['a.mp3', 'b.wav', 'c.m4a']);

process.stderr.write(`3. case-insensitive extensions\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.MP3'));
touch(path.join(w.INBOX, 'b.WaV'));
const got3 = w.listPending().map(p => path.basename(p)).sort();
assert('MP3 + WAV both included', got3, ['a.MP3', 'b.WaV']);

process.stderr.write(`4. active lockfile blocks\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp3'));
lockFile(path.join(w.INBOX, 'a.mp3'));
assert('skipped', w.listPending(), []);

process.stderr.write(`5. stale lockfile unblocks (by age)\n`);
resetInbox();
const staleLock = (() => {
    const f = path.join(w.INBOX, 'stale.mp3');
    touch(f);
    return lockFile(f, Date.now() - (10 * 60 * 1000));
})();
const got5 = w.listPending();
assert('returned (stale lock removed)', got5.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(staleLock));

process.stderr.write(`6. stale lockfile unblocks (file replaced)\n`);
resetInbox();
const replacedPath = path.join(w.INBOX, 'replace.mp3');
touch(replacedPath, Date.now() - 30_000);
lockFile(replacedPath, Date.now() - 30_000);
touch(replacedPath, Date.now());
const got6 = w.listPending();
assert('returned (replaced)', got6.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(w.lockFor(replacedPath)));

process.stderr.write(`7. mixed states + sorted output\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp3'));
touch(path.join(w.INBOX, 'b.wav'));
lockFile(path.join(w.INBOX, 'b.wav'));
const cPath = path.join(w.INBOX, 'c.flac');
touch(cPath);
lockFile(cPath, Date.now() - (10 * 60 * 1000)); // stale
const got7 = w.listPending().map(p => path.basename(p));
assert('a + stale-c', got7, ['a.mp3', 'c.flac']);

process.stderr.write(`8. lockFor hash stability\n`);
assert('same hash', w.lockFor('/foo/bar.mp3'), w.lockFor('/foo/bar.mp3'));
assertTrue('diff hash', w.lockFor('/foo/bar.mp3') !== w.lockFor('/foo/baz.mp3'));

process.stderr.write(`\n[songs-watcher.test] passed: ${passed}, failed: ${failed}\n`);

try {
    for (const e of fs.readdirSync(w.INBOX))    { try { fs.unlinkSync(path.join(w.INBOX, e)); } catch {} }
    for (const e of fs.readdirSync(w.PROCESSED)){ try { fs.unlinkSync(path.join(w.PROCESSED, e)); } catch {} }
    for (const e of fs.readdirSync(w.LOGDIR))   { try { fs.unlinkSync(path.join(w.LOGDIR, e)); } catch {} }
    fs.rmdirSync(w.INBOX); fs.rmdirSync(w.PROCESSED); fs.rmdirSync(w.LOGDIR); fs.rmdirSync(TEST_DIR);
} catch {}

process.exit(failed === 0 ? 0 : 1);