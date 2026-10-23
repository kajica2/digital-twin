#!/usr/bin/env node
// lib/treblo.js — a client for the Treblo (formerly Sonauto) music API.
//
// https://treblo.com/developers/docs
//
// The contract this follows, in the API's own words:
//
//   POST /v1/generations/v3        → { task_id }
//   GET  /v1/generations/status/:id → { status }
//   GET  /v1/generations/:id        → { song_paths: [ … ] }
//
// Every v3 generation costs 100 credits. The song URLs EXPIRE, so a
// generation is not finished until the audio has been downloaded — a
// catalogue that only holds a URL is a catalogue of dead links.
//
// The API key is never in this repo. It is read from the environment
// (TREBLO_API_KEY) or from `~/.treblo-api-key` (0600, outside the
// repo, alongside the cookie jar). Nothing here ever prints it.
//
// Usage:
//   node lib/treblo.js --prompt-file <pack.md> --out <dir> [--instrumental]
//   node lib/treblo.js --prompt "<text>" --out <dir> [--dry-run]
//
// The pack format is the repo's own: one top-level bullet per prompt,
// frontmatter / blockquotes / code fences ignored.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_BASE = 'https://api.treblo.com/v1';
const KEY_FILE = '.treblo-api-key';
const CREDITS_PER_GENERATION = 100;

// ---------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------

// The API key, from the environment or from `~/.treblo-api-key`.
// Throws a NO_KEY error with the fix when neither is usable — a
// missing key is a setup problem, not a network one, and the message
// should say so.
function apiKey(opts = {}) {
    const env = opts.env || process.env;
    const home = opts.home || os.homedir();
    const fromEnv = (env.TREBLO_API_KEY || '').trim();
    if (fromEnv) return fromEnv;

    const file = path.join(home, KEY_FILE);
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw noKeyError(`no key at ${file}`);
    }
    // A stray literal backslash-n (a heredoc that ate its escape) is
    // how a key file usually breaks — strip it rather than sending a
    // key the server will reject as invalid.
    const key = raw.replace(/\\n/g, '').trim();
    if (!key) throw noKeyError(`${file} is empty`);
    return key;
}

function noKeyError(detail) {
    const e = new Error(`NO_KEY: ${detail}. Put the key in the TREBLO_API_KEY environment variable or in ~/${KEY_FILE}.`);
    e.code = 'NO_KEY';
    return e;
}

// ---------------------------------------------------------------------
// the pack reader
// ---------------------------------------------------------------------

// One prompt per top-level bullet. Frontmatter, blockquotes and code
// fences are skipped — the same convention the Midjourney packs use.
function readPrompts(md) {
    const out = [];
    const lines = String(md || '').split(/\r?\n/);
    let inFence = false;
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
        if (inFrontmatter) { if (line.trim() === '---') inFrontmatter = false; continue; }
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        if (/^\s*>/.test(line)) continue;
        const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
        if (m) out.push(m[1].trim());
    }
    return out;
}

