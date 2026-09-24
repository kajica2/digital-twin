#!/usr/bin/env node
// lib/reel-watcher.test.js
//
// Sprint 0.17 — test harness for reel-watcher's lockfile + listPending
// logic. Mirrors lib/songs-watcher.test.js / lib/chart-watcher.test.js
// exactly:
//
//   * WATCHER_TEST_DIR points the watcher at a scratch dir so no real
//     files in reel-inbox/ are touched.
//   * setRunExport() noops ffmpeg invocation so tests don't actually
//     transcode (the ffmpeg path is exercised by the manual smoke
//     test documented in AGENTS.md).
//   * Plain `.js` file invoked via `node`, no test framework.
//
// Coverage:
//   1. empty inbox → no pending
//   2. supported video extensions only (.mp4, .mov, .m4v, .mkv, .webm)
//   3. case-insensitive extensions
//   4. active lockfile blocks
//   5. stale lockfile unblocks (by age)
//   6. stale lockfile unblocks (file replaced at same path)
//   7. mixed states + sorted output
//   8. lockFor hash stability (same path → same hash, diff path → diff hash)
//   9. SUPPORTED_EXTS matches real IG-friendly inputs

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-watcher-test-'));
process.env.WATCHER_TEST_DIR = TEST_DIR;

const w = require('./reel-watcher.js');

// Noop the transcode/cover path so listPending tests don't run ffmpeg.
w.setRunExport(({ outBase }) => {
    fs.writeFileSync(outBase + '.mp4', 'fake-mp4');
    fs.writeFileSync(outBase + '_cover.jpg', 'fake-jpg');
    fs.writeFileSync(outBase + '_POST.md', '# fake\n');
    return { reelMp4: outBase + '.mp4', coverJpg: outBase + '_cover.jpg' };
});

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
        passed++;
        process.stderr.write(`  ✓ ${label}\n`);
    } else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else      { failed++; failures.push({ label, actual: 'false', expected: 'true' });
                process.stderr.write(`  ✗ ${label}\n`); }
}
function resetInbox() {
    for (const e of fs.readdirSync(w.INBOX)) {
        if (e === '.gitkeep') continue;
        try { fs.unlinkSync(path.join(w.INBOX, e)); } catch {}
    }
}
function touch(filePath, mtimeMs) {
    fs.writeFileSync(filePath, 'x');
    if (mtimeMs != null) {
        const t = mtimeMs;
        fs.utimesSync(filePath, t / 1000, t / 1000);
    }
}
function lockFile(p, mtimeMs) {
    const lock = w.lockFor(p);
    fs.writeFileSync(lock, '0 1970-01-01T00:00:00Z\n');
    if (mtimeMs != null) {
        fs.utimesSync(lock, mtimeMs / 1000, mtimeMs / 1000);
    }
    return lock;
}

w.ensureDirs();
process.stderr.write(`\n[reel-watcher.test] test dir: ${TEST_DIR}\n\n`);

process.stderr.write(`1. empty inbox\n`);
resetInbox();
assert('listPending([]) when inbox empty', w.listPending(), []);

