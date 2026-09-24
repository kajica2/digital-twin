#!/usr/bin/env node
'use strict';
// lib/mj-cookies.test.js
//
// Sprint 0.25 — tests for cookie-jar loading.
//
// The rule with real teeth here: browsers REJECT a `__Host-` cookie
// that carries a Domain attribute, silently. Get it wrong and
// midjourney.com renders "Log in" with no error, and the only symptom
// is a 45s "textarea not found" timeout. These tests pin that.
//
//   node lib/mj-cookies.test.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ck = require('./mj-cookies.js');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-cookies-test-'));
process.stderr.write(`\n[mj-cookies.test]\n\n`);

// 1. Netscape parsing
process.stderr.write(`1. parseNetscape\n`);
// Synthetic values — deliberately NOT shaped like real tokens.
// An earlier version used the first 8 characters of a live auth cookie,
// which is a partial secret derived from a real session.
const JAR = [
    '# Netscape HTTP Cookie File',
    '# http://curl.haxx.se/rfc/cookie_spec.html',
    '',
    '.midjourney.com\tTRUE\t/\tFALSE\t1797998923\t_fbp\tfb.1.123',
    'www.midjourney.com\tFALSE\t/\tTRUE\t1792814923\t__Host-Midjourney.AuthUserTokenV3_i\tFAKE-AUTH-I-VALUE',
    'www.midjourney.com\tFALSE\t/\tTRUE\t1792814923\t__Host-Midjourney.AuthUserTokenV3_r\tFAKE-AUTH-R-VALUE',
    'www.midjourney.com\tFALSE\t/\tFALSE\t1792814923\tGAESA\tabc',
    '',
].join('\n');

const entries = ck.parseNetscape(JAR);
assert('header + blank lines skipped', entries.length, 4);
assert('name parsed', entries[1].name, '__Host-Midjourney.AuthUserTokenV3_i');
assert('value parsed', entries[1].value, 'FAKE-AUTH-I-VALUE');
assert('domain parsed', entries[1].domain, 'www.midjourney.com');
assert('secure flag parsed', entries[1].secure, true);
assert('insecure flag parsed', entries[0].secure, false);
assert('expires parsed', entries[0].expires, 1797998923);

// 2. JSON parsing
process.stderr.write(`2. parseJson\n`);
const j = ck.parseJson(JSON.stringify([
    { name: 'a', value: '1', domain: '.x.com', path: '/', secure: true, expirationDate: 123 },
    { name: 'b', value: '2', url: 'https://x.com/', secure: true },
    { nope: true },
]));
assert('JSON array parsed', j.length, 2);
assert('expirationDate mapped to expires', j[0].expires, 123);
assert('url preserved', j[1].url, 'https://x.com/');
assert('entries without a name dropped', j.some(c => c.name === undefined), false);
assert('{cookies:[...]} wrapper accepted', ck.parseJson(JSON.stringify({ cookies: [{ name: 'z', value: '9' }] })).length, 1);

// 3. THE critical rule: __Host- cookies
process.stderr.write(`3. __Host- handling (the rule with teeth)\n`);
const ORIGIN = 'https://www.midjourney.com';
const browser = ck.toBrowserCookies(entries, ORIGIN);

const hostI = browser.find(c => c.name.includes('AuthUserTokenV3_i'));
const hostR = browser.find(c => c.name.includes('AuthUserTokenV3_r'));
assertTrue('auth token i converted', !!hostI);
assertTrue('auth token r converted', !!hostR);
assertTrue('__Host- cookie carries NO domain', hostI.domain === undefined);
assert('__Host- cookie uses url instead', hostI.url, ORIGIN);
assert('__Host- cookie path is /', hostI.path, '/');
assert('__Host- cookie is secure', hostI.secure, true);

// A non-Host cookie keeps its domain.
const fbp = browser.find(c => c.name === '_fbp');
assert('plain cookie keeps its domain', fbp.domain, '.midjourney.com');
assertTrue('plain cookie has no url override', fbp.url === undefined);

// 4. expires semantics
process.stderr.write(`4. expires=0 means session cookie\n`);
const sessionJar = [
    '.midjourney.com\tTRUE\t/\tTRUE\t0\t_cfuvid\tabc',
].join('\n');
const s = ck.toBrowserCookies(ck.parseNetscape(sessionJar), ORIGIN);
assertTrue('expires omitted when 0', s[0].expires === undefined);
assertTrue('secure preserved', s[0].secure === true);

// 5. __Secure- prefix must be secure
process.stderr.write(`5. __Secure- prefix forced secure\n`);
const sec = ck.toBrowserCookies(
    ck.parseNetscape('.x.com\tTRUE\t/\tFALSE\t0\t__Secure-token\tv'), ORIGIN);
assert('__Secure- forced secure', sec[0].secure, true);
assertTrue('__Secure- keeps its domain', sec[0].domain === '.x.com');

// 6. file auto-detection + dedupe
process.stderr.write(`6. parseCookieFile — format detection\n`);
const nsPath = path.join(TMP, 'jar.txt');
fs.writeFileSync(nsPath, JAR);
assert('netscape file detected', ck.parseCookieFile(nsPath).length, 4);

const jsPath = path.join(TMP, 'jar.json');
fs.writeFileSync(jsPath, JSON.stringify([{ name: 'q', value: '1' }]));
assert('json file detected', ck.parseCookieFile(jsPath).length, 1);

const dupPath = path.join(TMP, 'dup.txt');
fs.writeFileSync(dupPath, [
    '.x.com\tTRUE\t/\tFALSE\t0\tdup\tfirst',
    '.y.com\tTRUE\t/\tFALSE\t0\tdup\tsecond',
].join('\n'));
assert('same name on different domains kept', ck.parseCookieFile(dupPath).length, 2);

// 7. preflight description
process.stderr.write(`7. describe() — the preflight check\n`);
const d = ck.describe(entries);
assert('count', d.count, 4);
assert('detects auth i', d.hasAuthI, true);
assert('detects auth r', d.hasAuthR, true);
assert('counts __Host- cookies', d.hostPrefixed, 2);

const noAuth = ck.describe(ck.parseNetscape('.x.com\tTRUE\t/\tFALSE\t0\tfoo\tbar'));
assert('flags a jar with no auth', noAuth.hasAuthI, false);
assert('flags a jar with no auth (r)', noAuth.hasAuthR, false);

// 8. malformed input never throws
process.stderr.write(`8. malformed input is tolerated\n`);
assert('empty jar', ck.parseNetscape(''), []);
assert('garbage JSON', ck.parseJson('not json'), []);
assert('short rows skipped', ck.parseNetscape('a\tb\tc'), []);
assert('missing file throws (caller checks existence)', (() => {
    try { ck.parseCookieFile(path.join(TMP, 'nope.txt')); return 'threw'; }
    catch { return 'threw'; }
})(), 'threw');

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.stderr.write(`\n[mj-cookies.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
