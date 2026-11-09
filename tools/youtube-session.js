#!/usr/bin/env node
'use strict';
// Restore the YouTube session for the poster.
//
// WHY THIS EXISTS
//
// The session lives in the user's own browser (Comet), and its cookie
// values are encrypted with a key only that browser holds. Two lessons,
// both measured:
//
//   1. Copy Comet's cookie store and launch CHROME against it and
//      Chrome decrypts NONE of them — the capture yields the handful of
//      unencrypted cookies (GPS, YSC...) and never the auth ones. The
//      browser that OWNS the key must be the one that opens the store.
//
//   2. Even a full profile copy can carry a DEAD session. The account
//      chooser then reads "Kai Djuric — Signed out": the account is
//      remembered, the session token is not valid. No cookie trick
//      fixes that — someone has to sign in.
//
// So this script does the part that can be automated (extract, launch
// Comet on the debug port, probe the session) and says plainly what it
// found. If the session is dead it says so, and the answer is to sign
// in to YouTube Studio once in the browser.
//
//   node tools/youtube-session.js            # extract + launch + probe
//   node tools/youtube-session.js --keep    # leave the browser running
//
// The poster then uses it:  node lib/youtube-poster.js --port 9447 ...

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const COMET = '/Applications/Comet.app/Contents/MacOS/Comet';
const PORT = 9447;
// A UNIQUE profile per run. The fixed path was a race: the browser
// this tool launches was never killed, so the next run's `rm -rf`
// deleted files out from under a LIVE browser, which recreated them,
// and the directory removal failed with "Directory not empty".
const PROFILE = path.join(
  os.homedir(), '.hermes/cache/scratch',
  `comet-profile-${process.pid}-${Date.now()}`);
const COOKIE_SRC = path.join(os.homedir(), 'Library', 'Application Support', 'Comet');
const JAR = path.join(os.homedir(), '.youtube-cookies.txt');
const KEEP = process.argv.includes('--keep');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(m) { process.stdout.write(`${m}\n`); }

function copyProfile() {
  execFileSync('rm', ['-rf', PROFILE]);
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  // The browser ROOT holds 'Local State' — the os_crypt key. Without it
  // the copied cookie store cannot be decrypted at all.
  const ls = path.join(COOKIE_SRC, 'Local State');
  if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(PROFILE, 'Local State'));
  // The profile minus its caches: IndexedDB, Service Worker, Cache and
  // Extensions are gigabytes and carry nothing the session needs.
  execFileSync('rsync', [
    '-a',
    '--exclude=IndexedDB', '--exclude=Service Worker', '--exclude=Cache',
    '--exclude=Code Cache', '--exclude=GPUCache', '--exclude=Extensions',
    '--exclude=DawnGraphiteCache', '--exclude=DawnWebGPUCache',
    '--exclude=Crashpad', '--exclude=ShaderCache', '--exclude=GrShaderCache',
    path.join(COOKIE_SRC, 'Default') + '/',
    path.join(PROFILE, 'Default') + '/',
  ], { stdio: 'ignore' });
}

async function portAlive() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return true;
  } catch { return false; }
}

async function main() {
  // A browser on the port already? Then it is the one with the user's
  // session — use it. Launching a second Comet on a taken port cannot
  // bind, so the launch would silently attach to nothing while the
  // profile copy did all the work for nothing.
  let child = null;
  if (await portAlive()) {
    log(`A browser is already on port ${PORT} — using it as it is.`);
  } else {
    log('Copying the Comet profile (minus the caches)…');
    copyProfile();

    log(`Launching Comet on port ${PORT}…`);
    child = spawn(COMET, [
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore', detached: true });
    child.unref();

    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(1000);
      up = await portAlive();
    }
    if (!up) { log('Comet did not come up.'); process.exit(1); }
    log('Comet is up.');
  }

  const { cdpConnect, CDPClient } = require(path.join(REPO, 'lib/mj-submitter.js'));
  const client = new CDPClient(await cdpConnect(`http://127.0.0.1:${PORT}`));
  await client.connect();
  const target = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const S = (method, params) => client.send(method, params, sessionId);
  await S('Network.enable'); await S('Page.enable'); await S('Runtime.enable');

  // What does the browser actually hold? getAllCookies returns the live
  // store with the host bindings intact — a text export loses exactly
  // the part that matters.
  const all = await S('Network.getAllCookies', {});
  const cookies = all?.result?.cookies || [];
  const auth = cookies.filter(c => /^(SID|HSID|SSID|APISID|SAPISID|__Secure-3PSID|__Host-3PSID|LOGIN_INFO)$/.test(c.name));
  log(`The browser holds ${cookies.length} cookies, ${auth.length} of them auth cookies.`);

  await S('Page.navigate', { url: 'https://studio.youtube.com/' });
  await sleep(9000);
  const probe = await S('Runtime.evaluate', {
    returnByValue: true,
    expression: `({
      url: location.href.slice(0, 90),
      signedOut: /accounts\\.google|\\/signin|\\/login/.test(location.href),
      bodyLen: (document.body && document.body.innerText || '').length,
      snippet: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 220),
    })`,
  });
  const v = probe?.result?.value || {};
  log('');
  log(`  url:     ${v.url}`);
  log(`  signed out: ${v.signedOut}`);
  log(`  page:    ${v.snippet || ''}`);
  log('');

  if (v.signedOut) {
    log('THE SESSION IS DEAD.');
    log('');
    log('The account is remembered but the session token is not valid — no');
    log('cookie trick fixes that. Sign in to YouTube Studio once, in the');
    log('browser, and run this again:');
    log('');
    log('    open https://studio.youtube.com/   (sign in)');
    log('    node tools/youtube-session.js');
    log('');
    process.exit(3);
  }

  log('The session is LIVE. The poster can use this browser:');
  log('');
  log('    node lib/youtube-poster.js --port 9447 …');
  log('');
  if (!KEEP) {
    log('(Pass --keep to leave the browser running after this script exits.)');
    await client.send('Target.closeTarget', { targetId: target.targetId });
  }
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
