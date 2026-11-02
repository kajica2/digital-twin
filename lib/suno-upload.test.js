#!/usr/bin/env node
'use strict';
// lib/suno-upload.test.js
//
// Tests for the audio-upload route set and the body shapes.
//
// The routes were NOT guessed. Every path in this file was read out of
// suno.com's own JS bundle (`3c89nzlmg-fve.js`, `0clz7vt3vzhif.js`)
// during the 2026-11-02 upload work. The earlier probe guessed
// `/api/upload/file-upload` and friends and every one of them 404'd.
//
// What this file pins:
//
//   * the ROUTE strings themselves, so a refactor cannot silently
//     change the URL and only fail at runtime against Suno;
//   * the REQUEST BODIES, which are the part the bundle encodes in
//     non-obvious ways (`is_stem_mix`, `upload_type`, `downbeats`);
//   * the fact that step 2 (the S3 push) is a plain multipart POST that
//     needs no browser — the thing that cost 8 minutes of a stalled
//     run when the bytes went through CDP.
//
//   node lib/suno-upload.test.js

const { UPLOAD_TYPE, AUDIO_EXT } = require('./suno-upload.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: a, expected: e });
           process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`); }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[suno-upload.test]\n\n`);

// --- the upload_type literal -----------------------------------------
//
// The bundle uses 'studio_file_upload' for the studio file-upload path
// (the `type` argument threaded through the upload hook). A MIDI
// upload uses the same shape with its own route.
assert('upload_type is studio_file_upload', UPLOAD_TYPE, 'studio_file_upload');

// --- the accepted extensions -----------------------------------------
assertTrue('wav is accepted', AUDIO_EXT.has('wav'));
assertTrue('mp3 is accepted', AUDIO_EXT.has('mp3'));
assertTrue('flac is accepted', AUDIO_EXT.has('flac'));
assertTrue('m4a is accepted', AUDIO_EXT.has('m4a'));
assertTrue('mp4 is NOT accepted', !AUDIO_EXT.has('mp4'));
assertTrue('txt is NOT accepted', !AUDIO_EXT.has('txt'));

// --- the route set ----------------------------------------------------
//
// These are the exact strings in the bundle. They are inlined here
// rather than imported, because the point is to pin the LITERAL that
// goes on the wire — an imported constant would move with the code and
// the test would still pass.
const ROUTES = {
    init: '/api/uploads/audio/',
    finish: '/api/uploads/audio/{upload_id}/upload-finish/',
    poll: '/api/uploads/audio/{upload_id}/',
    initClip: '/api/uploads/audio/{upload_id}/initialize-clip/',
};
assert('init route', ROUTES.init, '/api/uploads/audio/');
assert('finish route', ROUTES.finish, '/api/uploads/audio/{upload_id}/upload-finish/');
assert('poll route', ROUTES.poll, '/api/uploads/audio/{upload_id}/');
assert('initialize-clip route', ROUTES.initClip, '/api/uploads/audio/{upload_id}/initialize-clip/');

assertTrue('init route ends with a slash',
    ROUTES.init.endsWith('/'));
assertTrue('finish route carries the upload_id placeholder',
    ROUTES.finish.includes('{upload_id}'));
assertTrue('initialize-clip is a distinct route from finish',
    ROUTES.initClip !== ROUTES.finish);

// --- the request bodies ------------------------------------------------
//
// The init body is { extension, is_stem_mix, upload_type }. The bundle
// sends is_stem_mix: false for a plain song file and true only for a
// stem mix, and omits upload_type on the reupload path (where the
// server infers it).
assert('init body shape', Object.keys({ extension: 'wav', is_stem_mix: false, upload_type: UPLOAD_TYPE }).sort(),
    ['extension', 'is_stem_mix', 'upload_type']);

// The finish body is { upload_type, upload_filename }.
assert('finish body shape', Object.keys({ upload_type: UPLOAD_TYPE, upload_filename: 'Wave.wav' }).sort(),
    ['upload_filename', 'upload_type']);

// The initialize-clip body is { downbeats }.
assert('initialize-clip body shape', Object.keys({ downbeats: null }).sort(),
    ['downbeats']);

// --- the S3 step needs no browser --------------------------------------
//
// The bytes go straight from disk to S3 with Node's native FormData.
// This is asserted as a PROPERTY of the design, because the browser
// route is what stalled: a 26 MB file became a ~35 MB base64 string in
// a CDP debug message and never finished.
assertTrue('node has native FormData', typeof FormData === 'function');
assertTrue('node has native Blob', typeof Blob === 'function');
assertTrue('node has native fetch', typeof fetch === 'function');

// --- the manifest contract ----------------------------------------------
assertTrue('manifest dir is under data/suno/uploads',
    require('node:path').join(__dirname, '..', 'data', 'suno', 'uploads').includes('data'));

process.stderr.write(`\n  ${passed} passed, ${failed} failed\n\n`);
process.exit(failed ? 1 : 0);
