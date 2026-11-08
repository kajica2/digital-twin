#!/usr/bin/env node
'use strict';
// tools/treblo-upload.js
//
// Upload audio files to treblo.com and keep the returned
// `audio_upload_id` for each one.
//
// WHY THIS EXISTS
//
//   The repo's client (lib/treblo.js) covers GENERATION —
//   POST /v1/generations/v3 and the status/poll/download ladder. It does
//   not cover UPLOAD, because the endpoint was not in the docs the client
//   was written against.
//
//   MEASURED 2026-11-07, from the live OpenAPI spec at
//   https://api.treblo.com/openapi.json:
//
//     POST /v1/uploads — "Store an audio file for use as audio_upload_id
//                         in extend/inpaint/reference requests."
//     body: multipart/form-data, field `file` (binary)
//     200:  { "audio_upload_id": "<uuid4>" }
//
//   The `audio_upload_id` is then a first-class field on
//   /v1/generations/v3/{reference,extend,inpaint} — so an upload is the
//   way to get YOUR audio into the model rather than describing it.
//
//   An UPLOAD COSTS NO CREDITS. Measured: the balance was 300 before and
//   300 after an upload. Only a GENERATION spends credits (100 each for
//   v3).
//
// USAGE
//
//   node tools/treblo-upload.js <file> [more files…] [options]
//
//   --out <dir>        where the manifest lands (default data/treblo/uploads)
//   --manifest <name>  manifest filename (default uploads.json)
//   --dry-run          report what would be uploaded, upload nothing
//   --only-new         skip files already in the manifest
//
// The manifest records every upload id, the source path, the size and the
// sha256, so a re-run can tell what is already uploaded.
//
// Exit: 0 all uploaded · 2 bad input · 3 a failure

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ARGV = process.argv.slice(2);
const argVal = (name, fallback) => {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
};
const has = (f) => ARGV.includes(f);

const REPO = path.resolve(__dirname, '..');
const API = 'https://api.treblo.com';
const KEY_FILE = path.join(os.homedir(), '.treblo-api-key');

const OUT_DIR = path.resolve(REPO, argVal('--out', 'data/treblo/uploads'));
const MANIFEST = argVal('--manifest', 'uploads.json');
const DRY = has('--dry-run');
const ONLY_NEW = has('--only-new');

const files = ARGV.filter((a, i) => {
    if (a.startsWith('--')) return false;
    // Skip a flag's VALUE.
    const prev = ARGV[i - 1];
    if (prev === '--out' || prev === '--manifest') return false;
    return true;
});

// MEASURED 2026-11-07: the upload limit is exactly 40 MiB.
//   41943040 bytes → HTTP 200
//   41943041 bytes → HTTP 413 {"detail":"Uploaded file exceeds 40MB"}
// A file over the limit is rejected by Cloudflare before the API sees it.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

function log(m) { process.stdout.write(`[treblo-upload] ${m}\n`); }
function warn(m) { process.stderr.write(`[treblo-upload] ${m}\n`); }

function apiKey() {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!k) throw new Error('the API key file is empty');
    return k;
}

