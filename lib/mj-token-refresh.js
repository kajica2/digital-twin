#!/usr/bin/env node
'use strict';
// lib/mj-token-refresh.js
//
// Refresh the Midjourney id token when the jar's id token has gone stale.
//
// THE BUG
//
// The Midjourney session is two cookies:
//   __Host-Midjourney.AuthUserTokenV3_i   the ID token — a Firebase JWT
//   __Host-Midjourney.AuthUserTokenV3_r   the REFRESH token — long-lived
//
// When the server rejects the id token, midjourney.com CLEARS both auth
// cookies and redirects to /auth/signin. The refresh token keeps working,
// so the account session is alive and can be renewed.
//
// MEASURED 2026-11-01, on this account — and the expiry is NOT the
// signal, which was the first thing assumed and the first thing wrong:
//
//   * the jar's id token was still INSIDE its validity window
//     (exp 06:04, rejected at 05:44) and was still cleared by the server
//   * the A/B was clean: same browser, same profile, same cookies, only
//     the id token's VALUE differed —
//       original id token -> sent on the wire, server cleared both auth
//                            cookies, landed on /auth/signin
//       freshly minted id -> sent on the wire, page loaded, composer present
//   * the only claim that differs is `email_verified` (fresh) against
//     `umail_verified` (the typo'd one in the jar)
//
// So the fix cannot be "refresh when the token is expired" — that
// predicate never fires for the token that actually fails. It is:
//
//   1. refresh PRE-EMPTIVELY when the token is expired or nearly so
//      (cheap, and it is the normal hour-boundary case), and
//   2. refresh ON REJECTION when the server redirects to /auth/signin
//      (the case this file was written for).
//
// The symptom before the fix was a 30-second wait followed by "the prompt
// textarea never appeared. Verify the cookie jar is from a logged-in
// session." — a sentence about the JAR when the jar was fine and the
// TOKEN inside it was what the server refused.
//
// The pure half (everything here) is unit-tested with synthetic tokens.
// The network half lives in `refreshSession`, which needs a browser.
//
// Pure Node, no deps.

const ID_COOKIE = '__Host-Midjourney.AuthUserTokenV3_i';
const REFRESH_COOKIE = '__Host-Midjourney.AuthUserTokenV3_r';

// The Firebase token endpoint. The API key ships in MJ's own JS bundle
// and is read from the live page — it is a public client key (it is in
// every visitor's browser), not a secret.
const TOKEN_HOST = 'securetoken.googleapis.com';
const TOKEN_PATH = '/v1/token';

// How early a token is treated as expiring. A run takes minutes, so a
// token with 30 seconds left is already too late — refresh it now.
const SKEW_SECONDS = 300;

// ---------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------

/**
 * The `exp` claim of a JWT, in epoch seconds. Null when the value is not
 * a JWT or carries no usable expiry.
 * @param {string} token
 * @returns {number|null}
 */
function tokenExpiry(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
            return null;
        }
        return payload.exp;
    } catch {
        return null;
    }
}

/**
 * Is this token past its expiry?
 *
 * A token with no readable expiry is treated as FRESH — the jar's own
 * `expires` column is the fallback, and refusing to act on an unreadable
 * token is safer than refusing to act at all.
 *
 * @param {string} token
 * @param {number} [now] epoch seconds
 * @returns {boolean}
 */
function tokenExpired(token, now = Math.floor(Date.now() / 1000)) {
    const exp = tokenExpiry(token);
    if (exp === null) return false;
    return now > exp;
}

/**
 * The id token's value out of a parsed jar.
 * @param {Array<object>} entries
 * @returns {string|null}
 */
function idToken(entries) {
    const hit = (entries || []).find((c) => c && c.name === ID_COOKIE);
    return hit ? hit.value : null;
}

/**
 * The refresh token's value out of a parsed jar.
 * @param {Array<object>} entries
 * @returns {string|null}
 */
function refreshToken(entries) {
    const hit = (entries || []).find((c) => c && c.name === REFRESH_COOKIE);
    return hit ? hit.value : null;
}

/**
 * Did the server reject the session?
 *
 * midjourney.com answers a rejected session by redirecting to
 * /auth/signin and clearing the auth cookies. That redirect is the
 * ONLY reliable signal — the token can be inside its expiry window and
 * still be refused (MEASURED 2026-11-01).
 *
 * @param {string} url the page's location
 * @returns {boolean}
 */
