#!/usr/bin/env node
'use strict';
// e2e/mj-sheets.spec.mjs
//
// Contract for the Midjourney comparison sheet page (pages/mj-sheets.html).
// Runs WITHOUT the Midjourney stack — everything it asserts is a local file.
// Follows the repo-root URL convention of the clip/refael/how-to specs:
//   PORT=5180 node mj-sheets.spec.mjs   # after a server rooted at the repo root
//
// The point of this spec is PROVENANCE, not layout. A contact sheet can
// look perfect and still be wrong: the tiles must be the ones the
// recorded job ids point at, and the captions must be the clauses those
// jobs actually ran with. Both are checked against the manifest.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/mj-sheets.html`;
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

  check('mjs: hero <h1> names the brief', await page.evaluate(() =>
    (document.querySelector('h1')?.textContent || '').includes('Red Coat Underpass')));
  check('mjs: the contact sheet image is present', await page.evaluate(() => {
    const img = document.querySelector('.sheet img');
    return !!img && /contact-sheet\.png$/.test(img.getAttribute('src') || '');
  }));
  check('mjs: the sheet declares its dimensions', await page.evaluate(() => {
    const img = document.querySelector('.sheet img');
    return img?.getAttribute('width') === '1990' && img?.getAttribute('height') === '996';
  }));
  check('mjs: the sheet has descriptive alt text', await page.evaluate(() =>
    (document.querySelector('.sheet img')?.getAttribute('alt') || '').length > 80));

  // The tiles come from the manifest, so the count and the captions are
  // checked against the manifest rather than against the markup.
  const tileCheck = await page.evaluate(async () => {
    const rel = '../assets/mj-sheets/red-coat-underpass-12/sheet-manifest.json';
    const res = await fetch(new URL(rel, location.href).href, { cache: 'no-store' });
    if (!res.ok) return { ok: false, why: 'manifest HTTP ' + res.status, n: 0, listed: 0 };
    const man = await res.json();
    const figs = Array.from(document.querySelectorAll('#tiles figure'));
    const bad = [];
    for (const f of figs) {
      const img = f.querySelector('img');
      const cap = f.querySelector('figcaption');
      const src = (man.variants || []).find(v => v.index === (img?.getAttribute('src') || '').match(/prompt-(\d+)\.webp/)?.[1]);
      const got = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!src) { bad.push('no manifest entry for ' + (img?.getAttribute('src') || '?')); continue; }
      if (!got.includes(src.label)) bad.push(`caption lacks clause: ${got}`);
      if (!got.includes(src.taskId.slice(0, 8))) bad.push(`caption lacks task id: ${got}`);
    }
    return { ok: bad.length === 0, why: bad.join(' | '), n: figs.length, listed: (man.variants || []).length };
  });
  check('mjs: 12 tiles, each caption tied to its manifest entry', tileCheck.ok,
    tileCheck.ok ? `${tileCheck.n} tiles vs ${tileCheck.listed} manifest entries` : tileCheck.why);

  check('mjs: every tile has descriptive alt text', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#tiles img'));
    return imgs.length === 12 && imgs.every(i => (i.getAttribute('alt') || '').trim().length > 20);
  }));

  // Every caption must be the clause, not a stub. A caption that truncated
  // to "overhead…" tells the reader nothing about the tile.
  check('mjs: no caption is a truncated stub', await page.evaluate(() => {
    const caps = Array.from(document.querySelectorAll('#tiles figcaption'));
    return caps.length === 12 && caps.every(c => {
      const label = c.textContent.replace(/\s+/g, ' ').trim();
      return label.length > 25 && !/^[a-z ]+…$/.test(label);
    });
  }));

  check('mjs: the method section explains the feed attribution', await page.evaluate(() => {
    const t = document.querySelector('#method')?.innerText || '';
    return /feed/i.test(t) && /task id/i.test(t);
  }));
  check('mjs: the method section discloses the re-shot angles', await page.evaluate(() => {
    const t = document.querySelector('#method')?.innerText || '';
    return /re-shot|re-rendered|reworded/i.test(t);
  }));

  // Every image must actually render. The lightbox's <img> is excluded: it
  // is empty until a tile is clicked, so it has no naturalWidth to report.
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img:not(#lbImg)'));
    return imgs.length >= 13 && imgs.every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 15000 });
  const imgs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('img:not(#lbImg)'));
    return { count: all.length, ok: all.every(i => i.naturalWidth > 0) };
  });
  check('mjs: images load (naturalWidth > 0)', imgs.ok, `count=${imgs.count}`);

  // the lightbox opens on a tile click and closes on Escape
  await page.click('#tiles figure:first-child img');
  await new Promise(r => setTimeout(r, 250));
  check('mjs: clicking a tile opens the lightbox', await page.evaluate(() =>
    !document.getElementById('lightbox').hidden));
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 250));
  check('mjs: Escape closes the lightbox', await page.evaluate(() =>
    document.getElementById('lightbox').hidden));

  // theme toggle → dark persists on reload
  await page.evaluate(() => document.querySelector('[data-theme-btn="dark"]').click());
  await new Promise(r => setTimeout(r, 200));
  check('mjs: theme click → dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.reload({ waitUntil: 'networkidle2' });
  check('mjs: dark theme persists on reload', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.evaluate(() => document.querySelector('[data-theme-btn="auto"]').click());

  check('mjs: 0 console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'mj-sheets-light.png'), fullPage: true });
  await page.evaluate(() => document.querySelector('[data-theme-btn="dark"]').click());
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(ARTIFACTS, 'mj-sheets-dark.png'), fullPage: true });
  await browser.close();

  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(failed === 0 ? 'OK — all mj-sheets checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
