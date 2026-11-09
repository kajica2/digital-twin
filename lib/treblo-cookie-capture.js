#!/usr/bin/env node
'use strict';
// lib/treblo-cookie-capture.js
//
// Capture a live Treblo session out of the browser that is already signed
// in, and write it to ~/.treblo-cookies.txt.
//
// WHY
//
// A pasted cookie jar is lossy: the chat truncates the Supabase auth
// cookie (it is chunked, and the second chunk is often the one that
// goes missing), the export is space-separated, and the values carry a
// "base64-" annotation that is not part of the cookie. The browser
// already holds the real session — read it from there.
//
// The same discipline as lib/x-cookie-capture.js: the host allowlist is
// applied BEFORE any decryption, and only treblo.com is ever touched.
//
// macOS only. The keychain read may prompt once ("Chrome Safe
// Storage" / "Comet Safe Storage").

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const ALLOWED_HOSTS = ['treblo.com', '.treblo.com'];
const KEYCHAIN_SERVICES = ['Chrome Safe Storage', 'Comet Safe Storage'];
const PBKDF_SALT = 'saltysalt';
const PBKDF_ROUNDS = 1003;
const PBKDF_KEYLEN = 16;
const FIXED_IV = Buffer.alloc(16, 0x20);
const OUT = path.join(os.homedir(), '.treblo-cookies.txt');

function browserRoots() {
    const home = process.env.HOME || '';
    return [
        path.join(home, 'Library', 'Application Support', 'Comet'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    ];
}

function listProfiles() {
    const out = [];
    for (const root of browserRoots()) {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
            const dir = path.join(root, name);
            const db = path.join(dir, 'Cookies');
            const network = path.join(dir, 'Network', 'Cookies');
            if (fs.existsSync(db)) out.push({ browser: path.basename(root), profile: name, db });
            else if (fs.existsSync(network)) out.push({ browser: path.basename(root), profile: name, db: network });
        }
    }
    return out;
}

function safeStoragePasswords() {
    const found = [];
    for (const service of KEYCHAIN_SERVICES) {
        try {
            const res = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            });
            const password = res.trim();
            if (password) found.push({ password, service });
        } catch (e) { /* try the next service */ }
    }
    if (!found.length) {
        throw new Error(
            `could not read the safe-storage key (${KEYCHAIN_SERVICES.join(' or ')}). ` +
            'Grant access when macOS asks, then run it again.',
        );
    }
    return found;
}

function deriveKey(password) {
    return crypto.pbkdf2Sync(password, PBKDF_SALT, PBKDF_ROUNDS, PBKDF_KEYLEN, 'sha1');
}

function decryptValue(blob, hostKey, keys) {
    if (!blob) return '';
    const buf = Buffer.from(blob, 'hex');
    if (buf.length < 3) return '';
    const version = buf.subarray(0, 3).toString('utf8');
    if (version !== 'v10' && version !== 'v11') return '';
    const payload = buf.subarray(3);
    // Each browser has its OWN safe-storage key (Chrome's and Comet's
    // differ), and the profile knows which browser it belongs to — so try
    // them all and take the one that decrypts.
    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, FIXED_IV);
            const plain = Buffer.concat([decipher.update(payload), decipher.final()]);
            return plain.toString('utf8');
        } catch (e) { /* wrong key — try the next */ }
    }
    return '';
}

function readCookies(profile, keys) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-cookies-'));
    const copy = path.join(scratch, 'Cookies');
    try {
        fs.copyFileSync(profile.db, copy);
        for (const sidecar of ['-wal', '-shm']) {
            if (fs.existsSync(profile.db + sidecar)) {
                try { fs.copyFileSync(profile.db + sidecar, copy + sidecar); } catch (e) { /* optional */ }
            }
        }
        const sql = `SELECT host_key, name, value, encrypted_value, expires_utc, is_secure, path FROM cookies`;
        const out = execFileSync('sqlite3', ['-json', copy, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const rows = out.trim() ? JSON.parse(out) : [];
        const cookies = [];
        for (const row of rows) {
            // The allowlist is applied BEFORE any decryption.
            if (!ALLOWED_HOSTS.includes(row.host_key)) continue;
            const value = row.value || decryptValue(row.encrypted_value, row.host_key, key);
            if (!value) continue;
            cookies.push({
                domain: row.host_key,
                secure: !!row.is_secure,
                path: row.path || '/',
                expires: row.expires_utc,
                name: row.name,
                value,
            });
        }
        return cookies;
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

function toNetscape(cookies) {
    const lines = [
        '# Netscape HTTP Cookie File',
        '# http://curl.haxx.se/rfc/cookie_spec.html',
        '# This is a generated file!  Do not edit.',
        '',
    ];
    for (const c of cookies) {
        const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const expires = c.expires && c.expires > 0 ? Math.floor(c.expires / 1000000) - 11644473600 : 0;
        lines.push([c.domain, includeSub, c.path, c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
    }
    return lines.join('\n') + '\n';
}

/**
 * Capture the session and write the jar.
 * @returns {{file: string, cookies: number, profile: string, browser: string}}
 */
function capture(opts = {}) {
    const out = opts.out || OUT;
    const secrets = opts.password
        ? [{ password: opts.password, service: 'given' }]
        : safeStoragePasswords();
    const keys = secrets.map(s => deriveKey(s.password));
    const profiles = listProfiles();
    let best = null;
    for (const profile of profiles) {
        let cookies = [];
        try {
            cookies = readCookies(profile, keys);
        } catch (e) {
            continue;
        }
        const auth = cookies.find(c => c.name.startsWith('sb-db-auth-token'));
        if (!auth) continue;
        const count = cookies.filter(c => c.name.startsWith('sb-db-auth-token')).length;
        if (!best || count > best.cookies.length) best = { profile, cookies };
        if (count > 1) break;
    }
    if (!best) {
        throw new Error(
            'no Treblo session found in the browser profiles. Sign in at treblo.com and run it again.',
        );
    }
    fs.writeFileSync(out, toNetscape(best.cookies));
    fs.chmodSync(out, 0o600);
    return {
        file: out,
        cookies: best.cookies.length,
        browser: best.profile.browser,
        profile: best.profile.profile,
        keychain: secrets.map(s => s.service).join(' / '),
    };
}

module.exports = { capture, listProfiles, toNetscape, ALLOWED_HOSTS, OUT };

if (require.main === module) {
    try {
        const res = capture();
        console.log(`treblo: ${res.cookies} cookie(s) from ${res.browser}/${res.profile} -> ${res.file}`);
    } catch (e) {
        process.stderr.write(`treblo: ${e.message}\n`);
        process.exit(1);
    }
}
