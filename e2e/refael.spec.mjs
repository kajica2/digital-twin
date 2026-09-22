import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refael MP4 Maker port — page contract spec.
//
// URL convention (same as clip-interrogator.spec.mjs):
//   deployed → ${BASE}/pages/refael-mp4-maker.html  (site root = repo root)
//   local    → ${BASE}/refael-mp4-maker.html        (server runs --directory pages)
//   twin-os  → ${BASE}/pages/twin-os/index.html deployed / ${BASE}/twin-os/index.html local
//
//   E2E_URL=https://kajica2.github.io/digital-twin node refael.spec.mjs
//   PORT=5180 node refael.spec.mjs     # python3 -m http.server 5180 --directory pages
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const REFAEL_URL = `${BASE}${DEPLOYED_URL ? '/pages/refael-mp4-maker.html' : '/refael-mp4-maker.html'}`;
const TWINOS_URL = `${BASE}${DEPLOYED_URL ? '/pages/twin-os/index.html' : '/twin-os/index.html'}`;

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
  // Refael page — contract assertions (dark-only design)
  // ------------------------------------------------------------------
  const refErrors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => refErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') refErrors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => refErrors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  try {
    await page.goto(REFAEL_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  } catch (err) {
    // Down-server ergonomics: give the fix hint, dump checks so far, exit 1.
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: python3 -m http.server 5180 --directory pages');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  check('refael: title mentions MP3 → MP4', await page.evaluate(() =>
    (document.title || '').includes('MP3 → MP4')));
  check('refael: h1 mentions Refael + offline subtitle', await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent || '';
    return h1.includes('Refael') && h1.includes('MP3 → MP4');
  }), await page.evaluate(() => (document.querySelector('h1')?.textContent || '').trim().slice(0, 60)));
  check('refael: offline badge present', await page.evaluate(() =>
    !!document.querySelector('#offline-badge')));
  check('refael: tablist has 3 tabs (single/custom/batch)', await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'));
    return tabs.length === 3 && tabs[0].classList.contains('active') &&
      tabs.map(t => t.getAttribute('data-tab')).join(',') === 'single,custom,batch';
  }), await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map(t => t.getAttribute('data-tab')).join(',')));
  check('refael: 3 render engines (fast/ffmpeg/realtime)', await page.evaluate(() => {
    const segs = Array.from(document.querySelectorAll('#speed-seg .seg-btn'));
    return segs.length === 3 && segs[0].getAttribute('aria-checked') === 'true' &&
      segs.map(s => s.getAttribute('data-speed')).join(',') === 'fast,ffmpeg,realtime';
  }), await page.evaluate(() =>
    Array.from(document.querySelectorAll('#speed-seg .seg-btn')).map(s => s.getAttribute('data-speed')).join(',')));
  check('refael: engine pill + hint present', await page.evaluate(() =>
    !!document.querySelector('#engine-pill') && !!document.querySelector('#engine-hint')));
  check('refael: single tab is visible first', await page.evaluate(() =>
    !!document.querySelector('[data-panel="single"]') && !document.querySelector('[data-panel="single"]').classList.contains('hidden')));
  check('refael: single-tab render disabled until input', await page.evaluate(() => {
    const btn = document.querySelector('#s-render');
    return !!btn && btn.disabled === true;
  }));
  check('refael: single preview canvas is 1920×1080', await page.evaluate(() => {
    const c = document.querySelector('#s-previewCanvas');
    return !!c && c.width === 1920 && c.height === 1080;
  }));
  check('refael: custom tab has image + audio drops', await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="custom"]');
    return !!panel && !!panel.querySelector('#c-image-input') && !!panel.querySelector('#c-audio-input') &&
      !!panel.querySelector('#c-render') && panel.querySelector('#c-render').disabled === true;
  }));
  check('refael: batch tab has progress bar', await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="batch"]');
    return !!panel && !!panel.querySelector('#b-progress');
  }));
  check('refael: output info row declares H.264 · AAC', await page.evaluate(() =>
    (document.querySelector('#out-info')?.textContent || '').includes('H.264') &&
    (document.querySelector('#out-info')?.textContent || '').includes('AAC')));
  check('refael: footer claims offline · 0 network calls', await page.evaluate(() =>
    document.body.innerText.includes('0 network calls')));
  check('refael: ffmpeg one-liner details block', await page.evaluate(() => {
    const d = document.querySelector('.footer details');
    return !!d && !!d.querySelector('summary') && !!d.querySelector('pre');
  }));
  check('refael: hidden render canvas exists', await page.evaluate(() => {
    const c = document.querySelector('#renderCanvas');
    return !!c && c.width === 1920 && c.height === 1080;
  }));

  // Interactive contract: the random-name generator is local JS, no network.
  // Clicking it must fill the track-name input with a non-empty value.
  await page.evaluate(() => document.querySelector('#s-gen-name').click());
  await new Promise(r => setTimeout(r, 150));
  const genTitle = await page.evaluate(() => document.querySelector('#s-title').value);
  check('refael: 🎲 random fills track name', typeof genTitle === 'string' && genTitle.trim().length > 0,
    genTitle ? `"${genTitle}"` : 'empty');

  await page.screenshot({ path: path.join(ARTIFACTS, 'refael-dark.png'), fullPage: true });
  console.log('wrote artifacts/refael-dark.png');

  // Internal-link resolution: every relative href on the Refael page must not
  // 404 against the same base. The page is single-file, so this is expected to
  // be an empty set — a regression guard if links get added later.
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && !/^(https?:|mailto:|tel:|#)/.test(h)));
  const dead = [];
  for (const h of new Set(hrefs)) {
    const url = new URL(h, page.url());
    if (url.origin !== new URL(REFAEL_URL).origin) continue;
    try {
      const resp = await fetch(url.toString(), { method: 'HEAD' });
      if (resp.status >= 400) dead.push(`${h} → ${resp.status}`);
    } catch {
      dead.push(`${h} → fetch failed`);
    }
  }
  check('refael: no internal links 404', dead.length === 0, dead.slice(0, 4).join(' | ') || `${hrefs.length} internal href(s) checked`);

  // ------------------------------------------------------------------
  // Twin OS — data-tool-refael link
  // ------------------------------------------------------------------
  const twinErrors = [];
  const twin = await browser.newPage();
  await twin.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  twin.on('pageerror', e => twinErrors.push('pageerror: ' + e.message));
  twin.on('console', m => {
    // Known pre-existing: twin-os fetches ../../data/songs/catalog.json, which
    // 404s under --directory pages (catalog is gitignored user-local). Mirror
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
    const a = document.querySelector('.tool-grid a[data-tool-refael]');
    if (!a) return null;
    return { href: a.getAttribute('href'), name: a.querySelector('.tool-name')?.textContent?.trim() };
  });
  check('twin-os: a[data-tool-refael] exists', !!tool);
  check('twin-os: href ends with refael-mp4-maker.html', !!tool && tool.href.endsWith('refael-mp4-maker.html'), tool?.href || 'missing');
  check('twin-os: name is "Refael MP4 Maker"', !!tool && tool.name === 'Refael MP4 Maker', tool?.name || 'missing');
  await twin.screenshot({ path: path.join(ARTIFACTS, 'refael-twinos.png'), fullPage: true });
  console.log('wrote artifacts/refael-twinos.png');

  // ------------------------------------------------------------------
  // Console hygiene — 0 errors on both pages
  // ------------------------------------------------------------------
  check('refael: 0 console errors', refErrors.length === 0, refErrors.slice(0, 4).join(' | '));
  check('twin-os: 0 console errors', twinErrors.length === 0, twinErrors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all refael checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);