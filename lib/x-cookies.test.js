#!/usr/bin/env node
'use strict';
// lib/x-cookies.test.js
//
// Tests for the X cookie module.
//
// The rule with teeth here: X needs TWO cookies — auth_token (the
// session) and ct0 (the CSRF token). A jar with only one of them looks
// plausible and fails at write time, so validate() names the missing
// cookie rather than returning a boolean.
//
// The other rule: the module must never leak a cookie VALUE. describe()
// reports names and domains; nothing else. That is asserted here by
// checking that no value appears in its output.
//
//   node lib/x-cookies.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ck = require('./x-cookies.js');
const cap = require('./x-cookie-capture.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write('\n[x-cookies.test]\n\n');

// 1. Netscape parsing
process.stderr.write('1. parseNetscape\n');
// Synthetic values — deliberately NOT shaped like real tokens.
const JAR = [
    '# Netscape HTTP Cookie File',
    '',
    '.x.com\tTRUE\t/\tTRUE\t1797998923\tauth_token\tFAKE-AUTH-TOKEN-VALUE',
    '.x.com\tTRUE\t/\tTRUE\t1797998923\tct0\tFAKE-CSRF-VALUE',
    'x.com\tFALSE\t/\tFALSE\t1792814923\tguest_id\tFAKE-GUEST',
    '',
].join('\n');

const entries = ck.parseNetscape(JAR);
assert('header + blank lines skipped', entries.length, 3);
assert('name parsed', entries[0].name, 'auth_token');
assert('value parsed', entries[0].value, 'FAKE-AUTH-TOKEN-VALUE');
assert('domain parsed', entries[0].domain, '.x.com');
assert('path parsed', entries[0].path, '/');
assert('secure parsed', entries[0].secure, true);
assert('expires parsed', entries[0].expires, 1797998923);
assert('the second cookie parses too', entries[1].name, 'ct0');

// 2. JSON parsing
process.stderr.write('\n2. parseJson\n');
const JSONJAR = JSON.stringify([
    { name: 'auth_token', value: 'FAKE-AUTH', domain: '.x.com', path: '/', secure: true, expirationDate: 1797998923 },
    { name: 'ct0', value: 'FAKE-CSRF', domain: '.x.com', secure: true },
]);
const jentries = ck.parseJson(JSONJAR);
assert('json entries parsed', jentries.length, 2);
assert('json name parsed', jentries[0].name, 'auth_token');
assert('json value parsed', jentries[0].value, 'FAKE-AUTH');
assert('json expiry parsed', jentries[0].expires, 1797998923);
assert('a malformed json file is empty, not a throw', ck.parseJson('{ nope').length, 0);

// 3. parseCookieFile auto-detects
process.stderr.write('\n3. parseCookieFile\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x-cookies-test-'));
const jarPath = path.join(TMP, 'jar.txt');
fs.writeFileSync(jarPath, JAR);
assert('a netscape file is detected', ck.parseCookieFile(jarPath).length, 3);
const jsonPath = path.join(TMP, 'jar.json');
fs.writeFileSync(jsonPath, JSONJAR);
assert('a json file is detected', ck.parseCookieFile(jsonPath).length, 2);

// 4. toBrowserCookies — the __Host- rule
process.stderr.write('\n4. toBrowserCookies\n');
const bc = ck.toBrowserCookies([
    { name: 'auth_token', value: 'V', domain: '.x.com', path: '/', secure: true, expires: 1797998923 },
    { name: '__Host-x_token', value: 'V', domain: '.x.com', path: '/', secure: true },
    { name: 'plain', value: 'V', domain: '.x.com', path: '/', secure: false },
], 'https://x.com');
assert('three cookies converted', bc.length, 3);
assert('an ordinary cookie keeps its domain', bc[0].domain, '.x.com');
assert('an ordinary cookie is secure', bc[0].secure, true);
assert('an ordinary cookie keeps its path', bc[0].path, '/');
assert('a __Host- cookie carries NO domain', bc[1].domain, undefined);
assert('a __Host- cookie is expressed via url', bc[1].url, 'https://x.com');
assert('a __Host- cookie has path /', bc[1].path, '/');
assert('a __Host- cookie is secure', bc[1].secure, true);
assert('a non-secure cookie stays non-secure', bc[2].secure, false);
assert('sameSite is set on a secure cookie', bc[0].sameSite, 'Lax');
assert('sameSite is NOT set on a non-secure cookie', bc[2].sameSite, undefined);
assert('a session cookie omits the expiry', bc[1].expires, undefined);
assert('a dated cookie keeps the expiry', bc[0].expires, 1797998923);

// 5. describe — names and domains, never values
process.stderr.write('\n5. describe\n');
const info = ck.describe(entries);
assert('the count is right', info.count, 3);
assert('auth_token is detected', info.hasAuthToken, true);
assert('ct0 is detected', info.hasCt0, true);
assert('the domains are listed', info.domains, ['.x.com', 'x.com']);
assert('the names are listed', info.names, ['auth_token', 'ct0', 'guest_id']);
const described = JSON.stringify(info);
assertTrue('no cookie VALUE appears in describe()', !described.includes('FAKE-AUTH-TOKEN-VALUE'));
assertTrue('no cookie VALUE appears in describe() (ct0)', !described.includes('FAKE-CSRF-VALUE'));

