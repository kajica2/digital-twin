#!/usr/bin/env node
'use strict';
// tools/treblo-web.js
//
// Drive treblo.com in the REAL browser that is already running.
//
// WHY A BROWSER AND NOT `fetch`
//
//   treblo.com sits behind Cloudflare, which answers plain HTTP clients
//   with a 403 challenge page (measured 2026-11-05). The MJ web backend
//   already solved the same problem: a HEADED Chrome on :9444, driven
//   over CDP. This reuses that browser and injects the session cookie
//   from the cookie jar, so no login and no API key are needed.
//
// THE CREDENTIALS
//
//   The API path wants `Authorization: Bearer <api key>`, and that key
//   is gone — the integration was removed in 77e3c65 and the key file
//   with it. MEASURED: the SUPABASE SESSION TOKEN from the cookie jar
//   is NOT accepted as a Bearer ("Invalid API key"). So the web app is
//   the path, and the cookie jar is the credential.
//
//   The session token in the jar is CHUNKED across `sb-db-auth-token.0`,
//   `.1`, … — each chunk is a piece of one base64 blob. The chunks must
//   be joined and decoded together; decoding one alone is a truncated
//   JSON.
//
// Usage:
//   node tools/treblo-web.js --cookies <file> [--port 9444] <command>
//
//   commands:
//     probe            load /create and report what the session sees
//     prompt --text "…" --out <dir>   submit a prompt, download the audio
//
// Exit: 0 ok · 2 bad input · 3 runtime failure

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const COOKIES = argVal('--cookies', path.join(require('node:os').homedir(), '.treblo-cookies.txt'));
const PORT = Number(argVal('--port', '9444'));

// The command is the first POSITIONAL argument — the one that follows
// neither a flag nor a flag's value.
//
// The first version of this picked `ARGV.find(...)` with a predicate
// that only excluded the values of `--cookies` and `--port`, so
// `--cookies <file> probe` resolved the command to the PATH, and the
// jar was parsed as a command. The robust form is to walk the argv and
// skip a flag's value whenever the flag is a known value-taking one.
const VALUE_FLAGS = new Set(['--cookies', '--port', '--text', '--out', '--format']);
function firstPositional() {
    for (let i = 0; i < ARGV.length; i++) {
        const a = ARGV[i];
        if (!a.startsWith('--')) return a;
        if (VALUE_FLAGS.has(a)) i++;   // skip its value
    }
    return null;
}
const CMD = firstPositional() || 'probe';

function log(m) { process.stdout.write(`[treblo-web] ${m}\n`); }
function warn(m) { process.stderr.write(`[treblo-web] ${m}\n`); }

// ---------------------------------------------------------------------
// the cookie jar
// ---------------------------------------------------------------------

/**
 * Read the session token out of a Netscape cookie jar.
 *
 * The jar's `sb-db-auth-token` value is CHUNKED: `.0` holds the start of
 * a base64 blob and `.1` continues it. Decoding a single chunk yields
 * truncated JSON (measured: "number of data characters (3173) cannot be
 * 1 more than a multiple of 4"). So the chunks are joined and decoded
 * once, together.
 *
 * A JAR CAN CARRY MORE THAN ONE SESSION. MEASURED 2026-11-07: an export
 * held the chunked pair on BOTH domains — `.treblo.com` (expired) and
 * `treblo.com` (valid) — with DIFFERENT values. A reader that keeps one
 * value per chunk index and lets the last row win therefore picks a
 * session by ROW ORDER, not by validity, and a reordered export silently
 * yields the expired one.
 *
 * So the groups are collected per DOMAIN, each is decoded, and the one
 * with the LATEST expiry wins.
 */
function readSessionGroups(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const groups = new Map();   // domain -> Map(index -> value)
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        const m = /^sb-db-auth-token\.(\d+)$/.exec(parts[5]);
        if (!m) continue;
        if (!groups.has(parts[0])) groups.set(parts[0], new Map());
        groups.get(parts[0]).set(Number(m[1]), parts[6]);
    }
    return groups;
}

/** Decode one chunk group into its payload, or null if it is not one. */
function decodeSession(chunks) {
    const ordered = [...chunks.keys()].sort((a, b) => a - b)
        .map(k => chunks.get(k)).join('');
    try {
        const b64 = ordered.replace(/^base64-/, '');
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        if (!payload || !payload.access_token) return null;
        return { payload, blob: ordered };
    } catch (e) {
        return null;
    }
}

