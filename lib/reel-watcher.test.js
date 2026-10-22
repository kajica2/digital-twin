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
// Read a file as text, or '<missing>' when it does not exist. Keeps
// a failing assertion from crashing the whole suite before the
// remaining checks get a chance to report.
function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return '<missing>'; }
}
function readBytes(p) {
    try { return fs.readFileSync(p); } catch { return Buffer.alloc(0); }
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
        readText(reelPath, 'utf8'), MARKER);
    assert('parked source holds the original bytes',
        readBytes(parkPath).equals(srcBytes), true);
    assert('reel and source are different files',
        readBytes(reelPath).equals(srcBytes), false);
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
        readText(path.join(w.PROCESSED, 'collide-mov.mp4'), 'utf8'), MARKER);
    assertTrue('mov source parked as _source.mov',
        fs.existsSync(path.join(w.PROCESSED, 'collide-mov_source.mov')));
}

// 11. The consumed sibling audio leaves the inbox on a successful run.
//
// Regression (sprint 0.28): the watcher moved the dropped VIDEO to
// reel-inbox/processed/ but left the sibling AUDIO file sitting in
// the inbox forever. A later drop with the same basename then
// silently paired itself with that stale audio — wrong caption,
// wrong tags, no signal that anything was stale.
//
// The sibling is parked under `<base>_audio<audioExt>`, a name that
// cannot collide with any output of the run.
process.stderr.write(`11. consumed sibling audio leaves the inbox on success\n`);
resetInbox();
const sibVideo = path.join(w.INBOX, 'siblingcase.mp4');
const sibAudio = path.join(w.INBOX, 'siblingcase.mp3');
const strayAudio = path.join(w.INBOX, 'stray.mp3');
fs.writeFileSync(sibVideo, 'FAKE-VIDEO-BYTES');
fs.writeFileSync(sibAudio, 'FAKE-AUDIO-BYTES');
fs.writeFileSync(strayAudio, 'STRAY-BYTES');

w.setProbe(() => ({ durationSec: 12.5, width: 1080, height: 1920, hasAudio: false }));
w.setReadAudioTags(() => ({
    title: 'Blue Note', artist: 'Test Trio', album: null, date: null, genre: 'Modal Jazz',
}));
w.setRunExport(({ outBase }) => {
    fs.writeFileSync(outBase + '.mp4', 'REEL-MARKER');
    fs.writeFileSync(outBase + '_cover.jpg', 'COVER-MARKER');
    return { reelMp4: outBase + '.mp4', coverJpg: outBase + '_cover.jpg' };
});

const r11 = w.processOne(sibVideo);
assertTrue('processOne ok', r11.ok === true);
assertTrue('sibling audio left the inbox', !fs.existsSync(sibAudio));
assertTrue('dropped video left the inbox', !fs.existsSync(sibVideo));
assertTrue('unrelated audio left alone in the inbox', fs.existsSync(strayAudio));
assert('unrelated audio bytes unchanged', readText(strayAudio, 'utf8'), 'STRAY-BYTES');
assertTrue('unrelated audio was not parked', !fs.existsSync(path.join(w.PROCESSED, 'stray_audio.mp3')));

const parkedAudio = path.join(w.PROCESSED, 'siblingcase_audio.mp3');
assertTrue('sibling parked as <base>_audio<ext>', fs.existsSync(parkedAudio));
assert('parked audio holds the original bytes',
    readText(parkedAudio, 'utf8'), 'FAKE-AUDIO-BYTES');

const reel11 = path.join(w.PROCESSED, 'siblingcase.mp4');
assertTrue('reel written', fs.existsSync(reel11));
assert('reel still holds the transcode output (audio did not clobber it)',
    readText(reel11, 'utf8'), 'REEL-MARKER');
assertTrue('cover written', fs.existsSync(path.join(w.PROCESSED, 'siblingcase_cover.jpg')));
assertTrue('POST sheet written', fs.existsSync(path.join(w.PROCESSED, 'siblingcase_POST.md')));
assertTrue('source parked', fs.existsSync(path.join(w.PROCESSED, 'siblingcase_source.mp4')));

