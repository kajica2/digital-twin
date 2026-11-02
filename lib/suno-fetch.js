#!/usr/bin/env node
'use strict';
// lib/suno-fetch.js
//
// Fetch a finished Suno clip's audio to disk — as PLAYABLE media.
//
// MEASURED 2026-11-02 (live): the `.m4a` object on CloudFront is
// ENCRYPTED AT REST. The old version of this file wrote those bytes
// straight to disk and called it a download: the result was a file
// ffprobe could not read, and a sidecar JSON that implied it was audio.
// The fix is not a bigger download — it is that the bytes have to be
// DECRYPTED before they are written. `lib/suno-mango.js` holds the
// decryptor (Mango / AES-CTR) and the license call.
//
// The flow:
//
//   1. open the session (cookies) and wait for the clip to have audio
//   2. ask the license server for the key material (in-page: it needs
//      the session cookies)
//   3. fetch the encrypted body
//        - primary: a plain node fetch (the object is public; it is the
//          BYTES that are encrypted, not the address)
//        - fallback: an in-page read, bounded by an AbortController and
//          by a per-call CDP deadline — for session-gated URLs
//   4. decrypt, and check the result really is an MP4 family file
//      (`ftyp` box at offset 4). A wrong key produces plausible
//      garbage, so the brand check is what turns "wrote a file" into
//      "wrote a playable file".
//   5. write the PLAINTEXT. Encrypted bytes never land on the output
//      path.
//
// CLI:
//   node lib/suno-fetch.js --clip <clipId> [--out <file.m4a>] [--port 9455]
//   node lib/suno-fetch.js --clip <clipId> --wait 600
//   node lib/suno-fetch.js --clip <clipId> --user-data-dir /tmp/suno-profile
//
// Exit: 0 ok · 1 fatal · 2 the clip has no audio yet

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { fetchRights, decryptMedia, mediaUrlFor } = require('./suno-mango.js');

const REPO = path.resolve(__dirname, '..');

/** Deadline for the plain media fetch. */
const DEFAULT_MEDIA_TIMEOUT_MS = 120000;
/** Deadline for the in-page media fetch (the browser's own abort). */
const DEFAULT_INPAGE_TIMEOUT_MS = 120000;
/**
 * Deadline for the CDP call that carries the in-page body back. A
 * multi-megabyte base64 string is slow to bridge, so this is
 * deliberately larger than the in-page abort — the in-page timer is the
 * one that bounds the work; this one bounds the answer.
 */
const DEFAULT_INPAGE_CDP_TIMEOUT_MS = 180000;

function log(msg) { process.stdout.write(`[suno-fetch] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-fetch] ${msg}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The clip record carries the audio under one of these keys depending on
// how the clip was made (generation / cover / upload).
function audioUrlOf(clip) {
    if (!clip) return null;
    const candidates = [
        clip.audio_url, clip.song_url, clip.stream_url,
        clip.metadata && clip.metadata.audio_url,
        clip.metadata && clip.metadata.song_url,
    ];
    for (const c of candidates) {
        if (typeof c !== 'string' || !/^https?:\/\//.test(c)) continue;
        // While a clip is still generating, the API hands back a
        // placeholder URL that answers 403 (`/api/forbidden`). It is not an
        // audio address — the clip is simply not ready yet.
        if (/\/api\/forbidden\b/.test(c)) continue;
        return c;
    }

    // MEASURED 2026-11-02 (live): `audio_url` is the /api/forbidden
    // PLACEHOLDER on EVERY clip of this shape — including ones made
    // weeks ago that have real audio. It is not a refusal marker.
    //
    // The real address is in `media_urls`: an array of
    // `{ url, content_type, delivery, encoding }`, and the URL is a
    // CloudFront `.m4a` (AES256 at rest — the browser decrypts it, so
    // a plain curl gets bytes ffprobe cannot read).
    //
    // The old lookup stopped at the placeholder and found NOTHING for
    // these clips, which made a finished track look unfetchable.
    const media = Array.isArray(clip.media_urls) ? clip.media_urls : [];
    const isAudio = (m) => {
        const t = String((m && m.content_type) || '').toLowerCase();
        if (!t) return true;                       // no type: take it
        if (t.startsWith('video/')) return false;
        if (t.startsWith('image/')) return false;
        return true;
    };
    for (const m of media) {
        if (!m) continue;
        const u = m.url;
        if (typeof u !== 'string' || !/^https?:\/\//.test(u)) continue;
        if (/\/api\/forbidden\b/.test(u)) continue;
        if (!isAudio(m)) continue;
        return u;
    }
    return null;
}

/**
 * Fetch the encrypted body with a plain node fetch.
 *
 * The CloudFront object is publicly fetchable — it is the BYTES that are
 * encrypted, not the address. The deadline is not decoration: an
 * unbounded fetch of a large object is a fetch that can hang forever.
 */
async function fetchMediaBytes(url, {
    timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetchMediaBytes: no fetch implementation');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://suno.com/' },
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`media fetch ${url} → ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    } catch (e) {
        if (e && e.name === 'AbortError') {
            const err = new Error(`media fetch aborted after ${timeoutMs}ms: ${url}`);
            err.name = 'AbortError';
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Run one expression in the page, with a per-call CDP deadline.
 *
 * `CDPClient.js()` has no per-call timeout, and a multi-megabyte
 * base64 body needs a longer one than the client's default. The
 * deadline therefore goes on the CDP call itself.
 */
async function evaluateInPage(cdp, expression, timeoutMs) {
    if (!cdp) throw new Error('evaluateInPage: needs a CDP client');
    if (typeof cdp.send !== 'function') {
        return cdp.js(expression, true);
    }
    const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
    }, { timeoutMs });
    if (result && result.exceptionDetails) {
        const ex = result.exceptionDetails.exception;
        const detail = ex && ex.description
            ? ex.description.split('\n')[0]
            : (ex && ex.value ? String(ex.value) : result.exceptionDetails.text);
        const snippet = String(expression).replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`JS error: ${detail} (line ${result.exceptionDetails.lineNumber}) in: ${snippet}`);
    }
    return result.result.value;
}

