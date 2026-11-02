#!/usr/bin/env node
'use strict';
// lib/suno-login.js — open a browser to suno.com, wait for the user to
// sign in, and write the fresh session back to a cookie jar.
//
// WHY THIS EXISTS
//
// The Suno backend authenticates from a cookie jar. The jar's `__session`
// cookie is short-lived (MEASURED 2026-11-01: an hour), so a jar that
// worked in the morning is dead by the afternoon — and the failure is
// quiet: the tool reports "the cookie jar is probably expired or logged
// out" with no way forward.
//
// The jar is also the user's only credential, and it must stay OUT of
// the repo. So: this script opens the browser the tools already use
// (the same profile, the same CDP port), lets the user sign in by hand,
// and then exports the browser's own cookies back to the jar.
//
// WHAT IT DOES
//
//   1. launches the Suno browser profile, headed, on the CDP port
//   2. navigates to suno.com
//   3. waits until the page shows a signed-in user (the SPA's own
//      signal — the Authorization header on a real request)
//   4. reads the cookies back out of the browser
//   5. writes them to the jar, in the Netscape format the tools read
//   6. verifies the jar by authenticating with it
//
// USAGE
//
//   node lib/suno-login.js                    # the default jar
//   node lib/suno-login.js --out <path>       # somewhere else
//   node lib/suno-login.js --timeout 300      # wait longer (seconds)
//   node lib/suno-login.js --keep-open        # leave the browser up
//
// The browser stays open while it waits, and prints where to sign in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchChrome, CDPClient, cdpConnect, checkChromeOnPort } = require('./mj-submitter.js');
const { toNetscape } = require('./mj-cookies.js');
const { CONFIG, expandHome } = require('./suno-web.js');