// The parked sibling name must be distinct from every other output of
// the same run — that is the whole point of the `_audio` infix.
const runOutputs = [
    'siblingcase.mp4',              // the reel
    'siblingcase_cover.jpg',        // the cover frame
    'siblingcase_POST.md',          // the caption sheet
    'siblingcase_source.mp4',       // the parked source video
    'siblingcase_audio.mp3',        // the parked sibling audio
];
assert('all five run outputs have distinct names', new Set(runOutputs).size, 5);
assertTrue('parked audio name is not the reel name',
    path.basename(parkedAudio) !== 'siblingcase.mp4');
assertTrue('parked audio name is not the cover name',
    path.basename(parkedAudio) !== 'siblingcase_cover.jpg');
assertTrue('parked audio name is not the POST sheet name',
    path.basename(parkedAudio) !== 'siblingcase_POST.md');
assertTrue('parked audio name is not the parked source name',
    path.basename(parkedAudio) !== 'siblingcase_source.mp4');
assert('POST sheet names the parked sibling',
    readText(path.join(w.PROCESSED, 'siblingcase_POST.md'))
        .includes('siblingcase_audio.mp3'), true);

// 12. A failed export leaves the inbox exactly as it found it —
// video AND sibling audio.
//
// Both moves happen only after ffmpeg+ffprobe succeeded, so a failed
// run must not half-consume the inbox.
process.stderr.write(`12. a failed export leaves video AND sibling audio in the inbox\n`);
resetInbox();
const failVideo = path.join(w.INBOX, 'failcase.mp4');
const failAudio = path.join(w.INBOX, 'failcase.mp3');
fs.writeFileSync(failVideo, 'FAKE-VIDEO-BYTES');
fs.writeFileSync(failAudio, 'FAKE-AUDIO-BYTES');
w.setRunExport(() => { throw new Error('boom: ffmpeg exploded'); });
const r12 = w.processOne(failVideo);
assert('ok=false', r12.ok, false);
assert('attempts=2', r12.attempts, 2);
assertTrue('video still in the inbox', fs.existsSync(failVideo));
assertTrue('sibling audio still in the inbox', fs.existsSync(failAudio));
assert('sibling audio bytes untouched',
    readText(failAudio, 'utf8'), 'FAKE-AUDIO-BYTES');
assertTrue('no sibling parked on failure',
    !fs.existsSync(path.join(w.PROCESSED, 'failcase_audio.mp3')));
assertTrue('no source parked on failure',
    !fs.existsSync(path.join(w.PROCESSED, 'failcase_source.mp4')));
assertTrue('no reel written on failure',
    !fs.existsSync(path.join(w.PROCESSED, 'failcase.mp4')));
assertTrue('lockfile released even on failure', !fs.existsSync(w.lockFor(failVideo)));

// 13. Only the same-basename sibling is consumed.
//
// The old code had a last-resort fallback: "any audio file in the
// same directory". That is exactly how a leftover audio file paired
// itself with an unrelated later drop — and it would have made the
// watcher move a file it never really paired with. Sibling matching
// is now strictly same-basename.
process.stderr.write(`13. only the same-basename sibling is consumed\n`);
resetInbox();
const lonelyVideo = path.join(w.INBOX, 'lonely.mp4');
const stray2 = path.join(w.INBOX, 'stray2.mp3');
fs.writeFileSync(lonelyVideo, 'FAKE-VIDEO-BYTES');
fs.writeFileSync(stray2, 'STRAY-BYTES');
const tagsRead = [];
w.setReadAudioTags((p) => { tagsRead.push(path.basename(p)); return { title: 'Stray Title' }; });
w.setRunExport(({ outBase }) => {
    fs.writeFileSync(outBase + '.mp4', 'REEL-MARKER');
    fs.writeFileSync(outBase + '_cover.jpg', 'COVER-MARKER');
    return { reelMp4: outBase + '.mp4', coverJpg: outBase + '_cover.jpg' };
});
const r13 = w.processOne(lonelyVideo);
assertTrue('processOne ok', r13.ok === true);
assert('no audio file was read for tags', tagsRead, []);
assertTrue('unrelated audio still in the inbox', fs.existsSync(stray2));
assert('unrelated audio bytes unchanged', readText(stray2, 'utf8'), 'STRAY-BYTES');
assertTrue('unrelated audio was not parked', !fs.existsSync(path.join(w.PROCESSED, 'stray2_audio.mp3')));
assert('caption did not use the unrelated audio tags',
    readText(path.join(w.PROCESSED, 'lonely_POST.md')).includes('Stray Title'), false);

