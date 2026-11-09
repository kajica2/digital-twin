#!/usr/bin/env node
'use strict';
// tools/treblo-connect.mjs — prove the Treblo web session from the browser
// that already holds it.
//
// The cookie jar's values are encrypted with the browser's own key, and
// newer Chromium builds do not use the derivation the repo's X capture
// knows. So instead of decrypting, the browser is given a COPY of the
// profile's cookie store and asked to do it: Chromium decrypts the
// session itself, and the app's API answers.
//
//   node tools/treblo-connect.mjs            # report what the session sees
//
// The profile copy is a scratch directory; the running browser is not
// touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cdpConnect, CDPClient } = require('../lib/mj-submitter.js');

const COMET = '/Applications/Comet.app/Contents/MacOS/Comet';
const PORT = Number(process.env.TREBLO_CDP_PORT || 9462);
const SOURCES = [
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'Comet', 'Default'),
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome', 'Default'),
];

function copyCookieStore() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'treblo-profile-'));
    const profile = path.join(scratch, 'Default');
    fs.mkdirSync(profile, { recursive: true });
    let copied = 0;
    for (const src of SOURCES) {
        for (const rel of ['Cookies', 'Cookies-wal', 'Cookies-shm', 'Local State']) {
            const from = path.join(src, rel);
            if (!fs.existsSync(from)) continue;
            try {
                fs.copyFileSync(from, path.join(profile, rel));
                if (rel === 'Cookies') copied++;
            } catch (e) { /* optional */ }
        }
        if (copied) break;
    }
    if (!copied) throw new Error('no cookie store found in the browser profiles');
    return { scratch, profile, copied };
}

async function main() {
    const { scratch, profile } = copyCookieStore();
    const chrome = spawn(COMET, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${scratch}`,
        '--no-first-run', '--no-default-browser-check',
        'about:blank',
    ], { stdio: 'ignore', detached: true });

    let cdp = null;
    for (let i = 0; i < 40 && !cdp; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const base = await cdpConnect(`http://127.0.0.1:${PORT}`);
            cdp = new CDPClient(base);
            await cdp.connect();
        } catch (e) { /* not up yet */ }
    }
    if (!cdp) {
        chrome.kill();
        fs.rmSync(scratch, { recursive: true, force: true });
        throw new Error('the browser did not open a debugging port');
    }

    try {
        // a fresh profile opens Comet's onboarding (three steps) and
        // steals the navigation — dismiss every step first
        for (let i = 0; i < 6; i++) {
            const what = await cdp.js(`(() => {
                const el = Array.from(document.querySelectorAll('button, a, [role=button]'))
                    .find(e => /do this later|skip|not now/i.test((e.innerText || '').trim()));
                if (!el) return 'none';
                el.click();
                return 'clicked';
            })()`, true);
            await new Promise(r => setTimeout(r, 1800));
            if (what === 'none') break;
        }
        await cdp.js(`location.href = 'https://treblo.com/'`, true);
        await new Promise(r => setTimeout(r, 9000));
        const state = await cdp.js(`({
            title: document.title,
            url: location.href,
            body: document.body ? document.body.innerText.slice(0, 400) : '',
            cookies: document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean),
        })`, true);
        const tracks = await cdp.js(`fetch('/api/v1/tracks', {credentials: 'include'})
            .then(r => r.text().then(t => ({status: r.status, body: t.slice(0, 400)})))
            .catch(e => ({status: 0, body: String(e)}))`, true);
        const projects = await cdp.js(`fetch('/api/v1/projects', {credentials: 'include'})
            .then(r => r.text().then(t => ({status: r.status, body: t.slice(0, 300)})))
            .catch(e => ({status: 0, body: String(e)}))`, true);
        console.log(JSON.stringify({
            page: state,
            tracks,
            projects,
        }, null, 2));
    } finally {
        try { cdp.close(); } catch (e) { /* ignore */ }
        try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 800));
        try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* the browser is still writing */ }
    }
}

main().catch(e => {
    process.stderr.write(`treblo-connect: ${e.message}\n`);
    process.exit(1);
});
