import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits the launchd-managed server on PORT (default 5173,
// serves from the repo root, so the page lives at /pages/...).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-theme.mjs
//   PORT=5180 node ct-theme.mjs                    # ad-hoc python server on pages/
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

// Light system pref, no stored theme → should stay light
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });
const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('light system pref, no stored theme → data-theme:', JSON.stringify(lightTheme));

// Dark system pref, no stored theme → should auto-dark
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });
const darkTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('dark system pref, no stored theme → data-theme:', JSON.stringify(darkTheme));

// Stored theme wins
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.evaluate(() => localStorage.setItem('theme', 'dark'));
await page.reload({ waitUntil: 'networkidle0' });
const storedWins = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('light system pref, stored=dark → data-theme:', JSON.stringify(storedWins));

// And stored=light on dark system
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.evaluate(() => localStorage.setItem('theme', 'light'));
await page.reload({ waitUntil: 'networkidle0' });
const storedLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('dark system pref, stored=light → data-theme:', JSON.stringify(storedLight));

await browser.close();
