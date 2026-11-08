#!/usr/bin/env node
'use strict';
// tools/treblo-run.js
//
// Run ONE treblo generation and download the audio.
//
// WHY THIS EXISTS
//
//   The repo's own client (`lib/treblo.js`, restored from git history)
//   was removed in 77e3c65 along with the API key. The key is back (the
//   developer account can mint one at treblo.com/developers/account),
//   so the client works again — and this wrapper is the thin layer that
//   runs ONE prompt, waits for the task, downloads the audio, and PROBES
//   it.
//
// THE CONTRACT (treblo.com/developers/docs, measured 2026-11-05)
//
//   POST /v1/generations/v3        → { task_id }
//   GET  /v1/generations/status/:id → a BARE JSON STRING ("GENERATING")
//   GET  /v1/generations/:id        → { song_paths: [ … ] }
//   GET  /v1/credits/balance        → { num_credits, num_credits_payg }
//
//   Request fields: prompt, lyrics, tags, negative_tags, instrumental,
//   prompt_strength, style_scale, BALANCE_STRENGTH, num_songs,
//   output_format, output_bit_rate, length_range, align_lyrics,
//   model_version.
//
//   balance_strength is the voice-vs-music control: "Greater means more
//   natural vocals. Lower means sharper instrumentals. We recommend 0.7."
//
//   The song URLs EXPIRE, so a generation is not finished until the
//   audio is on disk.
//
// Usage:
//   node tools/treblo-run.js --prompt "<text>" --out <dir> [options]
//
//     --prompt <text>          the song idea (required)
//     --out <dir>              where the audio lands (default data/treblo/run)
//     --lyrics <text>          explicit lyrics
//     --instrumental           instrumental: true
//     --tags a,b,c             style tags
//     --negative-tags a,b,c    tags to avoid
//     --balance <float>        balance_strength (voice vs music)
//     --prompt-strength <f>    prompt_strength
//     --style-scale <f>        style_scale
//     --length <min,max>       length_range in seconds
//     --format <fmt>           output_format (mp3 | ogg | wav | flac | m4a)
//     --bitrate <n>            output_bit_rate
//     --model <v>              model_version
//     --dry-run                print the request, spend nothing
//
// Exit: 0 the audio is on disk · 2 bad input · 3 the generation failed

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const has = (f) => ARGV.includes(f);

const API = 'https://api.treblo.com/v1';
const REPO = path.resolve(__dirname, '..');
const KEY_FILE = path.join(os.homedir(), '.treblo-api-key');

function log(m) { process.stdout.write(`[treblo-run] ${m}\n`); }
function warn(m) { process.stderr.write(`[treblo-run] ${m}\n`); }

function apiKey() {
    const env = (process.env.TREBLO_API_KEY || '').trim();
    if (env) return env;
    const raw = fs.readFileSync(KEY_FILE, 'utf8').replace(/\\n/g, '').trim();
    if (!raw) throw new Error(`no key at ${KEY_FILE}`);
    return raw;
}

async function api(method, endpoint, body) {
    const headers = { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${endpoint}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
        const detail = json && json.detail ? String(json.detail) : text.slice(0, 300);
        const err = new Error(`treblo ${method} ${endpoint} → HTTP ${res.status}: ${detail}`);
        err.status = res.status;
        if (res.status === 402) err.code = 'OUT_OF_CREDITS';
        throw err;
    }
    return json;
}

/** The status endpoint answers with a BARE JSON STRING. */
function normalizeStatus(res) {
    if (typeof res === 'string') return res.trim();
    if (res && typeof res === 'object') {
        if (typeof res.status === 'string') return res.status.trim();
        if (typeof res.state === 'string') return res.state.trim();
    }
    return 'UNKNOWN';
}

const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED',
    'EXPIRED', 'REJECTED', 'REFUSED']);

function slugify(text, max = 48) {
    const s = String(text || '').toLowerCase().replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || 'prompt').slice(0, max).replace(/-+$/, '');
}

function probeDuration(file) {
    try {
        const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'csv=p=0', file], { encoding: 'utf8' });
        const s = Number(String(out).trim());
        return Number.isFinite(s) ? Math.round(s * 10) / 10 : null;
    } catch (e) { return null; }
}

