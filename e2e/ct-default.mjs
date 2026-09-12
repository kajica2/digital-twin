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
