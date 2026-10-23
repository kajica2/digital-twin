import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Treblo — page contract spec.
//
// No credentials, no API calls, no account. The page is a contract, and
// this is the contract.
//
// URL convention (single path in every mode — production Pages, the
// launchd dev server, and CI's PR-mode server all serve the repo root):
//   deployed → ${BASE}/pages/treblo.html
//   local    → ${BASE}/pages/treblo.html
//   twin-os  → ${BASE}/pages/twin-os/index.html
//
//   E2E_URL=https://digitaltwin-ebon.vercel.app node treblo.spec.mjs
//   PORT=5180 node treblo.spec.mjs   # node lib/serve.js --port 5180
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const TREBLO_URL = `${BASE}/pages/treblo.html`;
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
  // The Treblo page — light theme + contract assertions
  // ------------------------------------------------------------------
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  try {
    await page.goto(TREBLO_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  } catch (err) {
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: node lib/serve.js --port 5180');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  check('treblo: hero h1 is about songs from a prompt', await page.evaluate(() =>
    /songs? from .*prompt/i.test((document.querySelector('h1')?.textContent || '').trim())),
    await page.evaluate(() => (document.querySelector('h1')?.textContent || '').trim()));

  check('treblo: the skin stylesheet is loaded once', await page.evaluate(() =>
    document.querySelectorAll('link[data-skin-stylesheet]').length === 1));
  check('treblo: the house skin is applied', await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin') === 'house'),
    await page.evaluate(() => document.documentElement.getAttribute('data-skin')));
  check('treblo: the skin runtime is loaded once', await page.evaluate(() =>
    document.querySelectorAll('script[src*="lib/skin.js"]').length === 1));

  check('treblo: the theme has three buttons', await page.evaluate(() =>
    document.querySelectorAll('[data-theme-btn]').length === 3));
  check('treblo: the theme key is its own', await page.evaluate(() =>
    document.querySelector('script[data-theme-key]')?.getAttribute('data-theme-key') === 'treblo-theme'));

  // The pack — the user's five prompts, on the page.
  check('treblo: the pack lists five prompts', await page.evaluate(() =>
    document.querySelectorAll('[data-pack] li').length === 5),
    await page.evaluate(() => 'found ' + document.querySelectorAll('[data-pack] li').length));
  check('treblo: the pack names the flugelhorn piece', await page.evaluate(() =>
    /flugelhorn/i.test(document.querySelector('[data-pack]')?.textContent || '')));
  check('treblo: the pack names the Ethiopian pentatonic piece', await page.evaluate(() =>
    /Ethiopian pentatonic/i.test(document.querySelector('[data-pack]')?.textContent || '')));

  // The cost — the number that decides whether a run happens.
  check('treblo: the page states the cost of a generation', await page.evaluate(() =>
    /100 credits/i.test(document.body.innerText)));
  check('treblo: the page states the cost of the five', await page.evaluate(() =>
    /500 credits|five prompts cost 500/i.test(document.body.innerText)));

  // The key — outside the repo, always.
  check('treblo: the key guidance names the environment variable', await page.evaluate(() =>
    document.body.innerText.includes('TREBLO_API_KEY')));
  check('treblo: the key guidance names the home file', await page.evaluate(() =>
    document.body.innerText.includes('~/.treblo-api-key')));
  check('treblo: the page says the key never touches the repo', await page.evaluate(() =>
    /never (?:touches|enters|in) the repo/i.test(document.body.innerText)));

  // The two things that make a generation real: the poll and the download.
  check('treblo: the page shows the task flow', await page.evaluate(() =>
    /task_id/.test(document.body.innerText) && /song_paths/.test(document.body.innerText)));
  check('treblo: the page says the URLs expire', await page.evaluate(() =>
    /expire/i.test(document.body.innerText)));
  check('treblo: the page says the audio is downloaded', await page.evaluate(() =>
    /downloads the audio/i.test(document.body.innerText)));
  check('treblo: the page says instrumental takes no lyrics', await page.evaluate(() =>
    /instrumental: true/.test(document.body.innerText) && /no lyrics/i.test(document.body.innerText)));
  check('treblo: the page names the out-of-credits answer', await page.evaluate(() =>
    /402/.test(document.body.innerText) && /developers\/account/.test(document.body.innerText)));

  check('treblo: every code block has a copy button', await page.evaluate(() => {
    const blocks = document.querySelectorAll('.code').length;
    const btns = document.querySelectorAll('.code button[data-copy]').length;
    return { blocks, btns, ok: blocks > 0 && blocks === btns };
  }).then(r => r.ok), await page.evaluate(() => {
    const blocks = document.querySelectorAll('.code').length;
    const btns = document.querySelectorAll('.code button[data-copy]').length;
    return `blocks=${blocks} copyBtns=${btns}`;
  }));

  // A copy click must not throw, and the label must flip synchronously.
  check('treblo: a copy click flips the label and throws nothing', await page.evaluate(() => {
    const btn = document.querySelector('.code button[data-copy]');
    if (!btn) return false;
    btn.click();
    return btn.textContent.trim() === 'copied';
  }));

  await page.screenshot({ path: path.join(ARTIFACTS, 'treblo-light.png'), fullPage: true });
  console.log('wrote artifacts/treblo-light.png');

  // Theme: light → dark flips data-theme and persists on reload.
  await page.evaluate(() => document.querySelector('[data-theme-btn="dark"]').click());
  await new Promise(r => setTimeout(r, 250));
  check('treblo: the theme button flips data-theme to dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.screenshot({ path: path.join(ARTIFACTS, 'treblo-dark.png'), fullPage: true });
  console.log('wrote artifacts/treblo-dark.png');

  await page.reload({ waitUntil: 'networkidle0' });
  check('treblo: the theme persists on reload (localStorage treblo-theme)', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));

  // Internal-link resolution.
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && !/^(https?:|mailto:|tel:|#)/.test(h)));
  const dead = [];
  for (const h of new Set(hrefs)) {
    const url = new URL(h, page.url());
    if (url.origin !== new URL(TREBLO_URL).origin) continue;
    try {
      const resp = await fetch(url.toString(), { method: 'HEAD' });
      if (resp.status >= 400) dead.push(`${h} → ${resp.status}`);
    } catch {
      dead.push(`${h} → fetch failed`);
    }
  }
  check('treblo: no internal links 404', dead.length === 0, dead.slice(0, 4).join(' | ') || `${hrefs.length} internal href(s) checked`);

  // ------------------------------------------------------------------
  // Twin OS — data-tool-treblo link
  // ------------------------------------------------------------------
  const twinErrors = [];
  const twin = await browser.newPage();
  await twin.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  twin.on('pageerror', e => twinErrors.push('pageerror: ' + e.message));
  twin.on('console', m => {
    // Known pre-existing: twin-os fetches the songs catalogs (audio +
    // jazz-solos), both gitignored user-local, so they 404 on the
    // deployed site. Same filter as twin-os.spec.mjs.
    if (m.type() === 'error') {
      const url = m.location().url || '';
      const text = m.text();
      if (/catalog[^/]*\.json/.test(url) && text.includes('404')) return;
      twinErrors.push('console.error: ' + text + ' (' + url + ')');
    }
  });
  // A browser-initiated media abort is NOT a page error: Chrome
  // Range-fetches the twin's autoplay loops, then cancels the
  // continuation once it has buffered enough.
  twin.on('requestfailed', r => {
    const err = r.failure()?.errorText || '';
    const isMedia = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(r.url());
    if (isMedia && err === 'net::ERR_ABORTED') return;
    twinErrors.push('reqfail: ' + r.url() + ' ' + err);
  });
  await twin.goto(TWINOS_URL, { waitUntil: 'networkidle0', timeout: 20000 });

  const tool = await twin.evaluate(() => {
    const a = document.querySelector('.tool-grid a[data-tool-treblo]');
    if (!a) return null;
    return { href: a.getAttribute('href'), name: a.querySelector('.tool-name')?.textContent?.trim() };
  });
  check('twin-os: a[data-tool-treblo] exists', !!tool);
  check('twin-os: href ends with treblo.html', !!tool && tool.href.endsWith('treblo.html'), tool?.href || 'missing');
  check('twin-os: name is "Treblo"', !!tool && tool.name === 'Treblo', tool?.name || 'missing');
  await twin.screenshot({ path: path.join(ARTIFACTS, 'treblo-twinos.png'), fullPage: true });
  console.log('wrote artifacts/treblo-twinos.png');

  // ------------------------------------------------------------------
  // Console hygiene — 0 errors on both pages
  // ------------------------------------------------------------------
  check('treblo: 0 console errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  check('twin-os: 0 console errors', twinErrors.length === 0, twinErrors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all treblo checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
