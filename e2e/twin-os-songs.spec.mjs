// Puppeteer smoke test for the Songs panel in the Twin OS shell.
//
// Asserts:
//   - Songs panel structure (head, empty/catalog blocks)
//   - Loading state disappears once fetch resolves
//   - Either the catalog renders (when items exist) OR the configured-
//     empty-state renders (when items.length === 0 OR fetch fails)
//   - Search input filters the catalog (when catalog is shown)
//   - The transcription corpus renders from a DETERMINISTIC fixture
//     catalogue (e2e/fixtures/catalog-jazz-solos.json), served through
//     request interception: the real catalogue is a gitignored generated
//     artifact and reaches neither CI nor the deploy, so the filter
//     stack would otherwise have nothing to assert on.
//   - Corpus filters (style / instrument / tempo min / tempo max) AND
//     with each other and with the free-text query
//   - The "no matches" state is a different state from the "not
//     indexed yet" state, and the catalogue totals in the meta survive
//     filtering (the counter reports the surviving rows)
//   - Reset restores the full corpus
//   - Corpus filtering never touches the audio catalogue above
//   - 0 console errors
//
// Run from the e2e/ directory:
//   node twin-os-songs.spec.mjs
//   PORT=5180 node twin-os-songs.spec.mjs     # a server is already running
//
// E2E_URL semantics — same as twin-os.spec.mjs:
//   - undefined → local server on :5175 serving the repo root
//   - set       → hits the deployed site at ${E2E_URL}/pages/twin-os/
//
// The URL path is /pages/twin-os/index.html in EVERY mode.
//
// Artifacts saved to e2e/artifacts/twin-os-songs/

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = join(__dirname, 'artifacts', 'twin-os-songs');
// The corpus catalogue used by the assertions below. Committed on
// purpose — the real one is generated and gitignored.
const FIXTURE = join(__dirname, 'fixtures', 'catalog-jazz-solos.json');

// PORT semantics (same as the ct-*.mjs specs):
//   - unset → this spec starts its own static server on :5175
//   - set   → a server is already running on that port; use it
const PORT = Number(process.env.PORT) || 5175;

const DEPLOYED_URL = process.env.E2E_URL || null;
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const EXTERNAL_SERVER = !DEPLOYED_URL && !!process.env.PORT;
// The URL path is /pages/twin-os/index.html in EVERY mode — the local
// server roots at the repo root, as Pages does.
const PAGE_PATH = '/pages/twin-os/index.html';
const pageUrl = `${BASE}${PAGE_PATH}`;

async function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
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

