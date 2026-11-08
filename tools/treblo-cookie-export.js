#!/usr/bin/env node
'use strict';
// Export the BROWSER's current treblo session as a Netscape cookie jar.
//
// WHY THIS EXISTS
//
//   The exported jar goes stale: its access_token expires (MEASURED
//   2026-11-07: the jar's token expired at 17:39:55Z while the browser
//   was still signed in). But the app REFRESHES the session itself —
//   that is what the `refresh_token` inside the payload is for — so the
//   browser carries a NEWER access token than the file does.
//
//   So when the jar is expired and the browser is not, the BROWSER is
//   the source of truth. This reads the browser's cookies and writes
//   them out in the jar's format.
//
// Usage: node tools/treblo-cookie-export.js [--port 9445] [--out <file>]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ARGV = process.argv.slice(2);
const argVal = (name, fallback) => {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
};
const PORT = Number(argVal('--port', '9445'));
const OUT = argVal('--out', path.join(os.homedir(), '.treblo-cookies.txt'));

function log(m) { process.stdout.write(`[treblo-export] ${m}\n`); }

function newTab(url, port) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/json/new?' + encodeURIComponent(url),
            method: 'PUT', timeout: 10000,
        }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('/json/new: ' + d.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

(async () => {
    const target = await newTab('about:blank', PORT);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id); pending.delete(m.id);
            if (m.error) p.rj(new Error(p.method + ': ' + m.error.message)); else p.rs(m.result);
        }
    });
    await new Promise((rs, rj) => {
        if (ws.readyState === 1) return rs();
        ws.addEventListener('open', () => rs(), { once: true });
        ws.addEventListener('error', () => rj(new Error('ws error')), { once: true });
    });
    const call = (method, params = {}, { ms = 40000 } = {}) => Promise.race([
        (() => { const i = ++id; return new Promise((rs, rj) => {
            pending.set(i, { rs, rj, method }); ws.send(JSON.stringify({ id: i, method, params }));
        }); })(),
        new Promise((_, rj) => setTimeout(() => rj(new Error(method + ' timed out')), ms)),
    ]);
    for (const m of ['Page.enable', 'Network.enable', 'Runtime.enable']) await call(m);

    const r = await call('Network.getAllCookies');
    const treblo = (r.cookies || []).filter(c => /treblo/.test(c.domain));

    // The chunked session is spread over the domains; group by the
    // DECODED payload and keep the group that is still valid.
    const groups = new Map();
    for (const c of treblo) {
        const m = /^sb-db-auth-token\.(\d+)$/.exec(c.name);
        if (!m) continue;
        if (!groups.has(c.domain)) groups.set(c.domain, new Map());
        groups.get(c.domain).set(Number(m[1]), c.value);
    }

    let best = null;
    for (const [domain, chunks] of groups) {
        const joined = [...chunks.keys()].sort((a, b) => a - b).map(k => chunks.get(k)).join('');
        try {
            const p = JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64').toString('utf8'));
            if (!best || (p.expires_at || 0) > (best.payload.expires_at || 0)) best = { domain, chunks, payload: p };
        } catch (e) { /* not a session */ }
    }
    if (!best) { log('no chunked session in the browser'); process.exit(3); }

    const exp = best.payload.expires_at || 0;
    const now = Math.floor(Date.now() / 1000);
    log(`domain ${best.domain} · expires ${new Date(exp * 1000).toISOString()} · ${exp > now ? 'VALID' : 'EXPIRED'} (${exp - now}s)`);
    if (exp <= now) { log('the browser session is expired too — sign in again'); process.exit(3); }

    const lines = [
        '# Netscape HTTP Cookie File',
        '# http://curl.haxx.se/rfc/cookie_spec.html',
        '# This is a generated file!  Do not edit.',
        '',
    ];
    const domain = best.domain;
    const domainField = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const hostOnly = domain.startsWith('.') ? 'FALSE' : 'TRUE';
    // The session cookies are session-scoped on the site; the jar's own
    // expiry column is what the reader uses, and the payload's
    // expires_at is the authority for validity.
    const expiry = Math.floor(exp + 3600);
    for (const [i, v] of [...best.chunks.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`${domain}\t${domainField}\t/\tTRUE\t${expiry}\tsb-db-auth-token.${i}\t${v}`);
    }
    for (const c of treblo) {
        if (/^sb-db-auth-token\./.test(c.name)) continue;
        if (!c.value) continue;
        const d = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const e = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
        lines.push(`${c.domain}\t${d}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${e}\t${c.name}\t${c.value}`);
    }
    lines.push('');

    fs.writeFileSync(OUT, lines.join('\n'));
    fs.chmodSync(OUT, 0o600);
    log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, mode 0600)`);
    process.exit(0);
})().catch(e => { process.stderr.write(`[treblo-export] failed: ${e.message}\n`); process.exit(3); });