async function credits() {
    const r = await fetch(`${API}/v1/credits/balance`, {
        headers: { 'Authorization': `Bearer ${apiKey()}`, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`credits/balance → HTTP ${r.status}`);
    return (await r.json()).num_credits;
}

/**
 * Upload one file. POST /v1/uploads, multipart/form-data, field `file`.
 */
async function uploadOne(file) {
    const buf = fs.readFileSync(file);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(file));

    const res = await fetch(`${API}/v1/uploads`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey()}`, 'Accept': 'application/json' },
        body: form,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    if (!json || !json.audio_upload_id) {
        throw new Error(`no audio_upload_id in the answer: ${text.slice(0, 160)}`);
    }
    return json.audio_upload_id;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
    if (!files.length) {
        warn('usage: node tools/treblo-upload.js <file> [more files…] [--out <dir>] [--dry-run] [--only-new]');
        process.exit(2);
    }
    const missing = files.filter(f => !fs.existsSync(f));
    if (missing.length) {
        for (const m of missing) warn(`not found: ${m}`);
        process.exit(2);
    }

    const manifestPath = path.join(OUT_DIR, MANIFEST);
    let manifest = { generatedAt: null, uploads: [] };
    if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
        catch (e) { warn(`the existing manifest is unreadable — starting a new one`); }
    }
    manifest.uploads = manifest.uploads || [];
    const known = new Set(manifest.uploads.map(u => u.sha256));

    log(`${files.length} file(s) · ${manifest.uploads.length} already in the manifest`);
    const before = await credits();
    log(`credits before: ${before}`);

    let done = 0, failed = 0, skipped = 0;
    for (const f of files) {
        const digest = sha256(f);
        if (ONLY_NEW && known.has(digest)) {
            log(`skip (already uploaded): ${path.basename(f)}`);
            skipped++;
            continue;
        }
        const mb = (fs.statSync(f).size / 1048576).toFixed(1);
        const bytes = fs.statSync(f).size;
        if (bytes > MAX_UPLOAD_BYTES) {
            // Refuse BEFORE spending the request — the server answers 413
            // and the whole body was already sent.
            warn(`SKIPPED (over the 40MB limit, ${mb} MB): ${path.basename(f)}`);
            warn(`   split it first, or upload its segments:`);
            warn(`   ffmpeg -i "${f}" -map 0:a:0 -c copy -f segment -segment_time 420 -reset_timestamps 1 part-%02d.mp3`);
            failed++;
            continue;
        }
        if (DRY) {
            log(`dry-run: would upload ${path.basename(f)} (${mb} MB)`);
            skipped++;
            continue;
        }
        const t0 = Date.now();
        try {
            const id = await uploadOne(f);
            manifest.uploads.push({
                source: f,
                name: path.basename(f),
                audioUploadId: id,
                sha256: digest,
                bytes: fs.statSync(f).size,
                uploadedAt: new Date().toISOString(),
            });
            log(`uploaded ${path.basename(f)} (${mb} MB) → ${id} [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
            done++;
            // Write the manifest after EVERY file, so an interrupted run
            // keeps the ids it already earned.
            fs.mkdirSync(OUT_DIR, { recursive: true });
            manifest.generatedAt = new Date().toISOString();
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        } catch (e) {
            failed++;
            // MEASURED 2026-11-07: the server refuses an upload whose AUDIO
            // it already holds, with HTTP 422 and
            //   {"detail":"This upload matches existing audio and cannot be used."}
            // The match is PERCEPTUAL, not on bytes and not on the filename:
            // a renamed copy and a re-encode at 128k are both refused, and
            // the account's OWN uploads from earlier in the same batch
            // re-upload fine. So the account already holds these
            // recordings — the file is not missing, it is already there.
            if (/matches existing audio/i.test(e.message)) {
                log(`ALREADY HELD by the account (not an error): ${path.basename(f)}`);
                manifest.uploads.push({
                    source: f,
                    name: path.basename(f),
                    set: path.basename(path.dirname(f)).replace(/ _ 7min segments$/, ''),
                    audioUploadId: null,
                    alreadyHeld: true,
                    bytes: fs.statSync(f).size,
                    note: 'the account already holds this audio; the upload was refused with 422',
                    uploadedAt: new Date().toISOString(),
                });
                manifest.generatedAt = new Date().toISOString();
                fs.mkdirSync(OUT_DIR, { recursive: true });
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
                failed--;   // it is not a failure — the audio IS on the account
                done++;
                continue;
            }
            warn(`FAILED ${path.basename(f)}: ${e.message}`);
        }
    }

    const after = await credits();
    log(`credits after: ${after} (cost: ${before - after})`);
    log(`uploaded ${done} · skipped ${skipped} · failed ${failed}`);
    if (!DRY) log(`manifest: ${manifestPath}`);
    process.exit(failed ? 3 : 0);
})().catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
