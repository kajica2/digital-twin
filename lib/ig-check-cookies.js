#!/usr/bin/env node
'use strict';
// lib/ig-check-cookies.js
//
// Report on the Instagram cookie jar: is it there, does it have the
// auth tokens, and how old is it.
//
// An Instagram session is revoked SERVER-SIDE, so a jar can be
// perfectly well-formed and still dead — the only honest check is to
// load the page. This script does the cheap half; `ig-poster` does the
// real one and says so plainly when Instagram wants a password.
//
// Usage: node lib/ig-check-cookies.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCookieFile, describe, validate } = require('./ig-cookies.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'ig-config.json'), 'utf8'));

const jar = path.join(os.homedir(), CONFIG.cookiesFile.replace(/^~\//, ''));

if (!fs.existsSync(jar)) {
    console.error(`no cookie jar at ${jar}`);
    console.error('');
    console.error('Export one: log into instagram.com in a browser, then use a');
    console.error("'Get cookies.txt' extension (or DevTools) to save the jar there.");
    process.exit(2);
}

const cookies = parseCookieFile(jar);
console.log(jar);
console.log('  ' + describe(cookies));

const v = validate(cookies);
console.log('  structurally valid:', v.valid, v.missing.length ? `(missing: ${v.missing.join(', ')})` : '');

const stat = fs.statSync(jar);
const days = Math.round((Date.now() - stat.mtimeMs) / 86400000);
console.log(`  file age: ${days} day(s)`);
if (days > 7) {
    console.log('  note: Instagram sessions are usually revoked within days — this jar is likely dead.');
}

process.exit(v.valid ? 0 : 1);
