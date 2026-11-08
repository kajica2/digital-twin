#!/usr/bin/env node
'use strict';
// tools/mj-fetch-url.js
//
// FETCH ONE URL THROUGH THE BROWSER — the CDN and s.mj.run challenge curl.
//
// WHY
//
//   The MJ CDN answers curl and headless clients with a Cloudflare
//   403, so the bytes have to come through the real browser that is
//   already logged in. `lib/mj-fetch-fullres.js` does this for grid
//   cells; this does it for ANY url — including an `s.mj.run` style
//   reference, which is the thing this sprint needs to LOOK at.
//
//   Usage:
//     node tools/mj-fetch-url.js <url> <out.png> [--port 9445]
//
//   Exit: 0 written · 2 bad input · 3 the browser refused

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const URL_ = ARGV[0];
const OUT = ARGV[1];
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-fetch-url] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-fetch-url] ${m}\n`); }

if (!URL_ || !OUT) {
    warn('usage: mj-fetch-url.js <url> <out.png> [--port 9445]');
    process.exit(2);
}

function listTargets() {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 6000 }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

async function main() {
    const targets = await listTargets();
    const page = targets.find(t => t.type === 'page' && /midjourney\.com/.test(t.url || ''));
    if (!page) {
        warn('no midjourney.com tab open on :' + PORT);
        return 3;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((rs, rj) => {
        const i = ++id;
        pending.set(i, { rs, rj });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await new Promise((rs, rj) => {
        if (ws.readyState === 1) return rs();
        ws.addEventListener('open', () => rs(), { once: true });
        ws.addEventListener('error', () => rj(new Error('websocket error')), { once: true });
    });
    ws.addEventListener('message', ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) p.rj(new Error(m.error.message));
            else p.rs(m.result);
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');

    // Fetch in the page, so the session and the CDN's clearance apply.
    const expr = `(async () => {
      const url = ${JSON.stringify(URL_)};
      try {
        const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        const b = await r.blob();
        const buf = new Uint8Array(await b.arrayBuffer());
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        }
        return { ok: r.ok, status: r.status, type: b.type, size: buf.length, b64: btoa(bin) };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()`;

    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const d = (res && res.result && res.result.value) || {};
    if (!d.ok) {
        warn(`fetch failed: status ${d.status || 0} ${d.error || ''}`);
        return 3;
    }

    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), Buffer.from(d.b64, 'base64'));
    log(`wrote ${path.resolve(OUT)}  (${d.type}, ${d.size} bytes, status ${d.status})`);
    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
