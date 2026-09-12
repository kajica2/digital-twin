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
