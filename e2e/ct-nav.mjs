import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise serves the local `pages/` dir on PORT (default 5180).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-nav.mjs
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
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

const check = async (label, scrollY) => {
  await page.evaluate(y => window.scrollTo(0, y), scrollY);
  await new Promise(r => setTimeout(r, 200));
  const active = await page.evaluate(() => {
    const a = document.querySelector('.nav-link.active');
    return a ? a.getAttribute('href') : null;
  });
  console.log(`${label} (scrollY=${scrollY}) → active nav:`, active);
};

await check('top', 0);
await check('section 02 area', 1500);
await check('section 03 area', 3000);
await check('bottom', 999999);

console.log('errors:', errors);
await browser.close();
