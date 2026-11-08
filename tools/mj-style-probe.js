#!/usr/bin/env node
'use strict';
// tools/mj-style-probe.js
//
// DOES THIS ACCOUNT HAVE A "SET AS STYLE" ROUTE? — probed, not assumed.
//
// WHY A PROBE AND NOT A GUESS
//
//   "Set as style prompt" is a button in the Midjourney studio UI. The
//   user pointed at a job URL and asked for its look to become a
//   reusable style reference. Two ways that can work:
//
//     A. A studio SERVER route that creates a style reference from a
//        job (something like /api/styles or /api/style/create). Then
//        the account owns the reference and it has its own id/URL.
//
//     B. NO server route — the studio's button may just copy a
//        --sref URL, and the style reference is really just a public
//        image URL you pass to --sref.
//
//   The repo already learned the hard way that guessing here is
//   expensive: the measured-behaviours reference records that probing
//   /api/characters answered 404 {"error":"No such API route"} — a 404
//   is a DISCOVERY, because it proves the feature does not exist
//   server-side.
//
//   So this probe asks the live account for a set of candidate routes
//   IN ONE CALL and reports which exist. No prompt is composed and
//   nothing is submitted: it is a GET sweep, and it costs no
//   generations.
//
// WHAT IT REPORTS
//
//   For each candidate route: the HTTP status, and — when it answers
//   200 — the shape of the body. A route that answers 405 (method not
//   allowed) EXISTS but wants a POST; that is a different finding from
//   404 and it matters, because it means the feature is there.
//
// Usage:
//   node tools/mj-style-probe.js [--port 9444]
//
// Exit: 0 at least one route exists · 2 no route exists · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9444'));

function log(m) { process.stdout.write(`[mj-style-probe] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-probe] ${m}\n`); }

// The candidate routes, grouped by what they would MEAN.
//
//   style-reference creation — the studio's own "set as style" action
//   style listing          — does the account already own style refs?
//   character routes       — the sibling feature, probed as a control
//   job routes             — the jobs themselves, as a control
//
// A CONTROL route is included on purpose: if the controls come back
// 404 too, then the probe is broken (bad session, wrong page), and a
// 404 on the style routes means nothing.
const CANDIDATES = [
    // create / set-as-style
    { path: '/api/styles',             group: 'style-create', method: 'GET' },
    { path: '/api/styles/create',      group: 'style-create', method: 'GET' },
    { path: '/api/styles/create/',     group: 'style-create', method: 'GET' },
    { path: '/api/style',              group: 'style-create', method: 'GET' },
    { path: '/api/style/create',       group: 'style-create', method: 'GET' },
    { path: '/api/style/create/',      group: 'style-create', method: 'GET' },
    { path: '/api/style-reference',    group: 'style-create', method: 'GET' },
    { path: '/api/style-reference/',   group: 'style-create', method: 'GET' },
    { path: '/api/style-references',   group: 'style-create', method: 'GET' },
    { path: '/api/style-references/',  group: 'style-create', method: 'GET' },
    { path: '/api/style/create-from-job', group: 'style-create', method: 'GET' },

    // listing
    { path: '/api/styles/list',        group: 'style-list', method: 'GET' },
    { path: '/api/styles/mine',        group: 'style-list', method: 'GET' },

    // controls
    { path: '/api/characters',         group: 'control', method: 'GET' },
    { path: '/api/character',          group: 'control', method: 'GET' },
    { path: '/api/jobs',               group: 'control', method: 'GET' },
    { path: '/api/imagine',            group: 'control', method: 'GET' },
];

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

/**
 * The in-page sweep.
 *
 * Runs in the page so the session cookies and the CSRF header apply —
 * a curl from outside gets a 403 for EVERY route, which would look
 * exactly like "no route exists". That is the whole reason this runs
 * in the browser.
 */
const SWEEP = (routes) => `(async () => {
  const routes = ${JSON.stringify(routes)};
  const out = [];
  for (const r of routes) {
    const rec = { path: r.path, method: r.method, group: r.group, status: 0, ok: false, body: '' };
    try {
      const res = await fetch(r.path, {
        method: r.method,
        headers: { 'X-CSRF-Protection': '1' },
        credentials: 'include',
      });
      rec.status = res.status;
      rec.ok = res.ok;
      const txt = await res.text();
      rec.body = (txt || '').slice(0, 240);
    } catch (e) {
      rec.status = 0;
      rec.body = 'threw: ' + String(e && e.message || e);
    }
    out.push(rec);
  }
  return out;
})()`;

async function main() {
    const targets = await listTargets();
    const page = targets.find(t => t.type === 'page' && /midjourney\.com/.test(t.url || ''));
    if (!page) {
        warn('no midjourney.com tab open on :' + PORT + ' — start the MJ browser first');
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

    const res = await send('Runtime.evaluate', {
        expression: SWEEP(CANDIDATES),
        awaitPromise: true,
        returnByValue: true,
    });
    const results = (res && res.result && res.result.value) || [];

    const byGroup = new Map();
    for (const r of results) {
        if (!byGroup.has(r.group)) byGroup.set(r.group, []);
        byGroup.get(r.group).push(r);
    }

    for (const [group, list] of byGroup) {
        log(`--- ${group} ---`);
        for (const r of list) {
            const verdict = r.status === 404 ? 'NO SUCH ROUTE'
                : r.status === 405 ? 'EXISTS (wants another method)'
                : r.status === 401 || r.status === 403 ? 'EXISTS (auth wanted)'
                : r.status === 200 ? 'EXISTS'
                : r.status === 0 ? 'threw'
                : `status ${r.status}`;
            log(`  ${r.method} ${r.path} -> ${r.status}  ${verdict}`);
            if (r.body && r.status !== 404) log(`      ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    }

    const controls = byGroup.get('control') || [];
    const controlsAlive = controls.filter(r => r.status && r.status !== 404);
    const styleRoutes = [...(byGroup.get('style-create') || []), ...(byGroup.get('style-list') || [])];
    const styleAlive = styleRoutes.filter(r => r.status && r.status !== 404);

    log('');
    if (!controlsAlive.length) {
        warn('every CONTROL route also 404s — the probe itself is broken (bad session or wrong page)');
        return 3;
    }
    log(`controls alive: ${controlsAlive.length}/${controls.length}`);
    log(`style routes alive: ${styleAlive.length}/${styleRoutes.length}`);
    for (const r of styleAlive) log(`  -> ${r.method} ${r.path} (${r.status})`);

    return styleAlive.length ? 0 : 2;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`probe failed: ${e.message}`); process.exit(3); });