function sessionRejected(url) {
    const u = String(url || '');
    if (!u) return false;
    return /\/auth\/signin(?:[/?#]|$)/i.test(u)
        || /\/log[_-]?in(?:[/?#]|$)/i.test(u);
}

/**
 * Does this jar need a refresh before a run?
 *
 * Both halves must be present: a stale id token AND a refresh token. A
 * jar with no refresh token cannot be refreshed, and the caller should
 * say so rather than try.
 *
 * @param {Array<object>} entries
 * @param {number} [now]
 * @returns {boolean}
 */
function needsRefresh(entries, now = Math.floor(Date.now() / 1000)) {
    const refresh = refreshToken(entries);
    if (!refresh) return false;
    const id = idToken(entries);
    if (!id) return true;
    const exp = tokenExpiry(id);
    if (exp === null) return false;   // unreadable expiry — leave it alone
    return now + SKEW_SECONDS >= exp;
}

/**
 * A copy of the jar with a new id token. The original is NOT mutated —
 * the caller may still want the jar it read.
 *
 * @param {Array<object>} entries
 * @param {string} freshIdToken
 * @returns {Array<object>}
 */
function applyFreshIdToken(entries, freshIdToken) {
    return (entries || []).map((c) => (
        c && c.name === ID_COOKIE ? { ...c, value: freshIdToken } : c
    ));
}

/**
 * The body of the refresh exchange.
 * @param {string} refresh
 * @returns {{grant_type: string, refresh_token: string}}
 */
function refreshBody(refresh) {
    return { grant_type: 'refresh_token', refresh_token: String(refresh) };
}

/**
 * The URL of the refresh exchange.
 * @param {string} apiKey
 * @returns {string}
 */
function refreshUrl(apiKey) {
    return `https://${TOKEN_HOST}${TOKEN_PATH}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Find the Firebase API key in a JS bundle.
 *
 * The key is 39 characters: "AIza" plus 35. The match is strict about the
 * length because a truncated or padded key produces a 403 whose message
 * ("API key not valid") says nothing about the real problem.
 *
 * @param {string} text
 * @returns {string|null}
 */
function findApiKey(text) {
    const m = String(text || '').match(/AIza[0-9A-Za-z_-]{35}/);
    return m ? m[0] : null;
}

/**
 * The message to show when the session was rejected.
 *
 * The point is that it must NOT blame the jar: the jar is usually fine,
 * and the id token inside it is what expired.
 *
 * @param {string} jarPath
 * @returns {string}
 */
function staleTokenMessage(jarPath) {
    return 'Midjourney rejected the session and cleared the auth cookies: the jar\'s id '
        + 'token is not one the server accepts (it can be expired, or simply refused — '
        + 'MEASURED 2026-11-01, a token still inside its validity window was refused). '
        + `The refresh token in ${jarPath} is still valid — re-run and the session will `
        + 'be refreshed automatically. If it still fails, sign in to midjourney.com in a '
        + 'browser and re-export the cookie jar.';
}

// ---------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------

/**
 * Read the Firebase API key out of MJ's own loaded bundle, in the page.
 *
 * The key is a public client key — it is in every visitor's bundle — so
 * reading it is the same thing the page does.
 *
 * @param {object} cdp a connected CDPClient
 * @returns {Promise<string|null>}
 */
async function readApiKey(cdp) {
    const expr = `(async () => {
      const b = Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.src).find(u => /clientSideEntry/.test(u));
      if (!b) return null;
      const t = await (await fetch(b)).text();
      const m = t.match(/AIza[0-9A-Za-z_-]{35}/);
      return m ? m[0] : null;
    })()`;
    try {
        return await cdp.js(expr, true);
    } catch {
        return null;
    }
}

/**
 * Exchange the refresh token for a fresh id token.
 *
 * @param {string} refresh
 * @param {string} apiKey
 * @returns {Promise<{ok: boolean, idToken?: string, expiresIn?: number, reason?: string}>}
 */
async function exchangeRefresh(refresh, apiKey) {
    if (!refresh) return { ok: false, reason: 'the jar carries no refresh token' };
    if (!apiKey) return { ok: false, reason: 'could not read the API key from the page' };
    // Node's fetch is available from v18; this repo runs on v22.
    try {
        const res = await fetch(refreshUrl(apiKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(refreshBody(refresh)),
        });
        const text = await res.text();
        if (!res.ok) {
            return { ok: false, reason: `the refresh exchange was refused (HTTP ${res.status}): ${text.slice(0, 200)}` };
        }
        const payload = JSON.parse(text);
        if (!payload.id_token) {
            return { ok: false, reason: 'the refresh exchange returned no id token' };
        }
        return { ok: true, idToken: payload.id_token, expiresIn: payload.expires_in };
    } catch (e) {
        return { ok: false, reason: `the refresh exchange failed: ${e.message}` };
    }
}

/**
 * Refresh the session if it needs it.
 *
 * Returns the (possibly unchanged) jar entries. Never throws: a failure
 * here is reported in the result, and the caller decides whether to
 * continue — because a jar that does not NEED a refresh must not be
 * blocked by an exchange that failed.
 *
 * @param {Array<object>} entries the parsed jar
 * @param {object} cdp a connected CDPClient
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {Function} [opts.log]
 * @param {boolean} [opts.force] refresh even when the token is not
 *        expired — the REJECTION case, where the server refused a token
 *        that was still inside its validity window (MEASURED 2026-11-01)
 * @returns {Promise<{entries: Array<object>, refreshed: boolean, reason?: string}>}
 */
async function refreshSession(entries, cdp, opts = {}) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const log = opts.log || (() => {});
    if (!opts.force && !needsRefresh(entries, now)) {
        return { entries, refreshed: false };
    }
    const refresh = refreshToken(entries);
    if (!refresh) {
        return { entries, refreshed: false, reason: 'the jar has no refresh token' };
    }
    log(opts.force
        ? 'the session was refused — renewing it'
        : 'the id token has expired — renewing the session');
    const apiKey = await readApiKey(cdp);
    const res = await exchangeRefresh(refresh, apiKey);
    if (!res.ok) {
        return { entries, refreshed: false, reason: res.reason };
    }
    log(`the session was refreshed (a new id token, valid for ${res.expiresIn}s)`);
    return { entries: applyFreshIdToken(entries, res.idToken), refreshed: true };
}

module.exports = {
    ID_COOKIE,
    REFRESH_COOKIE,
    SKEW_SECONDS,
    tokenExpiry,
    tokenExpired,
    sessionRejected,
    idToken,
    refreshToken,
    needsRefresh,
    applyFreshIdToken,
    refreshBody,
    refreshUrl,
    findApiKey,
    staleTokenMessage,
    readApiKey,
    exchangeRefresh,
    refreshSession,
};
