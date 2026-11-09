#!/usr/bin/env node
'use strict';
// lib/treblo-upload.js
//
// Batch-upload audio files to Treblo's developer API.
//
//     POST https://api.treblo.com/v1/uploads
//     Authorization: Bearer <TREBLO_API_KEY>
//     Content-Type: multipart/form-data   field: file
//     → { "audio_upload_id": "<uuid>" }
//
// WHY THIS EXISTS
//
// The 29 tracks cut from "Traditional Music of Western Serbia" (see
// `docs/AUDIO-SPLITTER.md`) need to reach Treblo so they can be used as
// references for new generations. The endpoint is documented and simple;
// what is not simple is doing it for a folder of files without losing
// track of what came back.
//
// So the tool reports every id, writes a JSON report, and refuses a
// flag it does not understand — a paid-quota CLI that silently ignores
// what it does not understand is how `--help` once started a real render
// in this repo.
//
// An upload costs no credits: it is a file being stored, not a song
// being generated. `GET /v1/credits/balance` is what moves.
//
// The key comes from TREBLO_API_KEY or ~/.treblo-api-key — never from
// the command line, where every process on the machine can read it.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const API_BASE = 'https://api.treblo.com/v1';
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.treblo-api-key');
const REPORT_PATH = path.join('data', 'treblo', 'uploads.json');

/**
 * The API key: the environment first, then the key file.
 * @returns {string|null}
 */
function apiKey(env = process.env) {
    if (env.TREBLO_API_KEY) return env.TREBLO_API_KEY.trim();
    const file = env.TREBLO_API_FILE || DEFAULT_KEY_FILE;
    try {
        const value = fs.readFileSync(file, 'utf8').trim();
        return value || null;
    } catch (e) {
        return null;
    }
}

/**
 * Parse argv. An unknown flag is an error, never a no-op.
 * @returns {{files: string[], flags: object, error: string|null}}
 */
function parseArgs(argv) {
    const flags = { dryRun: false, json: false, out: REPORT_PATH, delayMs: 0 };
    const files = [];
    let error = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') { flags.dryRun = true; continue; }
        if (arg === '--json') { flags.json = true; continue; }
        if (arg === '--out' || arg === '--delay-ms') {
            const value = argv[++i];
            if (value === undefined) { error = `flag ${arg} needs a value`; continue; }
            if (arg === '--out') flags.out = value;
            else flags.delayMs = Number(value) || 0;
            continue;
        }
        if (arg.startsWith('-')) { error = `unknown flag: ${arg}`; continue; }
        files.push(arg);
    }
    return { files, flags, error };
}

/**
 * Upload one file.
 * @returns {Promise<{file: string, id: string|null, bytes: number, error: string|null}>}
 */
async function uploadOne(file, key, { fetchImpl = globalThis.fetch, base = API_BASE } = {}) {
    const abs = path.resolve(file);
    let bytes = 0;
    try {
        bytes = fs.statSync(abs).size;
    } catch (e) {
        return { file, id: null, bytes: 0, error: `no such file: ${file}` };
    }
    const data = fs.readFileSync(abs);
    const form = new FormData();
    form.append('file', new Blob([data]), path.basename(abs));
    const res = await fetchImpl(`${base}/uploads`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Accept': 'application/json',
        },
        body: form,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
        const detail = (json && json.detail) ? String(json.detail) : text.slice(0, 200);
        return { file, id: null, bytes, error: `HTTP ${res.status}: ${detail}` };
    }
    const id = json && json.audio_upload_id ? json.audio_upload_id : null;
    return { file, id, bytes, error: id ? null : 'the response carried no audio_upload_id' };
}

/**
 * Upload a list of files, in order, and report every result.
 */
async function uploadAll(files, key, opts = {}) {
    const results = [];
    for (const file of files) {
        const result = await uploadOne(file, key, opts);
        results.push(result);
        if (opts.onResult) opts.onResult(result);
        if (opts.delayMs && result.error === null) {
            await new Promise(r => setTimeout(r, opts.delayMs));
        }
    }
    return results;
}

