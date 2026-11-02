#!/usr/bin/env node
// lib/log-rotate.test.js — the pure half of lib/log-rotate.js.
//
// No launchd, no shell, no network. A temp directory stands in for
// logs/.
//
// The defect this file exists for
// -------------------------------
// The shell version of the rotator RENAMED the live log before
// gzipping it. Every writer in this repo holds an O_APPEND descriptor
// bound to the INODE, so the rename orphaned the writer: it kept
// appending to the renamed inode forever and the fresh `<name>.log`
// came back empty.
//
// The first assertion below pins the fix: after a rotation the live
// file keeps its INODE. A rotator that renames would fail it, and so
// would a rotator that deleted-and-recreated the file — which is why
// the inode check is the contract and not "the file is empty".

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { rotateOne, rotateDir, appendDoneLine, stamp } = require('./log-rotate.js');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
        failures.push({ name, err });
        process.stdout.write(`FAIL ${name}\n`);
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-test-'));

function write(name, body) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, body);
    return p;
}

function gunzip(p) {
    return zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
}

// ---------------------------------------------------------------------------
// 1. the live file keeps its inode
// ---------------------------------------------------------------------------

check('a rotated log keeps its inode (the writer is not orphaned)', () => {
    const f = write('keeper.log', 'line one\nline two\n');
    const before = fs.statSync(f).ino;
    const res = rotateOne(f);
    assert.strictEqual(res.rotated, true);
    assert.strictEqual(fs.statSync(f).ino, before, 'the inode changed — writers are now orphaned');
});

check('the rotated file is emptied in place, not removed', () => {
    const f = write('emptied.log', 'aaaa\n');
    rotateOne(f);
    assert.ok(fs.existsSync(f), 'the live log was removed');
    assert.strictEqual(fs.statSync(f).size, 0, 'the live log was not truncated');
});

check('the content lands in <name>.log.1.gz', () => {
    const f = write('content.log', 'hello world\n');
    rotateOne(f);
    const gz = path.join(TMP, 'content.log.1.gz');
    assert.ok(fs.existsSync(gz), 'no .1.gz was written');
    assert.strictEqual(gunzip(gz), 'hello world\n');
});

// ---------------------------------------------------------------------------
// 2. the rotation window
// ---------------------------------------------------------------------------

check('the previous .1.gz is bumped to .2.gz', () => {
    const f = write('bump.log', 'first\n');
    rotateOne(f);
    write('bump.log', 'second\n');
    rotateOne(f);
    assert.strictEqual(gunzip(path.join(TMP, 'bump.log.2.gz')), 'first\n');
    assert.strictEqual(gunzip(path.join(TMP, 'bump.log.1.gz')), 'second\n');
});

check('generations past the window are purged', () => {
    const f = write('purge.log', 'gen\n');
    for (let i = 0; i < 9; i++) {
        write('purge.log', `gen ${i}\n`);
        rotateOne(f);
    }
    assert.ok(fs.existsSync(path.join(TMP, 'purge.log.7.gz')), 'the 7th generation is missing');
    assert.ok(!fs.existsSync(path.join(TMP, 'purge.log.8.gz')), 'the 8th generation was not purged');
});

check('the purge window is 7 by default', () => {
    assert.strictEqual(require('./log-rotate.js').KEEP, 7);
});

// ---------------------------------------------------------------------------
// 3. edge cases
// ---------------------------------------------------------------------------

check('an empty log is skipped, not rotated into an empty gz', () => {
    const f = write('empty.log', '');
    const res = rotateOne(f);
    assert.strictEqual(res.rotated, false);
    assert.ok(!fs.existsSync(path.join(TMP, 'empty.log.1.gz')), 'an empty .1.gz was written');
});

check('a missing file is reported, not thrown', () => {
    const res = rotateOne(path.join(TMP, 'nope.log'));
    assert.strictEqual(res.reason, 'missing');
    assert.strictEqual(res.rotated, false);
});

check('a directory is not rotated', () => {
    const d = path.join(TMP, 'adir.log');
    fs.mkdirSync(d, { recursive: true });
    const res = rotateOne(d);
    assert.strictEqual(res.reason, 'not-a-file');
});

// ---------------------------------------------------------------------------
// 4. the directory sweep
// ---------------------------------------------------------------------------

check('rotateDir touches only *.log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-dir-'));
    fs.writeFileSync(path.join(dir, 'a.log'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'c.log'), 'c\n');
    const summaries = rotateDir(dir);
    assert.strictEqual(summaries.length, 2, `expected 2 summaries, got ${summaries.length}`);
    assert.ok(fs.existsSync(path.join(dir, 'a.log.1.gz')));
    assert.ok(fs.existsSync(path.join(dir, 'c.log.1.gz')));
    assert.ok(!fs.existsSync(path.join(dir, 'b.txt.1.gz')), 'a non-.log file was rotated');
});

check('rotateDir on a missing directory returns nothing', () => {
    assert.strictEqual(rotateDir(path.join(TMP, 'no-such-dir')).length, 0);
});

// ---------------------------------------------------------------------------
// 5. the completion line
// ---------------------------------------------------------------------------

check('the completion line lands in log-rotate.log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-done-'));
    appendDoneLine(dir, new Date(2026, 10, 2, 3, 0, 0));
    const body = fs.readFileSync(path.join(dir, 'log-rotate.log'), 'utf8');
    assert.ok(body.includes('[log-rotate] done at 2026-11-02 03:00:00'), body);
});

check('the stamp is zero-padded local time', () => {
    assert.strictEqual(stamp(new Date(2026, 0, 5, 7, 8, 9)), '2026-01-05 07:08:09');
});

// ---------------------------------------------------------------------------
// 6. the shell version is not the only implementation any more
// ---------------------------------------------------------------------------

check('the shell rotator is still present but the node one is what launchd runs', () => {
    // bin/log-rotate.sh stays as the historical implementation; the
    // plist points at lib/log-rotate.js. This assertion exists so a
    // future cleanup removes one deliberately.
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'bin', 'log-rotate.sh')));
    assert.ok(fs.existsSync(path.join(__dirname, 'log-rotate.js')));
});

// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[log-rotate.test] passed: ${passed}, failed: ${failures.length}`);
if (failures.length) {
    for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
    process.exit(1);
}
