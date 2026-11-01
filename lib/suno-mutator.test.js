#!/usr/bin/env node
'use strict';
// lib/suno-mutator.test.js — the URL resolver and the variant composer,
// pure. No browser, no account, no credits.
//
// The mutator's contract: hand it a Suno URL, and it works out which clip
// that is, reads that clip's own settings, and produces custom VARIANTS
// of it — each one a different style applied to the same source audio.
//
//   node lib/suno-mutator.test.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
    parseSunoUrl,
    resolveShortLink,
    resolveClipId,
    clipSettings,
    buildVariants,
    buildCoverBody,
    buildStyleBody,
    buildManifest,
    variantTitle,
    parseMutations,
    withRetry,
    findExistingStyle,
    LIMITS,
} = require('./suno-mutator.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        console.log(`  ✗ ${label}`);
        console.log(`    expected: ${e}`);
        console.log(`    got:      ${a}`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else {
        failed++; failures.push({ label, actual: 'false', expected: 'true' });
        console.log(`  ✗ ${label}`);
    }
}

async function run() {
console.log('\n1. parseSunoUrl — the shapes a Suno link comes in');

// ------------------------------------------------------------------
// The URL forms the mutator must accept.
// ------------------------------------------------------------------
assert('a song page yields its id',
    parseSunoUrl('https://suno.com/song/1e67934d-489b-49a3-b83f-0792933d1d86'),
    { kind: 'song', clipId: '1e67934d-489b-49a3-b83f-0792933d1d86' });

assert('a /s/<id> share link yields its id',
    parseSunoUrl('https://suno.com/s/9f8e7d6c-5b4a-3928-1706-9a8b7c6d5e4f'),
    { kind: 'song', clipId: '9f8e7d6c-5b4a-3928-1706-9a8b7c6d5e4f' });

// A SHORT share link — /s/<slug> — has no uuid in it. MEASURED
// 2026-11-01: suno.com answers it with a 307 to /song/<uuid>?sh=<slug>.
// So it parses, but it needs a network resolve before the id is known.
assert('a short share link parses as needing a resolve',
    parseSunoUrl('https://suno.com/s/htrR5vlSCxATy77v'),
    { kind: 'short', clipId: null, slug: 'htrR5vlSCxATy77v' });

assert('a hook link yields its id',
    parseSunoUrl('https://suno.com/hook/4fa05b74-e3bd-4fc1-b6f0-479bc4f67cf4'),
    { kind: 'hook', clipId: '4fa05b74-e3bd-4fc1-b6f0-479bc4f67cf4' });

assert('a create page yields its workspace id',
    parseSunoUrl('https://suno.com/create?wid=3cb0ad67-8729-40ce-8fd4-fb60d0a05006'),
    { kind: 'workspace', clipId: '3cb0ad67-8729-40ce-8fd4-fb60d0a05006' });

assert('a bare clip id is accepted',
    parseSunoUrl('1e67934d-489b-49a3-b83f-0792933d1d86'),
    { kind: 'clip', clipId: '1e67934d-489b-49a3-b83f-0792933d1d86' });

assert('a trailing slash is fine',
    parseSunoUrl('https://suno.com/song/1e67934d-489b-49a3-b83f-0792933d1d86/'),
    { kind: 'song', clipId: '1e67934d-489b-49a3-b83f-0792933d1d86' });

assert('a query string on a song page is fine',
    parseSunoUrl('https://suno.com/song/1e67934d-489b-49a3-b83f-0792933d1d86?x=1'),
    { kind: 'song', clipId: '1e67934d-489b-49a3-b83f-0792933d1d86' });

assert('http is accepted as well as https',
    parseSunoUrl('http://suno.com/song/1e67934d-489b-49a3-b83f-0792933d1d86'),
    { kind: 'song', clipId: '1e67934d-489b-49a3-b83f-0792933d1d86' });

// The refusable shapes.
assert('a non-Suno URL is refused', parseSunoUrl('https://example.com/song/abc'), null);
assert('a Suno URL with no id is refused', parseSunoUrl('https://suno.com/explore'), null);
assert('an empty string is refused', parseSunoUrl(''), null);
assert('a non-string is refused', parseSunoUrl(null), null);
assert('a malformed id is refused',
    parseSunoUrl('https://suno.com/song/not-a-uuid'), null);
assertTrue('an id must be uuid-shaped',
    parseSunoUrl('https://suno.com/song/1234') === null);

// ------------------------------------------------------------------
// 2. resolveClipId — the URL may point at a clip that is a COVER of
// another clip. To mutate the SOURCE, the source has to be found.
// ------------------------------------------------------------------
console.log('\n2. resolveClipId — find the source clip behind a link');

const CLIP = {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    title: 'KAI BALKAN UNDERGROUND',
    metadata: {
        task: 'cover',
        cover_clip_id: 'bbbbbbbb-1111-2222-3333-444444444444',
        duration: 198.4,
        tags: 'Balkan brass, African polyrhythms, 105 BPM',
        model_name: 'chirp-hawk',
        is_max_mode: true,
        control_sliders: { audio_weight: 0.85, weirdness_constraint: 0, aug_creativity: 1 },
    },
};
const SOURCE = {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    title: 'Original Track',
    metadata: { task: 'generate', duration: 190.2, tags: 'Balkan brass, African polyrhythms' },
};

const resolved = await resolveClipId(CLIP, { getClip: async (id) => (id === SOURCE.id ? SOURCE : null) });
assert('the source clip id is found behind a cover', resolved.sourceClipId, SOURCE.id);
assert('the source title is carried', resolved.sourceTitle, 'Original Track');
assert('the linked clip is recorded', resolved.clipId, CLIP.id);
assert('the linked title is recorded', resolved.clipTitle, 'KAI BALKAN UNDERGROUND');

// ------------------------------------------------------------------
// 2b. resolveShortLink — a short /s/<slug> link carries no uuid.
//
// MEASURED 2026-11-01: suno.com answers it with a 307 to
// /song/<uuid>?sh=<slug>. So the resolve is a redirect-follow, and the
// uuid is read out of the final URL.
// ------------------------------------------------------------------
console.log('\n2b. resolveShortLink — a short share link needs the network');

const REDIRECT = 'https://suno.com/song/4fa05b74-e3bd-4fc1-b6f0-479bc4f67cf4?sh=htrR5vlSCxATy77v';
const resolvedShort = await resolveShortLink('htrR5vlSCxATy77v', {
    fetch: async () => ({ url: REDIRECT, ok: true }),
});
assert('the short link resolves to the clip id', resolvedShort, '4fa05b74-e3bd-4fc1-b6f0-479bc4f67cf4');

// A redirect that goes nowhere useful must be refused, not guessed.
const badRedirect = await resolveShortLink('htrR5vlSCxATy77v', {
    fetch: async () => ({ url: 'https://suno.com/explore', ok: true }),
});
assert('a redirect with no clip id is refused', badRedirect, null);

// A network failure must be refused, not thrown.
const netFail = await resolveShortLink('htrR5vlSCxATy77v', {
    fetch: async () => { throw new Error('network down'); },
});
assert('a network failure is refused', netFail, null);

// `follow: false` mutates the LINKED clip instead of the one it was
// made from. MEASURED 2026-11-01: on the artist's own chain the two
// carry DIFFERENT lyrics and DIFFERENT tags, so this is a real choice.
const noFollow = await resolveClipId(CLIP, { getClip: async () => SOURCE, follow: false });
assert('without following, the linked clip is the target', noFollow.sourceClipId, CLIP.id);
assert('without following, the linked title is kept', noFollow.sourceTitle, 'KAI BALKAN UNDERGROUND');
assert('the cover id is still recorded', noFollow.coverClipId, SOURCE.id);

const notACover = await resolveClipId(SOURCE, { getClip: async () => null });
assert('a plain generation is its own source', notACover.sourceClipId, SOURCE.id);
assertTrue('a plain generation carries no cover id',
    notACover.coverClipId === null || notACover.coverClipId === undefined);

// ------------------------------------------------------------------
// 3. clipSettings — what to carry into a variant.
// ------------------------------------------------------------------
console.log('\n3. clipSettings — the settings a variant inherits');

// The REAL shape of a clip record, as the live account returned it
// (MEASURED 2026-11-01). The model lives at the clip's TOP LEVEL, not
// in `metadata` — `metadata.model_name` is undefined and
// `metadata.major_model_version` is undefined, while the clip itself
// carries `model_name: "chirp-hawk"` and `major_model_version:
// "Custom"`.
const REAL_CLIP = {
    id: '1443a36e-116f-4d6d-8c97-09f4a5dc3041',
    title: 'Serbian Byzantine Choir M',
    model_name: 'chirp-hawk',
    major_model_version: 'Custom',
    metadata: {
        task: 'vox_cover',
        type: 'gen',
        duration: 172,
        cover_clip_id: '475942eb-5c81-4310-ab13-ed28e0f55dcb',
        tags: 'Dark jazz electronica, organic broken beat',
        control_sliders: { audio_weight: 0.75, aug_creativity: 2 },
        model_badges: { songcard: { display_name: 'CUSTOM' } },
    },
};

const real = clipSettings(REAL_CLIP);
assert('the model comes from the clip TOP level', real.mv, 'chirp-hawk');
assert('a 172s source is not capped to 60s', real.duration, 172);
assert('the source duration is recorded', real.sourceDuration, 172);
assert('the influence is carried', real.influence, 0.75);

// A clip whose model only exists in metadata still resolves.
assert('a metadata model is used when the top level has none',
    clipSettings({ metadata: { model_name: 'v5' } }).mv, 'v5');

// A CUSTOM clip (no named model) must NOT get a named model forced on
// it — the account's own custom model is what it should keep.
assert('a custom clip with no model name keeps the default',
    clipSettings({ major_model_version: 'Custom' }).mv, 'chirp-hawk');

const settings = clipSettings(CLIP);
assert('the model is carried', settings.mv, 'chirp-hawk');
assert('the duration is a whole number of seconds', settings.duration, 198);
assert('the descriptor is carried', settings.descriptor, 'Balkan brass, African polyrhythms, 105 BPM');
assert('the influence is carried', settings.influence, 0.85);
assert('max mode is recorded', settings.isMaxMode, true);
assert('the source duration is recorded', settings.sourceDuration, 198.4);

// A clip with nothing usable must not produce NaN.
const bare = clipSettings({ id: 'x', metadata: {} });
assert('a bare clip gets the default duration', bare.duration, 198);
assert('a bare clip gets the default influence', bare.influence, 0.65);
assert('a bare clip has an empty descriptor', bare.descriptor, '');

// The influence must be clamped into the range the server accepts.
assert('an influence above 1 is clamped',
    clipSettings({ metadata: { control_sliders: { audio_weight: 1.7 } } }).influence, 1);
assert('a negative influence is clamped',
    clipSettings({ metadata: { control_sliders: { audio_weight: -0.4 } } }).influence, 0);
assert('a missing slider uses the default',
    clipSettings({ metadata: {} }).influence, 0.65);

// ------------------------------------------------------------------
// 4. buildVariants — the heart of it.
// ------------------------------------------------------------------
console.log('\n4. buildVariants — a custom style per variant');

const MUTATIONS = [
    { slug: 'dub', name: 'Dub', tags: 'dub techno, tape delay, submerged basslines', influence: 0.8 },
    { slug: 'orchestral', name: 'Orchestral', tags: 'symphonic orchestra, cinematic strings', influence: 0.6 },
];

// The PROMPT (the lyrics) travels with the variant. MEASURED
// 2026-11-01: the artist's clip carries its whole lyric sheet in
// `metadata.prompt`, in Suno's own bracketed form.
const LYRICS = '[Intro | 4/4 | instrumental, full band]\n'
    + '[Verse | 4/4 | alto female, soft]\nI keep the window open';
const withLyrics = clipSettings({ ...REAL_CLIP, metadata: { ...REAL_CLIP.metadata, prompt: LYRICS } });
assert('the prompt is carried', withLyrics.prompt, LYRICS);
assert('a clip with no prompt has none', clipSettings({ metadata: {} }).prompt, '');

const lyricVariants = buildVariants({ settings: withLyrics, mutations: MUTATIONS, songTitle: 'S' });
assert('every variant carries the lyrics', lyricVariants[0].prompt, LYRICS);

const lyricBody = buildCoverBody({
    variant: lyricVariants[0], sourceClipId: SOURCE.id, sourceDuration: 190.2,
});
assert('the cover body carries the lyrics, not the instrumental marker',
    lyricBody.prompt, LYRICS);
assertTrue('the instrumental marker is NOT forced onto a song with words',
    !lyricBody.prompt.includes('[Instrumental]'));

// An instrumental source (no prompt) still gets the marker.
const instrBody = buildCoverBody({
    variant: buildVariants({ settings: clipSettings({ metadata: {} }), mutations: MUTATIONS, songTitle: 'S' })[0],
    sourceClipId: SOURCE.id, sourceDuration: 190.2,
});
assert('an instrumental source keeps the marker', instrBody.prompt, '[Instrumental]');


const variants = buildVariants({
    settings,
    mutations: MUTATIONS,
    songTitle: 'KAI BALKAN UNDERGROUND',
});
assert('one variant per mutation', variants.length, 2);
assert('the first variant is the first mutation', variants[0].slug, 'dub');
assert('the variant names its mutation', variants[0].name, 'Dub');
assert('the variant carries the influence', variants[0].influence, 0.8);
assertTrue('the variant has tags', variants[0].tags.length > 0);

// The composer must PRESERVE the source descriptor. That is the rule the
// repo already established for Suno styles (lib/suno-styles.js): the
// directive gives way, the descriptor does not.
assertTrue('the source descriptor survives in the variant tags',
    variants[0].tags.includes('Balkan brass'));
assertTrue('the mutation is in the variant tags',
    variants[0].tags.includes('dub techno'));
assertTrue('the tags are within the server limit',
    variants[0].tags.length <= LIMITS.tags);
assertTrue('the title is within the server limit',
    variants[0].title.length <= LIMITS.title);

// A long descriptor plus a long mutation must still fit: the descriptor
// wins, and the mutation is trimmed.
const longSettings = clipSettings({
    metadata: { tags: 'x'.repeat(900), duration: 198, control_sliders: { audio_weight: 0.8 } },
});
const longVariants = buildVariants({ settings: longSettings, mutations: MUTATIONS, songTitle: 'T' });
assertTrue('an over-long composition is trimmed to the limit',
    longVariants[0].tags.length <= LIMITS.tags);
assertTrue('the descriptor is what survives the trim',
    longVariants[0].tags.startsWith('x'.repeat(100)));

// The titles must be distinct, or two variants are indistinguishable in
// the studio's library.
assertTrue('the variant titles are distinct',
    variants[0].title !== variants[1].title);
assertTrue('the title names the mutation',
    variants[0].title.includes('Dub'));

// ------------------------------------------------------------------
// 5. buildCoverBody — the request that makes the variant.
// ------------------------------------------------------------------
console.log('\n5. buildCoverBody — the request shape');

const body = buildCoverBody({
    variant: variants[0],
    sourceClipId: SOURCE.id,
    sourceDuration: 190.2,
});
assert('it is a cover', body.task, 'cover');
assert('it covers the source', body.cover_clip_id, SOURCE.id);
assert('it covers the whole source', body.cover_start_s, 0);
assert('the cover end is the source length', body.cover_end_s, 190.2);
assert('the title is the variant title', body.title, variants[0].title);
assert('the tags are the variant tags', body.tags, variants[0].tags);
assert('the model is carried', body.mv, 'chirp-hawk');
assert('the duration is a whole number', body.duration, 198);
assert('the influence is the variant influence', body.metadata.control_sliders.audio_weight, 0.8);
assert('the transaction id is unique per call', typeof body.transaction_uuid, 'string');
assertTrue('two bodies have different transaction ids',
    buildCoverBody({ variant: variants[0], sourceClipId: SOURCE.id, sourceDuration: 190.2 })
        .transaction_uuid !== body.transaction_uuid);

// ------------------------------------------------------------------
// 6. buildStyleBody — the SAVED style, for the studio's own picker.
// ------------------------------------------------------------------
console.log('\n6. buildStyleBody — the saved style');

const styleBody = buildStyleBody({ variant: variants[0] });
assert('a saved style has no id (it is new)', styleBody.id, null);
assert('the style title is the variant title', styleBody.title, variants[0].title);
assert('the style tags are the variant tags', styleBody.tags, variants[0].tags);
assertTrue('the style tags are within the limit', styleBody.tags.length <= LIMITS.tags);

// ------------------------------------------------------------------
// 7. buildManifest — the record of the run.
// ------------------------------------------------------------------
console.log('\n7. buildManifest');

const manifest = buildManifest({
    source: resolved,
    settings,
    variants,
    mutations: MUTATIONS,
});
assert('the manifest records the source clip', manifest.source.clipId, SOURCE.id);
assert('the manifest records the linked clip', manifest.source.linkClipId, CLIP.id);
assert('the manifest records the source title', manifest.source.title, 'Original Track');
assert('the manifest records the variants', manifest.variants.length, 2);
assertTrue('the manifest has a generatedAt', !!manifest.generatedAt);
assertTrue('the manifest carries the settings', manifest.settings.mv === 'chirp-hawk');
assertTrue('the manifest carries no secrets', !JSON.stringify(manifest).includes('Bearer '));

// The manifest must be JSON-serialisable without throwing.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-mutator-'));
const file = path.join(tmp, 'm.json');
fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
assertTrue('the manifest writes and reads back',
    JSON.parse(fs.readFileSync(file, 'utf8')).variants.length === 2);
fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------------------
// 8. variantTitle — the naming rule.
// ------------------------------------------------------------------
console.log('\n8. variantTitle');
assert('the title names the song and the variant',
    variantTitle('KAI BALKAN UNDERGROUND', 'Dub'), 'KAI BALKAN UNDERGROUND - Dub');
assert('a long title is trimmed to the limit',
    variantTitle('x'.repeat(200), 'Dub').length <= LIMITS.title, true);
assertTrue('the mutation name survives the trim',
    variantTitle('x'.repeat(200), 'Dub').includes('Dub'));

// ------------------------------------------------------------------
// 9. parseMutations — the command-line grammar.
//
// MEASURED 2026-11-01: the parser split on COMMA, so a style text that
// contains a comma ("symphonic strings, brass") was split into two
// mutations and the second one was named after the second half. The
// separator is a SEMICOLON; a comma belongs to the style text.
// ------------------------------------------------------------------
console.log('\n9. parseMutations');
const parsedOne = parseMutations('dub');
assert('a built-in name resolves to the library entry', parsedOne[0].tags, 'dub techno, tape delay, submerged basslines, cavernous reverb');
assert('the built-in influence comes with it', parsedOne[0].influence, 0.75);
assert('a built-in keeps its display name', parsedOne[0].name, 'Dub');

const parsedTwo = parseMutations('orchestral:0.6:symphonic strings, brass');
assert('a comma in the style does NOT split the mutation', parsedTwo.length, 1);
assert('the whole style text survives', parsedTwo[0].tags, 'symphonic strings, brass');
assert('the influence is read', parsedTwo[0].influence, 0.6);
// "orchestral" is a built-in name, so it keeps the library's display
// name even though the style text is overridden.
assert('a built-in name keeps its display name', parsedTwo[0].name, 'Orchestral');
assert('the slug is still the built-in one', parsedTwo[0].slug, 'orchestral');

const parsedThree = parseMutations('dub;orchestral:0.6:symphonic strings, brass');
assert('a semicolon separates mutations', parsedThree.length, 2);
assert('the first is the built-in', parsedThree[0].slug, 'dub');
assert('the second keeps its comma', parsedThree[1].tags, 'symphonic strings, brass');

const parsedFour = parseMutations('lofi:soft tape hiss');
assert('a name and a style, no influence', parsedFour[0].tags, 'soft tape hiss');
assert('the influence defaults', parsedFour[0].influence, 0.7);

// A non-numeric second field is a STYLE, not an influence.
const parsedFive = parseMutations('weird:glitchy broken signal');
assert('a non-numeric second field is a style', parsedFive[0].tags, 'glitchy broken signal');
assert('the influence still defaults', parsedFive[0].influence, 0.7);

assert('an empty spec yields nothing', parseMutations(''), []);
assert('a slug is derived from the name', parseMutations('My Style:0.5:x')[0].slug, 'my-style');

// ------------------------------------------------------------------
// 10. withRetry — the studio API rate-limits.
//
// MEASURED 2026-11-01: a live run hit `429 {"status_code": 429,
// "detail": "Too many requests.", "error_type": "rate_limited",
// "retryable": true}` on a plain clip read, and the tool failed the
// whole run on it. The body says `retryable: true` — so the retry is
// not a guess, it is what the server asked for.
// ------------------------------------------------------------------
console.log('\n10. withRetry — the 429 the studio API really sends');

let calls = 0;
const ok = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Too many requests.'), { status: 429 });
    return 'done';
}, { attempts: 4, delayMs: 1 });
assert('a rate-limited call is retried', ok, 'done');
assert('it took three attempts', calls, 3);

