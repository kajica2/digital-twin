import puppeteer from 'puppeteer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Config
const BASE = process.env.E2E_URL || 'http://127.0.0.1:5180';
const PORT = parseInt(process.env.PORT || '5180', 10);
const ARTIFACTS = join(__dirname, 'artifacts');

// Resolve URL: local server serves repo root, deployed serves from /pages/
const DEPLOYED_URL = BASE && !BASE.includes('127.0.0.1') && !BASE.includes('localhost');
const PAGE_PATH = DEPLOYED_URL ? '/pages/integrations.html' : '/pages/integrations.html';
const pageUrl = `${BASE}${PAGE_PATH}`;

const errors = [];

async function capture(msg, fn) {
  try {
    await fn();
    console.log(`  ✓ ${msg}`);
  } catch (e) {
    console.log(`  ✗ ${msg}: ${e.message}`);
    errors.push(e.message);
  }
}

// Wait helper (page.waitForTimeout is deprecated)
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('\n=== integrations.spec.mjs ===\n');

  // Find Chrome
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.CHROME_PATH
  ].filter(Boolean);

  let browser;
  for (const p of chromePaths) {
    try {
      browser = await puppeteer.launch({
        executablePath: p,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      break;
    } catch {}
  }
  if (!browser) browser = await puppeteer.launch({ headless: 'new' });

  // Theme test: light
  console.log('Testing light theme...');
  const page = await browser.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`[light] ${msg.text()}`);
  });
  page.on('pageerror', e => errors.push(`[light:pageerror] ${e.message}`));

  await page.goto(pageUrl, { waitUntil: 'networkidle0' });

  // Theme toggle
  await capture('theme toggle exists', async () => {
    const btns = await page.$$('.theme-btn');
    if (btns.length !== 3) throw new Error(`Expected 3 theme buttons, got ${btns.length}`);
  });

  await capture('click dark theme', async () => {
    await page.click('[data-theme="dark"]');
    await wait(200);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'dark') throw new Error(`Expected dark, got ${theme}`);
  });

  await capture('dark persists on reload', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'dark') throw new Error(`Expected dark, got ${theme}`);
  });

  // Structure
  await capture('logo exists', async () => {
    const svg = await page.$('.logo svg');
    if (!svg) throw new Error('Logo SVG not found');
  });

  await capture('success heading', async () => {
    const h1 = await page.evaluate(() => document.querySelector('h1').textContent);
    if (!h1.includes("You're all set")) throw new Error(`Unexpected h1: ${h1}`);
  });

  await capture('server running checkmark', async () => {
    const text = await page.evaluate(() => document.querySelector('.checkmark-list').textContent);
    if (!text.includes('Server running')) throw new Error('Missing Server running');
  });

  await capture('twin os ready checkmark', async () => {
    const text = await page.evaluate(() => document.querySelector('.checkmark-list').textContent);
    if (!text.includes('Twin OS ready')) throw new Error('Missing Twin OS ready');
  });

  await capture('credentials section heading', async () => {
    const h2 = await page.evaluate(() => document.querySelector('.credentials-section h2').textContent);
    if (!h2.includes('Connect your tools')) throw new Error(`Unexpected h2: ${h2}`);
  });

  await capture('three credential cards', async () => {
    const cards = await page.$$('.credential-card');
    if (cards.length !== 3) throw new Error(`Expected 3 cards, got ${cards.length}`);
  });

  await capture('midjourney card', async () => {
    const title = await page.evaluate(() => document.querySelector('[data-credential="midjourney"] .credential-title').textContent);
    if (!title.includes('Midjourney')) throw new Error('Missing Midjourney');
  });

  await capture('instagram card', async () => {
    const title = await page.evaluate(() => document.querySelector('[data-credential="instagram"] .credential-title').textContent);
    if (!title.includes('Instagram')) throw new Error('Missing Instagram');
  });

  await capture('youtube card', async () => {
    const title = await page.evaluate(() => document.querySelector('[data-credential="youtube"] .credential-title').textContent);
    if (!title.includes('YouTube')) throw new Error('Missing YouTube');
  });

  // Footer
  await capture('footer links', async () => {
    const links = await page.$$eval('.footer-links a', els => els.map(a => a.href));
    if (!links.some(l => l.includes('landing'))) throw new Error('Missing Home link');
    if (!links.some(l => l.includes('twin-os'))) throw new Error('Missing Twin OS link');
    if (!links.some(l => l.includes('how-to'))) throw new Error('Missing Docs link');
  });

  // Save screenshot
  await page.screenshot({ path: join(ARTIFACTS, 'integrations-dark.png'), fullPage: true });
  console.log('  📸 artifacts/integrations-dark.png');

  await browser.close();

  // Summary
  console.log(`\n=== Results: ${errors.length} errors ===\n`);
  if (errors.length > 0) {
    errors.forEach(e => console.log(`  - ${e}`));
    process.exit(1);
  }
  console.log('All checks passed.\n');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
