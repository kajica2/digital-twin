#!/usr/bin/env node
'use strict';
// lib/x-cookie-capture.js
//
// Capture the user's own X (Twitter) session out of their local Chrome
// profile, so the twin can post on their behalf.
//
// WHY THIS EXISTS
//
// The X session is two cookies — auth_token and ct0 — and both live in
// Chrome's encrypted cookie store. The user can export them by hand
// (a cookie-export extension), but that is a manual step every time the
// session rotates, and the twin's whole job is to not need a manual step.
//
// HOW IT READS THEM
//
// Chrome on macOS stores each cookie value AES-128-CBC encrypted under a
// key derived from the "Chrome Safe Storage" Keychain item:
//
//   key      = PBKDF2-SHA1(password, "saltysalt", 1003, 16)
//   blob     = "v10" || AES-128-CBC(key, iv = 16 spaces, plaintext)
//   plaintext= SHA256(host_key) || value
//
// The 32-byte SHA256 prefix is Chromium's host-key digest, not noise: it
// is a free integrity check, and this module ASSERTS it. A decryption
// that produces the right bytes for the wrong host is impossible here.
//
// A DELIBERATE SCOPE LIMIT
//
// This module decrypts x.com and twitter.com cookies, and nothing else.
// The host list below is a hard allowlist, applied BEFORE any decryption
// happens, so this file cannot be repurposed into a general-purpose
// credential extractor for the user's browser. If a future platform needs
// the same treatment, that platform gets its own capture module with its
// own allowlist — not a widened one.
//
// The jar it writes lives OUTSIDE the repo (~/.x-cookies.txt by default).
// .gitignore also carries a `*-cookies.txt` rule as a second line of
// defence, but the primary guarantee is that the default path is not in
// the repo at all.
//
// Usage:
//   node lib/x-cookie-capture.js                     # auto-pick a profile
//   node lib/x-cookie-capture.js --profile "Profile 1"
//   node lib/x-cookie-capture.js --out ~/some-jar.txt
//   node lib/x-cookie-capture.js --check             # validate a jar
//
// Pure Node, no deps. macOS only (the keychain is the OS's).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// The ONLY hosts this module will decrypt. See the scope note above.
const ALLOWED_HOSTS = ['.x.com', 'x.com', '.twitter.com', 'twitter.com'];

// The cookies an authenticated X session needs.
const REQUIRED = ['auth_token', 'ct0'];

const KEYCHAIN_SERVICE = 'Chrome Safe Storage';
const PBKDF_SALT = 'saltysalt';
const PBKDF_ROUNDS = 1003;
const PBKDF_KEYLEN = 16;

// Chrome's fixed IV for the v10 scheme: sixteen spaces.
const FIXED_IV = Buffer.alloc(16, 0x20);

// Chrome's cookie DB stores expires_utc in WebKit microseconds since
// 1601-01-01. Unix seconds is 11644473600 seconds later.
const WEBKIT_EPOCH_OFFSET = 11644473600;

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return p;
}

/** Where Chrome keeps its profiles on macOS. */
function chromeRoot() {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
}

/** The profile directories that actually exist. */
function listProfiles() {
    const root = chromeRoot();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
        .filter(name => {
            if (name === 'Default') return true;
            if (!name.startsWith('Profile ')) return false;
            return fs.existsSync(path.join(root, name, 'Cookies'));
        })
        .sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
}

/**
 * The "Chrome Safe Storage" password from the login keychain.
 *
 * macOS may prompt for keychain access the first time. That prompt is the
 * point: it is the user saying yes to their own machine reading their
 * own browser's own password.
 */
function safeStoragePassword() {
    try {
        return execFileSync(
            'security',
            ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).replace(/\s+$/, '');
    } catch (e) {
        const err = new Error(
            'could not read the "' + KEYCHAIN_SERVICE + '" keychain item. ' +
            'macOS may be asking for permission — approve it and run again.'
        );
        err.cause = e;
        throw err;
    }
}

/** PBKDF2 key for the cookie store. */
function deriveKey(password) {
    return crypto.pbkdf2Sync(password, PBKDF_SALT, PBKDF_ROUNDS, PBKDF_KEYLEN, 'sha1');
}

/**
 * Decrypt one v10 cookie blob.
 *
 * @param {Buffer} blob   the raw encrypted_value
 * @param {string} hostKey the cookie's host_key, used for the digest check
 * @param {Buffer} key    the PBKDF2 key
 * @returns {string|null} the plaintext value, or null if it cannot be trusted
 */