// 6. validate — both cookies required
process.stderr.write('\n6. validate\n');
assert('a complete session is valid', ck.validate(entries).valid, true);
const onlyAuth = ck.validate(entries.filter(e => e.name === 'auth_token'));
assert('a jar without ct0 is not valid', onlyAuth.valid, false);
assert('the missing cookie is named', onlyAuth.missing, ['ct0']);
const onlyCsrf = ck.validate(entries.filter(e => e.name === 'ct0'));
assert('a jar without auth_token is not valid', onlyCsrf.valid, false);
assert('the missing cookie is named', onlyCsrf.missing, ['auth_token']);
assert('an empty jar is not valid', ck.validate([]).valid, false);

// 7. defaultCookiePath — outside the repo
process.stderr.write('\n7. defaultCookiePath\n');
const def = ck.defaultCookiePath();
assertTrue('the default jar is under the home directory', def.startsWith(os.homedir()));
assertTrue('the default jar is not inside the repo', !def.startsWith(cap.REPO));

// 8. the capture module — scope and format
process.stderr.write('\n8. the capture module\n');
assert('the host allowlist is X only', cap.ALLOWED_HOSTS, ['.x.com', 'x.com', '.twitter.com', 'twitter.com']);
assert('the required cookies are the two X needs', cap.REQUIRED, ['auth_token', 'ct0']);
assertTrue('the allowlist contains no non-X host',
    cap.ALLOWED_HOSTS.every(h => h === 'x.com' || h.endsWith('.x.com') || h === 'twitter.com' || h.endsWith('.twitter.com')));

const net = cap.toNetscape([
    { name: 'auth_token', value: 'V1', domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: 1797998923 },
    { name: 'ct0', value: 'V2', domain: '.x.com', path: '/', secure: true, httpOnly: false, expires: 1797998924 },
]);
assertTrue('the jar has the netscape header', net.startsWith('# Netscape HTTP Cookie File\n'));
assertTrue('the http-only cookie is marked', net.includes('#HttpOnly_.x.com'));
assertTrue('the ordinary cookie is not marked', net.includes('\n.x.com\t'));
const roundTrip = ck.parseNetscape(net);
assert('the jar round-trips', roundTrip.length, 2);
assert('the round-tripped value is intact', roundTrip[0].value, 'V1');
assert('the round-tripped domain is intact', roundTrip[0].domain, '.x.com');
assert('the round-tripped expiry is intact', roundTrip[0].expires, 1797998923);
// The HTTP-only row is the session cookie on X. A parser that treats
// "#HttpOnly_" as a comment drops it, and the jar then looks valid but
// is not.
assert('the http-only row survives the round trip', roundTrip[0].httpOnly, true);
assert('the ordinary row is not http-only', roundTrip[1].httpOnly, false);
const rtBrowser = ck.toBrowserCookies(roundTrip, 'https://x.com');
assert('the http-only flag reaches the browser cookie', rtBrowser[0].httpOnly, true);
assert('the ordinary cookie is not http-only in the browser', rtBrowser[1].httpOnly, undefined);

// 9. the capture module refuses to write into the repo
process.stderr.write('\n9. the capture module refuses the repo\n');
let refused = null;
try {
    cap.capture({ out: path.join(cap.REPO, 'x-cookies.txt') });
} catch (e) {
    refused = e;
}
assertTrue('writing a jar into the repo is refused', !!refused);
assertTrue('the refusal names the repo', refused && /repo/i.test(refused.message));

// 10. webkit expiry conversion
process.stderr.write('\n10. expiry conversion\n');
// Chrome stores microseconds since 1601-01-01. 2027-06-04T00:00:00Z.
assert('a zero expiry is a session cookie', cap.webkitToUnix(0), 0);
const webkit = (Date.UTC(2027, 5, 4) / 1000 + 11644473600) * 1e6;
assert('a webkit expiry becomes unix seconds', cap.webkitToUnix(webkit), Math.round(Date.UTC(2027, 5, 4) / 1000));

// 11. decryptValue — the integrity check
process.stderr.write('\n11. decryptValue\n');
const crypto = require('node:crypto');
const key = cap.deriveKey('synthetic-test-password');
const hostKey = '.x.com';
const digest = crypto.createHash('sha256').update(hostKey).digest();
const plain = Buffer.concat([digest, Buffer.from('SYNTHETIC-VALUE')]);
const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
const blob = Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plain), cipher.final()]);
assert('a well-formed blob decrypts', cap.decryptValue(blob, hostKey, key), 'SYNTHETIC-VALUE');
assert('a blob for another host is refused', cap.decryptValue(blob, '.other.com', key), null);
assert('a non-v10 blob is refused', cap.decryptValue(Buffer.from('v11xxxx', 'latin1'), hostKey, key), null);
assert('a short blob is refused', cap.decryptValue(Buffer.from('v10'), hostKey, key), null);

fs.rmSync(TMP, { recursive: true, force: true });

process.stderr.write(`\n[x-cookies.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n`);
    process.exit(1);
}
