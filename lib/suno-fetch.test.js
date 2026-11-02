#!/usr/bin/env node
'use strict';
// lib/suno-fetch.test.js — finding a clip's real audio URL.
//
// MEASURED 2026-11-02 (live, on the account): a clip's `audio_url` is
// `https://studio-api.prod.suno.com/api/forbidden` — a PLACEHOLDER,
// not a refusal. The clip that was made on 2026-10-30 carries it too,
// and that one has real audio.
//
// The real address is in `media_urls`: an array of
// `{ url, content_type, delivery, encoding }`, and the URL is a
// CloudFront `.m4a` (AES256 at rest — the browser decrypts it, so a
// plain curl gets bytes that ffprobe cannot read).
//
// The old lookup only looked at `audio_url` / `song_url` / `stream_url`
// and skipped `/api/forbidden`, so it found NOTHING for these clips.
//
//   node lib/suno-fetch.test.js

const { audioUrlOf } = require('./suno-fetch.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}

process.stderr.write('1. audioUrlOf — the placeholder is not an address\n');

// The shape measured on the live clip.
const LIVE = {
    status: 'complete',
    title: 'Serbian Byzantine Choir M - Dub',
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [{
        url: 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/6b348a64-5b55-4418-9706-32b1d0563281.m4a',
        content_type: 'm4a-opus',
        delivery: 'progressive',
        encoding: '1.0.0',
    }],
};

assert('the real address is found in media_urls',
    audioUrlOf(LIVE),
    'https://d2lwuy8qc234o3.cloudfront.net/1/clip/6b348a64-5b55-4418-9706-32b1d0563281.m4a');

// The placeholder alone is not an address.
assert('a placeholder-only clip has no address',
    audioUrlOf({ audio_url: 'https://studio-api.prod.suno.com/api/forbidden' }), null);

// An ordinary clip still works.
assert('a plain audio_url still wins',
    audioUrlOf({ audio_url: 'https://cdn.example.com/a.mp3' }), 'https://cdn.example.com/a.mp3');

// media_urls with several entries: the first AUDIO one wins, not the
// first one (a video entry would be useless).
const MIXED = {
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [
        { url: 'https://cdn.example.com/clip.mp4', content_type: 'video/mp4' },
        { url: 'https://cdn.example.com/clip.m4a', content_type: 'm4a-opus' },
    ],
};
assert('the first AUDIO entry wins', audioUrlOf(MIXED), 'https://cdn.example.com/clip.m4a');

// A media_urls entry with no url is skipped, not returned.
assert('an entry with no url is skipped',
    audioUrlOf({ media_urls: [{ content_type: 'm4a-opus' }, { url: 'https://cdn.example.com/x.m4a' }] }),
    'https://cdn.example.com/x.m4a');

// A null clip is null.
assert('a missing clip is null', audioUrlOf(null), null);

// The placeholder is skipped even when it is the only candidate.
assert('the placeholder is never returned',
    audioUrlOf({ audio_url: 'https://x/api/forbidden', song_url: 'https://y/api/forbidden' }), null);

process.stderr.write(`\n[suno-fetch.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
