#!/usr/bin/env node
'use strict';
// lib/x-cookies.js
//
// Cookie handling for x.com. The twin posts to X on the user's behalf,
// so this module is the seam between "a cookie jar on disk" and "a
// browser that is logged in".
//
// WHAT A WORKING X SESSION NEEDS
//
//   auth_token   the bearer of the session. Without it x.com renders the
//                logged-out home page.
//   ct0          the CSRF token. x.com's write endpoints reject a request
//                that does not carry it, even with a perfect auth_token.
//
// Both are set as ordinary (non `__Host-`) cookies on `.x.com`, so they
// travel as `domain` + `path` + `secure`. The `__Host-` rule is still
// encoded here: if a future jar carries a `__Host-`/`__Secure-` name, it
// must be expressed via `url` and never with a Domain attribute, or
// Chromium drops it silently and the site renders "Log in" with no error.
//
// A NOTE ON VALIDATION
//
// X's REST endpoints (api.x.com/1.1/...) answer 401 "Invalid or expired
// token" even for a perfectly valid browser session — the web client uses
// a different auth path. So "is this cookie good?" is NOT answered by
// calling the API. It is answered by the page: load x.com, and check that
// the composer is there and "Log in" is not. lib/x-poster.js does exactly
// that, and it is the only check that means anything.
//
// Pure Node, no deps.

const fs = require('node:fs');
const path = require('node:path');

// A cookie this prefix-tagged must not be scoped to a domain.
const HOST_PREFIX = '__Host-';
const SECURE_PREFIX = '__Secure-';

// The origin the X cookies belong to.
const ORIGIN = 'https://x.com';

// The two cookies an authenticated X session cannot do without.
const REQUIRED = ['auth_token', 'ct0'];

/**
 * Parse a Netscape-format cookie jar.
 * Columns: domain, includeSubdomains, path, secure, expires, name, value
 * @returns {Array<object>} raw entries
 */
function parseNetscape(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        // Chrome and curl mark an HTTP-only cookie by prefixing the
        // domain with "#HttpOnly_". That row is a COOKIE, not a comment —
        // and on X the HTTP-only one is auth_token, so skipping it here
        // would drop the session and look like a valid-but-dead jar.
        const httpOnly = line.startsWith('#HttpOnly_');
        if (line.startsWith('#') && !httpOnly) continue;   // comments + the header
        const f = line.split('\t');
        if (f.length < 7) continue;                   // malformed row
        let [domain, , cpath, secure, expires, name, value] = f;
        if (!name) continue;
        if (httpOnly) domain = domain.slice('#HttpOnly_'.length);
        out.push({
            name,
            value,
            domain,
            path: cpath || '/',
            secure: String(secure).toUpperCase() === 'TRUE',
            httpOnly,
            expires: Number(expires) || 0,
        });
    }
    return out;
}

/**
 * Parse a JSON cookie array (Chrome DevTools export, EditThisCookie, etc).
 * @returns {Array<object>} raw entries
 */
function parseJson(text) {
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.cookies) ? data.cookies : []);
    return arr
        .filter(c => c && typeof c === 'object' && c.name)
        .map(c => ({
            name: String(c.name),
            value: String(c.value == null ? '' : c.value),
            domain: c.domain || null,
            url: c.url || null,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            expires: Number(c.expires || c.expirationDate || 0) || 0,
        }));
}

/**
 * Read and parse a cookie file, auto-detecting the format.
 * @param {string} filePath
 * @returns {Array<object>} raw entries
 */
function parseCookieFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const isJson = /^\s*[[{]/.test(text);
    const entries = isJson ? parseJson(text) : parseNetscape(text);
    // A jar may list the same cookie on several domains; keep the last,
    // which is how a browser jar is written (most specific wins).
    const byKey = new Map();
    for (const e of entries) byKey.set(e.name + '|' + (e.domain || e.url || ''), e);
    return [...byKey.values()];
}

/**
 * Convert raw entries into objects safe to hand to
 * CDP `Network.setCookies` / Puppeteer `page.setCookie`.
 *
 * Emits `url` instead of `domain` for `__Host-` cookies, which is the
 * only way a browser will accept them.
 *
 * @param {Array<object>} entries
 * @param {string} origin e.g. "https://x.com"
 */
function toBrowserCookies(entries, origin) {
    const base = origin || ORIGIN;
    const out = [];
    for (const e of entries) {
        if (!e.name) continue;
        const isHost = e.name.startsWith(HOST_PREFIX);
        const isSecure = e.name.startsWith(SECURE_PREFIX);

        const c = {
            name: e.name,
            value: e.value,
        };
        // Preserve HTTP-only when the jar says so. On X this matters in
        // both directions: auth_token is HTTP-only, and ct0 is NOT — the
        // page reads ct0 out of document.cookie as its CSRF token, so
        // marking it HTTP-only would break every write.
        if (e.httpOnly) c.httpOnly = true;

        if (isHost) {
            // `__Host-` rules: no Domain, Path=/, Secure, and therefore
            // must be expressed via `url`.
            c.url = base;
            c.path = '/';
            c.secure = true;
        } else {
            if (e.domain) c.domain = e.domain;
            else if (e.url) c.url = e.url;
            else c.url = base;
            c.path = e.path || '/';
            c.secure = isSecure ? true : !!e.secure;
        }

        // expires=0 in a jar means "session cookie" — omit it.
        if (e.expires && e.expires > 0) c.expires = e.expires;
        // CDP 155+ is stricter about sameSite. The spec says Lax/None
        // require Secure, so only set sameSite on secure cookies;
        // non-secure ones stay unset (CDP defaults to browser-default,
        // which is fine for first-party cookies).
        if (c.secure) c.sameSite = 'Lax';
        out.push(c);
    }
    return out;
}

/**
 * Convenience: file path -> browser-ready cookies.
 */
function loadCookies(filePath, origin) {
    return toBrowserCookies(parseCookieFile(filePath), origin);
}

/**
 * Report what a jar actually holds — names and domains only, never a
 * value. A cookie value is a credential; printing one is how credentials
 * end up in a log, a screenshot or a transcript.
 */
function describe(entries) {
    const names = entries.map(e => e.name);
    const domains = [...new Set(entries.map(e => e.domain || e.url || '(none)'))];
    return {
        count: entries.length,
        hasAuthToken: names.includes('auth_token'),
        hasCt0: names.includes('ct0'),
        hostPrefixed: names.filter(n => n.startsWith(HOST_PREFIX)).length,
        names,
        domains,
    };
}

/**
 * Is this jar an authenticated X session?
 *
 * The answer is a name check, not an API call: X's REST endpoints 401
 * even for a valid browser session, so the API cannot answer this.
 */
function validate(entries) {
    const names = entries.map(e => e.name);
    const missing = REQUIRED.filter(n => !names.includes(n));
    return {
        valid: missing.length === 0,
        missing,
        count: entries.length,
    };
}

/** Default location for the cookie jar. Outside the repo, always. */
function defaultCookiePath() {
    return path.join(process.env.HOME || '', '.x-cookies.txt');
}

module.exports = {
    parseNetscape,
    parseJson,
    parseCookieFile,
    toBrowserCookies,
    loadCookies,
    describe,
    validate,
    defaultCookiePath,
    HOST_PREFIX,
    SECURE_PREFIX,
    ORIGIN,
    REQUIRED,
};
