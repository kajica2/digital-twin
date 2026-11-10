#!/usr/bin/env node
'use strict';
// e2e/process-graphs.spec.mjs
//
// Contract for <process-graph> + pages/process-graphs.html + the Twin OS
// links into it. Repo-root URL convention:
//   PORT=5180 node process-graphs.spec.mjs   # after node lib/serve.js --port 5180

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/process-graphs.html`;
const TWIN = `${BASE}/pages/twin-os/index.html`;
const CATALOG = `${BASE}/data/twin/process-graphs.json`;
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
  fs.mkdirSync(ARTIFACTS, { recursive: true });

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
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => {
    const u = r.url();
    if (/favicon|ERR_ABORTED/i.test(u + ' ' + (r.failure()?.errorText || ''))) return;
    errors.push('reqfail: ' + u);
  });

  // Catalog must resolve before the page is useful.
  try {
    const catRes = await page.goto(CATALOG, { waitUntil: 'networkidle2', timeout: 15000 });
    check('catalog: resolves 200', !!(catRes && catRes.ok()));
    const cat = await catRes.json();
    check('catalog: 6 packages', Array.isArray(cat.packages) && cat.packages.length === 6);
    const ids = (cat.packages || []).map(p => p.id);
    for (const id of ['lyrics-to-frames', 'next-in-order', 'evolution', 'mutation']) {
      check(`catalog: has ${id}`, ids.includes(id));
    }
  } catch (e) {
    check('catalog: resolves 200', false, e.message);
  }

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) {
    console.error('⚠ page load failed: ' + e.message);
    console.error('hint: start the repo-root server with `node lib/serve.js --port 5180`');
    await browser.close();
    process.exit(1);
  }

  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('process-graph');
      return el && el.shadowRoot && el.shadowRoot.querySelectorAll('.card').length >= 4;
    }, { timeout: 8000 });
  } catch (_) { /* assertions below fail */ }

  check('page: hero names lyrics / frames', await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent || '';
    return /lyrics/i.test(h1) && /frames/i.test(h1);
  }));

  check('page: <process-graph> is defined and mounted', await page.evaluate(() => {
    return !!customElements.get('process-graph') && !!document.querySelector('process-graph')?.shadowRoot;
  }));

  check('page: four flow cards', await page.evaluate(() => {
    return document.querySelectorAll('[data-flow]').length === 4;
  }));

  check('page: catalog meta mentions packages', await page.evaluate(() => {
    const t = document.querySelector('[data-catalog-meta]')?.textContent || '';
    return /\d+/.test(t) && /package/i.test(t);
  }));

  check('component: cards include the four MJ flows', await page.evaluate(() => {
    const el = document.querySelector('process-graph');
    const cards = [...el.shadowRoot.querySelectorAll('.card[data-id]')].map(c => c.getAttribute('data-id'));
    return ['lyrics-to-frames', 'next-in-order', 'evolution', 'mutation']
      .every(id => cards.includes(id));
  }));

  check('component: default selection is lyrics-to-frames', await page.evaluate(() => {
    const el = document.querySelector('process-graph');
    return el.getAttribute('selected') === 'lyrics-to-frames'
      && !!el.shadowRoot.querySelector('[data-detail]');
  }));

  // Click evolution flow card → component selects it.
  await page.click('[data-flow="evolution"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('process-graph');
    return el && el.getAttribute('selected') === 'evolution';
  }, { timeout: 3000 }).catch(() => {});

  check('flow card selects evolution', await page.evaluate(() => {
    return document.querySelector('process-graph')?.getAttribute('selected') === 'evolution';
  }));

  // Dry-run against /api/process — may 404 if API is not mounted on a
  // static host, so we only assert the button exists and a click does
  // not throw a pageerror.
  const beforeErrors = errors.length;
  await page.evaluate(() => {
    const btn = document.querySelector('process-graph')?.shadowRoot?.querySelector('[data-dry]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 800));
  check('dry-run click throws no pageerror', errors.slice(beforeErrors).filter(e => /pageerror/.test(e)).length === 0);

  // Theme toggle.
  await page.click('#themeToggle');
  check('theme flips to dark', await page.evaluate(() => {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      || document.documentElement.dataset.theme === 'dark';
  }));

  // Copy button.
  await page.click('[data-copy]');
  check('copy button flips to copied', await page.evaluate(() => {
    const b = document.querySelector('[data-copy]');
    return b && /copied/i.test(b.textContent || '');
  }));

  // Internal links resolve.
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && !h.startsWith('http') && !h.startsWith('#')));
  let linkOk = true;
  for (const h of hrefs) {
    const url = new URL(h, PAGE).href;
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (!r || r.status() >= 400) { linkOk = false; break; }
    } catch { linkOk = false; break; }
  }
  check('internal links resolve ≤ 400', linkOk, hrefs.length + ' links');

  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.screenshot({ path: path.join(ARTIFACTS, 'process-graphs-light.png'), fullPage: true });
  await page.click('#themeToggle');
  await page.screenshot({ path: path.join(ARTIFACTS, 'process-graphs-dark.png'), fullPage: true });

  // Twin OS links.
  await page.goto(TWIN, { waitUntil: 'networkidle2', timeout: 30000 });
  check('twin-os: Songs tool-grid has process-graphs card', await page.evaluate(() => {
    const a = document.querySelector('a[data-tool-process-graphs]');
    return !!a && /process-graphs\.html$/.test(a.getAttribute('href') || '');
  }));
  check('twin-os: Twin storefront has process-graphs link', await page.evaluate(() => {
    const a = document.querySelector('a[data-store-process-graphs]');
    return !!a && /process-graphs\.html$/.test(a.getAttribute('href') || '');
  }));
  check('twin-os: Songs tool-grid has tool-dashboards card', await page.evaluate(() => {
    const a = document.querySelector('a[data-tool-dashboards]');
    return !!a && /tool-dashboards\.html$/.test(a.getAttribute('href') || '');
  }));
  check('twin-os: floating-toolset is mounted', await page.evaluate(() => {
    return !!customElements.get('floating-toolset') && !!document.querySelector('floating-toolset');
  }));
  check('twin-os: tool-dashboard is mounted', await page.evaluate(() => {
    return !!customElements.get('tool-dashboard') && !!document.querySelector('tool-dashboard');
  }));

  // Twin-os error pass: start a fresh collector so earlier page noise
  // cannot trip this check. Catalog JSON is gitignored and 404s on
  // deploy / empty clones — same filter as twin-os / clip / lvs specs.
  const twinPageErrors = [];
  const onTwinConsole = (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const url = (m.location() && m.location().url) || '';
    if (/catalog[^/]*\.json/.test(url) && /404/.test(text)) return;
    if (/ERR_ABORTED|favicon|cdn\.midjourney/i.test(text + ' ' + url)) return;
    twinPageErrors.push('console.error: ' + text + (url ? ' (' + url + ')' : ''));
  };
  const onTwinPageError = (e) => twinPageErrors.push('pageerror: ' + e.message);
  page.on('console', onTwinConsole);
  page.on('pageerror', onTwinPageError);
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  page.off('console', onTwinConsole);
  page.off('pageerror', onTwinPageError);
  check('twin-os: no severe console errors', twinPageErrors.length === 0, twinPageErrors.join('; '));

  await page.screenshot({ path: path.join(ARTIFACTS, 'process-graphs-twinos.png') });

  await browser.close();

  console.log(`\n${results.length} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
