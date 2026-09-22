import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits the launchd-managed server on PORT (default 5173,
// serves from the repo root, so the page lives at /pages/...).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-icon.mjs
//   PORT=5180 node ct-icon.mjs                     # ad-hoc python server on pages/
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

// Case 1: light system, no stored → light mode, ◐ icon
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });
let state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
}));
console.log('light pref, fresh load →', state);

// Case 2: dark system, no stored → dark mode, ☀ icon
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });
state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
}));
console.log('dark pref, fresh load →', state);

// Case 3: stored=dark, light system → dark, ☀
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.evaluate(() => localStorage.setItem('theme', 'dark'));
await page.reload({ waitUntil: 'networkidle0' });
state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
}));
console.log('stored=dark, light pref →', state);

// Case 4: click toggle from dark→light, icon flips ◐
await page.click('#themeToggle');
await new Promise(r => setTimeout(r, 100));
state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
  stored: localStorage.getItem('theme'),
}));
console.log('click once (was dark) →', state);

// Case 5: click again light→dark, icon flips ☀
await page.click('#themeToggle');
await new Promise(r => setTimeout(r, 100));
state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
  stored: localStorage.getItem('theme'),
}));
console.log('click again →', state);

// Case 6: reload — icon + theme should persist from storage
await page.reload({ waitUntil: 'networkidle0' });
state = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  icon: document.getElementById('themeToggle').textContent,
}));
console.log('reload (dark stored) →', state);

console.log('errors:', errors);
await browser.close();
