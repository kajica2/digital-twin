import puppeteer from 'puppeteer';

// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits the launchd-managed server on PORT (default 5173,
// serves from the repo root, so the page lives at /pages/...).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-verify.mjs
//   PORT=5180 node ct-verify.mjs                   # ad-hoc python server on pages/
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5173';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const URL = `${BASE}${DEPLOYED_URL ? '/pages/cognitive-twin.html' : '/cognitive-twin.html'}`;

const errors = [];

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
  });
  page.on('requestfailed', req => errors.push('reqfail: ' + req.url() + ' ' + req.failure()?.errorText));

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

  // LIGHT
  await page.screenshot({ path: '/tmp/ct_light.png', fullPage: true });

  // exercise: layer toggle
  await page.evaluate(() => showLayer('reasoner'));
  await new Promise(r => setTimeout(r, 250));
  const layerVisible = await page.evaluate(() => document.getElementById('layer-reasoner').classList.contains('visible'));
  console.log('layer-reasoner visible:', layerVisible);

  // exercise: twin tab switch
  await page.evaluate(() => showTwin('web'));
  await new Promise(r => setTimeout(r, 250));
  const twinActive = await page.evaluate(() => document.querySelector('.twin-content.active')?.id);
  console.log('active twin:', twinActive);

  // exercise: scanner demo
  await page.evaluate(() => document.getElementById('runScanner').click());
  await new Promise(r => setTimeout(r, 250));
  const demoVisible = await page.evaluate(() => document.getElementById('scannerOutput').classList.contains('visible'));
  console.log('scanner demo visible:', demoVisible);

  // exercise: theme toggle
  await page.evaluate(() => document.getElementById('themeToggle').click());
  await new Promise(r => setTimeout(r, 250));
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('theme after toggle:', theme);
  await page.screenshot({ path: '/tmp/ct_dark.png', fullPage: true });

  // contract checks
  const checks = await page.evaluate(() => {
    const requiredIds = ['scan','architecture','processes','instances','toolchain'];
    const found = requiredIds.map(id => !!document.getElementById(id));
    const twins = ['twin-music','twin-transcription','twin-web','twin-research','twin-agent-loop'].map(id => !!document.getElementById(id));
    const layers = ['layer-scanner','layer-model','layer-reasoner','layer-orchestrator'].map(id => !!document.getElementById(id));
    const archNodes = document.querySelectorAll('.arch-node').length;
    const processItems = document.querySelectorAll('.process-item').length;
    const domainCards = document.querySelectorAll('.domain-card').length;
    const toolItems = document.querySelectorAll('.tool-item').length;
    return { found, twins, layers, archNodes, processItems, domainCards, toolItems };
  });
  console.log('checks:', JSON.stringify(checks));

  console.log('errors:', JSON.stringify(errors, null, 2));
  console.log('OK');
} finally {
  await browser.close();
}