/**
 * Fetch one URL through the browser and return its bytes.
 *
 * In-page, because a session-gated URL refuses a plain client. The
 * bytes come back base64-encoded so they survive the CDP bridge.
 *
 * The read is BOUNDED twice: the page aborts its own fetch after
 * `timeoutMs`, and the CDP call that carries the answer back has its own
 * deadline. The old version had neither — an in-page fetch that never
 * resolved left the CDP evaluate pending forever, which is how a fetch
 * turns into a stuck session.
 *
 * `dest` is optional and only kept for callers that want the raw body
 * on disk. It receives ENCRYPTED bytes; the caller is responsible for
 * decrypting them.
 */
async function fetchThroughBrowser(cdp, url, dest, {
    timeoutMs = DEFAULT_INPAGE_TIMEOUT_MS,
    cdpTimeoutMs = DEFAULT_INPAGE_CDP_TIMEOUT_MS,
} = {}) {
    const b64 = await evaluateInPage(cdp, `(async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ${Number(timeoutMs)});
        try {
            const r = await fetch(${JSON.stringify(url)}, {
                credentials: 'omit',
                cache: 'no-store',
                signal: ctrl.signal,
            });
            if (!r.ok) return 'ERR:' + r.status;
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let s = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(s);
        } catch (e) {
            const err = new Error('in-page media fetch aborted after ' + ${Number(timeoutMs)} + 'ms: ' + (e && e.message ? e.message : String(e)));
            err.name = 'AbortError';
            throw err;
        } finally { clearTimeout(timer); }
    })()`, cdpTimeoutMs);
    if (typeof b64 !== 'string') throw new Error('no response from the browser');
    if (b64.startsWith('ERR:')) throw new Error(`fetch ${url} → ${b64}`);
    const bytes = Buffer.from(b64, 'base64');
    if (dest) fs.writeFileSync(dest, bytes);
    return bytes;
}

/**
 * The whole run, with every side effect injectable.
 *
 * The defaults are the real thing; the tests pass their own so no
 * browser and no network are involved.
 */
async function main(argv = process.argv.slice(2), deps = {}) {
    const {
        openClient = (opts) => SunoClient.open(opts),
        rightsFor = fetchRights,
        decrypt = decryptMedia,
        fetchBytes = fetchMediaBytes,
        readInPage = fetchThroughBrowser,
        sleepFor = sleep,
    } = deps;

    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };

    const clipId = flag('clip');
    if (!clipId) throw new Error('--clip <clipId> is required');
    // --wait is SECONDS. It was milliseconds once, which made the poll
    // loop exit before the first check could run.
    const waitMs = Number(flag('wait', 0)) * 1000;
    const outPath = path.resolve(REPO, flag('out', `data/suno/clips/${clipId}.m4a`));

    const client = await openClient({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
        userDataDir: flag('user-data-dir', undefined),
    });

    try {
        let clip = null;
        let url = null;
        const deadline = Date.now() + (waitMs || 1);
        while (Date.now() < deadline) {
            clip = await client.getClip(clipId);
            url = audioUrlOf(clip);
            if (url) break;
            if (!waitMs) break;
            log('no audio yet — waiting');
            await sleepFor(10000);
        }
        if (!url) {
            const status = clip && (clip.status || (clip.metadata && clip.metadata.status));
            warn(`clip ${clipId} has no audio yet (status: ${status || 'unknown'})`);
            return 2;
        }

        // The license call must come from the page: it carries the
        // session cookies.
        const rights = await rightsFor(client.cdp, clipId);

        // The body: a plain fetch first, the browser as a fallback.
        let encrypted = null;
        let fetchError = null;
        try {
            encrypted = await fetchBytes(url);
        } catch (e) {
            fetchError = e;
        }
        if (!encrypted) {
            log(`plain fetch failed (${fetchError && fetchError.message}) — reading through the browser`);
            encrypted = await readInPage(client.cdp, url);
        }

        // Decrypt BEFORE anything is written to the output path.
        const { plain, algo } = decrypt(encrypted, { clipId, ...rights });

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, plain);
        const bytes = plain.length;
        log(`saved ${path.relative(REPO, outPath)} (${(bytes / 1048576).toFixed(2)} MB, ${algo})`);
        log(`source url: ${url}`);
        fs.writeFileSync(path.join(path.dirname(outPath), `${clipId}.json`), JSON.stringify({
            clipId, url, bytes, title: clip.title || null,
            decrypted: true, algorithm: algo, fetchedAt: new Date().toISOString(),
        }, null, 2));
        return 0;
    } finally {
        await client.close();
    }
}

module.exports = {
    audioUrlOf,
    fetchThroughBrowser,
    fetchMediaBytes,
    evaluateInPage,
    main,
    DEFAULT_MEDIA_TIMEOUT_MS,
    DEFAULT_INPAGE_TIMEOUT_MS,
    DEFAULT_INPAGE_CDP_TIMEOUT_MS,
    REPO,
};

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn(`fatal: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}
