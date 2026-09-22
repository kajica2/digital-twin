import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loopable Video Segmenter port — page contract spec.
//
// URL convention (single path in every mode — production Pages, the
// launchd dev server, and CI's PR-mode server all serve the repo root):
//   deployed → ${BASE}/pages/loopable-video-segmenter.html
//   local    → ${BASE}/pages/loopable-video-segmenter.html
//   twin-os  → ${BASE}/pages/twin-os/index.html
//
//   E2E_URL=https://kajica2.github.io/digital-twin node loopable-video-segmenter.spec.mjs
//   PORT=5180 node loopable-video-segmenter.spec.mjs   # python3 -m http.server 5180 --directory .
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const LVS_URL = `${BASE}/pages/loopable-video-segmenter.html`;
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
  // LVS page — light theme + contract assertions
  // ------------------------------------------------------------------
  const lvsErrors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => lvsErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') lvsErrors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => lvsErrors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  try {
    await page.goto(LVS_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  } catch (err) {
    // Down-server ergonomics: give the fix hint, dump checks so far, exit 1.
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: python3 -m http.server 5180 --directory .');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  check('lvs: hero <h1> mentions loopable', await page.evaluate(() =>
    (document.querySelector('h1')?.textContent || '').toLowerCase().includes('loopable')));
  check('lvs: theme toggle button exists', await page.evaluate(() =>
    !!document.querySelector('.theme-toggle#themeToggle')));
  check('lvs: params table has 3 data rows', await page.evaluate(() =>
    document.querySelectorAll('#params table tbody tr, #params table tr').length === 4), await page.evaluate(() =>
    'found ' + document.querySelectorAll('#params table tr').length + ' rows (1 header + 3 params expected)'));
  check('lvs: how-it-works has 5 steps', await page.evaluate(() =>
    document.querySelectorAll('#how ol li').length === 5), await page.evaluate(() =>
    'found ' + document.querySelectorAll('#how ol li').length));
  check('lvs: how-to-run mentions npm run lvs:ui', await page.evaluate(() =>
    document.body.innerText.includes('npm run lvs:ui')));
  check('lvs: CLI block mentions --json', await page.evaluate(() =>
    document.body.innerText.includes('--json')));
  check('lvs: notes carry the mirrored-audio warning', await page.evaluate(() =>
    !!document.querySelector('#notes .callout.warn') && document.body.innerText.includes('audio backwards')));
  check('lvs: attribution links the original repo', await page.evaluate(() =>
    document.body.innerText.includes('kajica2/loopable-video-segmenter')));
  check('lvs: attribution mentions Gradio + librosa', await page.evaluate(() =>
    document.body.innerText.includes('Gradio') && document.body.innerText.includes('librosa')));
  check('lvs: hero chips include local-first', await page.evaluate(() =>
    document.body.innerText.includes('local-first')));
  check('lvs: every code block has a copy button', await page.evaluate(() => {
    const blocks = document.querySelectorAll('.code-block').length;
    const btns = document.querySelectorAll('.copy-btn[data-copy]').length;
    return { blocks, btns, ok: blocks > 0 && blocks === btns };
  }).then(r => r.ok), await page.evaluate(() => {
    const blocks = document.querySelectorAll('.code-block').length;
    const btns = document.querySelectorAll('.copy-btn[data-copy]').length;
    return `blocks=${blocks} copyBtns=${btns}`;
  }));

  await page.screenshot({ path: path.join(ARTIFACTS, 'lvs-light.png'), fullPage: true });
  console.log('wrote artifacts/lvs-light.png');

  // Theme toggle: light → dark flips data-theme and persists on reload
  await page.evaluate(() => document.querySelector('.theme-toggle#themeToggle').click());
  await new Promise(r => setTimeout(r, 250));
  check('lvs: theme click flips data-theme to dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.screenshot({ path: path.join(ARTIFACTS, 'lvs-dark.png'), fullPage: true });
  console.log('wrote artifacts/lvs-dark.png');

  await page.reload({ waitUntil: 'networkidle0' });
  check('lvs: theme persists on reload (localStorage lvs-theme)', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));

  // Internal-link resolution: every relative href on the LVS page must not
  // 404 against the same base. Fragment-only anchors are fine.
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && !/^(https?:|mailto:|tel:|#)/.test(h)));
  const dead = [];
  for (const h of new Set(hrefs)) {
    const url = new URL(h, page.url());
    if (url.origin !== new URL(LVS_URL).origin) continue; // hard external
    try {
      const resp = await fetch(url.toString(), { method: 'HEAD' });
      if (resp.status >= 400) dead.push(`${h} → ${resp.status}`);
    } catch {
      dead.push(`${h} → fetch failed`);
    }
  }
  check('lvs: no internal links 404', dead.length === 0, dead.slice(0, 4).join(' | ') || `${hrefs.length} internal href(s) checked`);

  // ------------------------------------------------------------------
  // Twin OS — data-tool-lvs link
  // ------------------------------------------------------------------
  const twinErrors = [];
  const twin = await browser.newPage();
  await twin.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  twin.on('pageerror', e => twinErrors.push('pageerror: ' + e.message));
  twin.on('console', m => {
    // Known pre-existing: twin-os fetches ../../data/songs/catalog.json, which
    // 404s (catalog is gitignored user-local). Mirror the filter used by
    // twin-os.spec.mjs / twin-os-songs.spec.mjs.
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
    const a = document.querySelector('.tool-grid a[data-tool-lvs]');
    if (!a) return null;
    return { href: a.getAttribute('href'), name: a.querySelector('.tool-name')?.textContent?.trim() };
  });
  check('twin-os: a[data-tool-lvs] exists', !!tool);
  check('twin-os: href ends with loopable-video-segmenter.html', !!tool && tool.href.endsWith('loopable-video-segmenter.html'), tool?.href || 'missing');
  check('twin-os: name is "Loopable Video Segmenter"', !!tool && tool.name === 'Loopable Video Segmenter', tool?.name || 'missing');
  await twin.screenshot({ path: path.join(ARTIFACTS, 'lvs-twinos.png'), fullPage: true });
  console.log('wrote artifacts/lvs-twinos.png');

  // ------------------------------------------------------------------
  // Console hygiene — 0 errors on both pages
  // ------------------------------------------------------------------
  check('lvs: 0 console errors', lvsErrors.length === 0, lvsErrors.slice(0, 4).join(' | '));
  check('twin-os: 0 console errors', twinErrors.length === 0, twinErrors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all loopable-video-segmenter checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);