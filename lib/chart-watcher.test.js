#!/usr/bin/env node
// lib/chart-watcher.test.js
//
// Sprint 0.12 — test harness for the watcher's lockfile logic.
//
// Pure-Node, no deps. Sets WATCHER_TEST_DIR before requiring the
// watcher so all paths (INBOX, PROCESSED, LOG) point at a scratch
// directory. Drives listPending() directly — no polling, no
// mscore — and asserts the right files come back in each
// scenario.
//
// Run:
//   node lib/chart-watcher.test.js
//   npm run test:watcher      (after adding the script alias)
//
// Exit code 0 on all-green, 1 on any failure.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// Use a tmp dir for the whole test run so the watcher's INBOX
// + PROCESSED + LOG all live there. Random suffix avoids collisions
// with prior runs.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-watcher-test-'));
process.env.WATCHER_TEST_DIR = TEST_DIR;

const w = require('./chart-watcher.js');

// Set the export runner to a noop so tick() can exercise
// listPending() end-to-end without invoking mscore.
w.setRunExport(() => {});

// ---------- Test harness ----------
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed += 1;
        process.stderr.write(`  ✓ ${label}\n`);
    } else {
        failed += 1;
        failures.push({ label, actual, expected });
        process.stderr.write(`  ✗ ${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}\n`);
    }
}

function assertTrue(label, cond) {
    if (cond) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
    else      { failed += 1; failures.push({ label, actual: cond, expected: true });
                process.stderr.write(`  ✗ ${label} (expected true)\n`); }
}

function resetInbox() {
    // Clear INBOX and PROCESSED, keep the dirs themselves.
    for (const dir of [w.INBOX, w.PROCESSED]) {
        try {
            for (const e of fs.readdirSync(dir)) {
                try { fs.unlinkSync(path.join(dir, e)); } catch {}
            }
        } catch {}
    }
}

function touch(filePath, mtimeMs) {
    fs.writeFileSync(filePath, '<x/>');
    if (mtimeMs !== undefined) {
        const t = new Date(mtimeMs);
        fs.utimesSync(filePath, t, t);
    }
}

function lockFile(musicxmlPath, mtimeMs) {
    const lock = w.lockFor(musicxmlPath);
    fs.writeFileSync(lock, `${process.pid}\n`);
    if (mtimeMs !== undefined) {
        const t = new Date(mtimeMs);
        fs.utimesSync(lock, t, t);
    }
    return lock;
}

w.ensureDirs();

process.stderr.write(`\n[chart-watcher.test] test dir: ${TEST_DIR}\n\n`);

// ---------- Tests ----------

// 1. Empty inbox returns []
process.stderr.write(`1. empty inbox\n`);
resetInbox();
assert('listPending([]) when inbox empty', w.listPending(), []);

