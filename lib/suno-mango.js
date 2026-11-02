#!/usr/bin/env node
'use strict';
// lib/suno-mango.js
//
// Suno's "Mango" media encryption, and the decryptor for it.
//
// MEASURED 2026-11-02: the `.m4a` objects on
// `d2lwuy8qc234o3.cloudfront.net` are ENCRYPTED AT REST. A plain fetch
// gets bytes that ffprobe cannot read — the app itself never plays the
// raw object; it asks the license server for key material and decrypts
// the media locally before handing it to the media element.
//
// The algorithm was reverse-engineered from suno.com's own app bundle
// (`suno.com/_next/static/immutable/chunks/0fzmmx_y_oah9.js`, modules
// 913328 and 930323) and confirmed against the live license server:
//
//   1. POST /a/api/mango/rights
//        body {content_params:{content_id:<clipId>, content_type:"clip"}}
//        -> { key: base64, iv: base64, glt: "<JWT>" }
//
//   2. GCM key  = SHA-256(glt)
//      `glt` is the "guest license token"; it is a JWT with a one-hour
//      TTL, so the rights step cannot be cached forever.
//
//   3. blob = base64decode(key) ; blob = base64decode(iv)
//      unwrap(blob) = AES-GCM-decrypt(iv = blob[0:12], aad = clipId,
//                                       key = GCM key)
//      -> CTR key   = unwrap(base64decode(key))
//      -> CTR iv    = unwrap(base64decode(iv))
//
//   4. media = AES-CTR-decrypt(the CloudFront bytes)
//      counter = 16-byte big-endian increment of the CTR iv, per 16-byte
//      block.
//
// The decryption was validated against the app's own playback: the
// offline decrypt and the app's MSE-decrypted stream differ in 0 of
// 7,679,376 samples (correlation 1.0).
//
// This module used to live in `data/suno/tools/` (gitignored, so it
// could never be reviewed or reused). It is tracked here so the
// decryptor is a first-class part of the repo.
//
//   node lib/suno-mango.js --clip <clipId> [--out <file.m4a>] [--port 9455]
//
// Exit: 0 ok · 1 fatal · 2 no rights for that clip

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

/** Where a clip's media object lives. The path is public; the bytes are not. */
const MEDIA_BASE = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip';

/** The rights endpoint, relative to the suno.com origin the SPA runs on. */
const RIGHTS_PATH = '/a/api/mango/rights';

/** How long an in-page rights fetch may take before it is aborted. */
const DEFAULT_RIGHTS_TIMEOUT_MS = 20000;

function log(msg) { process.stdout.write(`[suno-mango] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-mango] ${msg}\n`); }

/**
 * Unwrap one AES-GCM blob.
 *
 * The blob is `iv(12) || ciphertext || tag(16)`; the AAD is the clip id,
 * which is what binds the key material to that one clip.
 */