async function main() {
    const prompt = argVal('--prompt', null);
    if (!prompt) { warn('--prompt is required'); return 2; }
    const outDir = path.resolve(argVal('--out', path.join(REPO, 'data/treblo/run')));

    const payload = { prompt };
    if (argVal('--lyrics')) payload.lyrics = argVal('--lyrics');
    if (has('--instrumental')) payload.instrumental = true;
    const tags = argVal('--tags');
    if (tags) payload.tags = tags.split(',').map(s => s.trim()).filter(Boolean);
    const neg = argVal('--negative-tags');
    if (neg) payload.negative_tags = neg.split(',').map(s => s.trim()).filter(Boolean);
    if (argVal('--balance')) payload.balance_strength = Number(argVal('--balance'));
    if (argVal('--prompt-strength')) payload.prompt_strength = Number(argVal('--prompt-strength'));
    if (argVal('--style-scale')) payload.style_scale = Number(argVal('--style-scale'));
    if (argVal('--model')) payload.model_version = argVal('--model');
    if (argVal('--format')) payload.output_format = argVal('--format');
    if (argVal('--bitrate')) payload.output_bit_rate = Number(argVal('--bitrate'));
    const len = argVal('--length');
    if (len) payload.length_range = len.split(',').map(s => Number(s.trim()));

    if (has('--dry-run')) {
        log('--- request body ---');
        log(JSON.stringify(payload, null, 2));
        const bal = await api('GET', '/credits/balance');
        log(`credits: ${bal.num_credits} (payg ${bal.num_credits_payg})`);
        return 0;
    }

    const bal = await api('GET', '/credits/balance');
    log(`credits before: ${bal.num_credits}`);

    const task = await api('POST', '/generations/v3', payload);
    const taskId = task && task.task_id;
    if (!taskId) throw new Error('treblo did not return a task_id');
    log(`task: ${taskId}`);

    // Poll. The status endpoint answers a BARE STRING.
    const deadline = Date.now() + 15 * 60 * 1000;
    let status = 'UNKNOWN';
    while (Date.now() < deadline) {
        status = normalizeStatus(await api('GET', `/generations/status/${encodeURIComponent(taskId)}`));
        if (status !== status) log('status: ' + status);
        if (TERMINAL.has(status.toUpperCase())) break;
        await new Promise(r => setTimeout(r, 5000));
    }
    log(`final status: ${status}`);
    if (status.toUpperCase() !== 'SUCCESS') {
        const e = new Error(`task ${taskId} finished with status ${status}`);
        e.code = 'GENERATION_FAILED';
        throw e;
    }

    const gen = await api('GET', `/generations/${encodeURIComponent(taskId)}`);
    const urls = (gen && gen.song_paths) || [];
    if (!urls.length) throw new Error(`task ${taskId} reported SUCCESS but carried no song_paths`);

    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        // The extension comes from the URL that came BACK, not from the
        // requested format — the API answers with what it answers with.
        const m = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
        const ext = (m && m[1].toLowerCase()) || 'ogg';
        const dest = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${slugify(prompt)}.${ext}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download → HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest, buf);
        const dur = probeDuration(dest);
        results.push({ file: dest, bytes: buf.length, seconds: dur });
        log(`saved ${path.basename(dest)} — ${(buf.length / 1024).toFixed(0)} KB, ${dur ?? '?'}s`);
    }

    const after = await api('GET', '/credits/balance');
    log(`credits after: ${after.num_credits}`);

    const meta = {
        taskId,
        prompt,
        request: payload,
        status,
        tracks: results.map(r => ({ file: path.relative(REPO, r.file), bytes: r.bytes, seconds: r.seconds })),
        creditsBefore: bal.num_credits,
        creditsAfter: after.num_credits,
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(meta, null, 2));
    log(`catalog → ${path.join(outDir, 'catalog.json')}`);
    return 0;
}

if (require.main === module) {
    main()
        .then(c => process.exit(c))
        .catch(e => { warn(e.message); if (e.code) warn(`code: ${e.code}`); process.exit(3); });
}
