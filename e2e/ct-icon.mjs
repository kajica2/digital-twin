import puppeteer from 'puppeteer';
const URL = process.env.URL || 'http://127.0.0.1:5180/cognitive-twin.html';
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
