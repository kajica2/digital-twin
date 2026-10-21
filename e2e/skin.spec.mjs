import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Skin contract spec — the re-theming promise, end to end.
//
// The claim under test: a page carries no palette of its own, and the
// whole family re-skins from one URL. Concretely, this spec proves
// that ?skin=studio really changes the rendered colours (not just the
// href), that the param beats the stored choice, that an unknown skin
// falls back instead of breaking the page, and that nothing throws.
//
// URL convention (single path in every mode):
//   deployed → ${BASE}/pages/landing.html
//   local    → ${BASE}/pages/landing.html   (server runs --directory .)
//
//   E2E_URL=https://kajica2.github.io/digital-twin node skin.spec.mjs
//   PORT=5180 node skin.spec.mjs
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const LANDING_URL = `${BASE}/pages/landing.html`;
const CT_URL = `${BASE}/pages/cognitive-twin.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}

/** Read a token's computed value off the document element. */
const readToken = (page, name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

/** A page with console/network error collection. */
async function freshPage(emulate) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  p.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  if (emulate) await p.emulateMediaFeatures(emulate);
  p.__errors = errors;
  return p;
}

async function go(p, url) {
  try {
    await p.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    return true;
  } catch (err) {
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: node lib/serve.js --port 5180');
    return false;
  }
}

try {
  // ------------------------------------------------------------------
  // 1. The default skin
  // ------------------------------------------------------------------
  const p = await freshPage([{ name: 'prefers-color-scheme', value: 'light' }]);
  if (!await go(p, LANDING_URL)) {
    for (const r of results) console.log(r);
    console.log('FAILED — 0 assertions could run');
    process.exit(1);
  }
  await p.evaluate(() => { localStorage.removeItem('dt-skin'); localStorage.setItem('dt-theme-pref', 'light'); });
  await p.reload({ waitUntil: 'networkidle0' });

  const houseSkin = await p.evaluate(() => document.documentElement.getAttribute('data-skin'));
  check('default skin is house', houseSkin === 'house', houseSkin || 'none');

  const houseHref = await p.evaluate(() => document.querySelector('link[data-skin-stylesheet]')?.getAttribute('href') || '');
  check('house stylesheet is linked', /house\.css$/.test(houseHref), houseHref);

  const houseBg = await readToken(p, '--bg');
  const housePrimary = await readToken(p, '--primary');
  check('house tokens resolve', houseBg === '#f7f5f0' && housePrimary === '#c97b3f', `--bg=${houseBg} --primary=${housePrimary}`);

  await p.screenshot({ path: path.join(ARTIFACTS, 'skin-house-light.png'), fullPage: false });

  // ------------------------------------------------------------------
  // 2. ?skin=studio actually re-colours the page
  // ------------------------------------------------------------------
  await p.goto(`${LANDING_URL}?skin=studio`, { waitUntil: 'networkidle0' });
  const studioSkin = await p.evaluate(() => document.documentElement.getAttribute('data-skin'));
  check('?skin=studio sets data-skin=studio', studioSkin === 'studio', studioSkin || 'none');

  const studioHref = await p.evaluate(() => document.querySelector('link[data-skin-stylesheet]')?.getAttribute('href') || '');
  check('stylesheet href swapped to studio.css', /studio\.css$/.test(studioHref), studioHref);

  const studioBg = await readToken(p, '--bg');
  const studioPrimary = await readToken(p, '--primary');
  check('studio tokens differ from house', studioBg !== houseBg && studioPrimary !== housePrimary,
    `house(${houseBg},${housePrimary}) studio(${studioBg},${studioPrimary})`);
  check('studio token values are the skin\'s', studioPrimary === '#fd429c', studioPrimary);

  // The page's own background must have followed the skin, not just the
  // custom property — that is the difference between "the href changed"
  // and "the page re-skinned".
  const bodyBg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('body background follows the skin', bodyBg !== 'rgb(247, 245, 240)', bodyBg);

  // The ?skin= param is stripped so the URL stays shareable-clean.
  const url = await p.evaluate(() => location.href);
  check('?skin= is stripped from the URL', !url.includes('skin='), url);

  await p.screenshot({ path: path.join(ARTIFACTS, 'skin-studio-light.png'), fullPage: false });

  // ------------------------------------------------------------------
  // 3. The param beats the stored choice
  // ------------------------------------------------------------------
  await p.evaluate(() => localStorage.setItem('dt-skin', 'house'));
  await p.goto(`${LANDING_URL}?skin=studio`, { waitUntil: 'networkidle0' });
  const paramWins = await p.evaluate(() => document.documentElement.getAttribute('data-skin'));
  check('?skin= beats the stored skin', paramWins === 'studio', paramWins || 'none');

  // ------------------------------------------------------------------
  // 4. The stored choice is used when there is no param
  // ------------------------------------------------------------------
  await p.evaluate(() => localStorage.setItem('dt-skin', 'studio'));
  await p.goto(LANDING_URL, { waitUntil: 'networkidle0' });
  const storedWins = await p.evaluate(() => document.documentElement.getAttribute('data-skin'));
  check('stored skin is used without a param', storedWins === 'studio', storedWins || 'none');

  // ------------------------------------------------------------------
  // 5. An unknown skin falls back instead of breaking the page
  // ------------------------------------------------------------------
  await p.evaluate(() => localStorage.removeItem('dt-skin'));
  await p.goto(`${LANDING_URL}?skin=nope-not-a-skin`, { waitUntil: 'networkidle0' });
  const fallbackHref = await p.evaluate(() => document.querySelector('link[data-skin-stylesheet]')?.getAttribute('href') || '');
  const fallbackBg = await readToken(p, '--bg');
  check('unknown skin falls back to house', /house\.css$/.test(fallbackHref) && fallbackBg === '#f7f5f0',
    `href=${fallbackHref} --bg=${fallbackBg}`);

  // ------------------------------------------------------------------
  // 6. Dark theme, both skins
  // ------------------------------------------------------------------
  await p.evaluate(() => localStorage.setItem('dt-theme-pref', 'dark'));
  await p.goto(LANDING_URL, { waitUntil: 'networkidle0' });
  const houseDarkBg = await readToken(p, '--bg');
  check('house dark scope applies', houseDarkBg === '#1a1812', houseDarkBg);

  await p.goto(`${LANDING_URL}?skin=studio`, { waitUntil: 'networkidle0' });
  const studioDarkBg = await readToken(p, '--bg');
  check('studio dark scope applies', studioDarkBg === '#000000', studioDarkBg);
  await p.screenshot({ path: path.join(ARTIFACTS, 'skin-studio-dark.png'), fullPage: false });

  // ------------------------------------------------------------------
  // 7. A second page, same contract
  // ------------------------------------------------------------------
  const p2 = await freshPage([{ name: 'prefers-color-scheme', value: 'light' }]);
  await go(p2, `${CT_URL}?skin=studio`);
  const ctSkin = await p2.evaluate(() => document.documentElement.getAttribute('data-skin'));
  const ctPrimary = await readToken(p2, '--primary');
  check('cognitive-twin re-skins too', ctSkin === 'studio' && ctPrimary === '#fd429c', `${ctSkin} ${ctPrimary}`);
  check('cognitive-twin: 0 console errors', p2.__errors.length === 0, p2.__errors.slice(0, 3).join(' | '));
  await p2.close();

  // ------------------------------------------------------------------
  // 8. Console hygiene on the landing page, all passes
  // ------------------------------------------------------------------
  check('landing: 0 console errors across every pass', p.__errors.length === 0, p.__errors.slice(0, 5).join(' | '));
  await p.close();
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all skin checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
