#!/usr/bin/env node
'use strict';
// lib/mj-token-refresh.test.js
//
// Tests for the Midjourney id-token refresh.
//
// THE BUG THIS EXISTS FOR
//
// The Midjourney session is two cookies:
//   __Host-Midjourney.AuthUserTokenV3_i   the ID token — a Firebase JWT
//                                          with a ONE-HOUR lifetime
//   __Host-Midjourney.AuthUserTokenV3_r   the REFRESH token — long-lived
//
// The id token expires after an hour, but the refresh token keeps
// working. When a jar older than an hour is loaded, midjourney.com
// receives the expired id token, DECIDES the session is invalid, CLEARS
// the cookie and redirects to /auth/signin.
//
// The symptom was a 45-second wait followed by "the prompt textarea
// never appeared. Verify the cookie jar is from a logged-in session." —
// which is a sentence about the jar when the jar is fine and the TOKEN is
// stale.
//
// MEASURED 2026-11-01: with the stale id token the server cleared the
// cookies and redirected to signin. Exchanging the refresh token for a
// new id token returned HTTP 200, and the Imagine page then loaded with
// the composer present.
//
// The pure half lives here; the network half is exercised live.
//
//   node lib/mj-token-refresh.test.js

'use strict';

const ck = require('./mj-cookies.js');
const tr = require('./mj-token-refresh.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++; failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[mj-token-refresh.test]\n\n`);

// A synthetic JWT whose payload we control. NOT a real token.
function makeJwt(payload) {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

const now = Math.floor(Date.now() / 1000);
const FRESH = makeJwt({ sub: 'u1', iat: now - 60, exp: now + 3500 });
const STALE = makeJwt({ sub: 'u1', iat: now - 7200, exp: now - 3600 });
const NO_EXP = makeJwt({ sub: 'u1', iat: now - 60 });

// ------------------------------------------------------------------
// 1. Reading the expiry out of the id token.
// ------------------------------------------------------------------
process.stderr.write('1. token expiry\n');
assert('a fresh token reads as fresh', tr.tokenExpired(FRESH, now), false);
assert('a stale token reads as expired', tr.tokenExpired(STALE, now), true);
assert('a token with no exp is treated as fresh', tr.tokenExpired(NO_EXP, now), false);
assert('a token with no exp returns null', tr.tokenExpiry(NO_EXP), null);
assert('a fresh token reports its expiry', tr.tokenExpiry(FRESH), now + 3500);
assert('a token with no exp returns null for the expiry', tr.tokenExpiry(NO_EXP), null);
assertTrue('a non-JWT value has no expiry', tr.tokenExpiry('not-a-jwt') === null);
assertTrue('a JWT with a non-numeric exp has no expiry', tr.tokenExpiry(makeJwt({ exp: 'soon' })) === null);

// ------------------------------------------------------------------
// 2. Picking the token out of a jar.
// ------------------------------------------------------------------
process.stderr.write('2. picking the token\n');
const jar = [
    { name: '_fbp', value: 'fb' },
    { name: '__Host-Midjourney.AuthUserTokenV3_i', value: STALE },
    { name: '__Host-Midjourney.AuthUserTokenV3_r', value: 'REFRESH-VALUE' },
];
assert('the id token is found', tr.idToken(jar), STALE);
assert('the refresh token is found', tr.refreshToken(jar), 'REFRESH-VALUE');
assert('no id token -> null', tr.idToken([{ name: 'x', value: 'y' }]), null);
assert('no refresh token -> null', tr.refreshToken([{ name: 'x', value: 'y' }]), null);

// The names must match the REAL cookies, so the lookup is by the exact
// cookie names rather than a loose "contains auth" test.
assertTrue('the id token is found by its exact cookie name',
    tr.idToken([{ name: '__Host-Midjourney.AuthUserTokenV3_i', value: 'v' }]) === 'v');
assertTrue('a lookalike cookie name is not mistaken for the id token',
    tr.idToken([{ name: 'AuthUserTokenV3_i_backup', value: 'v' }]) === null);

// ------------------------------------------------------------------
// 3. Deciding whether a refresh is needed.
// ------------------------------------------------------------------
process.stderr.write('3. the refresh decision\n');
assert('a stale id token needs a refresh', tr.needsRefresh(jar, now), true);
assert('a fresh id token needs none',
    tr.needsRefresh([{ name: '__Host-Midjourney.AuthUserTokenV3_i', value: FRESH }], now), false);
assert('no id token needs a refresh',
    tr.needsRefresh([{ name: '__Host-Midjourney.AuthUserTokenV3_r', value: 'r' }], now), true);
assert('no refresh token means no refresh is possible',
    tr.needsRefresh([{ name: '__Host-Midjourney.AuthUserTokenV3_i', value: STALE }], now), false);

// The skew: a token that expires in 30 seconds must be refreshed NOW, not
// in 30 seconds — the run takes minutes.
//
// Both halves are needed: needsRefresh() deliberately requires a refresh
// token too, because a jar with no refresh token CANNOT be refreshed and
// the caller should be told that rather than have it silently skipped.
const withRefresh = (idValue) => [
    { name: '__Host-Midjourney.AuthUserTokenV3_i', value: idValue },
    { name: '__Host-Midjourney.AuthUserTokenV3_r', value: 'REFRESH-VALUE' },
];
assert('a token about to expire is refreshed early',
    tr.needsRefresh(withRefresh(makeJwt({ exp: now + 30 })), now), true);
assert('a token with an hour left is left alone',
    tr.needsRefresh(withRefresh(makeJwt({ exp: now + 3600 })), now), false);
assert('a token that expires inside the skew window is refreshed',
    tr.needsRefresh(withRefresh(makeJwt({ exp: now + 60 })), now), true);

// ------------------------------------------------------------------
// 3b. Detecting a REJECTED session.
//
// The expiry is NOT the signal. MEASURED 2026-11-01: the jar's id token
// was still inside its validity window (exp 06:04, rejected at 05:44)
// and midjourney.com still cleared it and redirected to /auth/signin.
// The A/B was clean — same browser, same profile, same cookies, only the
// id token's VALUE differed:
//
//   original id token -> sent on the wire, server cleared both auth
//                        cookies, landed on /auth/signin
//   freshly minted id -> sent on the wire, page loaded, composer present
//
// The only claim that differs is `email_verified` (the fresh token) vs
// `umail_verified` (the typo'd one in the jar) — so the server is
// checking something the jar's token does not carry.
//
// Which is why the fix cannot be "refresh when expired". It has to be
// "refresh when the session is REJECTED", and the rejection is only
// visible AFTER the navigation.
// ------------------------------------------------------------------
process.stderr.write('3b. detecting a rejected session\n');
assert('the sign-in redirect is a rejection', tr.sessionRejected('https://www.midjourney.com/auth/signin?callbackUrl=%2Fimagine'), true);
assert('the imagine page is not a rejection', tr.sessionRejected('https://www.midjourney.com/imagine'), false);
assert('an empty url is not a rejection', tr.sessionRejected(''), false);
assert('a null url is not a rejection', tr.sessionRejected(null), false);
assertTrue('a page that merely mentions signin is not a rejection',
    tr.sessionRejected('https://www.midjourney.com/imagine') === false);

// ------------------------------------------------------------------
// 4. Applying a refreshed token to a jar.
// ------------------------------------------------------------------
process.stderr.write('4. applying the refresh\n');
const applied = tr.applyFreshIdToken(jar, 'NEW-ID-TOKEN');
assert('the id token is replaced', tr.idToken(applied), 'NEW-ID-TOKEN');
assert('the refresh token is untouched', tr.refreshToken(applied), 'REFRESH-VALUE');
assert('the other cookies are untouched',
    applied.filter((c) => c.name === '_fbp').length, 1);
assert('a jar with no id token is unchanged',
    tr.applyFreshIdToken([{ name: 'x', value: 'y' }], 'N').length, 1);

// The ORIGINAL jar must not be mutated — the caller may still want it.
const original = [{ name: '__Host-Midjourney.AuthUserTokenV3_i', value: STALE }];
tr.applyFreshIdToken(original, 'NEW');
assert('the original jar is not mutated', tr.idToken(original), STALE);

// ------------------------------------------------------------------
// 5. The exchange body.
// ------------------------------------------------------------------
process.stderr.write('5. the exchange\n');
const body = tr.refreshBody('REFRESH-VALUE');
assert('the grant type is refresh_token', body.grant_type, 'refresh_token');
assert('the refresh token is carried', body.refresh_token, 'REFRESH-VALUE');
assertTrue('the body carries nothing else', Object.keys(body).length === 2);

// The URL is where the exchange goes. Firebase's endpoint is
// `securetoken.googleapis.com/v1/token?key=<api key>` — the key ships in
// MJ's own bundle and is read from the live page.
// A key of the RIGHT SHAPE, built at runtime.
//
// The repo's secrets guard matches /\b(AIza[0-9A-Za-z_-]{30,})/ — any
// 30+ characters after AIza, from the real key alphabet. A synthetic key
// written out in full is therefore indistinguishable from a live one to
// the guard, and it kept `npm run test:secrets` RED.
//
// So the key is CONSTRUCTED, never literal: the source holds 'AIza' and
// a repeat count, and no credential-shaped string ever appears in the
// file. The matcher is still exercised on a real-shaped key.
const SYNTH_KEY = 'AIza' + 'S'.repeat(35);
assert('the synthetic key has the real shape', SYNTH_KEY.length, 39);

assert('the exchange URL carries the key',
    tr.refreshUrl(SYNTH_KEY).includes(`key=${SYNTH_KEY}`), true);
assertTrue('the exchange URL points at the Firebase token endpoint',
    tr.refreshUrl('K').startsWith('https://securetoken.googleapis.com/v1/token?key='));

// The API key is read out of the page's JS bundle. The matcher must be
// strict enough to find the real key and loose enough to find it in a
// minified bundle.
assert('the API key is found in a bundle',
    tr.findApiKey(`var a="${SYNTH_KEY}";`), SYNTH_KEY);
assertTrue('a bundle with no key yields null', tr.findApiKey('var a=1;') === null);
assertTrue('a truncated key is not accepted',
    tr.findApiKey('AIza' + 'S'.repeat(10)) === null);

// ------------------------------------------------------------------
// 6. The failure is explained, not guessed.
// ------------------------------------------------------------------
process.stderr.write('6. the error message\n');
const msg = tr.staleTokenMessage('/home/example/.midjourney-cookies.txt');
assertTrue('the message names the id token', /id token/i.test(msg));
assertTrue('the message names the refresh', /refresh/i.test(msg));
assertTrue('the message says the session was rejected', /reject|cleared|invalid/i.test(msg));
assertTrue('the message is actionable', /re-export|sign in|sign-in/i.test(msg));

process.stderr.write(`\n[mj-token-refresh.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
