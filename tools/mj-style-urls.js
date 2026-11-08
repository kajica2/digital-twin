#!/usr/bin/env node
'use strict';
// tools/mj-style-urls.js
//
// WHAT URL FORMS DOES THIS ACCOUNT USE FOR --sref? — read off the feed.
//
// WHY THE FEED IS THE ANSWER KEY
//
//   The style probe found NO server-side route for "set as style" (13
//   candidate routes 404; the control route answers, so the probe
//   works). So a style reference on this account is a URL handed to
//   --sref, not an object the account owns.
//
//   The remaining question is WHICH URL. The artist's own jobs carry
//   their --sref verbatim in `full_command`, so the account's own
//   history is the answer key — the same lesson the repo learned when
//   it recovered a truncated template's missing suffix and reference
//   from the feed.
//
//   This tool reads the feed and reports every --sref it can find,
//   grouped by the URL FORM:
//
//     s.mj.run/<code>      MJ's own short link (what the studio UI
//                          produces when you click "set as style")
//     cdn.midjourney.com   the CDN path for a grid cell
//     anything else        a third form worth knowing about
//
//   It also reports the CHARACTER reference forms, because the two
//   features share the plumbing and the answer for one usually
//   generalises.
//
// Usage:
//   node tools/mj-style-urls.js [--port 9445] [--page-size 200]
//
// Exit: 0 read the feed · 2 the feed was unreachable · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9445'));
const PAGE_SIZE = Number(argVal('--page-size', '200'));

function log(m) { process.stdout.write(`[mj-style-urls] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-urls] ${m}\n`); }

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
 * The in-page read.
 *
 * The feed route needs the account's user_id, which the imagine page
 * discovers from its own resource timings. Everything runs in the page
 * so the session cookies and the CSRF header apply.
 */
const READ = `(async () => {
  const fromPerf = (performance.getEntriesByType('resource') || [])
    .map(e => e.name || '')
    .filter(n => n.includes('/api/imagine'))
    .map(n => (n.match(/user_id=([0-9a-f-]{36})/) || [])[1])
    .filter(Boolean);
  let uid = fromPerf[0];
  if (!uid) {
    for (const k of Object.keys(localStorage)) {
      if (k.indexOf('personalization_rollout') !== -1) {
        const m = k.match(/([0-9a-f-]{36})/);
        if (m) { uid = m[1]; break; }
      }
    }
  }
  if (!uid) return { error: 'no user_id' };

  const r = await fetch('/api/imagine?user_id=' + encodeURIComponent(uid) + '&page_size=' + ${JSON.stringify(String(PAGE_SIZE))}, {
    headers: { 'X-CSRF-Protection': '1' },
    credentials: 'include',
  });
  if (!r.ok) return { error: 'feed status ' + r.status, status: r.status };
  const j = await r.json();
  const items = Array.isArray(j) ? j : (j.items || j.data || []);

  // Only the fields that matter: the command and the shape of the item.
  const out = items.map(it => ({
    id: it.id,
    job_type: it.job_type,
    cmd: it.full_command || '',
    keys: Object.keys(it).slice(0, 40),
  }));
  return { user_id: uid, count: items.length, items: out };
})()`;

/** Every --sref value in a command, in order. */
function srefValues(cmd) {
    const out = [];
    const re = /--sref\s+((?:https?:\/\/\S+\s*)+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
        for (const u of m[1].trim().split(/\s+/)) if (u) out.push(u);
    }
    return out;
}

/** Every --cref value in a command, in order. */
function crefValues(cmd) {
    const out = [];
    const re = /--cref\s+((?:https?:\/\/\S+\s*)+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
        for (const u of m[1].trim().split(/\s+/)) if (u) out.push(u);
    }
    return out;
}

/** The URL's FORM — the thing that decides how to build one. */
function urlForm(u) {
    if (/^https:\/\/s\.mj\.run\//.test(u)) return 's.mj.run';
    if (/^https:\/\/cdn\.midjourney\.com\//.test(u)) return 'cdn.midjourney.com';
    if (/^https?:\/\//.test(u)) return 'other';
    return 'not-a-url';
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

    const res = await send('Runtime.evaluate', {
        expression: READ,
        awaitPromise: true,
        returnByValue: true,
    });
    const data = (res && res.result && res.result.value) || {};
    if (data.error) {
        warn('feed read failed: ' + data.error);
        return 2;
    }

    log(`user_id ${data.user_id} · ${data.count} feed item(s)`);

    const srefs = new Map();   // url -> [job ids]
    const crefs = new Map();
    const forms = new Map();
    let withSref = 0;
    let withCref = 0;

    for (const it of data.items || []) {
        const sv = srefValues(it.cmd);
        const cv = crefValues(it.cmd);
        if (sv.length) withSref++;
        if (cv.length) withCref++;
        for (const u of sv) {
            if (!srefs.has(u)) srefs.set(u, []);
            srefs.get(u).push(it.id);
            const f = urlForm(u);
            forms.set(f, (forms.get(f) || 0) + 1);
        }
        for (const u of cv) {
            if (!crefs.has(u)) crefs.set(u, []);
            crefs.get(u).push(it.id);
        }
    }

    log('');
    log(`jobs carrying --sref: ${withSref}   carrying --cref: ${withCref}`);
    log(`distinct --sref urls: ${srefs.size}   distinct --cref urls: ${crefs.size}`);
    log('');
    log('--- --sref URL FORMS ---');
    for (const [f, n] of [...forms.entries()].sort((a, b) => b[1] - a[1])) {
        log(`  ${f}: ${n}`);
    }
    log('');
    log('--- every distinct --sref url ---');
    for (const [u, ids] of srefs) {
        log(`  [${urlForm(u)}] ${u}`);
        log(`      used by ${ids.length} job(s): ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''}`);
    }
    log('');
    log('--- every distinct --cref url ---');
    for (const [u, ids] of crefs) {
        log(`  [${urlForm(u)}] ${u}`);
        log(`      used by ${ids.length} job(s): ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ' …' : ''}`);
    }

    // The shape of a feed item's own keys — where a style-reference
    // object would live if the account owned one.
    const first = (data.items || [])[0];
    if (first) {
        log('');
        log('--- a feed item\'s own fields ---');
        log('  ' + (first.keys || []).join(', '));
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`read failed: ${e.message}`); process.exit(3); });
