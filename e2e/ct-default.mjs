import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits the launchd-managed server on PORT (default 5173,
// serves from the repo root, so the page lives at /pages/...).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-default.mjs
//   PORT=5180 node ct-default.mjs                   # ad-hoc python server on pages/
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

const onLoad = await page.evaluate(() => {
  const visible = document.querySelector('.layer-details.visible')?.id;
  const activeNode = document.querySelector('.arch-node.active')?.dataset.layer;
  return { visible, activeNode };
});
console.log('on load → visible layer:', onLoad.visible, '| active arch-node:', onLoad.activeNode);

// Click another arch-node, then verify scanner is hidden
await page.evaluate(() => showLayer('orchestrator'));
await new Promise(r => setTimeout(r, 200));
const afterClick = await page.evaluate(() => {
  const visible = document.querySelector('.layer-details.visible')?.id;
  const activeNode = document.querySelector('.arch-node.active')?.dataset.layer;
  return { visible, activeNode };
});
console.log('after showLayer(orchestrator) → visible layer:', afterClick.visible, '| active arch-node:', afterClick.activeNode);

console.log('errors:', errors);
await browser.close();
