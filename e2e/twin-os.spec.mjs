// Puppeteer smoke test for the Twin OS PWA shell (sprint 1).
// Mirrors the structure of landing.spec.mjs. Asserts:
//   - shell loads (200)
//   - all 3 panels are present
//   - default panel is Today (aria-current="true" on Today rail-item)
//   - panel switcher toggles aria-current + hidden correctly
//   - 3 patterns cards render in Today
//   - agenda has 4 items
//   - Twin panel has 3 stat cards
//   - Songs panel renders the empty-state with the catalog path
//   - theme-toggle has 3 buttons (light / system / dark)
//   - data-theme attribute respects the system default
//   - 0 console errors
//
// Run from the e2e/ directory:
//   npm install
//   node twin-os.spec.mjs
//
// E2E_URL — when set, the e2e skips the local static server and runs
// against the deployed URL. Used by the GitHub Actions deploy-test
// loop and by humans running the test against the live site.
//   E2E_URL=https://kajica2.github.io/digital-twin node twin-os.spec.mjs
//
// Artifacts saved to e2e/artifacts/twin-os/

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = join(__dirname, 'artifacts', 'twin-os');
const PORT = 5174; // different from landing.spec.mjs so they don't collide

// E2E_URL semantics:
//   - undefined → local server on :5174 serving pages/twin-os/
//   - set       → hits the deployed site at ${E2E_URL}/pages/twin-os/
const DEPLOYED_URL = process.env.E2E_URL || null;
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;

// When running against the deployed site, the URL path is
// /pages/twin-os/index.html (because Pages serves from repo root).
// When running locally, the e2e's static server mounts pages/twin-os/
// as the server root, so the path is just /index.html.
const PAGE_PATH = DEPLOYED_URL ? '/pages/twin-os/index.html' : '/index.html';
const pageUrl = `${BASE}${PAGE_PATH}`;

