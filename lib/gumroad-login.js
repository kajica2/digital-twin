#!/usr/bin/env node
'use strict';
// lib/gumroad-login.js
//
// Mint a Gumroad seller session by walking the X-OAuth login flow.
//
// WHY THIS EXISTS
//
// The twin needs an authenticated Gumroad session to create products. There
// is no API token on this machine and no OAuth application on the account,
// so the session-cookie path is the only one available.
//
// The session cannot be scraped out of a browser cookie store either: only
// Comet holds gumroad.com cookies on this machine, and those belong to a
// DIFFERENT Gumroad account (seller 7729096936913, USD, zero products) than
// the storefront the repo ships against (seller 5952229292192 =
// kaidjuric.gumroad.com, EUR). Picking the wrong jar is worse than having
// none: it writes to the wrong storefront.
//
// So this module reproduces the login flow itself:
//
//   1. GET  gumroad.com/login          -> CSRF token
//   2. POST gumroad.com/users/auth/twitter -> redirects to X's authorize page
//   3. GET  x.com/oauth/authenticate   -> X's CSRF token (uses the X session)
//   4. POST x.com/oauth/authorize      -> HTML carrying the callback URL
//   5. GET  gumroad.com/users/auth/twitter/callback -> the new session cookie
//
// The X session itself comes from the twin's existing X capture module
// (lib/x-cookie-capture.js -> ~/.x-cookies.txt). This module does NOT read
// any browser cookie database: it consumes a jar file that already exists.
//
// The output jar is written OUTSIDE the repo (~/.gumroad-cookies.txt, mode
// 600). .gitignore also carries a `*-cookies.txt` rule as a second line of
// defence.
//
// Usage:
//   node lib/gumroad-login.js                 # write ~/.gumroad-cookies.txt
//   node lib/gumroad-login.js --out <file>    # write somewhere else
//   node lib/gumroad-login.js --x-cookies <file>
//   node lib/gumroad-login.js --check         # is the current jar usable?
//
// Pure Node, no deps.

const fs = require('node:fs');
const path = require('node:path');

const { parseNetscape } = require('./x-cookies.js');

const GUMROAD_ORIGIN = 'https://gumroad.com';
const DEFAULT_OUT = path.join(process.env.HOME || '', '.gumroad-cookies.txt');
const DEFAULT_X_COOKIES = path.join(process.env.HOME || '', '.x-cookies.txt');

function log(msg) { process.stdout.write(`[gumroad-login] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[gumroad-login] ${msg}\n`); }

/**
 * Build a `Cookie:` header value from a Netscape jar, filtered by host.
 */
