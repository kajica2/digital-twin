#!/usr/bin/env node
'use strict';
// lib/suno-upload.js
//
// Batch-upload local audio files to Suno as **uploaded clips**.
//
// WHY THIS FILE EXISTS
//
// The repo had a `cover` path (`lib/suno-run.js`) but no way to get an
// audio FILE into Suno. Uploading is the missing first half: an
// uploaded file becomes a real clip id, and a clip id is what a cover
// needs as its source. Without it, `cover_clip_id` can only ever point
// at a clip Suno itself generated.
//
// THE PROTOCOL (READ from the studio's own JS bundle, not guessed)
//
// The route strings and the request bodies were extracted from
// suno.com's own chunks (`3c89nzlmg-fve.js`, `0clz7vt3vzhif.js`):
//
//   1. POST /api/uploads/audio/
//        body { extension, is_stem_mix: false, upload_type }
//        ->  { id, url, fields }   (id = upload_id; url/fields = a
//                                   presigned S3 POST form)
//   2. POST <url>  multipart/form-data
//        fields..., then the file under the key "file"  -> S3
//   3. POST /api/uploads/audio/{upload_id}/upload-finish/
//        body { upload_type, upload_filename }
//   4. GET  /api/uploads/audio/{upload_id}/
//        -> { status: 'complete' | 'error', ... }   (poll)
//   5. POST /api/uploads/audio/{upload_id}/initialize-clip/
//        body { downbeats }  -> { clip_id }
//
//   Step 5 is what turns an upload into a CLIP. Step 4 alone leaves an
//   upload with no clip.
//
// MEASURED 2026-11-02: the earlier probe guessed paths and every one
// 404'd. The bundle names the routes; this file uses the bundle's
// names.
//
// WHY THE FILE IS SERVED OVER LOCAL HTTP
//
// The WAVs are 40–70 MB. Base64-ing them through the CDP evaluate
// channel would put a ~90 MB string in every debug message. Instead a
// tiny local HTTP server hands the bytes to the page, which is already
// on suno.com and can read them into a File without a CORS dance
// (the local server sends `Access-Control-Allow-Origin: *`).
//
// CLI:
//   node lib/suno-upload.js upload <file.wav> [more.wav ...]
//   node lib/suno-upload.js upload --dir <dir>
//   node lib/suno-upload.js list
//
// Exit: 0 ok · 1 fatal

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');

const UPLOAD_TYPE = 'studio_file_upload';

