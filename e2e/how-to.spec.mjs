import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// How-to page — user-guide contract spec.
//
// URL convention (single path in every mode):
//   deployed → ${BASE}/pages/how-to.html   (site root = repo root)
//   local    → ${BASE}/pages/how-to.html   (server runs --directory .)
//
//   E2E_URL=https://kajica2.github.io/digital-twin node how-to.spec.mjs
//   PORT=5180 node how-to.spec.mjs         # python3 -m http.server 5180 --directory .
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const HOWTO_URL = `${BASE}/pages/how-to.html`;

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

const SECTIONS = ['quickstart', 'twin-os', 'clip', 'refael', 'charts', 'songs', 'testing', 'launchagents', 'troubleshooting'];
const NAV_LINKS = ['#quickstart', '#twin-os', '#clip', '#refael', '#charts', '#songs', '#testing', '#launchagents', '#troubleshooting'];

try {
  // ------------------------------------------------------------------
  // Light pass — contract assertions
  // ------------------------------------------------------------------
  const lightErrors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => lightErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') lightErrors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => lightErrors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  try {
    await page.goto(HOWTO_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  } catch (err) {
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a static server first: python3 -m http.server 5180 --directory .');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  // title + hero
  const title = await page.title();
  check('title mentions How To', /how to/i.test(title), title);
  const h1 = await page.evaluate(() => document.querySelector('h1')?.innerText || '');
  check('hero h1 present', /how to run/i.test(h1), h1.slice(0, 60));

  // nav + sections
  const navHrefs = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-link')).map(a => a.getAttribute('href')));
  check('nav has 9 section links', navHrefs.length === 9, 'found ' + navHrefs.length);
  check('nav links match expected set', NAV_LINKS.every(h => navHrefs.includes(h)) && navHrefs.every(h => NAV_LINKS.includes(h)));

  const sections = await page.evaluate(() => Array.from(document.querySelectorAll('section[id]')).map(s => s.id));
  check('all 9 sections present', SECTIONS.every(id => sections.includes(id)), sections.join(', '));

  // code blocks + copy buttons
  const codeCount = await page.evaluate(() => document.querySelectorAll('.code-block').length);
  check('code blocks ≥ 6 (real commands)', codeCount >= 6, 'found ' + codeCount);
  const copyBtn = await page.evaluate(() => document.querySelectorAll('.copy-btn[data-copy]').length);
  check('copy buttons on every code block', copyBtn === codeCount, copyBtn + ' vs ' + codeCount);

  // copy interaction must not throw
  const copyBefore = lightErrors.length;
  await page.click('.copy-btn[data-copy]');
  await new Promise(r => setTimeout(r, 400));
  const copyAfter = lightErrors.length;
  check('copy click throws no errors', copyAfter === copyBefore, lightErrors.slice(copyBefore).join(' | '));

  // theme toggle flips + persists
  await page.click('#themeToggle');
  await new Promise(r => setTimeout(r, 150));
  const themeDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('theme toggle → dark', themeDark === 'dark', themeDark || 'none');

  await page.evaluate(() => localStorage.setItem('ht-theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle0' });
  const themeAfterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('theme persists on reload (ht-theme)', themeAfterReload === 'dark', themeAfterReload || 'none');

  // internal links resolve (footer + inline cross-page references, no 404s)
  const internalHrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const h = a.getAttribute('href');
      if (h && !h.startsWith('#') && !/^(https?:)?\/\//.test(h) && !h.startsWith('mailto:')) out.push(h);
    });
    return out;
  });
  check('cross-page links exist (cognitive-twin + twin-os)', internalHrefs.some(h => h.includes('cognitive-twin.html')) && internalHrefs.some(h => h.includes('twin-os')), internalHrefs.join(', '));
  for (const h of internalHrefs) {
    const resolved = new URL(h, page.url());
    let status = 'fetch-fail';
    try {
      const resp = await fetch(resolved.toString(), { method: 'HEAD' });
      status = String(resp.status);
    } catch { /* status stays fetch-fail */ }
    check(`internal link resolves: ${h}`, status.startsWith('2'), `${resolved.pathname} → ${status}`);
  }

  // dark screenshot + console hygiene
  await page.screenshot({ path: path.join(ARTIFACTS, 'howto-dark.png'), fullPage: true });
  check('0 console errors (light + dark passes)', lightErrors.length === 0, lightErrors.slice(0, 4).join(' | '));

  await page.close();

  // ------------------------------------------------------------------
  // Fresh light pass — screenshots + hygiene
  // ------------------------------------------------------------------
  const light2 = await browser.newPage();
  await light2.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const light2Errors = [];
  light2.on('pageerror', e => light2Errors.push('pageerror: ' + e.message));
  light2.on('console', m => { if (m.type() === 'error') light2Errors.push('console.error: ' + m.text()); });
  light2.on('requestfailed', r => light2Errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  await light2.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await light2.goto(HOWTO_URL, { waitUntil: 'networkidle0', timeout: 20000 });
  await light2.evaluate(() => localStorage.removeItem('ht-theme'));
  await light2.reload({ waitUntil: 'networkidle0' });
  const lightTheme = await light2.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('fresh light pass renders in light', lightTheme === 'light', lightTheme || 'none');
  await light2.screenshot({ path: path.join(ARTIFACTS, 'howto-light.png'), fullPage: true });
  check('0 console errors (fresh light pass)', light2Errors.length === 0, light2Errors.slice(0, 4).join(' | '));
  await light2.close();
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all how-to checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);