#!/usr/bin/env node
'use strict';
// e2e/marketplace.spec.mjs
//
// Contract for the marketplace listing page (pages/marketplace.html).
// Runs WITHOUT the drawthings/midjourney stack. Mirrors the repo-root
// URL convention of the clip/refael/how-to specs:
//   PORT=5180 node marketplace.spec.mjs   # after python3 -m http.server 5180 --directory .

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/marketplace.html`;
const ARTIFACTS = path.join(process.cwd(), 'artifacts');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch { console.error('puppeteer missing: cd e2e && npm install'); process.exit(1); }

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (ok) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    console.error('could not launch Chrome: ' + e.message);
    process.exit(1);
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); process.exit(1); }

  check('market: hero <h1> "Mood Frames"', await page.evaluate(() =>
    document.querySelector('h1')?.textContent === 'Mood Frames'));
  check('market: eight story cards', await page.evaluate(() =>
    document.querySelectorAll('.story').length === 8));
  check('market: story badges present', await page.evaluate(() =>
    document.querySelectorAll('.badge').length >= 7));
  check('market: extras row has 3 figures', await page.evaluate(() =>
    document.querySelectorAll('#extras figure').length === 3));

  // every image must actually render (naturalWidth > 0)
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.length >= 10 && imgs.every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 10000 });
  const imgs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('img'));
    return { count: all.length, ok: all.every(i => i.naturalWidth > 0) };
  });
  check('market: images load (naturalWidth > 0)', imgs.ok, `count=${imgs.count}`);

  // theme toggle → dark persists on reload
  await page.evaluate(() => document.querySelector('[data-theme-btn="dark"]').click());
  await new Promise(r => setTimeout(r, 200));
  check('market: theme click → dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.reload({ waitUntil: 'networkidle2' });
  check('market: dark theme persists on reload', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.evaluate(() => document.querySelector('[data-theme-btn="auto"]').click());

  // internal links must resolve ≤ 400
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[data-rel]')).map(a => a.getAttribute('href')));
  const dead = [];
  for (const h of hrefs) {
    const u = new URL(h, `${BASE}/pages/`);
    const r = await fetch(u.href, { method: 'HEAD' }).catch(() => null);
    if (!r || r.status > 400) dead.push(h);
  }
  check('market: internal links resolve', dead.length === 0, dead.join(' | ') || `${hrefs.length} checked`);

  check('market: 0 console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'marketplace-light.png'), fullPage: true });
  await browser.close();

  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(failed === 0 ? 'OK — all marketplace checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });