#!/usr/bin/env node
'use strict';
// tools/mj-style-routes.js
//
// THE STYLE API ROUTE — found by WATCHING the page that uses the feature.
//
// WHY THIS SHAPE OF PROBE
//
//   Guessing route names is expensive: the first sweep tried thirteen
//   candidates and every one 404'd. But a 404 from a guessed name
//   only proves THAT name is wrong.
//
//   The Style Creator page demonstrably USES the style feature — it
//   lists the account's styles as numeric ids and offers "Add
//   images". So its OWN network traffic names the route. Watching the
//   page load is a complete search, not a guess.
//
//   So: enable Network, load the page, and report every XHR/fetch
//   the page makes, with the response bodies of the JSON ones.
//
// Usage:
//   node tools/mj-style-routes.js [--port 9445]
//
// Exit: 0 routes were observed · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-routes] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-routes] ${m}\n`); }

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
    const events = [];
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
        } else if (m.method && /^Network\./.test(m.method)) {
            events.push(m);
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    log('loading the Style Creator page');
    await send('Page.navigate', { url: 'https://www.midjourney.com/style-creator' });
    await new Promise(r => setTimeout(r, 12000));

    // Collect the requests and their bodies.
    const reqs = new Map();
    for (const e of events) {
        if (e.method === 'Network.requestWillBeSent') {
            const r = e.params.request;
            reqs.set(e.params.requestId, {
                method: r.method, url: r.url, postData: (r.postData || ''),
                status: null, mime: '', type: e.params.type || '',
            });
        } else if (e.method === 'Network.responseReceived') {
            const r = reqs.get(e.params.requestId);
            if (r) { r.status = e.params.response.status; r.mime = e.params.response.mimeType || ''; }
        }
    }

    // Fetch the bodies of the JSON responses.
    const bodies = new Map();
    for (const [rid, r] of reqs) {
        if (!/json/i.test(r.mime || '')) continue;
        if (r.status && r.status >= 400) continue;
        try {
            const b = await send('Network.getResponseBody', { requestId: rid });
            bodies.set(rid, (b && b.body) || '');
        } catch (e) { /* the body may be gone */ }
    }

    log('');
    log(`--- ${reqs.size} request(s); ${bodies.size} with a JSON body ---`);
    for (const [rid, r] of reqs) {
        const isApi = /\/api\/|\/graphql/i.test(r.url);
        if (!isApi && !bodies.has(rid)) continue;
        log(`  ${r.method} ${r.status === null ? '---' : r.status} ${r.url.slice(0, 200)}`);
        if (r.postData) log(`      body: ${String(r.postData).replace(/\s+/g, ' ').slice(0, 300)}`);
        const body = bodies.get(rid);
        if (body) log(`      resp: ${body.replace(/\s+/g, ' ').slice(0, 600)}`);
    }

    // Also report every non-static XHR, so a route that answers 204
    // or 200-with-empty is not lost.
    log('');
    log('--- every XHR/fetch the page made ---');
    for (const r of reqs.values()) {
        if (r.type !== 'XHR' && r.type !== 'Fetch') continue;
        log(`  ${r.method} ${r.status === null ? '---' : r.status} ${r.url.slice(0, 200)}`);
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