/**
 * The best session in the jar: the one with the LATEST expiry.
 *
 * Every group is decoded and the winner is chosen by `expires_at`, so the
 * result does not depend on the order of the rows in the file.
 */
function bestSession(file) {
    const groups = readSessionGroups(file);
    if (!groups.size) throw new Error(`no sb-db-auth-token.N in ${file}`);
    const decoded = [];
    for (const [domain, chunks] of groups) {
        const d = decodeSession(chunks);
        if (d) decoded.push({ domain, ...d });
    }
    if (!decoded.length) throw new Error(`no sb-db-auth-token.N in ${file} decodes to a session`);
    decoded.sort((a, b) => (b.payload.expires_at || 0) - (a.payload.expires_at || 0));
    return decoded[0];
}

function sessionToken(file) {
    const { payload } = bestSession(file);
    return { token: payload.access_token, refresh: payload.refresh_token || '', expiresAt: payload.expires_at || 0 };
}

// ---------------------------------------------------------------------
// the CDP client
// ---------------------------------------------------------------------

function listTargets(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 6000 }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

/** Open a NEW tab and return a small CDP handle for it. */
async function openTab(url, port) {
    // Chrome 111+ requires PUT for /json/new — a GET answers with an
    // HTML error page ("Using unsafe HTTP verb GET to invoke /json/new")
    // that is not JSON. So the verb is PUT, and the failure mode of
    // parsing that error page is what the first version did.
    const target = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port,
            path: '/json/new?' + encodeURIComponent(url),
            method: 'PUT',
            timeout: 10000,
        }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`/json/new answered: ${d.slice(0, 120)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
    if (!target || !target.webSocketDebuggerUrl) throw new Error('could not open a tab');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((rs, rj) => {
        const i = ++id;
        pending.set(i, { rs, rj, method });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    // The signature is (method, params, { ms }) — the SAME shape every caller
    // already used and every other CDP client in this repo uses
    // (lib/mj-submitter.js `CDPClient.send(method, params)`).
    //
    // It used to be (method, { params, ms }) — which destructured the
    // caller's PARAMS object as if it were an options object, so `params`
    // was always {} and the real params were dropped on the floor. Chrome
    // then answered "Invalid parameters" for every call that needed them.
    // MEASURED 2026-11-07: that one signature mistake is the reason
    // docs/TREBLO.md recorded "Network.setCookie refuses EVERY parameter
    // set on this Chrome" — it did not; the params never arrived.
    const call = (method, params = {}, { ms = 30000 } = {}) => Promise.race([
        send(method, params),
        new Promise((_, rj) => setTimeout(() => rj(new Error(`${method} timed out after ${ms}ms`)), ms)),
    ]);

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
            // Name the method: a bare "Invalid parameters" hides WHICH call
            // was rejected, and that is exactly what made the dropped-params
            // bug above so expensive to find.
            if (m.error) p.rj(new Error(`${p.method}: ${m.error.message}`));
            else p.rs(m.result);
        }
    });

    await call('Page.enable');
    await call('Network.enable');
    await call('Runtime.enable');
    return { call, send, close: () => ws.close() };
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(tab, expression, ms = 30000) {
    const r = await tab.call('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
    }, { ms });
    if (r && r.exceptionDetails) {
        throw new Error(`page threw: ${r.exceptionDetails.text || 'unknown'}`);
    }
    return r && r.result ? r.result.value : undefined;
}

/**
 * Read the CHUNKED session cookies out of a Netscape cookie jar.
 *
 * MEASURED 2026-11-07: only the chunked pair signs treblo.com in. A flat
 * `sb-db-auth-token` cookie carrying the decoded access_token leaves the
 * page showing "Log in"; installing `.0` + `.1` verbatim renders the
 * signed-in app and makes it call `/api/v1/users/me/*`.
 *
 * The values are returned VERBATIM — they are pieces of one base64 blob
 * and must not be decoded individually.
 */
