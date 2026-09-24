#!/usr/bin/env node
// lib/mj-watcher.test.js
//
// Test harness for the mj-watcher's lockfile logic.
// Mirrors lib/chart-watcher.test.js and lib/songs-watcher.test.js patterns.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-watcher-test-'));
process.env.WATCHER_TEST_DIR = TEST_DIR;

const w = require('./mj-watcher.js');

// Noop the submitter so listPending tests don't invoke CDP/Chrome.
w.setRunSubmit(() => {});

let passed = 0, failed = 0;
function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed += 1; process.stderr.write(`  ✓ ${label}\n`); }
    else    { failed += 1;
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
process.stderr.write(`\n[mj-watcher.test] test dir: ${TEST_DIR}\n\n`);

process.stderr.write('1. empty inbox\n');
resetInbox();
assert('listPending([]) when inbox empty', w.listPending(), []);

process.stderr.write('2. supported extensions only (.md)\n');
resetInbox();
touch(path.join(w.INBOX, 'a-prompt.md'));
touch(path.join(w.INBOX, 'b.txt'));
touch(path.join(w.INBOX, 'c.xml'));
touch(path.join(w.INBOX, 'd'));
const got2 = w.listPending().map(p => path.basename(p));
assert('.md files only, sorted', got2, ['a-prompt.md']);

process.stderr.write('3. case-insensitive extension\n');
resetInbox();
touch(path.join(w.INBOX, 'a.MD'));
touch(path.join(w.INBOX, 'b.Md'));
const got3 = w.listPending().map(p => path.basename(p)).sort();
assert('.MD + .Md included', got3, ['a.MD', 'b.Md']);

process.stderr.write('4. active lockfile blocks\n');
resetInbox();
touch(path.join(w.INBOX, 'a.md'));
lockFile(path.join(w.INBOX, 'a.md'));
assert('skipped', w.listPending(), []);

process.stderr.write('5. stale lockfile unblocks (by age)\n');
resetInbox();
const staleLock = (() => {
    const f = path.join(w.INBOX, 'stale.md');
    touch(f);
    return lockFile(f, Date.now() - (10 * 60 * 1000));
})();
const got5 = w.listPending();
assert('returned (stale lock removed)', got5.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(staleLock));

process.stderr.write('6. stale lockfile unblocks (file replaced)\n');
resetInbox();
const replacedPath = path.join(w.INBOX, 'replace.md');
touch(replacedPath, Date.now() - 30_000);
lockFile(replacedPath, Date.now() - 30_000);
touch(replacedPath, Date.now());
const got6 = w.listPending();
assert('returned (replaced)', got6.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(w.lockFor(replacedPath)));

process.stderr.write('7. mixed states + sorted output\n');
resetInbox();
touch(path.join(w.INBOX, 'a.md'));
touch(path.join(w.INBOX, 'b.md'));
lockFile(path.join(w.INBOX, 'b.md'));
const cPath = path.join(w.INBOX, 'c.md');
touch(cPath);
lockFile(cPath, Date.now() - (10 * 60 * 1000)); // stale
const got7 = w.listPending().map(p => path.basename(p));
assert('a + stale-c', got7, ['a.md', 'c.md']);

process.stderr.write('8. lockFor hash stability\n');
assert('same hash', w.lockFor('/foo/bar.md'), w.lockFor('/foo/bar.md'));
assertTrue('diff hash', w.lockFor('/foo/bar.md') !== w.lockFor('/foo/baz.md'));

process.stderr.write('9. submitOne happy path with noop runner\n');
resetInbox();
touch(path.join(w.INBOX, 'happy.md'));
// resetInbox doesn't re-create, and the noop submitter never fails
const result = w.submitOne(path.join(w.INBOX, 'happy.md'));
assertTrue('submitOne ok', result.ok);
assert('processed file exists', fs.existsSync(path.join(w.PROCESSED, 'happy.md')), true);
assertTrue('lockfile cleaned', !fs.existsSync(w.lockFor(path.join(w.INBOX, 'happy.md'))));

process.stderr.write('10. submitOne with failing submitter\n');
resetInbox();
let failCount = 0;
w.setRunSubmit(() => { failCount++; throw new Error('simulated failure'); });
touch(path.join(w.INBOX, 'failprompt.md'));
const failResult = w.submitOne(path.join(w.INBOX, 'failprompt.md'));
assertTrue('submitOne not ok', !failResult.ok);
assert('2 attempts made', failResult.attempts, 2);
assertTrue('file not moved', !fs.existsSync(path.join(w.PROCESSED, 'failprompt.md')));

// Restore noop runner
w.setRunSubmit(() => {});

// 11. Engine routing — the watcher must submit via the backend named
// in mj-config.json. A silent fallback would mean the user thinks
// they're on the web backend while Discord is still being driven.
process.stderr.write(`11. engine routing\n`);
const chosenEngine = w.configuredEngine();
assertTrue('configured engine is a known value',
    chosenEngine === 'web' || chosenEngine === 'discord');
assert('engine defaults to web', chosenEngine, 'web');

const webPath = w.submitterFor('web');
const discPath = w.submitterFor('discord');
assert('web engine maps to mj-web.js', path.basename(webPath), 'mj-web.js');
assert('discord engine maps to mj-submitter.js', path.basename(discPath), 'mj-submitter.js');
assertTrue('web backend exists on disk', fs.existsSync(webPath));
assertTrue('discord backend exists on disk', fs.existsSync(discPath));
assertTrue('unknown engine falls back to web',
    path.basename(w.submitterFor('nonsense')) === 'mj-web.js');

process.stderr.write(`\n[mj-watcher.test] passed: ${passed}, failed: ${failed}\n`);

try {
    for (const e of fs.readdirSync(w.INBOX))     { try { fs.unlinkSync(path.join(w.INBOX, e)); } catch {} }
    for (const e of fs.readdirSync(w.PROCESSED))  { try { fs.unlinkSync(path.join(w.PROCESSED, e)); } catch {} }
    for (const e of fs.readdirSync(w.LOGDIR))     { try { fs.unlinkSync(path.join(w.LOGDIR, e)); } catch {} }
    fs.rmdirSync(w.INBOX); fs.rmdirSync(w.PROCESSED); fs.rmdirSync(w.LOGDIR); fs.rmdirSync(TEST_DIR);
} catch {}

process.exit(failed === 0 ? 0 : 1);