#!/usr/bin/env node
'use strict';
// lib/mj-cookies.js
//
// Sprint 0.25 — cookie-file loading for the Midjourney *web* backend.
//
// The web app authenticates with two cookies:
//   __Host-Midjourney.AuthUserTokenV3_i
//   __Host-Midjourney.AuthUserTokenV3_r
//
// Both use the `__Host-` prefix, which browsers enforce strictly:
// a `__Host-` cookie MUST be Secure, MUST have Path=/, and MUST NOT
// carry a Domain attribute. Pass one with a `domain` and Chromium
// silently DROPS it — the site then renders "Log in" with no error.
// That failure mode costs an hour if you don't know it, so the rule is
// encoded and tested here rather than left to the caller.
//
// Supported input formats:
//   * Netscape / curl cookie jar ("# Netscape HTTP Cookie File")
//   * JSON array of cookie objects
//
// Pure Node, no deps.

const fs = require('node:fs');
const path = require('node:path');

// A cookie this prefix-tagged must not be scoped to a domain.
const HOST_PREFIX = '__Host-';
const SECURE_PREFIX = '__Secure-';

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
        if (line.startsWith('#')) continue;           // comments + the header
        const f = line.split('\t');
        if (f.length < 7) continue;                   // malformed row
        const [domain, , cpath, secure, expires, name, value] = f;
        if (!name) continue;
        out.push({
            name,
            value,
            domain,
            path: cpath || '/',
            secure: String(secure).toUpperCase() === 'TRUE',
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
 * @param {string} origin e.g. "https://www.midjourney.com"
 */
function toBrowserCookies(entries, origin) {
    const out = [];
    for (const e of entries) {
        if (!e.name) continue;
        const isHost = e.name.startsWith(HOST_PREFIX);
        const isSecure = e.name.startsWith(SECURE_PREFIX);

        const c = {
            name: e.name,
            value: e.value,
            // HTTP-only is not knowable from a jar; the auth tokens are
            // read by the app's own JS in some builds, so leave it off.
        };

        if (isHost) {
            // `__Host-` rules: no Domain, Path=/, Secure, and therefore
            // must be expressed via `url`.
            c.url = origin;
            c.path = '/';
            c.secure = true;
        } else {
            if (e.domain) c.domain = e.domain;
            else if (e.url) c.url = e.url;
            else c.url = origin;
            c.path = e.path || '/';
            c.secure = isSecure ? true : !!e.secure;
        }

        // expires=0 in a jar means "session cookie" — omit it.
        if (e.expires && e.expires > 0) c.expires = e.expires;
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
 * Report whether the cookies an MJ session actually needs are present.
 * Useful as a preflight so a run fails fast and says why, rather than
 * rendering a login page and timing out 45s later.
 */
function describe(entries) {
    const names = entries.map(e => e.name);
    return {
        count: entries.length,
        hasAuthI: names.some(n => n.includes('AuthUserTokenV3_i')),
        hasAuthR: names.some(n => n.includes('AuthUserTokenV3_r')),
        hostPrefixed: names.filter(n => n.startsWith(HOST_PREFIX)).length,
        names,
    };
}

/** Default location for the cookie jar. */
function defaultCookiePath() {
    return path.join(process.env.HOME || '', '.midjourney-cookies.txt');
}

module.exports = {
    parseNetscape,
    parseJson,
    parseCookieFile,
    toBrowserCookies,
    loadCookies,
    describe,
    defaultCookiePath,
    HOST_PREFIX,
    SECURE_PREFIX,
};