let hardCalls = 0;
let hardErr = null;
try {
    await withRetry(async () => {
        hardCalls++;
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }, { attempts: 3, delayMs: 1 });
} catch (e) { hardErr = e; }
assert('a non-retryable error is NOT retried', hardCalls, 1);
assert('the error is re-thrown', hardErr && hardErr.status, 401);

let exhausted = 0;
let exhaustedErr = null;
try {
    await withRetry(async () => {
        exhausted++;
        throw Object.assign(new Error('Too many requests.'), { status: 429 });
    }, { attempts: 2, delayMs: 1 });
} catch (e) { exhaustedErr = e; }
assert('the attempts are bounded', exhausted, 2);
assert('the last error is reported', exhaustedErr && exhaustedErr.status, 429);

// A body-shaped error (the API's own JSON) must be recognised too.
let bodyCalls = 0;
const bodyOk = await withRetry(async () => {
    bodyCalls++;
    if (bodyCalls < 2) {
        const e = new Error('request failed');
        e.body = '{"status_code": 429, "detail": "Too many requests.", "error_type": "rate_limited", "retryable": true}';
        throw e;
    }
    return 'recovered';
}, { attempts: 3, delayMs: 1 });
assert('a body-shaped rate limit is retried', bodyOk, 'recovered');


