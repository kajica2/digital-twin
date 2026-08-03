// Puppeteer smoke test for the digital_twin landing page.
// Loads each variant (?v=1|2|3), screenshots, asserts:
//   0 page errors
//   variant switcher round-trips
//   the demo mockup renders
//   features grid is populated (6 cards, not 0)
//
// Run from the e2e/ directory:
//   npm install
//   node landing.spec.mjs
//
// Artifacts saved to e2e/artifacts/

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = join(__dirname, 'artifacts');
const PORT = 5173;
const BASE = `http://127.0.0.1:${PORT}`;

// Locate Chrome — prefer system Chrome, fall back to puppeteer's bundled
// Chrome. (puppeteer's chrome-headless-shell is broken on this machine
// with errno -88 on spawn, so we go through the system /Applications
// Chrome or the .app bundle directly.)
async function findChrome() {
  // 1. system Chrome
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(sys)) return sys;
  // 2. puppeteer's bundled Chrome for Testing
  const cache = process.env.HOME + '/.cache/puppeteer/chrome';
  if (existsSync(cache)) {
    const dirs = await readdir(cache);
    for (const d of dirs) {
      const exe = join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// ---------- tiny static file server ----------
function startServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, BASE);
      let p = u.pathname === '/' ? '/landing.html' : u.pathname;
      const file = join(rootDir, decodeURIComponent(p));
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const ext = file.split('.').pop();
      const types = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript' };
      res.setHeader('Content-Type', types[ext] || 'text/plain');
      const { readFile } = await import('node:fs/promises');
      res.end(await readFile(file));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const log = (msg, color = '\u001b[36m') => console.log(`${color}[e2e]${'\u001b[0m'} ${msg}`);
const ok  = (msg) => log(`✓ ${msg}`, '\u001b[32m');
const bad = (msg) => log(`✗ ${msg}`, '\u001b[31m');
const dim = (msg) => log(`  ${msg}`, '\u001b[90m');

let failures = 0;
function assert(cond, msg) {
  if (cond) { ok(msg); }
  else { failures++; bad(msg); }
}

async function main() {
  // prep
  if (existsSync(ART)) await rm(ART, { recursive: true });
  await mkdir(ART, { recursive: true });

  // serve the pages/ directory
  log(`starting static server on :${PORT} (serving ${join(ROOT, 'pages')})`);
  const server = await startServer(join(ROOT, 'pages'));

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: await findChrome() || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });

    // --- load each variant ---
    const variants = [
      { v: '1', name: 'control' },
      { v: '2', name: 'persona' },
      { v: '3', name: 'architecture' }
    ];

    for (const { v, name } of variants) {
      log(`--- variant v=${v} (${name}) ---`);
      consoleErrors.length = 0;
      await page.goto(`${BASE}/landing.html?v=${v}`, { waitUntil: 'networkidle0' });
      // wait for variant features to populate
      await page.waitForFunction(() => {
        const g = document.querySelector('[data-variant-features]');
        return g && g.children.length === 6;
      }, { timeout: 5000 });
      // wait for fonts
      await page.evaluate(() => document.fonts.ready);
      // wait a beat for reveal animations
      await new Promise(r => setTimeout(r, 400));

      // variant data attribute matches
      const dv = await page.$eval('html', el => el.getAttribute('data-variant'));
      assert(dv === v, `data-variant="${dv}" (expected "${v}")`);

      // eyebrow + h1 populated (not the literal "{eyebrow}" string)
      const eyebrow = await page.$eval('[data-variant-eyebrow]', el => el.textContent.trim());
      const h1l1 = await page.$eval('[data-variant-h1-line1]', el => el.textContent.trim());
      const h1l2 = await page.$eval('[data-variant-h1-line2]', el => el.textContent.trim());
      assert(eyebrow.length > 5, `eyebrow populated: "${eyebrow}"`);
      assert(h1l1.length > 0 && h1l2.length > 0, `h1 populated: "${h1l1} / ${h1l2}"`);

      // 6 feature cards rendered
      const fc = await page.$$eval('.feature-card', els => els.length);
      assert(fc === 6, `feature grid has 6 cards (got ${fc})`);

      // twin-demo rendered with the 4 panes
      const paneCount = await page.$$eval('twin-demo .demo-pane', els => els.length);
      assert(paneCount === 4, `twin-demo has 4 panes (got ${paneCount})`);

      // 4 architecture levels
      const lv = await page.$$eval('.level', els => els.length);
      assert(lv === 4, `architecture has 4 levels (got ${lv})`);

      // 4 domain twins
      const dt = await page.$$eval('.twin-card', els => els.length);
      assert(dt === 4, `domain twins: 4 cards (got ${dt})`);

      // 4 running-process flow nodes
      const flow = await page.$$eval('.flow-node', els => els.length);
      assert(flow === 4, `flow: 4 nodes (got ${flow})`);

      // hub-nav present
      const hub = await page.$('.hub-mark');
      assert(!!hub, 'hub-nav present');

      // theme toggle + variant switcher present
      const tt = await page.$('theme-toggle button[data-value="dark"]');
      const vs = await page.$('variant-switcher button[data-value="2"]');
      assert(!!tt, 'theme-toggle present');
      assert(!!vs, 'variant-switcher present');

      // 0 console errors
      assert(consoleErrors.length === 0, `0 console errors (got ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''})`);

      // Force all .reveal elements visible for clean screenshots.
      // (In normal use the IO fires as the user scrolls; in headless
      // screenshot mode the viewport is resized to full page height but
      // the IO timing can race with the screenshot capture.)
      await page.evaluate(() => {
        document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
      });
      await new Promise(r => setTimeout(r, 250));

      // screenshot — light theme
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: join(ART, `landing-${name}-light.png`), fullPage: true });
      dim(`saved ${join(ART, `landing-${name}-light.png`)}`);

      // screenshot — dark theme
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.documentElement.setAttribute('data-theme-pref', 'dark');
      });
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: join(ART, `landing-${name}-dark.png`), fullPage: true });
      dim(`saved ${join(ART, `landing-${name}-dark.png`)}`);

      // back to system for next iteration
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme-pref', 'system');
        document.documentElement.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      });
    }

    // --- variant switcher roundtrip ---
    log('--- variant switcher roundtrip ---');
    consoleErrors.length = 0;
    await page.goto(`${BASE}/landing.html?v=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('variant-switcher button[data-value="2"]');
    await page.click('variant-switcher button[data-value="2"]');
    await new Promise(r => setTimeout(r, 200));
    const url2 = page.url();
    const dv2 = await page.$eval('html', el => el.getAttribute('data-variant'));
    assert(url2.includes('v=2') && dv2 === '2', `click v2 → URL has v=2 + data-variant="2"`);

    await page.click('variant-switcher button[data-value="3"]');
    await new Promise(r => setTimeout(r, 200));
    const url3 = page.url();
    const dv3 = await page.$eval('html', el => el.getAttribute('data-variant'));
    assert(url3.includes('v=3') && dv3 === '3', `click v3 → URL has v=3 + data-variant="3"`);

    await page.click('variant-switcher button[data-value="1"]');
    await new Promise(r => setTimeout(r, 200));
    const dv1 = await page.$eval('html', el => el.getAttribute('data-variant'));
    assert(dv1 === '1', `click v1 → data-variant="1"`);

    // verify the features grid actually changed (different text per variant)
    const f2h2 = await page.evaluate(() => {
      // re-trigger to v=2 just for this check
      document.querySelector('variant-switcher button[data-value="2"]').click();
      return new Promise(r => setTimeout(() => r(document.querySelector('[data-variant-features-h2]').textContent), 250));
    });
    const f1h2 = await page.evaluate(() => {
      document.querySelector('variant-switcher button[data-value="1"]').click();
      return new Promise(r => setTimeout(() => r(document.querySelector('[data-variant-features-h2]').textContent), 250));
    });
    assert(f2h2 !== f1h2, `features h2 changes between variants ("${f1h2}" / "${f2h2}")`);

    // mobile screenshot for each variant
    log('--- mobile snapshots (390x844) ---');
    for (const { v, name } of variants) {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
      await page.goto(`${BASE}/landing.html?v=${v}`, { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 400));
      await page.screenshot({ path: join(ART, `landing-${name}-mobile.png`), fullPage: true });
      dim(`saved ${join(ART, `landing-${name}-mobile.png`)}`);
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    }

    // summary
    log('');
    if (failures === 0) {
      ok(`ALL CHECKS PASSED — ${variants.length * 2} desktop screenshots + ${variants.length} mobile screenshots saved to ${ART}`);
    } else {
      bad(`${failures} CHECK(S) FAILED`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