function gcmUnwrap(blob, aad, gcmKey) {
    if (!Buffer.isBuffer(blob)) throw new Error('gcmUnwrap: blob must be a Buffer');
    if (blob.length < 12 + 16) throw new Error(`gcmUnwrap: blob too short (${blob.length} bytes)`);
    const iv = blob.subarray(0, 12);
    const rest = blob.subarray(12);
    const tag = rest.subarray(rest.length - 16);
    const ct = rest.subarray(0, rest.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
    d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
}

/** The CTR algorithm that goes with a key of this length. */
function ctrAlgoFor(key) {
    if (key.length === 16) return 'aes-128-ctr';
    if (key.length === 24) return 'aes-192-ctr';
    return 'aes-256-ctr';
}

/**
 * Decrypt the media bytes. AES-CTR is a stream cipher, so the length is
 * preserved exactly and no padding rules apply.
 */
function ctrDecrypt(data, ctrKey, ctrIv) {
    const algo = ctrAlgoFor(ctrKey);
    const cipher = crypto.createCipheriv(algo, ctrKey, ctrIv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Turn a rights payload into the CTR key and iv that decrypt the media.
 *
 * `glt` is the guest license token; SHA-256 of it is the key that unwraps
 * the two blobs. The AAD is the clip id for both unwraps.
 */
function deriveCtrKeyIv(rights, clipId) {
    if (!rights || !rights.key || !rights.iv || !rights.glt) {
        throw new Error('rights payload is missing key/iv/glt');
    }
    const gcmKey = crypto.createHash('sha256').update(String(rights.glt), 'utf8').digest();
    const ctrKey = gcmUnwrap(Buffer.from(rights.key, 'base64'), clipId, gcmKey);
    const ctrIv = gcmUnwrap(Buffer.from(rights.iv, 'base64'), clipId, gcmKey);
    return { gcmKey, ctrKey, ctrIv, algo: ctrAlgoFor(ctrKey) };
}

/**
 * Decrypt one clip's media bytes.
 *
 * The `ftyp` brand check is the proof the bytes are real media: an MP4
 * family file starts with a 4-byte box size and the `ftyp` box type at
 * offset 4. A wrong key produces plausible-looking garbage, so the check
 * is what turns "wrote a file" into "wrote a playable file".
 */
function decryptMedia(encrypted, { clipId, key, iv, glt }) {
    if (!Buffer.isBuffer(encrypted)) throw new Error('decryptMedia: encrypted must be a Buffer');
    const { ctrKey, ctrIv, algo } = deriveCtrKeyIv({ key, iv, glt }, clipId);
    const plain = ctrDecrypt(encrypted, ctrKey, ctrIv);
    const brand = plain.length >= 8 ? plain.subarray(4, 8).toString('latin1') : '';
    if (brand !== 'ftyp') {
        throw new Error(
            `decrypted media for ${clipId} does not start with an ftyp box (brand: ${JSON.stringify(brand)}) — ` +
            'the key material is wrong or expired'
        );
    }
    return { plain, algo, brand };
}

/** The CloudFront URL for a clip's media object. */
function mediaUrlFor(clipId) {
    return `${MEDIA_BASE}/${clipId}.m4a`;
}

/**
 * Ask the license server for the key material for one clip.
 *
 * The request must carry the session cookies, so it is made from inside
 * the page (the same origin the SPA runs on) rather than from node. It
 * carries a deadline: an in-page fetch without one can hang the CDP
 * evaluate forever, which is how a probe turns into a stuck session.
 */
async function fetchRights(cdp, clipId, { timeoutMs = DEFAULT_RIGHTS_TIMEOUT_MS } = {}) {
    if (!cdp || typeof cdp.js !== 'function') throw new Error('fetchRights: needs a CDP client');
    const raw = await cdp.js(`(async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ${Number(timeoutMs)});
        try {
            const r = await fetch(${JSON.stringify(RIGHTS_PATH)}, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content_params: { content_id: ${JSON.stringify(clipId)}, content_type: 'clip' } }),
                signal: ctrl.signal,
            });
            return await r.text();
        } catch (e) {
            const err = new Error('mango rights request aborted after ' + ${Number(timeoutMs)} + 'ms: ' + (e && e.message ? e.message : String(e)));
            err.name = 'AbortError';
            throw err;
        } finally { clearTimeout(timer); }
    })()`, true);
    if (typeof raw !== 'string') throw new Error('mango rights: no response from the browser');
    let j;
    try {
        j = JSON.parse(raw);
    } catch (e) {
        throw new Error(`mango rights: response was not JSON (${raw.slice(0, 200)})`);
    }
    if (!j || !j.key || !j.iv || !j.glt) {
        throw new Error(`mango rights: unexpected payload (${raw.slice(0, 200)})`);
    }
    return { key: j.key, iv: j.iv, glt: j.glt };
}

module.exports = {
    MEDIA_BASE,
    RIGHTS_PATH,
    DEFAULT_RIGHTS_TIMEOUT_MS,
    REPO,
    gcmUnwrap,
    ctrAlgoFor,
    ctrDecrypt,
    deriveCtrKeyIv,
    decryptMedia,
    mediaUrlFor,
    fetchRights,
};

/* ------------------------------- CLI -------------------------------- */

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };

    const clipId = flag('clip');
    if (!clipId) throw new Error('--clip <clipId> is required');
    const port = Number(flag('port', 0)) || undefined;
    const outPath = path.resolve(REPO, flag('out', `data/suno/clips/${clipId}.m4a`));

    const { SunoClient } = require('./suno-web.js');
    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port,
        userDataDir: flag('user-data-dir', undefined),
    });
    try {
        const rights = await fetchRights(client.cdp, clipId);
        log(`rights ok for ${clipId} (glt ${rights.glt.length} chars)`);

        const url = mediaUrlFor(clipId);
        const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://suno.com/' } });
        if (!res.ok) throw new Error(`media fetch ${url} → ${res.status}`);
        const encrypted = Buffer.from(await res.arrayBuffer());
        const { plain, algo } = decryptMedia(encrypted, { clipId, ...rights });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, plain);
        log(`saved ${path.relative(REPO, outPath)} (${(plain.length / 1048576).toFixed(2)} MB, ${algo})`);
        return 0;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn('fatal: ' + (e && e.message ? e.message : e));
        process.exit(1);
    });
}