// Static server rooted at the REPO ROOT, exactly as GitHub Pages
// serves it. The shell lives at /pages/twin-os/ and fetches the
// catalogs from ../../data/…, which resolves to /data/… — the same
// shape the deploy serves. Rooting at pages/twin-os/ instead made
// ../assets/ and ../lib/ 404 locally while they worked on the deploy.
function startServer(repoRoot) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, BASE);
      let p = u.pathname === '/' ? '/pages/twin-os/index.html' : u.pathname;
      // The catalogs are gitignored generated artifacts; the /data/
      // branch keeps them resolvable from the repo root.
      let file;
      if (p.startsWith('/data/')) {
        file = join(repoRoot, decodeURIComponent(p.slice(1)));
      } else {
        file = join(repoRoot, decodeURIComponent(p));
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

  const fixtureBody = await readFile(FIXTURE, 'utf8');
  // Sanity: the fixture must be the catalogue shape the page parses.
  const fixture = JSON.parse(fixtureBody);
  if (!Array.isArray(fixture.items) || !fixture.items.length) {
    bad(`corpus fixture ${FIXTURE} has no items`);
    process.exit(1);
  }

  let server = null;
  if (DEPLOYED_URL) {
    log(`running against deployed URL: ${pageUrl}`);
  } else if (EXTERNAL_SERVER) {
    log(`using the server already running on :${PORT}`);
  } else {
    log(`starting static server on :${PORT} (serving repo root ${ROOT})`);
    server = await startServer(ROOT);
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
    const watchConsole = (p) => {
      p.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
      p.on('console', m => {
        if (m.type() === 'error') {
            const url = m.location().url || '';
            const text = m.text();
            // Catalogs are generated artifacts (gitignored), so a deployed
            // page legitimately 404s on them and the panel renders its
            // "not indexed yet" state. Ignore those.
            if (/catalog[^/]*\.json/.test(url) && text.includes('404')) return;
            // data/flux/* are gitignored generated assets, not deployed.
            if (/data\/flux\//.test(url) && text.includes('404')) return;
            // Some script tags reference gitignored paths (fallback behavior).
            if (text.includes('404') && text.includes('script')) return;
            consoleErrors.push(`console.error: ${text} (${url})`);
        }
      });
    };
    watchConsole(page);

    // The corpus catalogue is a generated artifact: it is gitignored, it
    // is not deployed, and the live site answers its URL with the
    // catch-all landing HTML. Serve the committed fixture through
    // request interception so the corpus section renders with KNOWN rows
    // in every mode — otherwise the filter assertions would have
    // nothing deterministic to assert on.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('catalog-jazz-solos.json')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: fixtureBody,
        }).catch(() => {});
        return;
      }
      req.continue().catch(() => {});
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

    // The audio row count, captured before the corpus is touched, so the
    // corpus assertions can prove the audio catalogue is unaffected.
    let audioRowsBaseline = null;

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

      audioRowsBaseline = restoredRows;

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

    /* ---------------------------------------------------------------
       Transcription corpus section (WJazzD MIDI archive).

       Independent of the audio catalogue: its own indexer, its own
       catalogue file, its own loading / empty / catalog states. The
       corpus may be indexed while the audio catalogue is not, so these
       assertions live outside the audio-catalog branch above.

       The rows come from the committed fixture catalogue, so the
       expected counts below are exact.
       --------------------------------------------------------------- */
    await page.waitForFunction(() => {
      const loading = document.querySelector('[data-jz-loading]');
      return loading && loading.hidden === true;
    }, { timeout: 10000 });

    const jzCatalogHidden = await page.$eval('[data-jz-catalog]', el => el.hidden);
    const jzEmptyHidden   = await page.$eval('[data-jz-empty]',   el => el.hidden);
    assert(jzCatalogHidden !== jzEmptyHidden,
      `exactly one corpus state is visible (catalog.hidden=${jzCatalogHidden}, empty.hidden=${jzEmptyHidden})`);

    // Helpers over the rendered corpus.
    const corpusRows = () => page.$$eval('[data-jz-groups] .song-row', els => els.map(el => {
      const cells = el.querySelectorAll('.song-meta-cell');
      const title = el.querySelector('.song-title');
      return {
        title: title ? (title.firstChild ? title.firstChild.textContent.trim() : '') : '',
        // The title cell also carries "performer · year" in a <small>.
        text: title ? title.textContent.replace(/\s+/g, ' ').trim() : '',
        instrument: cells[0] ? cells[0].textContent.trim() : '',
        tempo: cells[1] ? cells[1].textContent.trim() : '',
      };
    }));
    const corpusRowCount = async () => (await corpusRows()).length;
    const corpusGroups = () => page.$$eval('[data-jz-groups] .song-group-label', els => els.map(e => e.textContent.trim()));
    const corpusCounter = () => page.$eval('[data-jz-search-count]', el => el.textContent.trim());
    // The counter text is "N match" / "N matches" — read the number.
    const corpusCounterCount = async () => {
      const m = (await corpusCounter()).match(/(\d+)/);
      return m ? Number(m[1]) : -1;
    };
    const corpusMeta = () => page.$eval('[data-jz-meta]', el => el.textContent.replace(/\s+/g, ' ').trim());
    const noMatchHidden = () => page.$eval('[data-jz-no-match]', el => el.hidden);
    // "hidden" is the attribute; visibility is what the user sees.
    const isVisible = (p, sel) => p.$eval(sel,
      el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const setTempo = async (sel, value) => {
      await page.$eval(sel, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
      await wait(200);
    };
    const setSelect = async (sel, value) => {
      await page.select(sel, value);
      await wait(200);
    };
    const typeIn = async (sel, text) => {
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(sel, text);
      await wait(200);
    };

    if (!jzCatalogHidden) {
      log(`--- corpus catalog mode (${fixture.items.length} fixture solos) ---`);

      const jzMeta = await corpusMeta();
      assert(/\d+ solos?/.test(jzMeta), `corpus meta mentions solos: "${jzMeta}"`);
      assert(/\d+ performers/.test(jzMeta), `corpus meta mentions performers: "${jzMeta}"`);

      const jzGroups = await page.$$eval('[data-jz-groups] .song-group', els => els.length);
      assert(jzGroups >= 1, `corpus groups rendered (got ${jzGroups})`);

      const jzRows = await corpusRowCount();
      assert(jzRows === fixture.items.length,
        `corpus renders every fixture solo (got ${jzRows}, expected ${fixture.items.length})`);

      // Rows carry a mid/pdf chip + title + performer subtitle.
      const jzFmt = await page.$eval('[data-jz-groups] .song-row .song-fmt', el => el.textContent.trim());
      assert(['mid', 'pdf', 'mid+pdf'].includes(jzFmt), `corpus row format chip: "${jzFmt}"`);

      const jzTitle = await page.$eval('[data-jz-groups] .song-row .song-title', el => el.textContent.trim());
      assert(jzTitle.length > 0, `corpus row has a title: "${jzTitle}"`);

      // The "no matches" state must stay hidden while rows survive, and
      // the "not indexed yet" state must stay hidden while the catalog
      // is loaded — they are different states.
      assert(await noMatchHidden(), '"no matches" state hidden while rows survive');
      assert(jzEmptyHidden, '"not indexed yet" state hidden while the catalog is loaded');

      // Corpus search is independent of the audio search.
      await typeIn('[data-jz-search]', 'zzzzz-no-match-zzzzz');
      assert(await corpusRowCount() === 0, 'corpus search hides all corpus rows');
      assert(!(await noMatchHidden()), '"no matches" state appears when the query hits nothing');

      await typeIn('[data-jz-search]', '');
      const jzRestored = await corpusRowCount();
      assert(jzRestored === jzRows, `clearing corpus search restores rows (got ${jzRestored}, expected ${jzRows})`);
      assert(await noMatchHidden(), '"no matches" state hides again once rows are back');
      assert(!(await isVisible(page, '[data-jz-no-match]')),
        '"no matches" state is not visible once rows are back');

      // The audio list must be unaffected by the corpus search.
      if (audioRowsBaseline !== null) {
        const audioStillVisible = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
        assert(audioStillVisible === audioRowsBaseline,
          `corpus search leaves audio rows untouched (got ${audioStillVisible}, expected ${audioRowsBaseline})`);
      }

      /* ---- the filter stack -------------------------------------- */

      // The three controls exist and are populated from the catalogue
      // facets.
      const styleOptions = await page.$$eval('[data-jz-style] option', els => els.map(e => e.value));
      const instrumentOptions = await page.$$eval('[data-jz-instrument] option', els => els.map(e => e.value));
      assert(styleOptions.length === fixture.styles.length + 1,
        `style filter offers every facet plus "all" (got ${styleOptions.length}, expected ${fixture.styles.length + 1})`);
      assert(styleOptions[0] === '', 'style filter starts on "all styles"');
      assert(instrumentOptions.length === fixture.instruments.length + 1,
        `instrument filter offers every facet plus "all" (got ${instrumentOptions.length}, expected ${fixture.instruments.length + 1})`);
      assert(instrumentOptions[0] === '', 'instrument filter starts on "all instruments"');

      // Expected row counts per scenario, computed from the fixture
      // with explicit predicates (not a re-run of the page's own filter
      // function) so a wrong filter fails here.
      const is = (it, o) => Object.keys(o).every(k => it[k] === o[k]);
      const postbopTenor = fixture.items.filter(it =>
        is(it, { style: 'Postbop', instrumentName: 'tenor saxophone' }));
      const expected = {
        postbop: fixture.items.filter(it => is(it, { style: 'Postbop' })).length,
        postbopTenor: postbopTenor.length,
        postbopTenorMin150: postbopTenor.filter(it => it.tempo >= 150).length,
        postbopTenorMax120: postbopTenor.filter(it => it.tempo <= 120).length,
        postbopTenorWindow: postbopTenor.filter(it => it.tempo >= 145 && it.tempo <= 175).length,
        // The free-text query "ada" matches the performer name.
        ada: fixture.items.filter(it => it.performer === 'Ada Rivers').length,
        // …ANDed with style + instrument + tempo.
        adaPostbopTenorMin150: fixture.items.filter(it =>
          is(it, { style: 'Postbop', instrumentName: 'tenor saxophone' }) &&
          it.tempo >= 150 && it.performer === 'Ada Rivers').length,
      };

      // Style narrows the corpus.
      await setSelect('[data-jz-style]', 'Postbop');
      const styleRows = await corpusRows();
      assert(styleRows.length === expected.postbop,
        `style filter narrows the corpus to ${expected.postbop} rows (got ${styleRows.length})`);
      assert((await corpusGroups()).join(',') === 'Postbop',
        `only the selected style is grouped (got "${(await corpusGroups()).join(',')}")`);
      assert((await corpusCounterCount()) === expected.postbop,
        `counter reports the surviving rows ("${await corpusCounter()}")`);

      // Instrument narrows further.
      await setSelect('[data-jz-instrument]', 'tenor saxophone');
      const instrRows = await corpusRows();
      assert(instrRows.length === expected.postbopTenor,
        `instrument filter narrows further to ${expected.postbopTenor} rows (got ${instrRows.length})`);
      assert(instrRows.every(r => r.instrument.startsWith('tenor saxophone')),
        'every surviving row is the selected instrument');
      assert((await corpusCounterCount()) === expected.postbopTenor,
        `counter tracks the instrument filter ("${await corpusCounter()}")`);

      // Tempo min narrows further.
      await setTempo('[data-jz-tempo-min]', '150');
      const minRows = await corpusRows();
      assert(minRows.length === expected.postbopTenorMin150,
        `tempo min narrows to ${expected.postbopTenorMin150} rows (got ${minRows.length})`);
      assert(minRows.every(r => parseFloat(r.tempo) >= 150),
        `every surviving row is at or above 150 BPM (got ${minRows.map(r => r.tempo).join(', ')})`);

      // Tempo max narrows too — and it is a bound, not a replacement.
      await setTempo('[data-jz-tempo-min]', '');
      await setTempo('[data-jz-tempo-max]', '120');
      const maxRows = await corpusRows();
      assert(maxRows.length === expected.postbopTenorMax120,
        `tempo max narrows to ${expected.postbopTenorMax120} rows (got ${maxRows.length})`);
      assert(maxRows.every(r => parseFloat(r.tempo) <= 120),
        `every surviving row is at or below 120 BPM (got ${maxRows.map(r => r.tempo).join(', ')})`);
      assert((await corpusCounter()) === '1 match',
        `counter uses the singular form for one row ("${await corpusCounter()}")`);

      // Both bounds at once: min AND max — a window, not a replacement.
      await setTempo('[data-jz-tempo-min]', '145');
      await setTempo('[data-jz-tempo-max]', '175');
      const windowRows = await corpusRows();
      assert(windowRows.length === expected.postbopTenorWindow,
        `tempo min AND max narrow to the window (got ${windowRows.length}, expected ${expected.postbopTenorWindow})`);
      assert(windowRows.every(r => parseFloat(r.tempo) >= 145 && parseFloat(r.tempo) <= 175),
        `every surviving row is inside the tempo window (got ${windowRows.map(r => r.tempo).join(', ')})`);

      // Reset clears every control.
      await page.click('[data-jz-filters-reset]');
      await wait(200);
      assert(await corpusRowCount() === jzRows, 'reset restores the full corpus');
      assert(await page.$eval('[data-jz-style]', el => el.value) === '', 'reset clears the style filter');
      assert(await page.$eval('[data-jz-instrument]', el => el.value) === '', 'reset clears the instrument filter');
      assert(await page.$eval('[data-jz-tempo-min]', el => el.value) === '', 'reset clears the tempo min');
      assert(await page.$eval('[data-jz-tempo-max]', el => el.value) === '', 'reset clears the tempo max');

      // The free-text query ANDs with the facet filters.
      await typeIn('[data-jz-search]', 'ada');
      const adaRows = await corpusRows();
      assert(adaRows.length === expected.ada,
        `free-text query alone keeps ${expected.ada} rows (got ${adaRows.length})`);
      assert(adaRows.every(r => /ada/i.test(r.text)),
        `every surviving row matches the free-text query (got ${adaRows.map(r => r.title).join(', ')})`);

      await setSelect('[data-jz-style]', 'Postbop');
      await setSelect('[data-jz-instrument]', 'tenor saxophone');
      await setTempo('[data-jz-tempo-min]', '150');
      const andRows = await corpusRows();
      assert(andRows.length === expected.adaPostbopTenorMin150,
        `style AND instrument AND tempo AND query keep ${expected.adaPostbopTenorMin150} rows (got ${andRows.length})`);
      assert(andRows.length < adaRows.length,
        'the filter stack narrows the free-text result further');
      assert(andRows.every(r => r.instrument.startsWith('tenor saxophone')),
        'every surviving row is the selected instrument');
      assert(andRows.every(r => parseFloat(r.tempo) >= 150),
        'every surviving row honours the tempo bound');
      assert(andRows.every(r => /ada/i.test(r.text)),
        `every surviving row matches the free-text query (got ${andRows.map(r => r.title).join(', ')})`);

      // The meta keeps reporting the catalogue totals while the counter
      // reports the surviving rows.
      const filteredMeta = await corpusMeta();
      assert(new RegExp(`\\b${fixture.items.length} solos?\\b`).test(filteredMeta),
        `meta still reports the catalogue total ("${filteredMeta}")`);
      assert((await corpusCounterCount()) === expected.adaPostbopTenorMin150,
        `counter reports the surviving rows ("${await corpusCounter()}")`);

      // A filter stack that matches nothing shows the "no matches"
      // state — NOT the "not indexed yet" state.
      await setTempo('[data-jz-tempo-min]', '380');
      const emptyRows = await corpusRows();
      assert(emptyRows.length === 0, 'an impossible tempo bound leaves no rows');
      assert(!(await noMatchHidden()), '"no matches" state appears when the filter stack matches nothing');
      assert(await isVisible(page, '[data-jz-no-match]'),
        '"no matches" state is actually visible when the filter stack matches nothing');
      assert(await page.$eval('[data-jz-empty]', el => el.hidden),
        '"not indexed yet" state stays hidden — the corpus IS indexed');
      assert((await corpusCounter()) === '0 matches', 'counter reports zero matches');
      const noMatchText = await page.$eval('[data-jz-no-match]', el => el.textContent.replace(/\s+/g, ' ').trim());
      assert(/no solos match/i.test(noMatchText),
        `"no matches" state explains itself ("${noMatchText.slice(0, 70)}…")`);
      assert(!/index-jazz-solos/i.test(noMatchText),
        '"no matches" state does not tell the user to re-index');

      // Corpus filtering must not touch the audio catalogue above.
      if (audioRowsBaseline !== null) {
        const audioAfter = await page.$$eval('[data-songs-catalog] .song-row', els => els.length);
        assert(audioAfter === audioRowsBaseline,
          `corpus filters leave audio rows untouched (got ${audioAfter}, expected ${audioRowsBaseline})`);
      }

      // Reset from the empty state restores everything.
      await page.click('[data-jz-filters-reset]');
      await wait(200);
      assert(await corpusRowCount() === jzRows, 'reset from the empty state restores the full corpus');
      assert(await noMatchHidden(), '"no matches" state hides again after reset');

      // Screenshot with a filter applied.
      await setSelect('[data-jz-style]', 'Postbop');
      await setTempo('[data-jz-tempo-min]', '150');
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: join(ART, 'corpus-filtered-dark.png'), fullPage: true });
      dim('saved corpus-filtered-dark.png');
    } else {
      const jzEmptyText = await page.$eval('[data-jz-empty]', el => el.textContent.trim());
      assert(/index-jazz-solos|could not load/i.test(jzEmptyText),
        `corpus empty-state explains the fix: "${jzEmptyText.slice(0, 90)}…"`);
    }

    /* ---------------------------------------------------------------
       The corpus catalogue missing is a DIFFERENT state from "the
       filters matched nothing". A second page proves it: the corpus
       request fails, so the section renders its "not indexed yet"
       state, and the "no matches" state must NOT appear.
       --------------------------------------------------------------- */
    {
      const broken = await browser.newPage();
      await broken.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
      watchConsole(broken);
      await broken.setRequestInterception(true);
      broken.on('request', (req) => {
        if (req.url().includes('catalog-jazz-solos.json')) {
          req.respond({ status: 404, contentType: 'text/plain', body: 'not found' }).catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await broken.goto(pageUrl, { waitUntil: 'networkidle0' });
      await broken.click('.rail-item[data-panel="songs"]');
      await broken.waitForFunction(() => {
        const loading = document.querySelector('[data-jz-loading]');
        return loading && loading.hidden === true;
      }, { timeout: 10000 });

      const brokenEmptyHidden = await broken.$eval('[data-jz-empty]', el => el.hidden);
      const brokenCatalogHidden = await broken.$eval('[data-jz-catalog]', el => el.hidden);
      assert(!brokenEmptyHidden && brokenCatalogHidden,
        `a missing corpus catalogue shows the empty state (empty.hidden=${brokenEmptyHidden}, catalog.hidden=${brokenCatalogHidden})`);
      assert(await broken.$eval('[data-jz-no-match]', el => el.hidden),
        '"no matches" state does NOT appear when the catalogue is missing');
      assert(!(await isVisible(broken, '[data-jz-no-match]')),
        '"no matches" state is not visible when the catalogue is missing');
      assert(await isVisible(broken, '[data-jz-empty]'),
        'the "not indexed yet" state IS visible when the catalogue is missing');
      const brokenText = await broken.$eval('[data-jz-empty]', el => el.textContent.replace(/\s+/g, ' ').trim());
      assert(/index-jazz-solos|could not load/i.test(brokenText),
        `the missing-catalogue state explains the fix ("${brokenText.slice(0, 80)}…")`);
      await broken.close();
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
