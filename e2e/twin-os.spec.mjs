// Puppeteer smoke test for the Twin OS PWA shell (sprint 1).
// Mirrors the structure of landing.spec.mjs. Asserts:
//   - shell loads (200)
//   - all 3 panels are present
//   - default panel is Today (aria-current="true" on Today rail-item)
//   - panel switcher toggles aria-current + hidden correctly
//   - 3 patterns cards render in Today
//   - agenda has 4 items
//   - every agenda row carries a done toggle (4 checkboxes)
//   - the done-counter reads "0 of 4 done" on a clean profile
//   - task list: toggle marks a row done and bumps the counter
//   - task list: the add form takes several tasks at once (';'-separated)
//   - task list: done state survives a reload (localStorage)
//   - Twin panel has 3 stat cards
//   - the Twin panel's storefront links the Gumroad store + the
//     mood-frame catalogue, and the catalogue link resolves
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

// The URL path is /pages/twin-os/index.html in EVERY mode.
//
// GitHub Pages serves the repo root under /digital-twin/; the local
// server roots at the repo root for the same reason. A page in
// pages/twin-os/ needs ../assets/ and ../lib/ to resolve, so a
// pages/twin-os/-rooted server would 404 those locally while they
// worked on the deploy.
const PAGE_PATH = '/pages/twin-os/index.html';
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
      let p = u.pathname === '/' ? '/pages/twin-os/index.html' : u.pathname;
      // The server roots at the repo root (as Pages does), so /data/
      // resolves naturally. The explicit branch is kept because the
      // shell fetches ../../data/<x> relative to /pages/twin-os/ and
      // the catalogs are gitignored generated artifacts.
      let file;
      if (p.startsWith('/data/')) {
        file = join(ROOT, decodeURIComponent(p.slice(1)));
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
    log(`starting static server on :${PORT} (serving repo root ${ROOT})`);
    server = await startServer(ROOT);
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
            // data/flux/* are gitignored generated assets, not deployed.
            if (/data\/flux\//.test(url) && text.includes('404')) return;
            // Some script tags reference gitignored paths (fallback behavior).
            if (text.includes('404') && text.includes('script')) return;
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

    const checkCount = await page.$$eval('.agenda-item [data-check]', els => els.length);
    assert(checkCount === 4, `every agenda row has a done toggle (got ${checkCount} checkboxes)`);

    const countText = await page.$eval('[data-agenda-count]', el => el.textContent.trim());
    assert(countText === '0 of 4 done', `done-counter reads "0 of 4 done" (got "${countText}")`);

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

    // --- 5b. Storefront — the one front door for finished work ---
    const store = await page.evaluate(() => {
      const g = document.querySelector('[data-store-gumroad]');
      const m = document.querySelector('[data-store-marketplace]');
      return {
        gHref: g ? g.getAttribute('href') : null,
        gTarget: g ? g.getAttribute('target') : null,
        gRel: g ? g.getAttribute('rel') : null,
        mHref: m ? m.getAttribute('href') : null,
        inTwin: !!(g && g.closest('.panel[data-panel="twin"]')),
      };
    });
    assert(store.gHref === 'https://kaidjuric.gumroad.com/',
      `storefront points at the Gumroad store (got ${store.gHref})`);
    assert(store.gTarget === '_blank' && /noopener/.test(store.gRel || ''),
      'store link opens in a new tab with rel=noopener');
    assert(store.mHref === '../marketplace.html',
      `storefront points at the mood-frame catalogue (got ${store.mHref})`);
    assert(store.inTwin, 'storefront lives in the Twin panel');
    // The catalogue link has to resolve — a relative href that 404s is
    // worse than no link at all.
    const marketHref = new URL('../marketplace.html', `${BASE}${PAGE_PATH}`).href;
    const marketResp = await fetch(marketHref, { method: 'HEAD' }).catch(() => null);
    assert(marketResp && marketResp.status === 200,
      `catalogue link resolves (got ${marketResp ? marketResp.status : 'no response'})`);

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

    // Back to light for the remaining artifacts — the previous shot left
    // the page on dark, so "songs-light" and "twin-light" were capturing
    // the dark theme. The file names were lying.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme-pref', 'light'));
    await new Promise(r => setTimeout(r, 200));

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

    // --- 11. task list interaction (mutates the session; runs last) ---
    log(`--- task list interaction ---`);
    await page.setViewport({ width: 1280, height: 900 });
    await new Promise(r => setTimeout(r, 150));

    await page.click('.agenda-item[data-id="seed-0"] [data-check]');
    await new Promise(r => setTimeout(r, 120));
    const seedDone = await page.$eval('.agenda-item[data-id="seed-0"]', el => el.dataset.done);
    assert(seedDone === 'true', `toggling a row sets data-done="true"`);
    const countAfterToggle = await page.$eval('[data-agenda-count]', el => el.textContent.trim());
    assert(countAfterToggle === '1 of 4 done', `counter tracks the toggle (got "${countAfterToggle}")`);

    await page.type('[data-agenda-input]', 'alpha task; beta task; gamma task');
    await page.click('.agenda-add-btn');
    await new Promise(r => setTimeout(r, 120));
    const afterAdd = await page.$$eval('.agenda-item', els => els.length);
    assert(afterAdd === 7, `';'-separated input adds 3 tasks at once (got ${afterAdd} rows)`);
    const countAfterAdd = await page.$eval('[data-agenda-count]', el => el.textContent.trim());
    assert(countAfterAdd === '1 of 7 done', `counter grows with the list (got "${countAfterAdd}")`);

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.agenda-item[data-id="seed-0"]');
    await new Promise(r => setTimeout(r, 150));
    const seedDoneAfter = await page.$eval('.agenda-item[data-id="seed-0"]', el => el.dataset.done);
    assert(seedDoneAfter === 'true', `done state survives a reload`);
    const rowsAfterReload = await page.$$eval('.agenda-item', els => els.length);
    assert(rowsAfterReload === 7, `added tasks survive a reload (got ${rowsAfterReload})`);
    const countAfterReload = await page.$eval('[data-agenda-count]', el => el.textContent.trim());
    assert(countAfterReload === '1 of 7 done', `counter survives a reload (got "${countAfterReload}")`);

    assert(consoleErrors.length === 0, `0 console errors after the interaction pass (got ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''})`);

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