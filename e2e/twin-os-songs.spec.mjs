// Puppeteer smoke test for the Songs panel in the Twin OS shell.
//
// Asserts:
//   - Songs panel structure (head, empty/catalog blocks)
//   - Loading state disappears once fetch resolves
//   - Either the catalog renders (when items exist) OR the configured-
//     empty-state renders (when items.length === 0 OR fetch fails)
//   - Search input filters the catalog (when catalog is shown)
//   - 0 console errors
//
// Run from the e2e/ directory:
//   node twin-os-songs.spec.mjs
//
// E2E_URL semantics — same as twin-os.spec.mjs:
//   - undefined → local server on :5174 serving pages/twin-os/
//   - set       → hits the deployed site at ${E2E_URL}/pages/twin-os/
//
// Artifacts saved to e2e/artifacts/twin-os-songs/

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = join(__dirname, 'artifacts', 'twin-os-songs');
const PORT = 5175;

const DEPLOYED_URL = process.env.E2E_URL || null;
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const PAGE_PATH = DEPLOYED_URL ? '/pages/twin-os/index.html' : '/index.html';
const pageUrl = `${BASE}${PAGE_PATH}`;

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

// Minimal static server that ALSO serves /data/songs/catalog.json
// (which lives outside the twin-os dir in the repo). This is needed
// when running locally because the shell expects the catalog at
// ../../data/songs/catalog.json from the twin-os root.
function startServer(twinOsDir, repoRoot) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, BASE);
      let p = u.pathname === '/' ? '/index.html' : u.pathname;
      // Map the catalogs to their real location in the repo. The shell
      // fetches both catalog.json (audio) and catalog-jazz-solos.json
      // (MIDI corpus) from the Pages root, so map the whole /data/ subtree.
      let file;
      if (p.startsWith('/data/')) {
        file = join(repoRoot, decodeURIComponent(p.slice(1)));
      } else if (p.startsWith('../../data/')) {
        file = join(repoRoot, decodeURIComponent(p.replace(/^\.\.\/\.\.\//, '')));
      } else {
        file = join(twinOsDir, decodeURIComponent(p));
      }
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end('not found: ' + p);
        return;
      }
      const ext = file.split('.').pop();
      const types = {
        html: 'text/html; charset=utf-8',
        css: 'text/css',
        js: 'application/javascript',
        webmanifest: 'application/manifest+json',
        json: 'application/json',
      };
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

const log = (msg, color = '\u001b[36m') => console.log(`${color}[songs-e2e]${'\u001b[0m'} ${msg}`);
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
    log(`starting static server on :${PORT} (serving ${join(ROOT, 'pages', 'twin-os')} + /data from repo root)`);
    server = await startServer(join(ROOT, 'pages', 'twin-os'), ROOT);
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
            // Catalogs are generated artifacts (gitignored), so a deployed
            // page legitimately 404s on them and the panel renders its
            // "not indexed yet" state. Ignore those.
            if (/catalog[^/]*\.json/.test(url) && text.includes('404')) return;
            consoleErrors.push(`console.error: ${text} (${url})`);
        }
    });

    log(`--- load ${pageUrl} ---`);
    const resp = await page.goto(pageUrl, { waitUntil: 'networkidle0' });
    assert(resp.status() === 200, `shell returns HTTP 200 (got ${resp.status()})`);

    // Switch to Songs panel
    await page.click('.rail-item[data-panel="songs"]');
    await new Promise(r => setTimeout(r, 800));

    // --- Songs panel structure ---
    const panel = await page.$('.panel[data-panel="songs"]');
    assert(!!panel, 'songs panel exists');

    const kicker = await page.$eval('.panel[data-panel="songs"] .panel-kicker', el => el.textContent.trim());
    assert(kicker === 'panel 02 · songs', `panel kicker is "${kicker}"`);

    const heading = await page.$eval('.panel[data-panel="songs"] .panel-h1', el => el.textContent.trim());
    assert(heading.includes('catalog'), `panel heading mentions "catalog"`);

    // --- Wait for fetch to resolve (loading state goes away) ---
    await page.waitForFunction(() => {
      const loading = document.querySelector('[data-songs-loading]');
      return loading && loading.hidden === true;
    }, { timeout: 10000 });

    // --- One of catalog OR empty-state is visible (mutually exclusive) ---
    const catalogHidden = await page.$eval('[data-songs-catalog]', el => el.hidden);
    const emptyHidden = await page.$eval('[data-songs-empty]', el => el.hidden);
    assert(catalogHidden !== emptyHidden,
      `exactly one of catalog/empty-state is visible (catalog.hidden=${catalogHidden}, empty.hidden=${emptyHidden})`);

    // --- Detect mode and assert appropriately ---
    if (!catalogHidden) {
      log(`--- catalog mode (items present) ---`);

      const meta = await page.$eval('[data-songs-meta]', el => el.textContent.replace(/\s+/g, ' ').trim());
      assert(/items?\b/.test(meta), `meta mentions items: "${meta}"`);

      const groupCount = await page.$$eval('[data-songs-catalog] .song-group', els => els.length);
      assert(groupCount >= 1, `at least one group rendered (got ${groupCount})`);

      const rowCount = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
      assert(rowCount >= 1, `at least one song row rendered (got ${rowCount})`);

      // Each row has format chip + title.
      // Valid formats = SUPPORTED_EXTS in lib/songs-indexer.js (mp3/wav + aif/aiff
      // since sprint 0.14); the MIDI corpus section below renders its own
      // .song-row list with mid / pdf / mid+pdf chips, so this selector must stay
      // scoped to the audio catalog. Chip renders format: ext.slice(1).
      const AUDIO_FORMATS = ['mp3', 'wav', 'aif', 'aiff', 'm4a', 'aac', 'flac', 'ogg'];
      const firstRowFmt = await page.$eval('[data-songs-catalog] .song-row .song-fmt', el => el.textContent.trim());
      assert(AUDIO_FORMATS.includes(firstRowFmt),
        `first row has valid format chip: "${firstRowFmt}"`);

      const firstRowTitle = await page.$eval('[data-songs-catalog] .song-row .song-title', el => el.textContent.trim());
      assert(firstRowTitle.length > 0, `first row has a title: "${firstRowTitle}"`);

      // Search input is present
      const searchInput = await page.$('[data-songs-search]');
      assert(!!searchInput, 'search input present');

      // Type a query that matches nothing → row count drops to 0
      await page.type('[data-songs-search]', 'zzzzz-no-match-zzzzz');
      await new Promise(r => setTimeout(r, 250));
      const filteredRows = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
      assert(filteredRows === 0, `search "zzzzz-no-match-zzzzz" hides all rows (got ${filteredRows})`);

      // Clear search → all rows back
      await page.click('[data-songs-search]', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 250));
      const restoredRows = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
      assert(restoredRows === rowCount, `clearing search restores rows (got ${restoredRows}, expected ${rowCount})`);

      // Search count visible
      const counter = await page.$eval('[data-songs-search-count]', el => el.textContent.trim());
      assert(/\d+ match/.test(counter), `search count populated: "${counter}"`);

      // --- Transcription corpus section (WJazzD MIDI archive) ---
      // Independent of the audio catalog: its own indexer, its own
      // catalog file, its own loading/empty/catalog states.
      const jzCatalogHidden = await page.$eval('[data-jz-catalog]', el => el.hidden);
      const jzEmptyHidden   = await page.$eval('[data-jz-empty]',   el => el.hidden);
      assert(jzCatalogHidden !== jzEmptyHidden,
        `exactly one corpus state is visible (catalog.hidden=${jzCatalogHidden}, empty.hidden=${jzEmptyHidden})`);

      if (!jzCatalogHidden) {
        const jzMeta = await page.$eval('[data-jz-meta]', el => el.textContent.replace(/\s+/g, ' ').trim());
        assert(/\d+ solos?/.test(jzMeta), `corpus meta mentions solos: "${jzMeta}"`);
        assert(/\d+ performers/.test(jzMeta), `corpus meta mentions performers: "${jzMeta}"`);

        const jzGroups = await page.$$eval('[data-jz-groups] .song-group', els => els.length);
        assert(jzGroups >= 1, `corpus groups rendered (got ${jzGroups})`);

        const jzRows = await page.$$eval('[data-jz-groups] .song-row', els => els.length);
        assert(jzRows >= 1, `corpus rows rendered (got ${jzRows})`);

        // Rows carry a mid/pdf chip + title + performer subtitle.
        const jzFmt = await page.$eval('[data-jz-groups] .song-row .song-fmt', el => el.textContent.trim());
        assert(['mid', 'pdf', 'mid+pdf'].includes(jzFmt), `corpus row format chip: "${jzFmt}"`);

        const jzTitle = await page.$eval('[data-jz-groups] .song-row .song-title', el => el.textContent.trim());
        assert(jzTitle.length > 0, `corpus row has a title: "${jzTitle}"`);

        // Corpus search is independent of the audio search.
        await page.type('[data-jz-search]', 'zzzzz-no-match-zzzzz');
        await new Promise(r => setTimeout(r, 250));
        const jzFiltered = await page.$$eval('[data-jz-groups] .song-row', els => els.length);
        assert(jzFiltered === 0, `corpus search hides all corpus rows (got ${jzFiltered})`);
        // The audio list must be unaffected by the corpus search.
        const audioStillVisible = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
        assert(audioStillVisible === restoredRows,
          `corpus search leaves audio rows untouched (got ${audioStillVisible}, expected ${restoredRows})`);

        await page.click('[data-jz-search]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 250));
        const jzRestored = await page.$$eval('[data-jz-groups] .song-row', els => els.length);
        assert(jzRestored === jzRows, `clearing corpus search restores rows (got ${jzRestored}, expected ${jzRows})`);
      } else {
        const jzEmptyText = await page.$eval('[data-jz-empty]', el => el.textContent.trim());
        assert(/index-jazz-solos|could not load/i.test(jzEmptyText),
          `corpus empty-state explains the fix: "${jzEmptyText.slice(0, 90)}…"`);
      }

      // Screenshot
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.screenshot({ path: join(ART, 'songs-catalog-light.png'), fullPage: true });
      dim('saved songs-catalog-light.png');
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.evaluate(() => document.documentElement.setAttribute('data-theme-pref', 'dark'));
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: join(ART, 'songs-catalog-dark.png'), fullPage: true });
      dim('saved songs-catalog-dark.png');

    } else {
      log(`--- empty-state mode (no items or fetch failed) ---`);

      const emptyText = await page.$eval('[data-songs-empty]', el => el.textContent.trim());
      assert(/configured roots|could not load/i.test(emptyText),
        `empty-state explains the situation: "${emptyText.slice(0, 80)}…"`);

      // Screenshot
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.screenshot({ path: join(ART, 'songs-empty-light.png'), fullPage: true });
      dim('saved songs-empty-light.png');
    }

    // --- 0 console errors ---
    assert(consoleErrors.length === 0,
      `0 console errors (got ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''})`);

    log('');
    if (failures === 0) {
      ok(`ALL CHECKS PASSED — screenshots in ${ART}`);
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