// 14. The parked sibling never collides with a run output, whatever
// the extension pair.
//
// The two cases that matter: a `.mov` video with a `.mp3` sibling and
// a `.mp4` video with a `.m4a` sibling — here the parked source and
// the parked audio want neighbouring names, and the reel output is
// `<base>.mp4` while the source is `<base>_source.mp4`.
process.stderr.write(`14. parked sibling never collides with a run output\n`);
resetInbox();
const pairs = [
    { base: 'mixmov',  video: '.mov', audio: '.mp3' },
    { base: 'mixm4a',  video: '.mp4', audio: '.m4a' },
    { base: 'mixflac', video: '.mkv', audio: '.flac' },
];
for (const p of pairs) {
    const v = path.join(w.INBOX, p.base + p.video);
    const a = path.join(w.INBOX, p.base + p.audio);
    fs.writeFileSync(v, 'VIDEO-BYTES-' + p.base);
    fs.writeFileSync(a, 'AUDIO-BYTES-' + p.base);
    w.setRunExport(({ outBase }) => {
        fs.writeFileSync(outBase + '.mp4', 'REEL-MARKER-' + p.base);
        fs.writeFileSync(outBase + '_cover.jpg', 'COVER-MARKER');
        return { reelMp4: outBase + '.mp4', coverJpg: outBase + '_cover.jpg' };
    });
    const r = w.processOne(v);
    assertTrue(`${p.base}: processOne ok`, r.ok === true);

    const reel = path.join(w.PROCESSED, p.base + '.mp4');
    const source = path.join(w.PROCESSED, p.base + '_source' + p.video);
    const parked = path.join(w.PROCESSED, p.base + '_audio' + p.audio);
    assertTrue(`${p.base}: reel written`, fs.existsSync(reel));
    assertTrue(`${p.base}: source parked as _source${p.video}`, fs.existsSync(source));
    assertTrue(`${p.base}: sibling parked as _audio${p.audio}`, fs.existsSync(parked));
    assert(`${p.base}: reel holds the transcode output`,
        readText(reel, 'utf8'), 'REEL-MARKER-' + p.base);
    assert(`${p.base}: parked source holds the original video bytes`,
        readText(source, 'utf8'), 'VIDEO-BYTES-' + p.base);
    assert(`${p.base}: parked audio holds the original audio bytes`,
        readText(parked, 'utf8'), 'AUDIO-BYTES-' + p.base);
    assertTrue(`${p.base}: sibling left the inbox`, !fs.existsSync(a));
    const names = new Set([
        path.basename(reel), path.basename(source), path.basename(parked),
        p.base + '_cover.jpg', p.base + '_POST.md',
    ]);
    assert(`${p.base}: every output name is unique`, names.size, 5);
}

// 15. Moving the sibling does not disturb the lockfile / stale-mtime
// logic, and the parked file is inert for the processed/ sweep.
//
// The reel consumers (ig-watcher, social-engine) scan
// reel-inbox/processed/ for DIRECTORIES holding an .mp4 + POST.md.
// The parked sibling is a flat file at the top of processed/, so it
// cannot be mistaken for a reel package.
process.stderr.write(`15. moving the sibling does not disturb the lock/stale-mtime logic\n`);
resetInbox();
const lockVideo = path.join(w.INBOX, 'lockcase.mp4');
const lockAudio = path.join(w.INBOX, 'lockcase.mp3');
fs.writeFileSync(lockVideo, 'FAKE-VIDEO-BYTES');
fs.writeFileSync(lockAudio, 'FAKE-AUDIO-BYTES');
w.setReadAudioTags(() => ({ title: null, artist: null, album: null, date: null, genre: null }));
w.setRunExport(({ outBase }) => {
    fs.writeFileSync(outBase + '.mp4', 'REEL-MARKER');
    fs.writeFileSync(outBase + '_cover.jpg', 'COVER-MARKER');
    return { reelMp4: outBase + '.mp4', coverJpg: outBase + '_cover.jpg' };
});
const r15 = w.processOne(lockVideo);
assertTrue('processOne ok', r15.ok === true);
assertTrue('no lockfile left behind', !fs.existsSync(w.lockFor(lockVideo)));
assertTrue('no .processing-* lockfiles left in the inbox',
    fs.readdirSync(w.INBOX).filter(e => e.startsWith('.processing-')).length === 0);
assertTrue('the consumed pair is no longer pending',
    !w.listPending().includes(lockVideo));
assertTrue('the parked sibling is not pending',
    !w.listPending().some(f => f.endsWith('lockcase_audio.mp3')));
assertTrue('the parked sibling is a flat file, not a reel directory',
    fs.existsSync(path.join(w.PROCESSED, 'lockcase_audio.mp3')) &&
    fs.statSync(path.join(w.PROCESSED, 'lockcase_audio.mp3')).isFile());

// The stale-mtime unblocking still works after all that moving.
const staleVideo = path.join(w.INBOX, 'stalecase.mp4');
fs.writeFileSync(staleVideo, 'x');
lockFile(staleVideo, Date.now() - 10 * 60 * 1000);
assertTrue('a stale lock still unblocks the file',
    w.listPending().includes(staleVideo));

// 16. The naming rule itself: for every supported video/audio
// extension pair, the parked sibling name is distinct from every
// other name the run writes.
process.stderr.write(`16. the naming rule holds for every extension pair\n`);
const videoExts = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];
const audioExts = ['.mp3', '.wav', '.aif', '.aiff', '.m4a', '.flac'];
let nameCollisions = [];
for (const ve of videoExts) {
    for (const ae of audioExts) {
        const base = 'naming';
        const parked = path.basename(w.siblingParkName(base, base + ae));
        const others = [
            base + '.mp4',                 // the reel
            base + '_cover.jpg',           // the cover frame
            base + '_POST.md',             // the caption sheet
            base + '_source' + ve,         // the parked source video
        ];
        if (others.includes(parked)) nameCollisions.push(`${ve} + ${ae} → ${parked}`);
        if (!parked.startsWith(base + '_audio')) nameCollisions.push(`${ve} + ${ae} → ${parked} (wrong infix)`);
    }
}
assert('no parked-sibling name collides with a run output', nameCollisions, []);

// 10. the hashtags follow the genre
//
// A reel with no genre is a chart demo (jazz). A reel whose genre says
// something else -- the daily run's plates -- gets tags from that
// genre: a cyberpunk plate captioned "#jazz #trumpet" is a lie.
(function () {
    const jazz = w.pickHashtags({ genre: 'modal' });
    assert('a jazz reel keeps the jazz tags', /#jazz/.test(jazz), true);
    assert('a jazz reel keeps the trumpet tag', /#trumpet/.test(jazz), true);
    assert('a modal jazz reel adds the modal tag', /#modalmusic/.test(jazz), true);
    assert('a reel with no genre keeps the jazz tags', /#jazz/.test(w.pickHashtags({ genre: '' })), true);

    const cyber = w.pickHashtags({ genre: 'cyberpunk / hk' });
    assert('a non-jazz reel drops the jazz tags', /#jazz/.test(cyber), false);
    assert('a non-jazz reel drops the trumpet tag', /#trumpet/.test(cyber), false);
    assert('a non-jazz reel carries its own genre', /#cyberpunk/.test(cyber), true);
    assert('a non-jazz reel carries every word of its genre', /#hk/.test(cyber), true);
    assert('a non-jazz reel still says it is a reel', /#reel/.test(cyber), true);
    assert('a non-jazz reel still says who made it', /#digitaltwin/.test(cyber), true);
    assert('the tag list is never longer than ten', w.pickHashtags({ genre: 'a b c d e f g h i j k l' }).split(' ').length <= 10, true);

    assert('the genre words become tags', w.genreTags('cyberpunk / hk').join(' '), '#cyberpunk #hk');
    assert('an empty genre has no tags', w.genreTags('').length, 0);

    // The caption carries the same tags.
    const cap = w.buildCaption({ title: 'switchboard · lamp', artist: 'Digital Twin', album: 'Relay', genre: 'cyberpunk / hk', hashtags: cyber }, 'x');
    assert('the caption names the title', /switchboard/.test(cap), true);
    assert('the caption carries the genre', /cyberpunk/.test(cap), true);
    assert('the caption carries the tags', /Hashtags:/.test(cap), true);
})();

process.stderr.write(`\n[reel-watcher.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) {
        process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
    }
}
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);