function log(m) { process.stdout.write(`[suno-upload] ${m}\n`); }
function warn(m) { process.stderr.write(`[suno-upload] ${m}\n`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// The extensions the studio accepts for an audio upload.
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif']);

function mimeFor(ext) {
    switch (ext) {
        case 'wav': return 'audio/wav';
        case 'mp3': return 'audio/mpeg';
        case 'm4a': return 'audio/mp4';
        case 'aac': return 'audio/aac';
        case 'flac': return 'audio/flac';
        case 'ogg': case 'opus': return 'audio/ogg';
        case 'aiff': case 'aif': return 'audio/aiff';
        default: return 'application/octet-stream';
    }
}

/**
 * Upload one file and turn it into a clip.
 *
 * @returns {Promise<object>} the clip record
 */
async function uploadFile(client, filePath, localBase, opts = {}) {
    const name = path.basename(filePath);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
        throw new Error(`unsupported audio extension ".${ext}" for ${name}`);
    }
    const bytes = fs.statSync(filePath).size;

    // --- 1. ask for a presigned upload --------------------------------
    const init = await client.api('/api/uploads/audio/', {
        method: 'POST',
        body: {
            extension: ext,
            is_stem_mix: false,
            upload_type: UPLOAD_TYPE,
        },
    });
    if (init.status !== 200 || !init.json || !init.json.id) {
        throw new Error(`upload init failed ${init.status}: ${String(init.body).slice(0, 300)}`);
    }
    const uploadId = init.json.id;
    const s3url = init.json.url;
    const fields = init.json.fields || {};
    log(`${name}: upload_id=${uploadId} (${(bytes / 1048576).toFixed(1)} MB)`);

    // --- 2. push the bytes to S3 --------------------------------------
    //
    // MEASURED 2026-11-02: the browser route STALLED. Passing 26 MB
    // through the CDP evaluate channel meant a ~35 MB base64 string in
    // a debug message, and the transfer never finished — the run sat
    // for 8+ minutes with no progress and no error.
    //
    // The fix is that step 2 never needed the browser. The presigned
    // POST is a plain multipart request to S3, and S3's CORS policy
    // allows it from any origin. Node 22 has FormData/Blob/fetch
    // natively, so the bytes go straight from disk to S3.
    //
    // The BROWSER is still needed for steps 1, 3, 4 and 5 — those are
    // authenticated studio API calls.
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mimeFor(ext) }), name);
    const s3res = await fetch(s3url, { method: 'POST', body: fd });
    if (!s3res.ok) {
        const txt = await s3res.text().catch(() => '');
        throw new Error(`s3 upload failed ${s3res.status}: ${txt.slice(0, 300)}`);
    }

    // --- 3. tell Suno the upload is complete --------------------------
    const fin = await client.api(`/api/uploads/audio/${encodeURIComponent(uploadId)}/upload-finish/`, {
        method: 'POST',
        body: { upload_type: UPLOAD_TYPE, upload_filename: name },
    });
    if (fin.status !== 200 || !fin.json) {
        throw new Error(`upload-finish failed ${fin.status}: ${String(fin.body).slice(0, 300)}`);
    }

    // --- 4. wait for processing ---------------------------------------
    let status = null;
    const deadline = Date.now() + (opts.timeoutMs || 10 * 60 * 1000);
    while (Date.now() < deadline) {
        const poll = await client.api(`/api/uploads/audio/${encodeURIComponent(uploadId)}/`, { method: 'GET' });
        const j = poll.json || {};
        status = j.status;
        if (status === 'error') {
            throw new Error(`upload processing error: ${j.error_message || j.error_type || 'unknown'}`);
        }
        if (status === 'complete') break;
        await sleep(opts.pollMs || 4000);
    }
    if (status !== 'complete') {
        throw new Error(`upload processing timed out (last status: ${status})`);
    }
    log(`${name}: processing complete`);

    // --- 5. initialize the clip ---------------------------------------
    const initClip = await client.api(`/api/uploads/audio/${encodeURIComponent(uploadId)}/initialize-clip/`, {
        method: 'POST',
        body: { downbeats: opts.downbeats ?? null },
    });
    if (initClip.status !== 200 || !initClip.json || !initClip.json.clip_id) {
        throw new Error(`initialize-clip failed ${initClip.status}: ${String(initClip.body).slice(0, 300)}`);
    }
    const clipId = initClip.json.clip_id;
    log(`${name}: clip_id=${clipId}`);

    return {
        file: filePath,
        name,
        uploadId,
        clipId,
        title: initClip.json.title || name.replace(/\.[^.]+$/, ''),
        status,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (!cmd || cmd === 'help' || cmd === '--help') {
        log('usage: node lib/suno-upload.js upload <file.wav> [more.wav ...]');
        log('       node lib/suno-upload.js upload --dir <dir>');
        log('       node lib/suno-upload.js list');
        return;
    }

    if (cmd === 'list') {
        const client = await SunoClient.open({});
        try {
            const j = await client.apiOk('/api/feed/v2?page=0');
            (j.clips || []).forEach(c => {
                log(`${c.id}  ${c.title}  [${c.status}]  ${c.generation_type || ''}`);
            });
        } finally {
            await client.close();
        }
        return;
    }

    if (cmd !== 'upload') throw new Error(`unknown command: ${cmd}`);

    // collect files
    const files = [];
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') {
            const dir = argv[++i];
            for (const f of fs.readdirSync(dir)) {
                const p = path.join(dir, f);
                if (fs.statSync(p).isFile() && AUDIO_EXT.has(path.extname(f).slice(1).toLowerCase())) {
                    files.push(p);
                }
            }
        } else if (!a.startsWith('--')) {
            files.push(path.resolve(a));
        }
    }
    if (!files.length) throw new Error('no audio files given');

    for (const f of files) {
        if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    }
    log(`uploading ${files.length} file(s): ${files.map(f => path.basename(f)).join(', ')}`);

    const client = await SunoClient.open({});
    const results = [];
    try {
        for (const f of files) {
            try {
                const r = await uploadFile(client, f, null, {});
                results.push({ ...r, ok: true });
            } catch (e) {
                warn(`${path.basename(f)}: FAILED — ${e.message}`);
                results.push({ file: f, name: path.basename(f), ok: false, error: e.message });
            }
        }
    } finally {
        await client.close();
    }

    const outDir = path.join(__dirname, '..', 'data', 'suno', 'uploads');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifest = path.join(outDir, `uploads-${stamp}.json`);
    fs.writeFileSync(manifest, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

    const ok = results.filter(r => r.ok);
    log(`--- ${ok.length}/${results.length} uploaded ---`);
    ok.forEach(r => log(`  ${r.clipId}  ${r.name}`));
    log(`manifest: ${manifest}`);
}

if (require.main === module) {
    main().catch((e) => { warn(`FATAL ${e && e.message}`); process.exit(1); });
}

module.exports = { uploadFile, UPLOAD_TYPE, AUDIO_EXT };