function usage() {
    return [
        'treblo-upload — batch-upload audio files to Treblo',
        '',
        'usage: node lib/treblo-upload.js <file...> [--out report.json] [--json]',
        '       node lib/treblo-upload.js --check',
        '',
        'the key comes from TREBLO_API_KEY or ~/.treblo-api-key (never from the command line)',
        'uploads cost no credits; only generation does',
    ].join('\n');
}

/**
 * The state of the connection to Treblo: the developer API (the key) and
 * the web session (the cookie jar), if there is one.
 */
async function checkConnection(opts = {}) {
    const out = { api: null, session: null, files: {} };
    // an explicit null means "no key"; only fall back when the option is absent
    const key = ('apiKey' in opts) ? opts.apiKey : apiKeyFromEnv();
    if (!key) {
        out.api = { ok: false, error: 'no key — set TREBLO_API_KEY or write ~/.treblo-api-key' };
    } else {
        const res = await (opts.fetchImpl || globalThis.fetch)(
            `${opts.base || API_BASE}/credits/balance`,
            { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
        );
        let body = null;
        try { body = await res.json(); } catch { /* not json */ }
        out.api = { ok: res.ok, status: res.status, credits: body ? body.num_credits : null };
    }
    const jar = opts.cookieFile || path.join(os.homedir(), '.treblo-cookies.txt');
    try {
        const text = fs.readFileSync(jar, 'utf8');
        const names = text.split('\n')
            .filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7)
            .map(l => l.split('\t')[5]);
        const auth = names.find(n => n === 'sb-db-auth-token' || n.startsWith('sb-db-auth-token.'));
        out.session = {
            ok: Boolean(auth),
            file: jar,
            cookies: names.length,
            authCookie: auth || null,
            note: auth
                ? 'the session cookie is present — the app API is behind Cloudflare, so it needs a browser'
                : 'no session cookie — export one from a signed-in browser',
        };
    } catch (e) {
        out.session = { ok: false, file: jar, error: 'no cookie jar' };
    }
    return out;
}

function apiKeyFromEnv() {
    if (process.env.TREBLO_API_KEY) return process.env.TREBLO_API_KEY.trim();
    try {
        return fs.readFileSync(path.join(os.homedir(), '.treblo-api-key'), 'utf8').trim() || null;
    } catch (e) {
        return null;
    }
}

async function main(argv) {
    if (argv[0] === '--check') {
        const state = await checkConnection();
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
        return state.api && state.api.ok ? 0 : 1;
    }
    const { files, flags, error } = parseArgs(argv);
    if (error) {
        process.stderr.write(`treblo-upload: ${error}\n`);
        return 2;
    }
    if (!files.length) {
        process.stdout.write(usage() + '\n');
        return 0;
    }
    const key = apiKey();
    if (!key) {
        process.stderr.write(
            'treblo-upload: no API key.\n' +
            '  set TREBLO_API_KEY, or put the key in ~/.treblo-api-key (mode 0600)\n'
        );
        return 2;
    }
    if (flags.dryRun) {
        const plan = files.map(f => ({ file: f, bytes: fs.existsSync(f) ? fs.statSync(f).size : null }));
        if (flags.json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
        else {
            process.stdout.write(`treblo-upload: ${plan.length} file(s) would be uploaded\n`);
            for (const p of plan) process.stdout.write(`  ${p.file}  ${p.bytes ?? 'missing'} bytes\n`);
        }
        return 0;
    }
    const results = await uploadAll(files, key, {
        delayMs: flags.delayMs,
        onResult: (r) => {
            if (!flags.json) {
                process.stderr.write(`  ${r.error ? '✗' : '✓'} ${path.basename(r.file)}  ${r.id || r.error}\n`);
            }
        },
    });
    const ok = results.filter(r => r.id).length;
    const failed = results.length - ok;
    const report = {
        endpoint: `${API_BASE}/uploads`,
        uploadedAt: new Date().toISOString(),
        uploaded: ok,
        failed,
        results,
    };
    const outPath = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    if (flags.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
        process.stdout.write(`treblo-upload: ${ok} uploaded, ${failed} failed — report in ${outPath}\n`);
    }
    return failed ? 1 : 0;
}

module.exports = { apiKey, parseArgs, uploadOne, uploadAll, checkConnection, usage, API_BASE, REPORT_PATH };

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code));
}