function decryptValue(blob, hostKey, key) {
    if (!blob || blob.length < 3 + 16) return null;
    if (blob.subarray(0, 3).toString('latin1') !== 'v10') return null;   // unsupported scheme
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, FIXED_IV);
        const plain = Buffer.concat([
            decipher.update(blob.subarray(3)),
            decipher.final(),
        ]);
        // Chromium prefixes the plaintext with the host-key digest. If it
        // does not match, this is not our cookie — refuse rather than
        // return bytes that belong to another host.
        const digest = crypto.createHash('sha256').update(hostKey).digest();
        if (!plain.subarray(0, 32).equals(digest)) return null;
        return plain.subarray(32).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * Read the X cookies out of one Chrome profile's cookie database.
 *
 * The database is copied to a scratch file first: Chrome holds a lock on
 * the live one, and the copy is what makes a read safe while a browser is
 * running.
 */
function readProfileCookies(profile, key) {
    const dbPath = path.join(chromeRoot(), profile, 'Cookies');
    if (!fs.existsSync(dbPath)) return [];

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x-cookie-capture-'));
    const copy = path.join(scratch, 'Cookies');
    try {
        fs.copyFileSync(dbPath, copy);
        // A sidecar journal, if Chrome is mid-write.
        for (const suffix of ['-wal', '-shm', '-journal']) {
            const side = dbPath + suffix;
            if (fs.existsSync(side)) {
                try { fs.copyFileSync(side, copy + suffix); } catch { /* best effort */ }
            }
        }

        // The host list is a module constant, but it is interpolated into
        // SQL rather than bound, because the sqlite3 CLI takes no bind
        // parameters — and an argument like ".x.com" would be read as a
        // dot-command. The guard keeps the interpolation honest.
        for (const host of ALLOWED_HOSTS) {
            if (!/^[a-z0-9.-]+$/.test(host)) {
                throw new Error('refusing to query an unsafe host name: ' + host);
            }
        }
        const hostList = ALLOWED_HOSTS.map(h => "'" + h + "'").join(',');

        const sql =
            'SELECT host_key, name, value, hex(encrypted_value) AS ev, ' +
            'expires_utc, is_secure, is_httponly, samesite, path ' +
            'FROM cookies WHERE host_key IN (' + hostList + ')';

        const out = execFileSync('sqlite3', ['-json', copy, sql], {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        }).trim();
        if (!out) return [];
        const rows = JSON.parse(out);

        const entries = [];
        for (const row of rows) {
            let value = row.value || '';
            if (!value && row.ev) {
                value = decryptValue(Buffer.from(row.ev, 'hex'), row.host_key, key) || '';
            }
            if (!value) continue;
            entries.push({
                name: row.name,
                value,
                domain: row.host_key,
                path: row.path || '/',
                secure: !!row.is_secure,
                httpOnly: !!row.is_httponly,
                expires: webkitToUnix(row.expires_utc),
            });
        }
        return entries;
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

/** Chrome's WebKit-microsecond expiry → Unix seconds. */
function webkitToUnix(webkitMicros) {
    const n = Number(webkitMicros || 0);
    if (!n) return 0;
    return Math.round(n / 1e6 - WEBKIT_EPOCH_OFFSET);
}

/**
 * Write a Netscape-format jar.
 *
 * Chrome's own cookie export marks HTTP-only cookies by prefixing the
 * domain with "#HttpOnly_". The format is used by curl and every cookie
 * editor in the world, so the jar this writes is portable — and the
 * HTTP-only flag survives the round trip.
 */
function toNetscape(entries) {
    const lines = [
        '# Netscape HTTP Cookie File',
        '# Captured by lib/x-cookie-capture.js — X session cookies only.',
        '',
    ];
    for (const e of entries) {
        const domain = e.domain || '.x.com';
        const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const prefix = e.httpOnly ? '#HttpOnly_' : '';
        lines.push([
            prefix + domain,
            includeSub,
            e.path || '/',
            e.secure ? 'TRUE' : 'FALSE',
            e.expires || 0,
            e.name,
            e.value,
        ].join('\t'));
    }
    return lines.join('\n') + '\n';
}

/** A jar is a session only if it carries both required cookies. */
function isComplete(entries) {
    const names = new Set(entries.map(e => e.name));
    return REQUIRED.every(n => names.has(n));
}

/**
 * Capture the X session.
 *
 * @param {object} options
 * @param {string} [options.profile] which Chrome profile to read
 * @param {string} [options.out]      where to write the jar
 * @returns {object} a report — names and domains only, never a value
 */
function capture(options) {
    const opts = options || {};
    const outPath = expandHome(opts.out || path.join(process.env.HOME || '', '.x-cookies.txt'));

    // Refuse to write a credential into the repo. The jar's home is
    // outside it; a repo-local path is a mistake, not a choice.
    const resolved = path.resolve(outPath);
    if (resolved === REPO || resolved.startsWith(REPO + path.sep)) {
        throw new Error(
            'refusing to write the cookie jar inside the repo (' + path.relative(REPO, resolved) +
            '). Credentials never enter the repository — use a path under your home directory.'
        );
    }

    const profiles = listProfiles();
    if (!profiles.length) throw new Error('no Chrome profiles found at ' + chromeRoot());

    const candidates = opts.profile ? [opts.profile] : profiles;
    if (opts.profile && !profiles.includes(opts.profile)) {
        throw new Error('no such Chrome profile: ' + opts.profile);
    }

    const password = safeStoragePassword();
    const key = deriveKey(password);

    const found = [];
    for (const profile of candidates) {
        const entries = readProfileCookies(profile, key);
        if (!entries.length) continue;
        found.push({ profile, entries });
    }
    if (!found.length) {
        throw new Error(
            'no X cookies found in ' + candidates.join(', ') +
            ' — is the browser signed in to x.com?'
        );
    }

    // With several profiles holding a session, the one whose session runs
    // longest is the likelier live one.
    const latest = (entries) => entries.reduce(
        (max, e) => (e.name === 'auth_token' && e.expires > max ? e.expires : max), 0);
    found.sort((a, b) => latest(b.entries) - latest(a.entries));

    const complete = found.filter(f => isComplete(f.entries));
    const chosen = (complete[0] || found[0]);
    const entries = chosen.entries;

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, toNetscape(entries), { mode: 0o600 });

    return {
        path: resolved,
        profile: chosen.profile,
        count: entries.length,
        complete: isComplete(entries),
        missing: REQUIRED.filter(n => !entries.some(e => e.name === n)),
        names: entries.map(e => e.name),
        domains: [...new Set(entries.map(e => e.domain))],
        otherProfiles: found.filter(f => f.profile !== chosen.profile)
            .map(f => ({ profile: f.profile, complete: isComplete(f.entries), count: f.entries.length })),
    };
}

module.exports = {
    ALLOWED_HOSTS,
    REQUIRED,
    capture,
    listProfiles,
    readProfileCookies,
    decryptValue,
    deriveKey,
    safeStoragePassword,
    toNetscape,
    isComplete,
    webkitToUnix,
    chromeRoot,
    expandHome,
    REPO,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    const argVal = (name, fallback) => {
        const i = argv.indexOf(name);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    const has = (name) => argv.includes(name);

    try {
        if (has('--check')) {
            const jarPath = expandHome(argVal('--jar', path.join(process.env.HOME || '', '.x-cookies.txt')));
            const ck = require('./x-cookies.js');
            const entries = ck.parseCookieFile(jarPath);
            const info = ck.describe(entries);
            const verdict = ck.validate(entries);
            process.stdout.write(
                'jar: ' + jarPath + '\n' +
                'cookies: ' + info.count + ' across ' + info.domains.join(', ') + '\n' +
                'names: ' + info.names.join(', ') + '\n' +
                'auth_token: ' + (info.hasAuthToken ? 'present' : 'MISSING') + '\n' +
                'ct0: ' + (info.hasCt0 ? 'present' : 'MISSING') + '\n' +
                'session: ' + (verdict.valid ? 'complete' : 'incomplete — missing ' + verdict.missing.join(', ')) + '\n'
            );
            process.exit(verdict.valid ? 0 : 2);
        }

        const report = capture({
            profile: argVal('--profile', undefined),
            out: argVal('--out', undefined),
        });
        process.stdout.write(
            'captured: ' + report.count + ' X cookies from Chrome profile "' + report.profile + '"\n' +
            'jar: ' + report.path + '\n' +
            'domains: ' + report.domains.join(', ') + '\n' +
            'names: ' + report.names.join(', ') + '\n' +
            'session: ' + (report.complete ? 'complete (auth_token + ct0)' : 'INCOMPLETE — missing ' + report.missing.join(', ')) + '\n' +
            (report.otherProfiles.length
                ? 'other profiles with X cookies: ' +
                  report.otherProfiles.map(p => p.profile + ' (' + p.count + ', ' + (p.complete ? 'complete' : 'no session') + ')').join('; ') + '\n'
                : '')
        );
        process.exit(report.complete ? 0 : 2);
    } catch (e) {
        process.stderr.write('capture failed: ' + e.message + '\n');
        process.exit(1);
    }
}