// ------------------------------------------------------------------
// 11. findExistingStyle — a re-run must UPDATE, not duplicate.
//
// MEASURED 2026-11-01 (live, on the account): the mutator ran twice
// with the same six variant titles and the account ended up with TWELVE
// styles — six pairs sharing identical titles. The log said "style
// updated" both times.
//
// Root cause: the create call hardcoded `id: null`, which the server
// reads as "new" every time. The title lookup only fed the log message,
// so the word "updated" was printed while the write created a duplicate.
//
// These tests pin the lookup that decides which id to send.
// ------------------------------------------------------------------
console.log('\n11. findExistingStyle — a re-run updates, it does not duplicate');

const STYLE_SET = [
    { id: 'aacb6d95-1111-2222-3333-444455556666', title: 'Song - Dub', tags: 'old dub' },
    { id: 'bcdb34af-7777-8888-9999-000011112222', title: 'Song - Ambient', tags: 'old ambient' },
    { id: 'cccccccc-5555-6666-7777-888899990000', title: 'Something Else', tags: 'unrelated' },
];

const found = findExistingStyle(STYLE_SET, 'Song - Dub');
assert('an existing title is found', found && found.id, 'aacb6d95-1111-2222-3333-444455556666');

assert('a title that is not there is null', findExistingStyle(STYLE_SET, 'Song - Breaks'), null);
assert('an empty style list is null', findExistingStyle([], 'Song - Dub'), null);

// The title match is EXACT — two songs that share a prefix must not
// collide, or one song's variants would overwrite another's.
assert('the match is exact, not a prefix match',
    findExistingStyle(STYLE_SET, 'Song'), null);
assert('a longer title is not matched by a shorter one',
    findExistingStyle(STYLE_SET, 'Song - Dub Extended'), null);

// A style row with no title is skipped rather than matching everything.
assert('a style with no title does not match',
    findExistingStyle([{ id: 'x', title: '' }, { id: 'y' }], 'Song - Dub'), null);

console.log(`\n[suno-mutator.test] passed: ${passed}, failed: ${failed}`);
if (failed > 0) {
    for (const f of failures) console.log(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}`);
}
process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
