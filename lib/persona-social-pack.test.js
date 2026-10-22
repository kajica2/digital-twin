// lib/persona-social-pack.test.js — unit suite for the persona social pack.
//
// No network to the outside world and no credentials: the Gemini call
// is exercised against a local stub HTTP server through the base-URL
// override, and the key is a fake string that never leaves the box.
//
// The load-bearing test here is toIgPostMd: its output is read back by
// lib/ig-poster.js's readCaption(), which is not exported. So the exact
// parse loop is replicated below and the generated file is asserted
// against it. If ig-poster's parser changes, this suite has to change
// with it — that is the point.

'use strict';

const http = require('node:http');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const psp = require('./persona-social-pack.js');

let passed = 0;
let failed = 0;
// The helper awaits, so an async check body is actually covered: a
// rejected assertion is caught here and counted as a failure. Without
// the await a failing async check would print "ok" and escape as an
// unhandled rejection, taking the rest of the suite with it.
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (err) {
        failed++;
        console.log('FAIL  ' + name);
        console.log('      ' + (err && err.message ? err.message : String(err)));
    }
}

console.log('persona-social-pack');

// ---------------------------------------------------------------------------
// a replica of lib/ig-poster.js readCaption()
//
// Copied verbatim from lib/ig-poster.js:94-127. The behaviour it encodes:
//   - title   = the first '# ' heading
//   - '## '   = a section heading; inNext is on when the heading says Next
//   - the first NON-EMPTY line after '## Next' BREAKS the loop, so
//     nothing after it is part of the body
//   - hashtags are matched over the WHOLE file, not just the body
// ---------------------------------------------------------------------------
function readCaption(content) {
    const lines = content.split('\n');
    let title = '';
    let body = [];
    let inNext = false;

    for (const line of lines) {
        if (line.startsWith('# ') && !title) {
            title = line.slice(2).trim();
        } else if (line.startsWith('## ')) {
            inNext = line.includes('Next');
        } else if (inNext && line.trim()) {
            // Skip the manual instructions
            break;
        } else if (!inNext && title && line.trim()) {
            body.push(line);
        }
    }

    const hashtagRegex = /#[a-zA-Z0-9_]+/g;
    const hashtags = (content.match(hashtagRegex) || []).join(' ');

    const text = body.length > 0 ? body.join('\n').trim() : title;
    return { text, hashtags };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RAW_PERSONA = {
    personaName: 'The Minimalist Home Decorator',
    description: 'Focuses on clean lines, neutral palettes, and decluttered living spaces.',
    primarySet: ['homedecor', '#minimalism', '#interiordesign', '#decor', '#home', '#minimalism'],
    secondarySet: ['#minimalisthome', '#scandidecor', '#neutraldecor', '#simpleliving', '#modernhome', '#interiorstyling', '#beigedecor'],
    nicheSet: ['#japandi', '#minimaldecor', '#whiteinteriors', '#declutteryourlife', '#hyggehome', '#organicmodern', '#slowliving', '#neutralaesthetic'],
    youtube: {
        title: '5 Minutes of Japandi Calm',
        description: 'A slow pass through a neutral living room.',
        tags: ['#homedecor', '#minimalism', '#japandi'],
    },
    social: {
        instagram: { caption: 'One surface. One decision. Less, but better.' },
        tiktok: { caption: 'POV: you cleared one shelf and the whole room changed.' },
        twitter: { caption: 'A quiet room is a loud idea.' },
        facebook: { caption: 'I spent the weekend removing things and the room finally breathes.' },
    },
};

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            server.url = 'http://127.0.0.1:' + server.address().port;
            resolve(server);
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// Every check is awaited, so the whole suite runs inside one async
// function. A sync check body is fine here — awaiting a non-promise is
// a no-op — but an async one has to be awaited or its failure escapes.
(async () => {

// ---------------------------------------------------------------------------
// the prompts
// ---------------------------------------------------------------------------

await check('the base prompt carries the URL', () => {
    const p = psp.buildPrompt('https://example.com/personas');
    assert.ok(p.includes('https://example.com/personas'));
});

await check('the base prompt states the three tier sizes', () => {
    const p = psp.buildPrompt('https://example.com');
    assert.ok(/5-7/.test(p), 'primary size missing');
    assert.ok(/7-10/.test(p), 'secondary size missing');
    assert.ok(/10-15/.test(p), 'niche size missing');
});

await check('the base prompt names every required JSON key', () => {
    const p = psp.buildPrompt('https://example.com');
    for (const key of ['personaName', 'description', 'primarySet', 'secondarySet', 'nicheSet', 'youtube', 'social']) {
        assert.ok(p.includes('"' + key + '"'), 'missing key ' + key);
    }
    for (const platform of ['instagram', 'tiktok', 'twitter', 'facebook']) {
        assert.ok(p.includes('"' + platform + '"'), 'missing platform ' + platform);
    }
});

await check('the base prompt demands a single valid JSON array', () => {
    const p = psp.buildPrompt('https://example.com');
    assert.ok(/single, valid JSON array/.test(p));
});

await check('the base prompt states the # rule', () => {
    const p = psp.buildPrompt('https://example.com');
    assert.ok(/must start with a '#'/.test(p));
});

await check('the fallback prompt asks for a better URL', () => {
    const p = psp.buildFallbackPrompt('https://example.com');
    assert.ok(/Google search/.test(p));
    assert.ok(/better, more relevant URL/.test(p));
    assert.ok(p.includes('https://example.com'));
});

await check('the fallback prompt repeats the JSON contract', () => {
    const p = psp.buildFallbackPrompt('https://example.com');
    for (const key of ['personaName', 'primarySet', 'secondarySet', 'nicheSet', 'youtube', 'social']) {
        assert.ok(p.includes('"' + key + '"'), 'missing key ' + key);
    }
    assert.ok(/single, valid JSON array/.test(p));
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

await check('parsePersonas strips a ```json fence', () => {
    const text = '```json\n[{"personaName":"A"}]\n```';
    assert.strictEqual(psp.parsePersonas(text).length, 1);
});

await check('parsePersonas strips a bare ``` fence', () => {
    const text = '```\n[{"personaName":"A"}]\n```';
    assert.strictEqual(psp.parsePersonas(text).length, 1);
});

await check('parsePersonas accepts an empty array', () => {
    assert.deepStrictEqual(psp.parsePersonas('[]'), []);
});

await check('parsePersonas rejects a non-array', () => {
    let err = null;
    try { psp.parsePersonas('{"personaName":"A"}'); } catch (e) { err = e; }
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'NOT_AN_ARRAY');
});

await check('parsePersonas rejects invalid JSON', () => {
    let err = null;
    try { psp.parsePersonas('not json at all'); } catch (e) { err = e; }
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'INVALID_JSON');
});

await check('parsePersonas rejects an empty response', () => {
    let err = null;
    try { psp.parsePersonas('   '); } catch (e) { err = e; }
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'EMPTY_RESPONSE');
});

await check('parsePersonas digs the array out of surrounding prose', () => {
    const text = 'Here you go:\n[{"personaName":"A"}]\nHope that helps!';
    assert.strictEqual(psp.parsePersonas(text).length, 1);
});

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

await check('normalizePersona forces the # prefix', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    assert.ok(p.primarySet.every((t) => t.startsWith('#')), 'primary tier lost its #');
    assert.ok(p.secondarySet.every((t) => t.startsWith('#')));
    assert.ok(p.nicheSet.every((t) => t.startsWith('#')));
    assert.strictEqual(p.primarySet[0], '#homedecor');
});

await check('normalizePersona removes duplicates', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const lower = p.primarySet.map((t) => t.toLowerCase());
    assert.strictEqual(new Set(lower).size, lower.length, 'duplicates survived');
    assert.strictEqual(p.primarySet.length, 5);
});

