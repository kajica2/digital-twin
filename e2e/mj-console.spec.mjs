#!/usr/bin/env node
'use strict';
// e2e/mj-console.spec.mjs
//
// Contract for the Midjourney console (pages/mj-console.html).
//
//   PORT=5180 node mj-console.spec.mjs   # after node lib/serve.js --port 5180
//   E2E_URL=https://digitaltwin-ebon.vercel.app node mj-console.spec.mjs
//
// WHAT THIS SPEC GUARDS
//
//   1. The composer shows the command the SUBMITTER would send — the
//      page loads lib/mj-flags.js, the same file lib/mj-submitter.js
//      uses. The spec asserts the on-screen command matches what the
//      Node-side composer produces for the same input, which is the
//      only way to catch a second source of truth.
//   2. The identity lint fires in the browser, on the same rule the
//      repo's linter enforces.
//   3. A prompt can be saved to the library and found again (the API
//      half). This part needs the local server; on a host with no API
//      the spec asserts the graceful-degradation banner instead.
//
// The API part runs against a SCRATCH store (MJ_CONSOLE_STORE), so the
// spec never writes the artist's real library.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
import { spawn } from 'node:child_process';

const DEPLOYED_URL = process.env.E2E_URL || null;

// A free port, so a leftover server never silently answers the spec.
const PORT = Number(process.env.MJ_CONSOLE_PORT || (DEPLOYED_URL ? 5180 : 5300 + Math.floor(Math.random() * 400)));
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/mj-console.html`;
const ARTIFACTS = path.join(process.cwd(), 'artifacts');
const REPO = path.join(process.cwd(), '..');

// The spec must never write the artist's real prompt library. The server
// is started with MJ_PROMPT_STORE pointing at a scratch file.
const SCRATCH_STORE = path.join(os.tmpdir(), `mj-console-e2e-${process.pid}.json`);

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch { console.error('puppeteer missing: cd e2e && npm install'); process.exit(1); }

// ---------------------------------------------------------------------------
// The server under test (skipped against a deployed host)
// ---------------------------------------------------------------------------
let server = null;

async function startServer() {
  if (DEPLOYED_URL) return;
  server = spawn(process.execPath, ['lib/serve.js', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), MJ_PROMPT_STORE: SCRATCH_STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy on ${BASE}`);
}