function sessionCookieChunks(file) {
    const { domain, blob } = bestSession(file);
    // The winner's chunks, verbatim. `blob` is the joined value; split it
    // back by the index each row carried, so the cookie NAMES come out
    // right rather than being guessed.
    const groups = readSessionGroups(file);
    const chunks = groups.get(domain);
    const out = [...chunks.keys()].sort((a, b) => a - b)
        .map(i => ({ name: `sb-db-auth-token.${i}`, value: chunks.get(i) }));
    if (!out.length) throw new Error(`no sb-db-auth-token.N in ${file}`);
    // Sanity: the joined values must be the blob that was decoded.
    if (out.map(c => c.value).join('') !== blob) {
        throw new Error('the chunk group does not reconstruct the selected session');
    }
    return out;
}

/**
 * Install the session cookies into the browser.
 *
 * `Network.setCookie` is the right instrument — MEASURED 2026-11-07, it
 * accepts every parameter set. The earlier note that it "refuses EVERY
 * parameter set on this Chrome" was an artifact of this module's own
 * dropped-params bug (see openTab's `call`), not a Chrome restriction.
 *
 * THE STALE FLAT COOKIE SHADOWS THE CHUNKED PAIR. MEASURED 2026-11-07:
 * installing `.0` + `.1` on a profile that still carries a flat
 * `sb-db-auth-token` renders the app SIGNED-OUT; deleting the candidate
 * names first and then installing the pair renders it signed-in (the app
 * then calls /api/v1/users/me/*). The app reads the flat name when both
 * are present, so the stale one has to go.
 */
async function installSession(tab, file) {
    // 1. Clear every candidate session cookie, on both domain forms.
    for (const name of ['sb-db-auth-token', 'sb-db-auth-token.0', 'sb-db-auth-token.1']) {
        for (const domain of ['.treblo.com', 'treblo.com']) {
            try {
                await tab.call('Network.deleteCookies', { name, domain, path: '/' }, { ms: 10000 });
            } catch (e) { /* a cookie that is not there is fine */ }
        }
    }
    // 2. Install the chunked pair, verbatim.
    const chunks = sessionCookieChunks(file);
    for (const c of chunks) {
        await tab.call('Network.setCookie', {
            name: c.name,
            value: c.value,
            domain: '.treblo.com',
            path: '/',
            secure: true,
            httpOnly: false,
        }, { ms: 15000 });
    }
    return chunks.map(c => c.name);
}

module.exports = {
    sessionToken, sessionCookieChunks, bestSession, readSessionGroups,
    installSession, listTargets, openTab, evaluate, log, warn,
};

// ---------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------

async function cmdProbe() {
    const { token, expiresAt } = sessionToken(COOKIES);
    const left = Math.round(expiresAt - Date.now() / 1000);
    log(`session token loaded (${token.length} chars), valid for ~${left}s`);

    const tab = await openTab('https://treblo.com/create', PORT);
    // The cookie must be set BEFORE the page loads, so the app boots
    // authenticated. The CHUNKED pair is the form that works — a flat
    // `sb-db-auth-token` leaves the page showing "Log in".
    const installed = await installSession(tab, COOKIES);
    log(`session cookies installed: ${installed.join(', ')}`);
    await tab.call('Page.navigate', { url: 'https://treblo.com/create' }, { ms: 30000 });
    await new Promise(r => setTimeout(r, 8000));

    const title = await evaluate(tab, 'document.title');
    const text = await evaluate(tab, 'document.body.innerText.slice(0, 1200)');
    log(`title: ${title}`);
    log('--- page text ---');
    process.stdout.write((text || '') + '\n');
    // The signed-in app renders "You have Treblo Pro"; the signed-out one
    // renders "Log in" / "Sign up". So the ANSWER is the absence of the
    // sign-in links, not their presence.
    const probes = ['Sign in', 'Log in', 'You have Treblo Pro', 'credits', 'Prompt', 'Generate', 'Create'];
    for (const p of probes) log(`  ${p.padEnd(18)} present: ${String(text || '').includes(p)}`);
    const signedIn = /You have Treblo Pro/i.test(text || '') && !/Log in/i.test(text || '');
    log(`signed in: ${signedIn}`);
    tab.close();
    return signedIn ? 0 : 3;
}

async function main() {
    try {
        if (CMD === 'probe') return await cmdProbe();
        warn(`unknown command: ${CMD} (probe)`);
        return 2;
    } catch (e) {
        warn(`failed: ${e.message}`);
        return 3;
    }
}

if (require.main === module) {
    main().then(c => process.exit(c));
}
