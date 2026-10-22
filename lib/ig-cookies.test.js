#!/usr/bin/env node
'use strict';

/**
 * lib/ig-cookies.test.js — the cookie jar → Chrome conversion.
 *
 * The `__Host-` rule is the interesting one: a `__Host-` cookie must
 * not carry a Domain attribute, so it has to be expressed through a
 * URL instead — and that URL has to be the cookie's OWN host. A
 * Google's `__Host-GAPS` addressed to instagram.com would send
 * Google's cookie to Instagram.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCookieFile, toBrowserCookies } = require('./ig-cookies.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-cookies-test-'));

function writeJar(lines) {
    const p = path.join(tmp, 'jar.txt');
    fs.writeFileSync(p, [
        '# Netscape HTTP Cookie File',
        '',
        ...lines,
        '',
    ].join('\n'));
    return p;
}

console.log('ig-cookies');

check('parseCookieFile reads the Netscape columns', () => {
    const p = writeJar(['.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tabc123']);
    const [c] = parseCookieFile(p);
    assert.strictEqual(c.domain, '.instagram.com');
    assert.strictEqual(c.flag, true);
    assert.strictEqual(c.path, '/');
    assert.strictEqual(c.secure, true);
    assert.strictEqual(c.name, 'sessionid');
    assert.strictEqual(c.value, 'abc123');
});

check('parseCookieFile skips comments and blank lines', () => {
    const p = writeJar(['# a comment', '', '.instagram.com\tTRUE\t/\tTRUE\t0\tig_did\txyz']);
    const cookies = parseCookieFile(p);
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].name, 'ig_did');
});

check('a regular cookie keeps its domain attribute', () => {
    const p = writeJar(['.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc']);
    const [c] = toBrowserCookies(parseCookieFile(p));
    assert.strictEqual(c.domain, '.instagram.com');
    assert.strictEqual(c.url, 'https://instagram.com',
        'the leading dot must not end up in the URL');
});

check('a __Host- cookie carries no domain attribute', () => {
    const p = writeJar(['accounts.google.com\tFALSE\t/\tTRUE\t0\t__Host-GAPS\tsomevalue']);
    const [c] = toBrowserCookies(parseCookieFile(p));
    assert.strictEqual(c.domain, undefined, 'a __Host- cookie must not carry a domain');
    assert.strictEqual(c.path, '/');
    assert.strictEqual(c.secure, true);
});

check("a __Host- cookie is addressed to its OWN host, not to Instagram's", () => {
    const p = writeJar(['accounts.google.com\tFALSE\t/\tTRUE\t0\t__Host-GAPS\tsomevalue']);
    const [c] = toBrowserCookies(parseCookieFile(p));
    assert.strictEqual(c.url, 'https://accounts.google.com',
        "a Google's __Host- cookie was addressed to Instagram");
});

check('a __Host- cookie with no host falls back to the caller origin', () => {
    const p = writeJar(['\tFALSE\t/\tTRUE\t0\t__Host-BARE\tvalue']);
    const cookies = parseCookieFile(p);
    assert.strictEqual(cookies.length, 1,
        'a cookie with an empty domain column was dropped');
    const [c] = toBrowserCookies(cookies, 'https://studio.youtube.com');
    assert.strictEqual(c.url, 'https://studio.youtube.com');
});

check('the Instagram default is unchanged', () => {
    const p = writeJar(['\tFALSE\t/\tTRUE\t0\t__Host-BARE\tvalue']);
    const [c] = toBrowserCookies(parseCookieFile(p));
    assert.strictEqual(c.url, 'https://www.instagram.com');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
