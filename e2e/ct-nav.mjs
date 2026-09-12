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