process.stderr.write(`2. supported extensions only\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp4'));
touch(path.join(w.INBOX, 'b.mov'));
touch(path.join(w.INBOX, 'c.m4v'));
touch(path.join(w.INBOX, 'd.txt'));
touch(path.join(w.INBOX, 'e.docx'));
const got2 = w.listPending().map(p => path.basename(p));
assert('video files only, sorted', got2, ['a.mp4', 'b.mov', 'c.m4v']);

process.stderr.write(`3. case-insensitive extensions\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.MP4'));
touch(path.join(w.INBOX, 'b.MoV'));
touch(path.join(w.INBOX, 'c.MKV'));
const got3 = w.listPending().map(p => path.basename(p)).sort();
assert('MP4 + MOV + MKV all included', got3, ['a.MP4', 'b.MoV', 'c.MKV']);

process.stderr.write(`4. active lockfile blocks\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp4'));
lockFile(path.join(w.INBOX, 'a.mp4'));
assert('skipped', w.listPending(), []);

process.stderr.write(`5. stale lockfile unblocks (by age)\n`);
resetInbox();
const staleLock = (() => {
    const p = path.join(w.INBOX, 'stale.mp4');
    touch(p);
    return lockFile(p, Date.now() - (10 * 60 * 1000));
})();
const got5 = w.listPending();
assert('returned (stale lock removed)', got5.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(staleLock));

process.stderr.write(`6. stale lockfile unblocks (file replaced)\n`);
resetInbox();
const replacedPath = path.join(w.INBOX, 'replace.mp4');
touch(replacedPath, Date.now() - 30_000);
lockFile(replacedPath, Date.now() - 30_000);
touch(replacedPath, Date.now());
const got6 = w.listPending();
assert('returned (replaced)', got6.length, 1);
assertTrue('lockfile unlinked', !fs.existsSync(w.lockFor(replacedPath)));

process.stderr.write(`7. mixed states + sorted output\n`);
resetInbox();
touch(path.join(w.INBOX, 'a.mp4'));
touch(path.join(w.INBOX, 'b.mov'));
lockFile(path.join(w.INBOX, 'b.mov'));
const cPath = path.join(w.INBOX, 'c.mkv');
touch(cPath);
lockFile(cPath, Date.now() - (10 * 60 * 1000)); // stale
const got7 = w.listPending().map(p => path.basename(p));
assert('a + stale-c', got7, ['a.mp4', 'c.mkv']);

process.stderr.write(`8. lockFor hash stability\n`);
assert('same hash', w.lockFor('/foo/bar.mp4'), w.lockFor('/foo/bar.mp4'));
assertTrue('diff hash', w.lockFor('/foo/bar.mp4') !== w.lockFor('/foo/baz.mp4'));
// Cross-watcher namespace isolation — the reel-watcher's lockFor must
// ever collide with the songs-watcher's.
const songsLock = require('crypto').createHash('sha1')
    .update('songs-watcher:').update('/foo/bar.mp4').digest('hex').slice(0, 12);
assertTrue('namespace-isolated from songs-watcher',
    !w.lockFor('/foo/bar.mp4').endsWith('.processing-' + songsLock));

process.stderr.write(`9. SUPPORTED_EXTS covers IG-friendly inputs\n`);
const expected = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];
for (const ext of expected) {
    assertTrue(`supports ${ext}`, w.SUPPORTED_EXTS.includes(ext));
}

// 10. The transcode output must survive the input move.
//
// Regression: the watcher parks the dropped source in processed/ after
// exporting. It used to park it as `<base><ext>`, which for an .mp4
// drop is exactly the reel output path `<base>.mp4` — so the move
// overwrote the transcoded reel with the original and shipped an
// un-transcoded 16:9 file labelled as the Reel. Only source
// extensions that differed from .mp4 avoided it, which is why a .mov
// smoke test passed.
//
// This test drives the real processOne (so the real move runs) with a
// mocked export that writes a marker, then asserts the marker survived
// and the source landed somewhere else.
process.stderr.write(`10. transcode output survives the input move\n`);
const { execFileSync } = require('node:child_process');
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
    .find(p => fs.existsSync(p));
if (!ffmpeg) {
    process.stderr.write(`  – skipped: no ffmpeg\n`);
} else {
    resetInbox();
    // A real, tiny .mp4 — the real probe() inspects it.
    const src = path.join(w.INBOX, 'collide.mp4');
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1', src], { stdio: 'ignore' });
    const srcBytes = fs.readFileSync(src);

    const MARKER = 'MARKER: this is the transcoded reel, not the source';
    w.setRunExport(({ outBase }) => {
        const reelMp4 = outBase + '.mp4';
        const coverJpg = outBase + '_cover.jpg';
        fs.writeFileSync(reelMp4, MARKER);
        fs.writeFileSync(coverJpg, 'jpg');
        return { reelMp4, coverJpg };
    });

    const res = w.processOne(src);
    assertTrue('processOne ok', res.ok === true);

    const reelPath = path.join(w.PROCESSED, 'collide.mp4');
    const parkPath = path.join(w.PROCESSED, 'collide_source.mp4');
    assertTrue('reel output exists', fs.existsSync(reelPath));
    assertTrue('source parked under a distinct name', fs.existsSync(parkPath));
    assert('reel still holds the transcode output (not clobbered)',
        fs.readFileSync(reelPath, 'utf8'), MARKER);
    assert('parked source holds the original bytes',
        fs.readFileSync(parkPath).equals(srcBytes), true);
    assert('reel and source are different files',
        fs.readFileSync(reelPath).equals(srcBytes), false);
    assertTrue('input removed from the inbox', !fs.existsSync(src));
    assertTrue('lockfile cleaned',
        !fs.existsSync(w.lockFor(src)));

    // Also cover a non-.mp4 source (the case the old bug hid behind).
    const srcMov = path.join(w.INBOX, 'collide-mov.mov');
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
        '-c:v', 'mpeg4', '-t', '1', srcMov], { stdio: 'ignore' });
    const res2 = w.processOne(srcMov);
    assertTrue('mov source ok', res2.ok === true);
    assert('mov reel holds the transcode output',
        fs.readFileSync(path.join(w.PROCESSED, 'collide-mov.mp4'), 'utf8'), MARKER);
    assertTrue('mov source parked as _source.mov',
        fs.existsSync(path.join(w.PROCESSED, 'collide-mov_source.mov')));
}

process.stderr.write(`\n[reel-watcher.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) {
        process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
}
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);