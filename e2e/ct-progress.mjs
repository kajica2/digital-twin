import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits the launchd-managed server on PORT (default 5173,
// serves from the repo root, so the page lives at /pages/...).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-progress.mjs
//   PORT=5180 node ct-progress.mjs                 # ad-hoc python server on pages/
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5173';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const URL = `${BASE}${DEPLOYED_URL ? '/pages/cognitive-twin.html' : '/cognitive-twin.html'}`;

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });

// At top: width should be ~0
let w = await page.evaluate(() => document.getElementById('progressBar').style.width);
console.log('at top → progressBar.style.width:', JSON.stringify(w));

// Scroll halfway
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
await new Promise(r => setTimeout(r, 200));
w = await page.evaluate(() => document.getElementById('progressBar').style.width);
console.log('mid scroll → progressBar.style.width:', JSON.stringify(w));

// Scroll to bottom: width should be ~100%
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await new Promise(r => setTimeout(r, 200));
w = await page.evaluate(() => document.getElementById('progressBar').style.width);
console.log('at bottom → progressBar.style.width:', JSON.stringify(w));

console.log('errors:', errors);
await browser.close();