await check('normalizePersona caps the tiers at 7 / 10 / 15', () => {
    const many = {
        primarySet: Array.from({ length: 20 }, (_, i) => '#p' + i),
        secondarySet: Array.from({ length: 20 }, (_, i) => '#s' + i),
        nicheSet: Array.from({ length: 20 }, (_, i) => '#n' + i),
    };
    const p = psp.normalizePersona(many);
    assert.strictEqual(p.primarySet.length, 7);
    assert.strictEqual(p.secondarySet.length, 10);
    assert.strictEqual(p.nicheSet.length, 15);
});

await check('normalizePersona never pads a short tier', () => {
    const p = psp.normalizePersona({ personaName: 'A', primarySet: ['#one', '#two'] });
    assert.strictEqual(p.primarySet.length, 2);
    assert.strictEqual(p.secondarySet.length, 0);
    assert.strictEqual(p.nicheSet.length, 0);
});

await check('normalizePersona warns about a short tier instead of inventing tags', () => {
    const p = psp.normalizePersona({ personaName: 'A', primarySet: ['#one', '#two'] });
    assert.ok(p.warnings.some((w) => /primarySet/.test(w)), 'no warning about the short tier');
    assert.ok(p.warnings.some((w) => /secondarySet/.test(w)));
});

await check('normalizePersona tolerates a missing youtube block', () => {
    const p = psp.normalizePersona({ personaName: 'A' });
    assert.deepStrictEqual(p.youtube, { title: '', description: '', tags: [] });
});