// A filename-safe slug for a prompt.
function slugify(text, max = 48) {
    const s = String(text || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return (s || 'prompt').slice(0, max).replace(/-+$/, '');
}

// ---------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------

class Treblo {
    constructor(opts = {}) {
        this.base = (opts.base || API_BASE).replace(/\/+$/, '');
        this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
        this._key = opts.apiKey || null;
    }

    key() {
        if (!this._key) this._key = apiKey();
        return this._key;
    }

    async request(method, url, body) {
        const headers = {
            'Authorization': `Bearer ${this.key()}`,
            'Accept': 'application/json',
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await this.fetch(url.startsWith('http') ? url : `${this.base}${url}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        if (!res.ok) {
            let detail = json && json.detail ? String(json.detail) : text.slice(0, 200);
            let code = null;
            if (res.status === 402) {
                code = 'OUT_OF_CREDITS';
                detail = `${detail} — the account has no credits; activate the free trial at https://treblo.com/developers/account`;
            }
            // The MESSAGE carries the fix, not only the detail: the CLI
            // prints the message, so a hint that lives in `detail` is a
            // hint nobody reads.
            const err = new Error(`treblo ${method} ${url} → HTTP ${res.status}: ${detail}`);
            err.status = res.status;
            err.detail = detail;
            if (code) err.code = code;
            throw err;
        }
        return json;
    }

    // POST /generations/v3 → { task_id }
    //
    // The recommended call is prompt-only: the model infers tags,
    // lyrics and the strength settings. `instrumental: true` and NO
    // lyrics is the documented way to ask for an instrumental.
    generate(opts = {}) {
        const payload = { prompt: opts.prompt };
        if (opts.instrumental) payload.instrumental = true;
        if (opts.lyrics) payload.lyrics = opts.lyrics;
        if (opts.tags && opts.tags.length) payload.tags = opts.tags;
        if (opts.negativeTags && opts.negativeTags.length) payload.negative_tags = opts.negativeTags;
        if (opts.lengthRange) payload.length_range = opts.lengthRange;
        if (opts.outputFormat) payload.output_format = opts.outputFormat;
        if (opts.outputBitRate) payload.output_bit_rate = opts.outputBitRate;
        if (opts.styleScale !== undefined) payload.style_scale = opts.styleScale;
        if (opts.promptStrength !== undefined) payload.prompt_strength = opts.promptStrength;
        if (opts.webhookUrl) payload.webhook_url = opts.webhookUrl;
        // An instrumental must not carry lyrics.
        if (payload.instrumental) delete payload.lyrics;
        return this.request('POST', '/generations/v3', payload);
    }

    // GET /generations/status/:id → { status }
    status(taskId) {
        return this.request('GET', `/generations/status/${encodeURIComponent(taskId)}`);
    }

    // GET /generations/:id → { song_paths: [ … ] }
    generation(taskId) {
        return this.request('GET', `/generations/${encodeURIComponent(taskId)}`);
    }

    // Poll until the task reports SUCCESS or FAILURE.
    async waitFor(taskId, opts = {}) {
        const intervalMs = opts.intervalMs || 5000;
        const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
        const onStatus = opts.onStatus || (() => {});
        const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const started = Date.now();
        let last = null;
        for (;;) {
            const res = await this.status(taskId);
            const st = res && typeof res.status === 'string' ? res.status : (res && res.status);
            last = st;
            onStatus(st, res);
            if (st === 'SUCCESS' || st === 'FAILURE') return { status: st, raw: res };
            if (Date.now() - started > timeoutMs) {
                const e = new Error(`treblo task ${taskId} timed out after ${Math.round((Date.now() - started) / 1000)}s (last status: ${last})`);
                e.code = 'TIMEOUT';
                throw e;
            }
            await sleep(intervalMs);
        }
    }

    // Download a song URL to disk. The URLs expire, so this is not
    // optional in a pipeline.
    async download(url, dest) {
        const res = await this.fetch(url);
        if (!res.ok) throw new Error(`treblo download ${url} → HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        return { path: dest, bytes: buf.length };
    }
}

// ---------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------

// One prompt → one song, downloaded. Returns the catalogue entry.
async function generateOne(client, prompt, opts = {}) {
    const index = opts.index || 0;
    const outDir = opts.outDir;
    const instrumental = opts.instrumental !== false;
    const format = opts.format || 'mp3';

    const task = await client.generate({ prompt, instrumental });
    const taskId = task && task.task_id;
    if (!taskId) throw new Error('treblo did not return a task_id');

    const { status } = await client.waitFor(taskId, {
        intervalMs: opts.intervalMs,
        timeoutMs: opts.timeoutMs,
        onStatus: (st) => opts.onStatus && opts.onStatus(st),
    });
    if (status !== 'SUCCESS') {
        const e = new Error(`treblo task ${taskId} finished with status ${status}`);
        e.code = 'GENERATION_FAILED';
        throw e;
    }

    const gen = await client.generation(taskId);
    const urls = (gen && gen.song_paths) || [];
    if (!urls.length) throw new Error(`treblo task ${taskId} reported SUCCESS but carried no song_paths`);

    const entry = {
        index,
        prompt,
        taskId,
        instrumental,
        format,
        songPaths: urls,
        status,
    };

    if (outDir && opts.download !== false) {
        const base = `${String(index + 1).padStart(2, '0')}-${slugify(prompt)}`;
        const dest = path.join(outDir, `${base}.${format}`);
        const saved = await client.download(urls[0], dest);
        entry.file = saved.path;
        entry.bytes = saved.bytes;
    }
    return entry;
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

function parseArgs(argv) {
    const out = { limit: 0, instrumental: true, format: 'mp3', download: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => argv[++i];
        if (a === '--prompt-file') out.promptFile = val();
        else if (a === '--prompt') out.prompt = val();
        else if (a === '--out') out.outDir = val();
        else if (a === '--limit') out.limit = parseInt(val(), 10) || 0;
        else if (a === '--instrumental') out.instrumental = true;
        else if (a === '--vocal') out.instrumental = false;
        else if (a === '--format') out.format = val();
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--no-download') out.download = false;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

const USAGE = `treblo — generate songs with the Treblo (Melodia v3) API

  node lib/treblo.js --prompt-file <pack.md> --out <dir> [--instrumental]
  node lib/treblo.js --prompt "<text>" --out <dir> [--dry-run]

  --prompt-file <file>   a pack: one top-level bullet per prompt
  --prompt "<text>"      a single prompt
  --out <dir>            where the audio + catalog.json are written
  --instrumental         instrumental (the default)
  --vocal                allow lyrics (the model writes them)
  --format <fmt>         mp3 (default) | ogg | flac | wav | m4a
  --limit <n>            only the first n prompts
  --no-download          do not fetch the audio (the URLs expire)
  --dry-run              show the plan, spend nothing
  --json                 machine-readable output

The key comes from $TREBLO_API_KEY or ~/${KEY_FILE}. Never in the repo.`;

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }

    let prompts = [];
    if (args.promptFile) {
        const abs = path.resolve(args.promptFile);
        if (!fs.existsSync(abs)) {
            process.stderr.write(`treblo: no such pack: ${abs}\n`);
            return 2;
        }
        prompts = readPrompts(fs.readFileSync(abs, 'utf8'));
    }
    if (args.prompt) prompts.push(args.prompt);
    if (!prompts.length) {
        process.stderr.write('treblo: nothing to generate — pass --prompt-file or --prompt\n');
        return 2;
    }
    if (args.limit > 0) prompts = prompts.slice(0, args.limit);

    if (args.dryRun) {
        const plan = prompts.map((p, i) => ({ index: i + 1, prompt: p, instrumental: args.instrumental, format: args.format }));
        if (args.json) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return 0; }
        for (const p of plan) process.stdout.write(`${p.index}. ${p.prompt.slice(0, 90)}…\n`);
        process.stdout.write(`\n${plan.length} prompt(s) — ${plan.length * CREDITS_PER_GENERATION} credits (dry run, nothing spent)\n`);
        return 0;
    }

    const outDir = path.resolve(args.outDir || path.join(process.cwd(), 'data', 'treblo', 'out'));
    fs.mkdirSync(outDir, { recursive: true });

    const client = new Treblo();
    const entries = [];
    for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        process.stdout.write(`[${i + 1}/${prompts.length}] ${prompt.slice(0, 72)}…\n`);
        try {
            const entry = await generateOne(client, prompt, {
                index: i,
                outDir,
                instrumental: args.instrumental,
                format: args.format,
                download: args.download,
                onStatus: (st) => process.stdout.write(`    status: ${st}\n`),
            });
            entries.push(entry);
            process.stdout.write(`    ✓ ${entry.taskId}${entry.file ? ` → ${path.basename(entry.file)} (${entry.bytes} bytes)` : ''}\n`);
        } catch (e) {
            process.stderr.write(`    ✗ ${e.message}\n`);
            if (e.code === 'OUT_OF_CREDITS') {
                process.stderr.write('    the account has no credits — a v3 generation costs 100.\n');
                return 3;
            }
            entries.push({ index: i + 1, prompt, error: e.message });
        }
    }

    const catalog = {
        generatedAt: new Date().toISOString(),
        source: args.promptFile ? path.basename(args.promptFile) : 'inline',
        instrumental: args.instrumental,
        format: args.format,
        count: entries.length,
        items: entries,
    };
    fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
    if (args.json) process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
    else process.stdout.write(`\n${entries.filter((e) => !e.error).length}/${entries.length} generated → ${outDir}\n`);
    return entries.some((e) => e.error) ? 1 : 0;
}

module.exports = {
    Treblo, apiKey, readPrompts, slugify, generateOne, parseArgs,
    API_BASE, CREDITS_PER_GENERATION,
};

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => {
        process.stderr.write(`treblo: ${e.message}\n`);
        process.exit(1);
    });
}
