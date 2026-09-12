import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const URL = process.env.URL || 'http://127.0.0.1:5180/cognitive-twin.html';

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