await check('normalizePersona tolerates a missing social block', () => {
    const p = psp.normalizePersona({ personaName: 'A' });
    for (const platform of ['instagram', 'tiktok', 'twitter', 'facebook']) {
        assert.deepStrictEqual(p.social[platform], { caption: '' });
    }
});

await check('normalizePersona accepts a bare string caption', () => {
    const p = psp.normalizePersona({ social: { instagram: 'plain caption' } });
    assert.strictEqual(p.social.instagram.caption, 'plain caption');
});

await check('normalizePersona drops tags with no usable characters', () => {
    const p = psp.normalizePersona({ primarySet: ['#', '###', '   ', '#ok'] });
    assert.deepStrictEqual(p.primarySet, ['#ok']);
});

await check('normalizePersona gives an unnamed persona a name', () => {
    const p = psp.normalizePersona({});
    assert.strictEqual(p.personaName, 'Untitled persona');
});

// ---------------------------------------------------------------------------
// platform content
// ---------------------------------------------------------------------------

await check('buildPlatformContent assembles the YouTube block', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const content = psp.buildPlatformContent(p);
    assert.strictEqual(content.youtube.title, '5 Minutes of Japandi Calm');
    assert.strictEqual(content.youtube.description, 'A slow pass through a neutral living room.');
    assert.deepStrictEqual(content.youtube.tags, ['#homedecor', '#minimalism', '#japandi']);
});

await check('buildPlatformContent assembles the four social captions', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const content = psp.buildPlatformContent(p);
    for (const platform of ['instagram', 'tiktok', 'twitter', 'facebook']) {
        assert.ok(content.social[platform].caption.length > 0, platform + ' caption is empty');
    }
});

await check('buildPlatformContent puts the hashtag line on the captions', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const content = psp.buildPlatformContent(p);
    assert.ok(content.social.instagram.caption.includes('#homedecor'));
    assert.ok(content.social.twitter.caption.includes('#homedecor'));
});

await check('buildPlatformContent leaves an empty caption empty', () => {
    const p = psp.normalizePersona({ personaName: 'A' });
    const content = psp.buildPlatformContent(p);
    assert.strictEqual(content.social.instagram.caption, '');
});

await check('the hashtag union holds the tiers in tier order, de-duplicated', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const union = psp.personaHashtags(p);
    assert.strictEqual(union[0], '#homedecor');
    assert.strictEqual(union[5], '#minimalisthome');
    assert.strictEqual(new Set(union.map((t) => t.toLowerCase())).size, union.length);
});

// ---------------------------------------------------------------------------
// toIgPostMd — asserted against ig-poster's own parser
// ---------------------------------------------------------------------------

await check('toIgPostMd produces a file ig-poster reads as title + caption + tags', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const parsed = readCaption(psp.toIgPostMd(p));
    assert.strictEqual(parsed.text, 'One surface. One decision. Less, but better.');
    assert.ok(parsed.hashtags.includes('#homedecor'));
    assert.ok(parsed.hashtags.includes('#japandi'));
});

await check('toIgPostMd keeps the caption body free of hashtags', () => {
    const p = psp.normalizePersona({
        personaName: 'A',
        social: { instagram: { caption: 'Look at this #minimalism in the wild.' } },
    });
    const parsed = readCaption(psp.toIgPostMd(p));
    assert.ok(!/#[a-zA-Z0-9_]+/.test(parsed.text), 'a tag leaked into the caption body');
});

await check('toIgPostMd posts every tag exactly once', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const parsed = readCaption(psp.toIgPostMd(p));
    const posted = parsed.text + '\n\n' + parsed.hashtags;
    const union = psp.personaHashtags(p);
    for (const tag of union) {
        // Token boundary: '#home' must not count inside '#homedecor'.
        const occurrences = (posted.match(new RegExp(tag + '(?![A-Za-z0-9_])', 'gi')) || []).length;
        assert.strictEqual(occurrences, 1, tag + ' appears ' + occurrences + ' times in the posted caption');
    }
});