// 2. Single file, no lockfile → returned
process.stderr.write(`2. single file, no lockfile\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.musicxml'));
const got2 = w.listPending();
assert('length 1', got2.length, 1);
assert('basename', path.basename(got2[0]), 'a.musicxml');

// 3. File with active lockfile → skipped
process.stderr.write(`3. file with active lockfile\n`);
resetInbox();
touch(path.join(w.INBOX, 'locked.musicxml'));
lockFile(path.join(w.INBOX, 'locked.musicxml'));
assert('skipped', w.listPending(), []);

// 4. File with lockfile older than STALE_LOCK_MS → unblocked + lockfile removed
process.stderr.write(`4. file with stale lockfile (older than STALE_LOCK_MS)\n`);
resetInbox();
const staleLockPath = (() => {
    const f = path.join(w.INBOX, 'stale.musicxml');
    touch(f);
    const oldMtime = Date.now() - (10 * 60 * 1000); // 10 min ago
    return lockFile(f, oldMtime);
})();
const got4 = w.listPending();
assert('returned (stale lock removed)', got4.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(staleLockPath));

// 5. File replaced at same path (mtime newer than lockfile) → unblocked
process.stderr.write(`5. file replaced at same path (mtime newer than lockfile)\n`);
resetInbox();
const replacedPath = path.join(w.INBOX, 'replace.musicxml');
// First version (older)
touch(replacedPath, Date.now() - 30_000);
lockFile(replacedPath, Date.now() - 30_000);
// Second version (newer mtime, same path)
touch(replacedPath, Date.now());
const got5 = w.listPending();
assert('returned (replaced file)', got5.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(w.lockFor(replacedPath)));

// 6. Multiple files: some pending, some locked, some stale
process.stderr.write(`6. multiple files mixed states\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.musicxml'));
touch(path.join(w.INBOX, 'b.musicxml'));
lockFile(path.join(w.INBOX, 'b.musicxml')); // active lock (recent)
touch(path.join(w.INBOX, 'c.musicxml'));
lockFile(path.join(w.INBOX, 'c.musicxml'), Date.now() - (10 * 60 * 1000)); // stale-by-age
// 'd' simulates a file replaced at same path: original file old,
// lockfile from the old file, then NEW file newer than the lock.
const dPath = path.join(w.INBOX, 'd.musicxml');
touch(dPath, Date.now() - (10 * 60 * 1000));   // original (old)
lockFile(dPath, Date.now() - (10 * 60 * 1000)); // lock from old file
touch(dPath, Date.now());                       // replace with newer file
const got6 = w.listPending().map(p => path.basename(p));
assert('3 pending, sorted (a + stale-c + replaced-d)', got6, ['a.musicxml', 'c.musicxml', 'd.musicxml']);

// 7. Deterministic ordering (sorted)
process.stderr.write(`7. deterministic ordering\n`);
resetInbox();
touch(path.join(w.INBOX, 'z.musicxml'));
touch(path.join(w.INBOX, 'a.musicxml'));
touch(path.join(w.INBOX, 'm.musicxml'));
const got7 = w.listPending().map(p => path.basename(p));
assert('alphabetical', got7, ['a.musicxml', 'm.musicxml', 'z.musicxml']);

// 8. Non-musicxml files ignored
process.stderr.write(`8. non-musicxml files ignored\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.musicxml'));
touch(path.join(w.INBOX, 'b.txt'));
touch(path.join(w.INBOX, 'c.mxl'));      // compressed musicxml — also ignored
touch(path.join(w.INBOX, 'd.MusicXML')); // case-sensitive match
const got8 = w.listPending().map(p => path.basename(p));
assert('only .musicxml lower-case', got8, ['a.musicxml']);

// 9. lockFor is path-stable (same hash for same path)
process.stderr.write(`9. lockFor hash stability\n`);
assert('same hash for same path',
    w.lockFor('/foo/bar.musicxml'),
    w.lockFor('/foo/bar.musicxml'));
assertTrue('different hash for different path',
    w.lockFor('/foo/bar.musicxml') !== w.lockFor('/foo/baz.musicxml'));

// ---------- Summary ----------

process.stderr.write(`\n[chart-watcher.test] passed: ${passed}, failed: ${failed}\n`);

// Cleanup the scratch dir.
try {
    for (const e of fs.readdirSync(w.INBOX))    { try { fs.unlinkSync(path.join(w.INBOX, e)); } catch {} }
    for (const e of fs.readdirSync(w.PROCESSED)){ try { fs.unlinkSync(path.join(w.PROCESSED, e)); } catch {} }
    for (const e of fs.readdirSync(w.LOGDIR))   { try { fs.unlinkSync(path.join(w.LOGDIR, e)); } catch {} }
    fs.rmdirSync(w.INBOX);
    fs.rmdirSync(w.PROCESSED);
    fs.rmdirSync(w.LOGDIR);
    fs.rmdirSync(TEST_DIR);
} catch {}

process.exit(failed === 0 ? 0 : 1);