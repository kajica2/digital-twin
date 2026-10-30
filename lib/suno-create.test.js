#!/usr/bin/env node
'use strict';
// lib/suno-create.test.js — the request body and the tag normalisation,
// pure. No browser, no account, no credits.

const fs = require('node:fs');
const path = require('node:path');

const { buildBody, normalizeNegatives, slug, clipVerdict, INSTRUMENTAL_MARKER } = require('./suno-create.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e && e.message ? e.message : e}`);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
}

console.log('\n1. normalizeNegatives — Suno wants phrases, the brief writes nouns');
check('bare nouns become "no X"', () => {
    assertEqual(normalizeNegatives('vocals, pop, EDM'), 'no vocals, no pop, no EDM');
});
check('an existing "no X" is left alone', () => {
    assertEqual(normalizeNegatives('no vocals, no pop'), 'no vocals, no pop');
});
check('the non-breaking hyphen is stripped', () => {
    assertEqual(normalizeNegatives('‑vocals'), 'no vocals');
});
check('a hyphenated word is not turned into "no -word"', () => {
    assertEqual(normalizeNegatives('-polished orchestral brass'), 'no polished orchestral brass');
});
check('an empty list stays empty', () => {
    assertEqual(normalizeNegatives(''), '');
    assertEqual(normalizeNegatives(undefined), '');
});
check('multi-word negatives keep every word', () => {
    assertEqual(normalizeNegatives('no polished orchestral brass, no synthetic horns'),
        'no polished orchestral brass, no synthetic horns');
});

console.log('\n2. buildBody — the shape the studio API validates');
const body = buildBody({
    tags: 'Balkan brass meets dark spiritual jazz',
    negativeTags: 'no vocals, no pop',
    title: 'Florada e Cinzas',
    duration: 198,
});

check('it is a text generation', () => {
    assertEqual(body.generation_type, 'TEXT');
});
check('the task is a generation, not a cover', () => {
    // 'create' is not an accepted literal — the API's 422 lists them all
    // and 'generate' is the one for "make me a song from this text".
    assertEqual(body.task, 'generate');
});
check('instrumental is on and the prompt is the marker', () => {
    assertEqual(body.make_instrumental, true);
    assertEqual(body.prompt, INSTRUMENTAL_MARKER);
});
check('the style brief rides in tags', () => {
    assertEqual(body.tags, 'Balkan brass meets dark spiritual jazz');
});
check('the negatives ride in their own field', () => {
    assertEqual(body.negative_tags, 'no vocals, no pop');
});
check('the duration is a whole number of seconds', () => {
    assert(Number.isInteger(body.duration) && body.duration > 0, 'duration is not a positive integer');
});
check('the title is capped at 100 characters', () => {
    assert(buildBody({ title: 'x'.repeat(200) }).title.length === 100);
});
check('the tags are capped at 1000 characters', () => {
    assert(buildBody({ tags: 'y'.repeat(2000) }).tags.length === 1000);
});
check('each request carries its own transaction id', () => {
    const a = buildBody({ tags: 't' }).transaction_uuid;
    const b = buildBody({ tags: 't' }).transaction_uuid;
    assert(typeof a === 'string' && a.length > 10, 'no transaction uuid');
    assert(a !== b, 'two requests share a transaction id');
});
check('max mode and the control sliders are set', () => {
    assertEqual(body.metadata.is_max_mode, true);
    assertEqual(body.duration, 198, 'a max-mode request asks for the full length');
    assert(typeof body.metadata.control_sliders.audio_weight === 'number');
});
check('a vocal request keeps its own prompt', () => {
    const v = buildBody({ tags: 't', instrumental: false, prompt: 'a lyric line' });
    assertEqual(v.make_instrumental, false);
    assertEqual(v.prompt, 'a lyric line');
});

console.log('\n2b. duration and max mode are one decision');
check('a short request is simple mode and is capped at 60 seconds', () => {
    const short = buildBody({ tags: 't', duration: 60 });
    assertEqual(short.metadata.is_max_mode, false);
    assertEqual(short.duration, 60);
});
check('a short request is never sent as max mode', () => {
    // The measured failure: is_max_mode true with a 60 s duration produced
    // a clip whose error_type was "invalid_generation_request".
    const short = buildBody({ tags: 't', duration: 60 });
    assert(short.metadata.is_max_mode !== true, 'a 60 s request was sent in max mode');
});
check('a long request is max mode at the full length', () => {
    const long = buildBody({ tags: 't', duration: 240 });
    assertEqual(long.metadata.is_max_mode, true);
    assertEqual(long.duration, 198);
});

console.log('\n3. slug — a filename that is safe on every filesystem');
check('titles become kebab case', () => {
    assertEqual(slug('Florada e Cinzas'), 'florada-e-cinzas');
});
check('punctuation cannot escape the name', () => {
    assert(/^[a-z0-9-]+$/.test(slug('../../etc/passwd')), 'slug kept path characters');
});
check('an empty title still yields a name', () => {
    assert(slug('!!!').length > 0);
});

console.log('\n4. clipVerdict — a submitted clip is not a made track');
check('a clip that errored with a forbidden audio URL names the account', () => {
    const v = clipVerdict({
        status: 'error',
        error_type: 'invalid_generation_request',
        audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    }, 7);
    assert(!v.ok, 'the verdict must not call a refused generation ok');
    assertEqual(v.status, 'error');
    assert(/account refused/.test(v.reason), 'the reason names the account: ' + v.reason);
    assert(/7 credit/.test(v.reason), 'the reason carries the balance: ' + v.reason);
});
check('a clip that failed for another reason says so', () => {
    const v = clipVerdict({ status: 'error', error_type: 'invalid_generation_request' }, 400);
    assert(!v.ok);
    assert(/invalid_generation_request/.test(v.reason), v.reason);
});
check('a rendering clip is ok', () => {
    assert(clipVerdict({ status: 'complete' }, 400).ok);
    assert(clipVerdict({ status: 'streaming' }, 400).ok);
    assert(clipVerdict({ status: 'submitted' }, 400).ok);
});
check('a missing clip is not ok', () => {
    const v = clipVerdict(null, 400);
    assert(!v.ok);
    assertEqual(v.status, 'missing');
});
check('an unknown state is not ok', () => {
    const v = clipVerdict({ status: 'weird' }, 400);
    assert(!v.ok);
    assert(/unexpected state/.test(v.reason), v.reason);
});

console.log(`\n[suno-create.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed ? 1 : 0);