await check('toIgPostMd uses the persona name as the title', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const md = psp.toIgPostMd(p);
    assert.ok(md.startsWith('# The Minimalist Home Decorator\n'), 'title heading is wrong');
});

await check('toIgPostMd puts the tag section AFTER the Next break', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const md = psp.toIgPostMd(p);
    const nextAt = md.indexOf('## Next');
    const tagsAt = md.indexOf('## Hashtags');
    assert.ok(nextAt > -1 && tagsAt > nextAt, 'the tag section must follow the Next section');
    // The body is what ig-poster reads: everything up to the break.
    const body = md.split('## Next')[0].split('## Caption')[1].trim();
    assert.strictEqual(body, 'One surface. One decision. Less, but better.');
});

await check('toIgPostMd keeps the instruction lines out of the body', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const parsed = readCaption(psp.toIgPostMd(p));
    assert.ok(!parsed.text.includes('Open the Instagram app'));
    assert.ok(!parsed.text.includes('hashtag line'));
});

await check('toIgPostMd survives a caption that carries its own heading', () => {
    const p = psp.normalizePersona({
        personaName: 'A',
        social: { instagram: { caption: '## Next\nA caption that lies.' } },
    });
    const parsed = readCaption(psp.toIgPostMd(p));
    assert.ok(!parsed.text.includes('Open the Instagram app'), 'the body ran past its section');
    assert.ok(parsed.text.length > 0);
});

// ---------------------------------------------------------------------------
// toYoutubeMetadata
// ---------------------------------------------------------------------------

await check('toYoutubeMetadata returns title, description, tags and tagsCsv', () => {
    const p = psp.normalizePersona(RAW_PERSONA);
    const meta = psp.toYoutubeMetadata(p);
    assert.strictEqual(meta.title, '5 Minutes of Japandi Calm');
    assert.strictEqual(meta.description, 'A slow pass through a neutral living room.');
    assert.deepStrictEqual(meta.tags, ['#homedecor', '#minimalism', '#japandi']);
    assert.strictEqual(meta.tagsCsv, 'homedecor,minimalism,japandi');
});

await check('toYoutubeMetadata falls back to the tiers when the model gave no tags', () => {
    const p = psp.normalizePersona({ personaName: 'A', primarySet: ['#one', '#two'] });
    const meta = psp.toYoutubeMetadata(p);
    assert.deepStrictEqual(meta.tags, ['#one', '#two']);
    assert.strictEqual(meta.tagsCsv, 'one,two');
});

await check('toYoutubeMetadata falls back to the persona name for a missing title', () => {
    const p = psp.normalizePersona({ personaName: 'The Name' });
    assert.strictEqual(psp.toYoutubeMetadata(p).title, 'The Name');
});

// ---------------------------------------------------------------------------
// the Gemini call
// ---------------------------------------------------------------------------

// ---- no key ---------------------------------------------------------------

await check('generatePack without a key fails with NO_KEY and no network call', async () => {
    const saved = process.env.PERSONA_PACK_API_KEY;
    delete process.env.PERSONA_PACK_API_KEY;
    let err = null;
    try {
        await psp.generatePack('https://example.com', { apiKey: '', fetch: () => { throw new Error('the network must not be touched'); } });
    } catch (e) { err = e; }
    if (saved === undefined) delete process.env.PERSONA_PACK_API_KEY;
    else process.env.PERSONA_PACK_API_KEY = saved;
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'NO_KEY');
    assert.ok(/PERSONA_PACK_API_KEY/.test(err.message), 'the message does not name the env var');
});

await check('the NO_KEY message never echoes a key', () => {
    const preview = psp.redactedKey('AIzaSy-fake-key-1234567890');
    assert.ok(!preview.includes('fake-key'), 'the redacted preview leaks the key');
    assert.ok(preview.includes('…'));
    assert.strictEqual(psp.redactedKey(''), '(none)');
});

// ---- the request ----------------------------------------------------------

let lastRequest = null;
let serverCalls = 0;
const server = await startServer((req, res) => {
    serverCalls++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        lastRequest = { method: req.method, url: req.url, headers: req.headers, body: body };
        const payload = {
            candidates: [{
                content: {
                    parts: [{ text: JSON.stringify([RAW_PERSONA]) }],
                },
            }],
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
    });
});