function cookieHeader(cookieFile, hostMatch) {
    const entries = parseNetscape(fs.readFileSync(cookieFile, 'utf8'));
    const byName = new Map();
    for (const e of entries) {
        if (!hostMatch(e.domain || '')) continue;
        byName.set(e.name, e.value);
    }
    return [...byName.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

/**
 * A tiny cookie jar: keeps the cookies the flow hands us, keyed by name.
 */
class Jar {
    constructor() { this.cookies = new Map(); }
    addFrom(setCookieHeaders) {
        for (const raw of [].concat(setCookieHeaders || [])) {
            if (!raw) continue;
            const [pair] = raw.split(';');
            const idx = pair.indexOf('=');
            if (idx < 0) continue;
            this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
        }
    }
    header() {
        return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
    }
    /** Netscape rows for the given domain. */
    toNetscape(domain, expires) {
        const lines = [
            '# Netscape HTTP Cookie File',
            '# Written by lib/gumroad-login.js',
            '',
        ];
        for (const [name, value] of this.cookies.entries()) {
            lines.push([domain, 'TRUE', '/', 'TRUE', String(expires), name, value].join('\t'));
        }
        return lines.join('\n') + '\n';
    }
}

/**
 * Extract the Inertia props (CSRF token and friends) from a page.
 */
function propsFromHtml(html) {
    const m = html.match(/data-page="([^"]+)"/);
    if (!m) return null;
    const decoded = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    try { return JSON.parse(decoded).props; } catch { return null; }
}

/**
 * The whole flow. Returns {jar, sellerId, subdomain}.
 */
async function login(options) {
    const opts = options || {};
    const xCookieFile = opts.xCookieFile || DEFAULT_X_COOKIES;
    if (!fs.existsSync(xCookieFile)) {
        throw new Error(
            `X session jar not found: ${xCookieFile}\n` +
            'Run: node lib/x-cookie-capture.js  (reads your own Chrome profile)'
        );
    }
    const xCookie = cookieHeader(xCookieFile, (d) => /(^|\.)x\.com$/.test(d) || /(^|\.)twitter\.com$/.test(d));
    if (!/auth_token=/.test(xCookie)) {
        throw new Error(`X jar ${xCookieFile} has no auth_token — run lib/x-cookie-capture.js again`);
    }

    const jar = new Jar();
    const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));

    // 1. CSRF token for the Gumroad side.
    const loginPage = await fetchImpl(`${GUMROAD_ORIGIN}/login`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    jar.addFrom(loginPage.headers.getSetCookie ? loginPage.headers.getSetCookie() : [loginPage.headers.get('set-cookie')]);
    const loginHtml = await loginPage.text();
    const loginProps = propsFromHtml(loginHtml);
    if (!loginProps || !loginProps.authenticity_token) {
        throw new Error('could not read a CSRF token from gumroad.com/login');
    }
    const gumroadToken = loginProps.authenticity_token;

    // 2. Start the OmniAuth request phase. GET is 404 ("Authentication
    //    passthru.") — the request phase is POST-only.
    const requestBody = new URLSearchParams({ authenticity_token: gumroadToken });
    const start = await fetchImpl(`${GUMROAD_ORIGIN}/users/auth/twitter`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
            // The request phase is bound to the session the /login page
            // opened. Without the cookie Gumroad answers 302 -> /users/sign_in
            // instead of handing over X's authorize URL.
            Cookie: jar.header(),
            Referer: `${GUMROAD_ORIGIN}/login`,
        },
        body: requestBody.toString(),
        redirect: 'manual',
    });
    const authorizeUrl = start.headers.get('location');
    if (!authorizeUrl || !/oauth\/authenticate/.test(authorizeUrl)) {
        throw new Error(`X request phase did not redirect to X (status ${start.status}, location ${authorizeUrl})`);
    }
    jar.addFrom(start.headers.getSetCookie ? start.headers.getSetCookie() : [start.headers.get('set-cookie')]);

    // 3. X's authorize page (needs the X session).
    const xPage = await fetchImpl(authorizeUrl, {
        headers: { Cookie: xCookie, 'User-Agent': 'Mozilla/5.0' },
    });
    const xHtml = await xPage.text();
    if (!/screen_name/.test(xHtml)) {
        throw new Error('X did not return a logged-in authorize page — the X session is stale');
    }
    const xProps = propsFromHtml(xHtml);
    const xToken = (xProps && xProps.authenticity_token) ||
        (xHtml.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
    if (!xToken) throw new Error('could not read X\'s CSRF token from the authorize page');

    // 4. Accept the authorization. This answers 200 with the callback URL
    //    in the BODY, not in a Location header.
    const approve = await fetchImpl('https://x.com/oauth/authorize', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
            Cookie: xCookie,
            Referer: authorizeUrl,
        },
        body: new URLSearchParams({
            authenticity_token: xToken,
            oauth_token: (authorizeUrl.match(/oauth_token=([^&]+)/) || [])[1] || '',
            oauth_trust_accepted: 'true',
        }).toString(),
        redirect: 'manual',
    });
    const approveHtml = await approve.text();
    const callback = (approveHtml.match(/https:\/\/gumroad\.com\/users\/auth\/twitter\/callback[^"'\s<]+/) || [])[0];
    if (!callback) {
        throw new Error(`X authorization did not produce a Gumroad callback (status ${approve.status})`);
    }

    // 5. Complete the callback with the Gumroad jar -> the session cookie.
    const callbackRes = await fetchImpl(callback, {
        headers: { Cookie: jar.header(), 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
    });
    jar.addFrom(callbackRes.headers.getSetCookie ? callbackRes.headers.getSetCookie() : [callbackRes.headers.get('set-cookie')]);
    if (!jar.cookies.has('_gumroad_app_session')) {
        throw new Error('callback did not set a _gumroad_app_session cookie');
    }

    // 6. Confirm which storefront we landed on.
    const products = await fetchImpl(`${GUMROAD_ORIGIN}/products`, {
        headers: { Cookie: jar.header(), 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
    });
    if (products.status !== 200) {
        throw new Error(`the new session cannot open /products (status ${products.status})`);
    }
    const props = propsFromHtml(await products.text());
    const seller = (props && props.current_seller) || {};
    return {
        jar,
        sellerId: seller.id || null,
        subdomain: seller.subdomain || null,
        email: (props && props.user && props.user.email) || null,
    };
}

/**
 * Write the jar to disk, outside the repo, mode 600.
 */
function writeJar(jar, outFile) {
    const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    fs.writeFileSync(outFile, jar.toNetscape('.gumroad.com', expires), { mode: 0o600 });
    try { fs.chmodSync(outFile, 0o600); } catch { /* best effort */ }
    return outFile;
}

module.exports = { login, writeJar, Jar, cookieHeader, propsFromHtml, DEFAULT_OUT, DEFAULT_X_COOKIES };

// ------------------------------------------------------------------- CLI

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}

async function main() {
    if (ARGV.includes('--check')) {
        const out = argVal('--out', DEFAULT_OUT);
        if (!fs.existsSync(out)) {
            warn(`no jar at ${out} — run: node lib/gumroad-login.js`);
            return 2;
        }
        const { GumroadClient } = require('./gumroad.js');
        const info = await new GumroadClient({ cookieFile: out }).check();
        if (!info.ok) {
            warn(`jar unusable: ${info.reason} (HTTP ${info.status})`);
            return 2;
        }
        log(`seller ${info.sellerName} (${info.sellerId}) on ${info.storefrontUrl}`);
        log(`email ${info.email || '(none)'}${info.hasUnconfirmedEmail ? ' (+ unconfirmed)' : ''}`);
        log(`publishing ${info.canPublish ? 'allowed' : `blocked (${info.publishBlockedReason})`}`);
        return 0;
    }

    const out = argVal('--out', DEFAULT_OUT);
    const xCookieFile = argVal('--x-cookies', DEFAULT_X_COOKIES);
    log('walking the X-OAuth flow…');
    const result = await login({ xCookieFile });
    writeJar(result.jar, out);
    log(`session minted for seller ${result.sellerId} (${result.subdomain})`);
    log(`jar written to ${out} (mode 600)`);
    return 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => {
        warn(e && e.message ? e.message : String(e));
        process.exit(1);
    });
}
