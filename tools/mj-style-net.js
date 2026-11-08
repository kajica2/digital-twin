#!/usr/bin/env node
'use strict';
// tools/mj-style-net.js
//
// WHAT DOES THE "STYLE REFERENCE" BUTTON DO? — watch the network.
//
// WHY THE NETWORK IS THE ANSWER
//
//   Pressing the button changed nothing visible: no dialog, no new
//   chip, the composer's --sref chip unchanged. So the effect, if
//   there is one, is a request the page made in the background — and
//   the ROUTE is what tells us whether the account mints a style
//   reference server-side (which the earlier route probe said it does
//   not) or the page merely rewrites the composer.
//
//   This tool enables the Network domain, presses the button, and
//   reports every request the page made with its method, URL and
//   status. The one that carries a response body naming a style is
//   the mechanism.
//
// Usage:
//   node tools/mj-style-net.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the press was observed · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-net] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-net] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-net.js <jobId> [--port 9445] [--cell 0_0]');
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

const OPEN = `(() => {
  const JOB = ${JSON.stringify(JOB)};
  const CELL = ${JSON.stringify(CELL)};
  const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('/' + JOB + '/'));
  if (!imgs.length) return { ok: false, why: 'no image for this job on the page' };
  const exact = imgs.find(i => (i.src || '').includes('/' + CELL + '_')) || imgs[0];
  const src = exact.src;
  exact.click();
  return { ok: true, src: src };
})()`;

const PRESS = `(() => {
  const b = [...document.querySelectorAll('button, [role="button"]')].find(x => {
    const l = (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === 'Style Reference';
  });
  if (!b) return { ok: false };
  b.click();
  return { ok: true };
})()`;

/** The composer, plus any toast, after the press. */
const AFTER = `(() => {
  const out = { composer: '', toasts: [], chips: [], srefIds: [] };
  const ta = document.querySelector('textarea');
  out.composer = (ta && ta.value) || '';
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [data-testid*="toast"], [class*="toast"]')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t && t.length < 300) out.toasts.push(t);
  }
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (/sref/i.test(t) && t.length < 100 && !out.chips.includes(t)) out.chips.push(t);
    const m = t.match(/\b(\d{8,12})\b/);
    if (m && !out.srefIds.includes(m[1])) out.srefIds.push(m[1]);
  }
  return out;
})()`;

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

    log('opening the job page');
    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    // Clear what the page did on load, so only the press's traffic is reported.
    events.length = 0;

    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    if (!open.ok) { warn('could not open the cell: ' + (open.why || '?')); return 3; }
    log('opened: ' + open.src);
    await new Promise(r => setTimeout(r, 2500));

    log('pressing "Style Reference" …');
    const p = await send('Runtime.evaluate', { expression: PRESS, returnByValue: true });
    const pr = (p && p.result && p.result.value) || {};
    if (!pr.ok) { warn('no "Style Reference" button found'); return 4; }
    await new Promise(r => setTimeout(r, 6000));

    // ---- the requests made by the press -----------------------------
    const reqs = new Map();
    for (const e of events) {
        if (e.method === 'Network.requestWillBeSent') {
            const r = e.params.request;
            reqs.set(e.params.requestId, {
                method: r.method,
                url: r.url,
                postData: (r.postData || '').slice(0, 400),
                status: null,
                type: e.params.type || '',
            });
        } else if (e.method === 'Network.responseReceived') {
            const r = reqs.get(e.params.requestId);
            if (r) { r.status = e.params.response.status; r.mime = e.params.response.mimeType || ''; }
        }
    }

    log('');
    log(`--- ${reqs.size} request(s) during the press ---`);
    for (const r of reqs.values()) {
        // Only the interesting ones: a JSON API call, or anything with a body.
        const interesting = /\/api\/|\/graphql|\/v[0-9]/i.test(r.url) || r.postData;
        if (!interesting) continue;
        log(`  ${r.method} ${r.status === null ? '---' : r.status} ${r.url.slice(0, 160)}`);
        if (r.postData) log(`      body: ${r.postData.replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    // ---- the composer's state ---------------------------------------
    const a = await send('Runtime.evaluate', { expression: AFTER, returnByValue: true });
    const d = (a && a.result && a.result.value) || {};
    log('');
    log('--- composer after the press ---');
    log('  ' + (d.composer || '(empty)').slice(0, 400));
    log('');
    log('--- toasts ---');
    for (const t of d.toasts || []) log(`  ${t}`);
    log('');
    log('--- sref chips ---');
    for (const c of d.chips || []) log(`  ${c}`);
    log('');
    log('--- numeric ids on the page ---');
    log('  ' + (d.srefIds || []).join(', '));

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