await check('generatePack POSTs to the v1beta generateContent endpoint', async () => {
    const personas = await psp.generatePack('https://example.com/personas', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        fetch: globalThis.fetch,
    });
    assert.strictEqual(personas.length, 1);
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/v1beta/models/gemini-2.5-pro:generateContent');
});

await check('the request carries the key in the x-goog-api-key header', async () => {
    await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        fetch: globalThis.fetch,
    });
    assert.strictEqual(lastRequest.headers['x-goog-api-key'], 'fake-key');
    assert.strictEqual(lastRequest.headers['content-type'], 'application/json');
});

await check('the request declares url_context and google_search as tools', async () => {
    await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        fetch: globalThis.fetch,
    });
    const body = JSON.parse(lastRequest.body);
    assert.ok(Array.isArray(body.tools), 'no tools array');
    assert.ok(body.tools.some((t) => t.url_context !== undefined), 'url_context is missing');
    assert.ok(body.tools.some((t) => t.google_search !== undefined), 'google_search is missing');
    assert.ok(typeof body.contents[0].parts[0].text === 'string', 'the prompt is not in contents');
    assert.ok(body.contents[0].parts[0].text.includes('https://example.com'), 'the prompt lost the URL');
});

await check('the response is normalised into personas', async () => {
    const personas = await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        fetch: globalThis.fetch,
    });
    const p = personas[0];
    assert.strictEqual(p.personaName, 'The Minimalist Home Decorator');
    assert.ok(p.primarySet.every((t) => t.startsWith('#')));
    assert.strictEqual(p.social.instagram.caption, 'One surface. One decision. Less, but better.');
    assert.strictEqual(p.youtube.title, '5 Minutes of Japandi Calm');
});

await check('the model can be overridden', async () => {
    await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        model: 'gemini-2.5-flash',
        fetch: globalThis.fetch,
    });
    assert.strictEqual(lastRequest.url, '/v1beta/models/gemini-2.5-flash:generateContent');
});

// ---- the two-phase fallback ----------------------------------------------

let fallbackCalls = 0;
const fallbackServer = await startServer((req, res) => {
    fallbackCalls++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        const prompt = JSON.parse(body).contents[0].parts[0].text;
        const text = prompt.includes('previous attempt')
            ? JSON.stringify([RAW_PERSONA])
            : '[]';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    });
});

await check('an empty first answer triggers the fallback prompt', async () => {
    fallbackCalls = 0;
    const personas = await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: fallbackServer.url,
        fetch: globalThis.fetch,
    });
    assert.strictEqual(fallbackCalls, 2, 'expected the fallback to run once');
    assert.strictEqual(personas.length, 1);
});

await check('a non-empty first answer does NOT trigger the fallback', async () => {
    // The `server` fixture answers every prompt with one persona, so the
    // first phase already has something and the fallback must not run.
    // (The fallbackServer answers the BASE prompt with [], so it can only
    // ever exercise the empty path.)
    serverCalls = 0;
    await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: server.url,
        fetch: globalThis.fetch,
    });
    assert.strictEqual(serverCalls, 1, 'the fallback ran when it should not have');
});

// A blank answer is "nothing found", not an error — upstream says the
// same, and the reason matters: it is what lets the second phase run.
let blankCalls = 0;
const blankServer = await startServer((req, res) => {
    blankCalls++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        const prompt = JSON.parse(body).contents[0].parts[0].text;
        const text = prompt.includes('previous attempt')
            ? JSON.stringify([RAW_PERSONA])
            : '   ';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    });
});

// Blank in BOTH phases — the run finds nothing at all.
const blankAlwaysServer = await startServer((req, res) => {
    blankCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '  ' }] } }] }));
});

// A response that is not JSON — a misparse, which must stay an error.
const malformedServer = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] }));
});

await check('a BLANK first answer still triggers the fallback prompt', async () => {
    blankCalls = 0;
    const personas = await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: blankServer.url,
        fetch: globalThis.fetch,
    });
    assert.strictEqual(blankCalls, 2, 'the fallback did not run after a blank answer');
    assert.strictEqual(personas.length, 1, 'the fallback did not recover the personas');
});

await check('a blank answer in BOTH phases yields no personas, not a throw', async () => {
    blankCalls = 0;
    const personas = await psp.generatePack('https://example.com', {
        apiKey: 'fake-key',
        baseUrl: blankAlwaysServer.url,
        fetch: globalThis.fetch,
    });
    assert.deepStrictEqual(personas, []);
    assert.strictEqual(blankCalls, 2);
});