// Locate Chrome — prefer system Chrome, fall back to puppeteer's bundled
// Chrome. (Same fallback as landing.spec.mjs — chrome-headless-shell
// has errno -88 on this machine.)
async function findChrome() {
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(sys)) return sys;
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
      let p = u.pathname === '/' ? '/index.html' : u.pathname;
      // Map the catalog paths to their real location in the repo.
      // The shell expects ../../data/<x> relative to /pages/twin-os/,
      // which resolves to /data/<x> — the same shape Pages serves.
      // Map the whole /data/ subtree, not just the one audio catalog:
      // the Songs panel fetches both catalog.json and
      // catalog-jazz-solos.json.
      let file;
      if (p.startsWith('/data/')) {
        file = join(ROOT, decodeURIComponent(p.slice(1)));
      } else if (p.startsWith('../../data/')) {
        file = join(ROOT, decodeURIComponent(p.replace(/^\.\.\/\.\.\//, '')));
      } else {
        file = join(rootDir, decodeURIComponent(p));
      }
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

const log = (msg, color = '\u001b[36m') => console.log(`${color}[twin-os-e2e]${'\u001b[0m'} ${msg}`);
const ok  = (msg) => log(`✓ ${msg}`, '\u001b[32m');
const bad = (msg) => log(`✗ ${msg}`, '\u001b[31m');
const dim = (msg) => log(`  ${msg}`, '\u001b[90m');

let failures = 0;
function assert(cond, msg) {
  if (cond) { ok(msg); }
  else { failures++; bad(msg); }
}

async function main() {
  if (existsSync(ART)) await rm(ART, { recursive: true });
  await mkdir(ART, { recursive: true });

  let server = null;
  if (!DEPLOYED_URL) {
    log(`starting static server on :${PORT} (serving ${join(ROOT, 'pages', 'twin-os')})`);
    server = await startServer(join(ROOT, 'pages', 'twin-os'));
  } else {
    log(`running against deployed URL: ${pageUrl}`);
  }

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
    page.on('console', m => {
        if (m.type() === 'error') {
            const url = m.location().url || '';
            const text = m.text();
            // Catalogs are generated artifacts (gitignored), so a
            // deployed page legitimately 404s on them and the panel
            // renders its "not indexed yet" state. Ignore those.
            if (/catalog[^/]*\.json/.test(url) && text.includes('404')) return;
            consoleErrors.push(`console.error: ${text} (${url})`);
        }
    });

    log(`--- load ${pageUrl} ---`);
    consoleErrors.length = 0;
    const resp = await page.goto(pageUrl, { waitUntil: 'networkidle0' });
    assert(resp.status() === 200, `shell returns HTTP 200 (got ${resp.status()})`);

    await page.waitForSelector('.rail-item[data-panel="today"]');

    // --- 1. Shell chrome ---
    const railItems = await page.$$eval('.rail-item', els => els.map(e => e.dataset.panel));
    assert(JSON.stringify(railItems) === '["today","songs","twin"]', `rail has 3 items: ${JSON.stringify(railItems)}`);

    const topbar = await page.$('.topbar');
    assert(!!topbar, 'topbar present');

    const statusbar = await page.$('.statusbar');
    assert(!!statusbar, 'statusbar present');

    // --- 2. Today is default ---
    const todayCurrent = await page.$eval('.rail-item[data-panel="today"]', el => el.getAttribute('aria-current'));
    assert(todayCurrent === 'true', `Today has aria-current="true" by default`);

    const songsHidden = await page.$eval('.panel[data-panel="songs"]', el => el.hidden);
    const twinHidden = await page.$eval('.panel[data-panel="twin"]', el => el.hidden);
    const todayHidden = await page.$eval('.panel[data-panel="today"]', el => el.hidden);
    assert(todayHidden === false, 'Today panel is visible');
    assert(songsHidden === true, 'Songs panel is hidden');
    assert(twinHidden === true, 'Twin panel is hidden');

    // --- 3. Today content ---
    const agendaCount = await page.$$eval('.agenda-item', els => els.length);
    assert(agendaCount === 4, `agenda has 4 items (got ${agendaCount})`);

    const patternCount = await page.$$eval('.pattern-card', els => els.length);
    assert(patternCount === 3, `patterns grid has 3 cards (got ${patternCount})`);

    // --- 4. Songs panel references catalog + config ---
    const songsAllText = await page.$eval('.panel[data-panel="songs"]', el => el.textContent);
    assert(songsAllText.includes('catalog.json'),
      `songs panel mentions catalog.json (in any element)`);
    assert(songsAllText.includes('sources.config.json'),
      `songs panel mentions sources.config.json (in any element)`);
    assert(songsAllText.includes('index-songs'),
      `songs panel mentions npm run index-songs (in any element)`);

    // --- 5. Twin stats ---
    const statCount = await page.$$eval('.twin-stat', els => els.length);
    assert(statCount === 3, `twin panel has 3 stat cards (got ${statCount})`);

    // --- 6. Theme toggle has 3 buttons ---
    const toggleBtns = await page.$$eval('theme-toggle button', els => els.map(b => b.dataset.value));
    assert(JSON.stringify(toggleBtns) === '["light","system","dark"]', `theme-toggle has 3 buttons: ${JSON.stringify(toggleBtns)}`);

    // --- 7. data-theme attribute present ---
    const dataTheme = await page.$eval('html', el => el.getAttribute('data-theme'));
    assert(dataTheme === 'light' || dataTheme === 'dark', `data-theme set to ${dataTheme}`);

    // --- 8. Panel switcher ---
    log(`--- panel switcher roundtrip ---`);
    await page.click('.rail-item[data-panel="songs"]');
    await new Promise(r => setTimeout(r, 200));
    const songsCurrent = await page.$eval('.rail-item[data-panel="songs"]', el => el.getAttribute('aria-current'));
    const todayCurrent2 = await page.$eval('.rail-item[data-panel="today"]', el => el.getAttribute('aria-current'));
    assert(songsCurrent === 'true', `click Songs → aria-current="true"`);
    assert(todayCurrent2 === 'false', `click Songs → Today aria-current="false"`);
    const songsVisible = await page.$eval('.panel[data-panel="songs"]', el => !el.hidden);
    assert(songsVisible, 'click Songs → Songs panel is visible');

    await page.click('.rail-item[data-panel="twin"]');
    await new Promise(r => setTimeout(r, 200));
    const twinCurrent = await page.$eval('.rail-item[data-panel="twin"]', el => el.getAttribute('aria-current'));
    assert(twinCurrent === 'true', `click Twin → aria-current="true"`);

    await page.click('.rail-item[data-panel="today"]');
    await new Promise(r => setTimeout(r, 200));
    const todayCurrent3 = await page.$eval('.rail-item[data-panel="today"]', el => el.getAttribute('aria-current'));
    assert(todayCurrent3 === 'true', `click Today → aria-current="true"`);

    // --- 9. URL hash reflects panel state ---
    const hash = await page.evaluate(() => location.hash);
    assert(hash === '#today', `URL hash is #today (got "${hash}")`);

    // --- 10. 0 console errors ---
    assert(consoleErrors.length === 0, `0 console errors (got ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''})`);

    // --- screenshots ---
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme-pref', 'light'));
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'today-light.png'), fullPage: true });
    dim(`saved today-light.png`);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme-pref', 'dark'));
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'today-dark.png'), fullPage: true });
    dim(`saved today-dark.png`);

    await page.click('.rail-item[data-panel="songs"]');
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'songs-light.png'), fullPage: true });
    dim(`saved songs-light.png`);

    await page.click('.rail-item[data-panel="twin"]');
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'twin-light.png'), fullPage: true });
    dim(`saved twin-light.png`);

    // mobile snapshot
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.click('.rail-item[data-panel="today"]');
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'today-mobile.png'), fullPage: true });
    dim(`saved today-mobile.png`);

    // summary
    log('');
    if (failures === 0) {
      ok(`ALL CHECKS PASSED — 5 screenshots saved to ${ART}`);
    } else {
      bad(`${failures} CHECK(S) FAILED`);
    }
  } finally {
    await browser.close();
    if (server) server.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });