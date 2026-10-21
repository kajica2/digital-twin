#!/usr/bin/env node
'use strict';
// lib/x-poster.test.js
//
// Tests for the X poster's pure parts — the parts that decide WHAT
// gets posted, before a browser is ever opened.
//
// The rule with teeth: X counts 280 WEIGHTED characters, and the
// engine's caption is 424 characters with a full tag set. Something
// has to be cut, and which thing gets cut is a publish decision, so
// it is pinned by a test rather than left to chance.
//
// The DOM half of the poster (the composer, the Post button, the
// file input) cannot be tested without a browser and a real session;
// those are exercised by the live smoke, not here.
//
//   node lib/x-poster.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const poster = require('./x-poster.js');
const xt = require('./x-text.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); return; }
    failed++;
    failures.push(label);
    process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    actual:   ${a}\n`);
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); return; }
    failed++;
    failures.push(label);
    process.stderr.write(`  ✗ ${label}\n`);
}

process.stderr.write(`\n[x-poster.test]\n\n`);

// ---------------------------------------------------------------------------
// 1. fitting the caption
// ---------------------------------------------------------------------------
process.stderr.write(`1. the caption\n`);

const LIVE = 'Neon Pulse — cover study. 5 seed variants of the same cover at 832×832, with the title set in layout rather than painted in.\n\n#neon #neonpulse #pulse #cover #jazz #modaljazz #ambient #soundcloud #bandcamp #spotify #vinyl #saxophone #trumpet #piano #improvisation #contrafact #same #title #rather #than #painted #weimarjazzdatabase #bebop #dorianmode #quartalvoicings #generativeart #diffusionmodels #midjourney #notanaiimage';

assertTrue('the live caption really is over the limit', xt.countLength(LIVE) > xt.MAX_LENGTH);

const FIT = poster.fitCaption(LIVE);
assertTrue('the fitted caption fits', xt.countLength(FIT.text) <= xt.MAX_LENGTH);
assertTrue('the body survives intact', FIT.body.startsWith('Neon Pulse — cover study.'));
assertTrue('some tags were dropped', FIT.dropped.length > 0);
assertTrue('some tags were kept', FIT.hashtags.length > 0);
assertTrue('the first tag survives', FIT.hashtags[0] === '#neon');
assertTrue('the body was not cut to make room for tags', !FIT.truncated);
assertTrue('fitting is idempotent', poster.fitCaption(FIT.text).text === FIT.text);

const SHORT = poster.fitCaption('A short one.\n\n#a #b');
assert('a caption that fits is untouched', SHORT.text, 'A short one.\n\n#a #b');
assert('nothing is dropped when it fits', SHORT.dropped, []);

const NOLEN = poster.fitCaption('');
assert('an empty caption stays empty', NOLEN.text, '');
assertTrue('an empty caption is still inside the limit', xt.countLength(NOLEN.text) <= xt.MAX_LENGTH);

// The weighted count is the part that can be wrong silently, so the
// cases that distinguish "one" from "two" are spelled out.
//
// These weights were MEASURED against X's own composer counter, not
// taken from documentation: at 270 ASCII characters the counter read
// "10", at 135 CJK characters it read "10" (so CJK weighs 2), at 135
// emoji it read "10" (so emoji weighs 2), and a 256-character prefix
// followed by an 80-character URL left the counter empty while one
// character less left "1" (so a URL weighs 23, whatever its length).
assert('latin counts one per character', xt.countLength('abc'), 3);
assert('a CJK character counts two', xt.countLength('漢'), 2);
assert('an emoji counts two', xt.countLength('🎺'), 2);
assert('a URL counts as 23 however long it is',
    xt.countLength('https://example.com/' + 'x'.repeat(80)), 23);
assert('the limit is 280', xt.MAX_LENGTH, 280);

// ---------------------------------------------------------------------------
// 2. choosing the media
// ---------------------------------------------------------------------------
process.stderr.write(`2. the media\n`);

const MEDIA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x-poster-media-'));
fs.writeFileSync(path.join(MEDIA_TMP, 'a.mp4'), 'x');
fs.writeFileSync(path.join(MEDIA_TMP, 'b.jpg'), 'x');
fs.writeFileSync(path.join(MEDIA_TMP, 'c.jpg'), 'x');
fs.writeFileSync(path.join(MEDIA_TMP, 'd.jpg'), 'x');
fs.writeFileSync(path.join(MEDIA_TMP, 'e.jpg'), 'x');
fs.writeFileSync(path.join(MEDIA_TMP, 'notes.txt'), 'x');

const WITH_VIDEO = poster.mediaInDir(MEDIA_TMP);
assert('a video wins', WITH_VIDEO.map(p => path.basename(p)), ['a.mp4']);

const IMAGE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x-poster-images-'));
for (const n of ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', 'notes.txt']) {
    fs.writeFileSync(path.join(IMAGE_TMP, n), 'x');
}
assert('images are capped at four',
    poster.mediaInDir(IMAGE_TMP).map(p => path.basename(p)), ['1.jpg', '2.jpg', '3.jpg', '4.jpg']);
assertTrue('a text file is not media', !poster.mediaInDir(IMAGE_TMP).some(p => p.endsWith('.txt')));
assert('a missing directory means no media', poster.mediaInDir(path.join(MEDIA_TMP, 'nope')), []);
assert('the cap is four', poster.MAX_MEDIA, 4);

fs.rmSync(MEDIA_TMP, { recursive: true, force: true });
fs.rmSync(IMAGE_TMP, { recursive: true, force: true });

// A media path that does not exist must be reported, not skipped.
//
// This is not hypothetical: a run with `--media /nope/nope.jpg` used
// to filter the path away and publish the caption with no picture —
// a DIFFERENT post than the one that was asked for, with nothing on
// the timeline to say so. It was found because a real tweet was
// published by accident and had to be deleted again.
const RESOLVE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x-resolve-'));
const REAL = path.join(RESOLVE_TMP, 'real.jpg');
fs.writeFileSync(REAL, 'x');

const RESOLVED = poster.resolveMedia([REAL, path.join(RESOLVE_TMP, 'gone.jpg')]);
assert('the media that exists is resolved', RESOLVED.media, [REAL]);
assert('the media that does not exist is reported', RESOLVED.missing, [path.join(RESOLVE_TMP, 'gone.jpg')]);
assertTrue('a missing file is never silently dropped',
    RESOLVED.media.length + RESOLVED.missing.length === 2);
assert('no media means nothing missing', poster.resolveMedia([]), { media: [], missing: [] });
assert('no paths means nothing missing', poster.resolveMedia(undefined), { media: [], missing: [] });

fs.rmSync(RESOLVE_TMP, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 3. reading a package
// ---------------------------------------------------------------------------
process.stderr.write(`3. the package\n`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x-poster-test-'));
const PKG_DIR = path.join(TMP, 'pkg');
fs.mkdirSync(PKG_DIR, { recursive: true });
fs.writeFileSync(path.join(PKG_DIR, 'post.json'), JSON.stringify({
    platforms: { twitter: { caption: 'The caption.\n\n#one' } },
    files: { video: '/somewhere/a.mp4' },
}, null, 2));
fs.writeFileSync(path.join(PKG_DIR, 'cover.jpg'), 'x');
fs.writeFileSync(path.join(PKG_DIR, 'note.txt'), 'x');

const READ = poster.readPackage(PKG_DIR);
assert('the caption is read from the package', READ.caption, 'The caption.\n\n#one');
assertTrue('the media comes from the package directory',
    READ.media.some(p => p.endsWith('cover.jpg')));
assertTrue('a text file is not media', !READ.media.some(p => p.endsWith('note.txt')));

let THREW = false;
try { poster.readPackage(path.join(TMP, 'nope')); } catch { THREW = true; }
assertTrue('a missing package is an error, not an empty post', THREW);

// The media the poster attaches must be the files the package holds,
// not absolute paths from the machine the package was built on.
assertTrue('the media is resolved inside the package directory',
    READ.media.every(p => p.startsWith(PKG_DIR)));

// ---------------------------------------------------------------------------
// 4. arguments
// ---------------------------------------------------------------------------
process.stderr.write(`4. arguments\n`);

const ARGS = poster.parseArgs(['--text', 'hello', '--media', '/a.jpg', '--dry-run']);
assert('the text is read', ARGS.text, 'hello');
assert('the media is read', ARGS.media, ['/a.jpg']);
assert('the dry-run flag is read', ARGS.dryRun, true);
assert('a bare argument is the directory', poster.parseArgs(['pkg-dir']).dir, 'pkg-dir');
assert('an unknown flag does not eat the next argument',
    poster.parseArgs(['--whatever', 'pkg-dir']).dir, 'pkg-dir');
assert('the cookie file is read', poster.parseArgs(['--cookies', '/c.txt']).cookies, '/c.txt');
assert('the port is read', poster.parseArgs(['--port', '1234']).port, '1234');

fs.rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 5. the embedded browser expressions
// ---------------------------------------------------------------------------
//
// The poster drives X's composer with JavaScript it embeds as template
// literals. A syntax error in one of those strings is invisible to
// every other test: the file parses, the module loads, the pure
// functions work — and the poster fails at runtime with a SyntaxError
// pointing at a line number that means nothing.
//
// That is not hypothetical. A missing quote in one expression
// (`querySelectorAll('[role="dialog"])` → `querySelectorAll('[role="dialog"])`)
// made the whole media path fail, and no other test noticed.
//
// So every expression the poster sends to the browser is parsed here.
// A parse failure is a test failure, with the offending line named.
// ---------------------------------------------------------------------------
process.stderr.write(`5. the embedded expressions\n`);

const POSTER_SRC = fs.readFileSync(path.join(__dirname, 'x-poster.js'), 'utf8');
const EXPRESSIONS = [...POSTER_SRC.matchAll(/`\(\(\) => \{[\s\S]*?\}\)\(\)`/g)].map(m => m[0]);

assertTrue('the poster has browser expressions to check', EXPRESSIONS.length >= 6);

let PARSE_FAILURES = 0;
for (const raw of EXPRESSIONS) {
    const body = raw.slice(1, -1);
    try {
        // eslint-disable-next-line no-new-func
        new Function(`return (${body});`);
    } catch (e) {
        PARSE_FAILURES++;
        process.stderr.write(`  ✗ an embedded expression does not parse: ${e.message}\n`);
        const line = body.split('\n').find(l => /[^\x00-\x7F]/.test(l) || /'\w[^']*[\])]/.test(l));
        if (line) process.stderr.write(`      suspect line: ${line.trim()}\n`);
    }
}
assert('every embedded expression parses', PARSE_FAILURES, 0);

process.stderr.write(`\n[x-poster.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f}\n`);
    process.exit(1);
}