function log(msg) { process.stdout.write(`[suno-login] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-login] ${msg}\n`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function argVal(name, dflt) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
function hasFlag(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

/**
 * The cookies the browser holds for suno.com and auth.suno.com.
 *
 * `Network.getAllCookies` returns every cookie in the profile — the
 * analytics ones too. We keep the ones that matter and drop the rest,
 * because a jar full of Datadog rows is noise (and one of them
 * (`_dd_s`) actively breaks Chrome's cookie sanitiser).
 */
async function readCookies(cdp) {
    const res = await cdp.send('Network.getAllCookies');
    const all = (res && res.cookies) || [];
    return all.filter((c) => {
        const d = String(c.domain || '');
        return d === 'suno.com' || d.endsWith('.suno.com');
    });
}

/**
 * Prove the jar works, by authenticating with it against the live API.
 *
 * A jar can look perfect and still be refused — so the check is a real
 * request, not an inspection. It runs in a separate browser on a
 * separate port, so it does not inherit anything from the browser the
 * cookies came from.
 */
async function verifyJar(jarPath) {
    const { SunoClient } = require('./suno-web.js');
    const verifyPort = 9458;
    log('verifying the jar against the live API...');
    let client = null;
    try {
        client = await SunoClient.open({
            cookieFile: jarPath,
            port: verifyPort,
            userDataDir: '/tmp/suno-web-verify-profile',
        });
        const billing = await client.billing();
        // `credits` is the BALANCE left (7 on this account).
        // `total_credits_left` is the plan's monthly ALLOWANCE (2677 on
        // Premier) — not the balance. Reporting the allowance as
        // "credits" would say there are generations to spend.
        const balance = billing && billing.credits;
        const plan = billing && billing.plan && billing.plan.plan_key;
        log(`  VERIFIED — the session works` +
            (balance === undefined ? '' : ` (${balance} credits left`) +
            (plan ? `, ${plan} plan` : '') + ')');
    } catch (e) {
        warn(`  NOT VERIFIED: ${e.message}`);
        warn('  The jar was written, but the tools could not authenticate with it.');
        throw e;
    } finally {
        if (client) { try { await client.close(); } catch { /* ignore */ } }
    }
}

async function main() {
    const outPath = expandHome(argVal('out', CONFIG.cookiesFile));
    const port = Number(argVal('port', CONFIG.port)) || CONFIG.port;
    const userDataDir = expandHome(argVal('user-data-dir', CONFIG.userDataDir));
    const chromeBin = argVal('chrome', (CONFIG.paths && CONFIG.paths.webBrowserBin) || '');
    const timeoutSec = Number(argVal('timeout', 300)) || 300;
    const keepOpen = hasFlag('keep-open');

    if (!chromeBin || !fs.existsSync(chromeBin)) {
        throw new Error(`browser binary not found: ${chromeBin}`);
    }

    // An already-running instance on this port would be another tool's
    // browser — do not fight over it.
    const already = await checkChromeOnPort(port);
    if (already) {
        throw new Error(
            `port ${port} already has a browser on it (${already.Browser || 'unknown'}). ` +
            `Close it, or pass --port <other>.`
        );
    }

    log(`launching ${chromeBin} on :${port}`);
    log(`profile  ${userDataDir}`);
    log(`jar      ${outPath}`);
    const proc = await launchChrome(port, userDataDir, chromeBin, false);

    let cdp = null;
    try {
        const wsUrl = await cdpConnect(`http://127.0.0.1:${port}`);
        cdp = await new CDPClient(wsUrl).connect();

        await cdp.send('Network.enable');
        await cdp.send('Page.enable');

        // The auth signal has to be listened for BEFORE the navigation.
        let sawBearer = false;
        cdp.ws.addEventListener('message', (ev) => {
            try {
                const m = JSON.parse(ev.data);
                if (m.method !== 'Network.requestWillBeSent') return;
                const h = (m.params.request && m.params.request.headers) || {};
                const a = h.authorization || h.Authorization;
                if (typeof a === 'string' && a.startsWith('Bearer ')) sawBearer = true;
            } catch { /* a malformed frame is not fatal */ }
        });

        await cdp.send('Page.navigate', { url: 'https://suno.com/' });
        log('');
        log('  A browser window is open at suno.com.');
        log('  Sign in there by hand (Google, email, whatever you use).');
        log('  This script notices the moment you are signed in and exports the session.');
        log('');

        const deadline = Date.now() + timeoutSec * 1000;
        let done = false;
        let onSignInWarned = false;
        while (Date.now() < deadline) {
            if (sawBearer) { done = true; break; }
            // The header can be missed if the SPA was already loaded and
            // made no new request, so keep checking the page as well.
            //
            // MEASURED 2026-11-01: an expired session sends the browser
            // to GOOGLE's sign-in page, not Suno's — and `document.cookie`
            // cannot see `__session` at all (it is HttpOnly), so a
            // cookie probe can never confirm a sign-in.
            //
            // The URL is therefore only ever a NEGATIVE signal: if we are
            // on a sign-in page we are definitely not signed in. The
            // positive signal is always the Authorization header.
            const onSignIn = await cdp.js(
                `(/^https?:\/\/accounts\.google\.com/.test(location.href)
                  || location.pathname.startsWith('/auth/signin')
                  || location.pathname.startsWith('/signin')
                  || location.pathname.startsWith('/login')) ? 1 : 0`
            ).catch(() => 0);
            if (onSignIn) {
                if (!onSignInWarned) {
                    log('  the browser is on a sign-in page — finish signing in.');
                    onSignInWarned = true;
                }
            } else if (sawBearer) {
                done = true;
                break;
            }
            await sleep(1500);
        }

        if (!done) {
            throw new Error(`no signed-in session within ${timeoutSec}s — nothing was written`);
        }
        log('signed in.');

        const cookies = await readCookies(cdp);
        if (!cookies.length) {
            throw new Error('the browser reports no suno.com cookies — nothing was written');
        }

        const jar = toNetscape(cookies, 'https://suno.com');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, jar, { mode: 0o600 });

        const names = cookies.map((c) => c.name);
        // Suno's session cookie has carried a per-user SUFFIX
        // (`__session_Jnxw-muT`) as well as the plain `__session`, and
        // which one the server wants has changed. So do not gate on a
        // name — gate on the jar WORKING.
        const hasSession = names.some((n) => n === '__session' || n.startsWith('__session_'));
        const hasClient = names.some((n) => n === '__client' || n.startsWith('__client_'));
        log(`wrote ${cookies.length} cookies -> ${outPath}`);
        log(`  session: ${hasSession ? 'yes' : 'NO'}   client: ${hasClient ? 'yes' : 'NO'}`);

        if (!hasSession) {
            warn('the jar has no session cookie — the tools may not authenticate');
        }

        if (!keepOpen) {
            log('closing the browser.');
            try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        } else {
            log('leaving the browser open (--keep-open).');
        }

        // VERIFY BY USING IT. A jar that looks right can still be
        // wrong — the session cookie may be the wrong variant, or the
        // server may refuse it. The only proof is a live API call with
        // the jar we just wrote.
        await verifyJar(outPath);
    } finally {
        if (!keepOpen) {
            try { if (cdp) cdp.close(); } catch { /* ignore */ }
            try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        }
    }
}

if (require.main === module) {
    main().catch((e) => { warn(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { main };
