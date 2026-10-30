#!/usr/bin/env node
'use strict';
// lib/suno-fetch.js
//
// Fetch a finished Suno clip's audio to disk.
//
// The generation endpoint returns a clip id immediately; the audio appears
// later, and the URL it arrives on is only served to a browser that has the
// session (a plain fetch of the CDN URL answers 403). So the bytes are
// pulled in-page, the same way `lib/mj-download.js` pulls Midjourney's
// cells.
//
// CLI:
//   node lib/suno-fetch.js --clip <clipId> [--out <file.mp3>] [--port 9455]
//   node lib/suno-fetch.js --clip <clipId> --wait 600
//
// Exit: 0 ok · 1 fatal · 2 the clip has no audio yet

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');

const REPO = path.resolve(__dirname, '..');

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
    return null;
}

/**
 * Fetch one URL through the browser and write it to `dest`.
 *
 * In-page, because the CDN refuses a plain client: the bytes come back
 * base64-encoded so they survive the CDP bridge.
 */
async function fetchThroughBrowser(cdp, url, dest) {
    const b64 = await cdp.js(`(async () => {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) return 'ERR:' + r.status;
        const buf = await r.arrayBuffer();
        let s = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    })()`, true);
    if (typeof b64 !== 'string') throw new Error('no response from the browser');
    if (b64.startsWith('ERR:')) throw new Error(`fetch ${url} → ${b64}`);
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    return dest;
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };

    const clipId = flag('clip');
    if (!clipId) throw new Error('--clip <clipId> is required');
    // --wait is SECONDS. It was milliseconds once, which made the poll
    // loop exit before the first check could run.
    const waitMs = Number(flag('wait', 0)) * 1000;
    const outPath = path.resolve(REPO, flag('out', `data/suno/clips/${clipId}.mp3`));

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
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
            await sleep(10000);
        }
        if (!url) {
            const status = clip && (clip.status || (clip.metadata && clip.metadata.status));
            warn(`clip ${clipId} has no audio yet (status: ${status || 'unknown'})`);
            process.exit(2);
        }

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await fetchThroughBrowser(client.cdp, url, outPath);
        const bytes = fs.statSync(outPath).size;
        log(`saved ${path.relative(REPO, outPath)} (${(bytes / 1048576).toFixed(2)} MB)`);
        log(`source url: ${url}`);
        fs.writeFileSync(path.join(path.dirname(outPath), `${clipId}.json`), JSON.stringify({
            clipId, url, bytes, title: clip.title || null, fetchedAt: new Date().toISOString(),
        }, null, 2));
    } finally {
        await client.close();
    }
}

module.exports = { audioUrlOf, fetchThroughBrowser };

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn(`fatal: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}
