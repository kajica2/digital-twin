import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLIP Interrogator port — page contract spec.
//
// URL convention (deliberately NOT the ct-spec quirk):
//   deployed → ${BASE}/pages/clip-interrogator.html  (site root = repo root)
//   local    → ${BASE}/pages/clip-interrogator.html  (server runs --directory .,
//              matching production + the launchd dev server — CI's PR-mode
//              server serves the repo root too)
//   twin-os  → ${BASE}/pages/twin-os/index.html (same in every mode)
//
//   E2E_URL=https://kajica2.github.io/digital-twin node clip-interrogator.spec.mjs
//   PORT=5180 node clip-interrogator.spec.mjs     # python3 -m http.server 5180 --directory .
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
// Single path in every mode: /pages/... on GitHub Pages, the launchd dev
// server, and CI's PR-mode server all serve the repo root.
const CLIP_URL = `${BASE}/pages/clip-interrogator.html`;
const TWINOS_URL = `${BASE}/pages/twin-os/index.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

try {
  // ------------------------------------------------------------------
  // CLIP page — light theme + contract assertions
  // ------------------------------------------------------------------
  const clipErrors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => clipErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') clipErrors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => clipErrors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  try {
    await page.goto(CLIP_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  } catch (err) {
    // Down-server ergonomics: give the fix hint, dump checks so far, exit 1.
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: python3 -m http.server 5180 --directory .');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  check('clip: hero <h1> mentions CLIP Interrogator', await page.evaluate(() =>
    (document.querySelector('h1')?.textContent || '').includes('CLIP Interrogator')));
  check('clip: <theme-toggle> exists', await page.evaluate(() => !!document.querySelector('theme-toggle')));
  check('clip: mode table has 4 rows', await page.evaluate(() =>
    document.querySelectorAll('[data-mode-table] tbody tr').length === 4), await page.evaluate(() =>
    'found ' + document.querySelectorAll('[data-mode-table] tbody tr').length));
  check('clip: model table has 2 entries', await page.evaluate(() =>
    document.querySelectorAll('[data-model-table] tbody tr').length === 2), await page.evaluate(() =>
    'found ' + document.querySelectorAll('[data-model-table] tbody tr').length));
  check('clip: how-to-run mentions npm run clip:ui', await page.evaluate(() =>
    document.body.innerText.includes('npm run clip:ui')));
  check('clip: attribution mentions Pixabay', await page.evaluate(() =>
    document.body.innerText.includes('Pixabay')));
  check('clip: attribution mentions pharmapsychotic', await page.evaluate(() =>
    document.body.innerText.includes('pharmapsychotic')));
  check('clip: [data-sample-output] exists', await page.evaluate(() =>
    !!document.querySelector('[data-sample-output]')));

  await new Promise(r => setTimeout(r, 600)); // let images finish after load
  const imgLoad = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.example img'));
    return { count: imgs.length, allLoaded: imgs.every(i => i.complete && i.naturalWidth > 0) };
  });
  check('clip: both example imgs load (naturalWidth > 0)', imgLoad.count === 2 && imgLoad.allLoaded,
    `count=${imgLoad.count} allLoaded=${imgLoad.allLoaded}`);

  await page.screenshot({ path: path.join(ARTIFACTS, 'clip-light.png'), fullPage: true });
  console.log('wrote artifacts/clip-light.png');

  // Theme toggle: light → dark flips data-theme and persists on reload
  await page.evaluate(() => document.querySelector('theme-toggle button[data-value="dark"]').click());
  await new Promise(r => setTimeout(r, 250));
  check('clip: theme click flips data-theme to dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.screenshot({ path: path.join(ARTIFACTS, 'clip-dark.png'), fullPage: true });
  console.log('wrote artifacts/clip-dark.png');

  await page.reload({ waitUntil: 'networkidle0' });
  check('clip: theme persists on reload', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));

  // Internal-link resolution: every relative href on the CLIP page must not
  // 404 against the same base. An anchor is "internal" when it doesn't start
  // with http(s)://, mailto:, tel:, or '#'. Fragment-only anchors are fine.
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && !/^(https?:|mailto:|tel:|#)/.test(h)));
  const dead = [];
  for (const h of new Set(hrefs)) {
    // Resolve against the page's own URL so ../ and ./ semantics match the browser.
    const url = new URL(h, page.url());
    if (url.origin !== new URL(CLIP_URL).origin) continue; // hard external
    try {
      const resp = await fetch(url.toString(), { method: 'HEAD' });
      if (resp.status >= 400) dead.push(`${h} → ${resp.status}`);
    } catch {
      dead.push(`${h} → fetch failed`);
    }
  }
  check('clip: no internal links 404', dead.length === 0, dead.slice(0, 4).join(' | ') || `${hrefs.length} internal href(s) checked`);

  // ------------------------------------------------------------------
  // Twin OS — data-tool-clip link
  // ------------------------------------------------------------------
  const twinErrors = [];
  const twin = await browser.newPage();
  await twin.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  twin.on('pageerror', e => twinErrors.push('pageerror: ' + e.message));
  twin.on('console', m => {
    // Known pre-existing: twin-os fetches ../../data/songs/catalog.json, which
    // 404s (catalog is gitignored user-local — still true under the repo-root server). Mirror
    // the filter used by twin-os.spec.mjs / twin-os-songs.spec.mjs.
    if (m.type() === 'error') {
      const url = m.location().url || '';
      const text = m.text();
      if (url.includes('catalog.json') && text.includes('404')) return;
      twinErrors.push('console.error: ' + text + ' (' + url + ')');
    }
  });
  twin.on('requestfailed', r => twinErrors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await twin.goto(TWINOS_URL, { waitUntil: 'networkidle0', timeout: 20000 });

  const tool = await twin.evaluate(() => {
    const a = document.querySelector('.tool-grid a[data-tool-clip]');
    if (!a) return null;
    return { href: a.getAttribute('href'), name: a.querySelector('.tool-name')?.textContent?.trim() };
  });
  check('twin-os: a[data-tool-clip] exists', !!tool);
  check('twin-os: href ends with clip-interrogator.html', !!tool && tool.href.endsWith('clip-interrogator.html'), tool?.href || 'missing');
  check('twin-os: name is "CLIP Interrogator"', !!tool && tool.name === 'CLIP Interrogator', tool?.name || 'missing');
  await twin.screenshot({ path: path.join(ARTIFACTS, 'clip-twinos.png'), fullPage: true });
  console.log('wrote artifacts/clip-twinos.png');

  // ------------------------------------------------------------------
  // Console hygiene — 0 errors on both pages
  // ------------------------------------------------------------------
  check('clip: 0 console errors', clipErrors.length === 0, clipErrors.slice(0, 4).join(' | '));
  check('twin-os: 0 console errors', twinErrors.length === 0, twinErrors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all clip-interrogator checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);