// A malformed answer is still an error. If a misparse were mistaken for
// "nothing found", the fallback would run on top of a broken response
// and the real failure would be hidden.
await check('a malformed answer is an error, not a silent empty', async () => {
    let err = null;
    try {
        await psp.generatePack('https://example.com', {
            apiKey: 'fake-key',
            baseUrl: malformedServer.url,
            fetch: globalThis.fetch,
        });
    } catch (e) { err = e; }
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'INVALID_JSON');
});

// ---- an API error ---------------------------------------------------------

const errorServer = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'API_KEY_INVALID', message: 'API key not valid' } }));
});

await check('an API error surfaces its code and never the key', async () => {
    let err = null;
    try {
        await psp.generatePack('https://example.com', {
            apiKey: 'fake-secret-key',
            baseUrl: errorServer.url,
            fetch: globalThis.fetch,
        });
    } catch (e) { err = e; }
    assert.ok(err, 'expected a throw');
    assert.strictEqual(err.code, 'API_KEY_INVALID');
    assert.strictEqual(err.status, 400);
    assert.ok(!err.message.includes('fake-secret-key'), 'the error echoed the key');
});

await closeServer(server);
await closeServer(fallbackServer);
await closeServer(blankServer);
await closeServer(blankAlwaysServer);
await closeServer(malformedServer);
await closeServer(errorServer);

// ---------------------------------------------------------------------------
// the drift guard
//
// lib/social-shared.js (the social worker's rules module) carries a
// second copy of the tag/tier/POST.md rules this file also implements.
// Two copies of one convention is a hazard, so this suite PROVES they
// agree: if either side is edited and the other is not, this fails.
//
// The check is skipped when social-shared.js is absent — the module is
// another piece of work, and this suite must not depend on it being
// present.
// ---------------------------------------------------------------------------

const SHARED_PATH = path.join(__dirname, 'social-shared.js');
if (fs.existsSync(SHARED_PATH)) {
    const shared = require(SHARED_PATH);
    const DRIFT_PERSONA = {
        personaName: 'The Minimalist Home Decorator',
        description: 'Clean lines, neutral palettes.',
        primarySet: ['homedecor', '#minimalism', '#interiordesign', '#decor', '#home'],
        secondarySet: ['#minimalisthome', '#scandidecor', '#neutraldecor', '#simpleliving', '#modernhome'],
        nicheSet: ['#japandi', '#minimaldecor', '#whiteinteriors'],
        youtube: { title: '5 Minutes of Japandi Calm', description: 'A slow pass.', tags: ['#homedecor', '#japandi'] },
        social: {
            instagram: { caption: 'One surface. One decision. #minimalism' },
            tiktok: { caption: 'POV: you cleared one shelf.' },
            twitter: { caption: 'A quiet room is a loud idea.' },
            facebook: { caption: 'The room finally breathes.' },
        },
    };

    await check('the shared rules agree with lib/social-shared.js (no drift)', () => {
        assert.deepStrictEqual(
            psp.normalizePersona(DRIFT_PERSONA),
            shared.normalizePersona(DRIFT_PERSONA),
            'normalizePersona drifted'
        );
        assert.deepStrictEqual(
            psp.buildPlatformContent(DRIFT_PERSONA),
            shared.buildPlatformContent(DRIFT_PERSONA),
            'buildPlatformContent drifted'
        );
        assert.deepStrictEqual(
            psp.personaHashtags(DRIFT_PERSONA),
            shared.personaHashtags(DRIFT_PERSONA),
            'personaHashtags drifted'
        );
        assert.deepStrictEqual(
            psp.toYoutubeMetadata(DRIFT_PERSONA),
            shared.toYoutubeMetadata(DRIFT_PERSONA),
            'toYoutubeMetadata drifted'
        );
        assert.strictEqual(
            psp.toIgPostMd(DRIFT_PERSONA),
            shared.toIgPostMd(DRIFT_PERSONA),
            'toIgPostMd drifted'
        );
    });

    await check('the tier contract is the same on both sides', () => {
        assert.deepStrictEqual(psp.TIER_CAPS, shared.TIER_CAPS);
        assert.deepStrictEqual(psp.TIER_MINIMUMS, shared.TIER_MINIMUMS);
        assert.deepStrictEqual(psp.PLATFORMS, shared.PLATFORMS);
    });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

})();
