#!/usr/bin/env node
'use strict';
// tools/treblo-cookie-set.js
//
// ONE probe: can the session cookie be installed, and does treblo.com then
// believe we are signed in?
//
// WHY THIS FILE EXISTS
//
//   It is the "did the session work?" check for the treblo integration.
//
// WHAT CHANGED (2026-11-07)
//
//   The old version set a FLAT `sb-db-auth-token` cookie from the page
//   (`document.cookie`), because the module's CDP `call()` dropped the
//   params of every request — so `Network.setCookie` "refused every
//   parameter set" (it never received them) and the page had to be the
//   instrument.
//
//   Measured, with the params actually arriving:
//     - `Network.setCookie` accepts every parameter set;
//     - the CHUNKED pair (.0 + .1) is what signs in — a flat cookie
//       carrying the access_token renders the app signed-OUT;
//     - a stale flat cookie in the profile SHADOWS the fresh chunked
//       pair, so the candidates are deleted first.
//
//   So this now uses the shared `installSession()` from tools/treblo-web.js
//   and asserts on the SIGNED-IN marker rather than the absence of a link.
//
// Usage: node tools/treblo-cookie-set.js [--port 9445]
// Exit: 0 the session works · 3 it does not

const path = require('node:path');
const os = require('node:os');
const {
    sessionToken, installSession, openTab, evaluate, log, warn,
} = require('./treblo-web.js');

const ARGV = process.argv.slice(2);
const i = ARGV.indexOf('--port');
const PORT = Number(i !== -1 ? ARGV[i + 1] : 9445);
const JAR = path.join(os.homedir(), '.treblo-cookies.txt');

(async () => {
    const { token, expiresAt } = sessionToken(JAR);
    log(`token: ${token.length} chars, expires in ${Math.round(expiresAt - Date.now() / 1000)}s`);

    const tab = await openTab('https://treblo.com/', PORT);
    await new Promise(r => setTimeout(r, 4000));

    const origin = await evaluate(tab, 'location.origin');
    log(`page origin: ${origin}`);

    const installed = await installSession(tab, JAR);
    log(`session cookies installed: ${installed.join(', ')}`);

    // Reload so the app boots with the session present.
    await tab.call('Page.reload', {}, { ms: 30000 });
    await new Promise(r => setTimeout(r, 8000));

    const state = await evaluate(tab, `(() => {
        const text = document.body.innerText || '';
        return {
            url: location.href,
            title: document.title,
            textLen: text.length,
            head: text.slice(0, 600),
            hasSignedIn: /You have Treblo Pro/i.test(text),
            hasSignInLink: /Log in/i.test(text),
            hasEmail: /kai\\.weiler|\\.juric|kajica/i.test(text),
            hasCreate: /create|prompt|generate/i.test(text),
            hasCredits: /credit/i.test(text),
            cookies: document.cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean),
        };
    })()`);

    log('--- page state ---');
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');

    const signedIn = state.hasSignedIn === true && state.hasSignInLink === false;
    log(`signed in: ${signedIn}`);
    tab.close();
    process.exit(signedIn ? 0 : 3);
})().catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