function stopServer() {
  if (server) { server.kill('SIGKILL'); server = null; }
  try { fs.unlinkSync(SCRATCH_STORE); } catch { /* already gone */ }
}

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (ok) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  try { await startServer(); }
  catch (e) { console.error('could not start the server: ' + e.message); process.exit(1); }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    console.error('could not launch Chrome: ' + e.message);
    stopServer();
    process.exit(1);
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The API is absent on a static host. The console is EXPECTED to
    // notice and show the banner — that is not an error.
    if (/Failed to load resource|net::ERR|404/.test(text)) return;
    errors.push('console.error: ' + text);
  });
  page.on('requestfailed', (r) => {
    const line = 'reqfail: ' + r.url();
    if (/\/api\//.test(r.url())) return;   // no API on a static host
    errors.push(line);
  });

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); stopServer(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800));

  // --- structure ---
  const title = await page.title();
  check('mjc: the title names the console', /console/i.test(title), title);
  const h1 = await page.evaluate(() => document.querySelector('h1')?.innerText || '');
  check('mjc: the hero heading is present', h1.trim().length > 0, h1.trim().slice(0, 40));

  // --- the shared modules loaded ---
  const mods = await page.evaluate(() => ({
    flags: typeof window.MJFlags?.buildFullPrompt,
    lint: typeof window.PromptLint?.findViolations,
  }));
  check('mjc: the shared flag composer is loaded', mods.flags === 'function', mods.flags);
  check('mjc: the shared lint rule is loaded', mods.lint === 'function', mods.lint);

  // --- the composer ---
  await page.type('#pTitle', 'Dawn trumpet');
  await page.type('#pText', 'a trumpet player alone on a stage at dawn');
  await page.select('#pAr', '16:9');
  await new Promise((r) => setTimeout(r, 500));

  const cmd = await page.$eval('#cmdOut', (e) => e.innerText.trim());
  check('mjc: the composer shows a command', cmd.length > 20, cmd.slice(0, 60));
  check('mjc: the command carries the prompt text', cmd.includes('a trumpet player alone on a stage at dawn'));
  check('mjc: the command carries the ratio', /--ar\s+16:9/.test(cmd), cmd.slice(-40));
  check('mjc: the command has exactly ONE --ar',
    (cmd.match(/--ar\s+\S+/g) || []).length === 1, cmd);
  check('mjc: the --ar is last', cmd.slice(cmd.indexOf('--ar')).startsWith('--ar 16:9'), cmd.slice(-30));

  // THE PARITY CHECK — the on-screen command must equal what the Node
  // composer produces for the same input. This is the assertion that
  // catches a browser-side copy of the rules drifting from the
  // submitter's.
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '..', 'lib', 'mj-config.json'), 'utf8'));
  const submitter = require(path.join(process.cwd(), '..', 'lib', 'mj-submitter.js'));
  const expected = submitter.buildFullPrompt('a trumpet player alone on a stage at dawn', '16:9', cfg.mj.defaultArgs);
  check('mjc: the on-screen command MATCHES the submitter\'s composer', cmd === expected,
    cmd === expected ? '' : `screen: ${cmd} | node: ${expected}`);

  // --- the lint fires in the browser ---
  const clean = await page.$eval('#lintOut', (e) => ({ hidden: e.hidden, text: e.innerText }));
  check('mjc: a clean prompt reports clean', !clean.hidden && /clean/i.test(clean.text), clean.text.slice(0, 50));

  await page.$eval('#pText', (e) => { e.value = ''; });
  await page.type('#pText', 'a Black man in a red coat');
  await new Promise((r) => setTimeout(r, 500));
  const bad = await page.$eval('#lintOut', (e) => ({ hidden: e.hidden, text: e.innerText }));
  check('mjc: an identity claim is flagged in the browser', !bad.hidden && /identity/i.test(bad.text), bad.text.slice(0, 70));

  // The save must be refused for it.
  const savedBad = await page.evaluate(async () => {
    const btn = document.querySelector('#saveBtn');
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
    return document.querySelector('#saveStatus')?.textContent || '';
  });
  check('mjc: a flagged prompt cannot be saved', /identity|wording/i.test(savedBad), savedBad.slice(0, 60));

  // --- back to a clean prompt ---
  await page.$eval('#pText', (e) => { e.value = ''; });
  await page.type('#pText', 'a trumpet player alone on a stage at dawn');
  await new Promise((r) => setTimeout(r, 400));

  // --- the library: save, find, remove ---
  const apiAlive = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/mj/prompts');
      return r.ok;
    } catch { return false; }
  });

  if (apiAlive) {
    check('mjc: the library API is reachable', true);

    // Save.
    await page.evaluate(() => { document.querySelector('#pTags').value = 'jazz,dawn'; });
    const saveMsg = await page.evaluate(async () => {
      document.querySelector('#saveBtn').click();
      await new Promise((r) => setTimeout(r, 900));
      return document.querySelector('#saveStatus')?.textContent || '';
    });
    check('mjc: a prompt saves to the library', /saved/i.test(saveMsg), saveMsg.slice(0, 60));

    // It appears in the library.
    const items = await page.$$eval('#libList .item', (els) => els.map((e) => ({
      title: e.querySelector('.title')?.textContent.trim() || '',
      text: e.querySelector('.text')?.textContent.trim() || '',
      ratio: e.querySelector('.ratio')?.textContent.trim() || '',
      tags: Array.from(e.querySelectorAll('.chip')).map((c) => c.textContent.trim()),
    })));
    check('mjc: the saved prompt appears in the library', items.length > 0, `${items.length} items`);
    const mine = items.find((i) => i.title === 'Dawn trumpet');
    check('mjc: the library item carries the title', !!mine, items.map((i) => i.title).join(', '));
    check('mjc: the library item carries the composed command',
      !!mine && mine.text.includes('a trumpet player alone on a stage at dawn'), mine ? mine.text.slice(0, 50) : '');
    check('mjc: the library item carries the ratio', !!mine && mine.ratio === '16:9', mine ? mine.ratio : '');
    check('mjc: the library item carries its tags', !!mine && mine.tags.includes('jazz') && mine.tags.includes('dawn'),
      mine ? mine.tags.join(',') : '');

    // Search filters.
    await page.type('#libSearch', 'zzzznotathing');
    await new Promise((r) => setTimeout(r, 400));
    const filtered = await page.$$eval('#libList .item', (els) => els.length);
    check('mjc: the search filters the library', filtered === 0, `${filtered} items`);
    await page.$eval('#libSearch', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
    await new Promise((r) => setTimeout(r, 400));
    const restored = await page.$$eval('#libList .item', (els) => els.length);
    check('mjc: clearing the search restores the library', restored > 0, `${restored} items`);

    // "Use" loads it back into the composer.
    await page.evaluate(() => {
      document.querySelector('#pText').value = '';
      const btn = Array.from(document.querySelectorAll('#libList button[data-act]')).find((b) => b.dataset.act === 'use');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const reloaded = await page.$eval('#pText', (e) => e.value);
    check('mjc: "Use" loads the prompt back into the composer',
      reloaded.includes('a trumpet player alone on a stage at dawn'), reloaded.slice(0, 50));

    // The pack export.
    await page.click('#packBtn');
    await new Promise((r) => setTimeout(r, 700));
    const pack = await page.evaluate(() => ({
      hidden: document.querySelector('#packBox')?.hidden,
      text: document.querySelector('#packOut')?.textContent || '',
    }));
    check('mjc: the pack export opens', !pack.hidden);
    check('mjc: the pack is a bullet per prompt', (pack.text.match(/^- /gm) || []).length > 0, pack.text.slice(0, 60));
    check('mjc: the pack carries a ratio', /--ar\s+16:9/.test(pack.text), pack.text.slice(-60));

    // Delete removes it.
    const before = await page.$$eval('#libList .item', (els) => els.length);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('#libList button[data-act]')).find((b) => b.dataset.act === 'del');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const after = await page.$$eval('#libList .item', (els) => els.length);
    check('mjc: deleting removes the prompt from the library', after === before - 1, `${before} -> ${after}`);
  } else {
    // No API (a static host). The console must degrade gracefully and
    // say so — not fail silently.
    console.log('  (note: no /api on this host — asserting the graceful-degradation path)');
    const banner = await page.evaluate(() => {
      const b = document.querySelector('#apiBanner');
      return { hidden: b?.hidden, text: b?.innerText || '' };
    });
    check('mjc: without an API the console shows the banner', banner.hidden === false, banner.text.slice(0, 60));
    check('mjc: the banner names the fix', /npm run serve/i.test(banner.text), banner.text.slice(0, 80));

    // The composer still works — it runs in the browser.
    const stillComposes = await page.$eval('#cmdOut', (e) => e.innerText.trim());
    check('mjc: the composer still works without the API', stillComposes.includes('--ar 16:9'), stillComposes.slice(-40));
  }

  // --- the theme ---
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeBtn');
  await new Promise((r) => setTimeout(r, 400));
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('mjc: the theme toggle flips the theme', before !== after, `${before} -> ${after}`);

  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));
  const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('mjc: the theme choice persists across a reload', persisted === after, persisted);

  // --- internal links resolve ---
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && !/^(https?:|mailto:|#)/.test(h)));
  const dead = [];
  for (const href of hrefs) {
    const url = new URL(href, PAGE).toString();
    try {
      const r = await fetch(url, { method: 'GET' });
      if (!(r.status < 400)) dead.push(`${href} -> ${r.status}`);
    } catch (e) { dead.push(`${href} -> ${e.message}`); }
  }
  check('mjc: internal links resolve', dead.length === 0, dead.join(' | ') || `${hrefs.length} checked`);

  // --- console errors ---
  check('mjc: 0 console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'mj-console.png'), fullPage: true });

  await browser.close();
  stopServer();
  console.log(failed === 0 ? 'OK — all mj-console checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); stopServer(); process.exit(1); });
