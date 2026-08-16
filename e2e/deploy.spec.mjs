// Puppeteer smoke test for the deployed digital_twin site.
// Per the agent memory rule: any web/PWA deploy is NOT done until a
// Puppeteer test visits the deployed URL and verifies concrete
// requirements; loop fix/redeploy/retest until green.
//
// Run from the e2e/ directory:
//   node deploy.spec.mjs
//
// Exits 0 on pass, 1 on fail. The URL defaults to the aliased
// production URL; pass a different one as the first arg to override.

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = [
  'https://digitaltwin-ebon.vercel.app',
  'https://digitaltwin-pto3egiow-kai-djurics-projects.vercel.app',
];
const URL = process.argv[2] || DEFAULTS[0];

// Locate Chrome (same logic as landing.spec.mjs)
async function findChrome() {
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(sys)) return sys;
  const cache = process.env.HOME + '/.cache/puppeteer/chrome';
  if (existsSync(cache)) {
    const dirs = await readdir(cache);
    for (const d of dirs) {
      const exe = join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const log = (m, c = '\u001b[36m') => console.log(`${c}[deploy-e2e]${'\u001b[0m'} ${m}`);
const ok  = (m) => log(`✓ ${m}`, '\u001b[32m');
const bad = (m) => log(`✗ ${m}`, '\u001b[31m');
const dim = (m) => log(`  ${m}`, '\u001b[90m');

let failures = 0;
function assert(cond, msg) {
  if (cond) ok(msg);
  else { failures++; bad(msg); }
}

async function main() {
  log(`deploy check against ${URL}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: await findChrome() || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });
    page.on('requestfailed', r => failedRequests.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
    page.on('response', r => {
      if (r.status() >= 400) {
        failedRequests.push(`HTTP ${r.status()}: ${r.url()}`);
      }
    });

    // No networkidle0 — Vercel sometimes holds long-poll connections.
    // domcontentloaded is enough for an HTML page; we then wait for
    // the variant features to populate.
    const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert(resp && resp.status() === 200, `HTTP 200 from ${URL} (got ${resp ? resp.status() : 'no response'})`);

    // Wait for the variant features to populate
    await page.waitForFunction(() => {
      const g = document.querySelector('[data-variant-features]');
      return g && g.children.length === 6;
    }, { timeout: 15000 });

    // wait for fonts
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 400));

    // basic content
    const title = await page.title();
    assert(/digital_twin/i.test(title), `title contains "digital_twin" (got "${title}")`);

    const h1 = await page.$eval('.h-display', el => el.textContent.trim());
    assert(h1.length > 5, `h1 populated: "${h1.replace(/\s+/g, ' ').slice(0, 80)}…"`);

    // 6 feature cards (default variant)
    const fc = await page.$$eval('.feature-card', els => els.length);
    assert(fc === 6, `feature grid has 6 cards (got ${fc})`);

    // architecture levels
    const lv = await page.$$eval('.level', els => els.length);
    assert(lv === 4, `architecture has 4 levels (got ${lv})`);

    // domain twins
    const dt = await page.$$eval('.twin-card', els => els.length);
    assert(dt === 4, `domain twins: 4 cards (got ${dt})`);

    // demo mockup
    const panes = await page.$$eval('twin-demo .demo-pane', els => els.length);
    assert(panes === 4, `twin-demo has 4 panes (got ${panes})`);

    // copy-block
    const cb = await page.$('copy-block');
    const cbBtn = await page.$('copy-block .cb-btn');
    assert(!!cb, 'copy-block present in deploy');
    assert(!!cbBtn, 'copy-block button present in deploy');

    // copy button click works
    const beforeLabel = await page.$eval('copy-block .cb-btn span', el => el.textContent.trim());
    await page.click('copy-block .cb-btn');
    await new Promise(r => setTimeout(r, 200));
    const afterLabel = await page.$eval('copy-block .cb-btn span', el => el.textContent.trim());
    assert(beforeLabel === 'Copy' && (afterLabel === 'Copied' || afterLabel === 'Failed'),
      `copy button transitions on deploy: "${beforeLabel}" → "${afterLabel}"`);
    await new Promise(r => setTimeout(r, 1700));

    // 0 console errors
    assert(consoleErrors.length === 0,
      `0 console errors on deploy (got ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''})`);
    // also log any failed requests so we can see 4xx URLs
    if (failedRequests.length) {
      dim(`failed requests on deploy:`);
      failedRequests.forEach(r => dim(`  ${r}`));
    }

    // variant switcher roundtrip
    await page.click('variant-switcher button[data-value="2"]');
    await new Promise(r => setTimeout(r, 200));
    const dv2 = await page.$eval('html', el => el.getAttribute('data-variant'));
    assert(dv2 === '2', `variant switcher click v2 works on deploy (data-variant="${dv2}")`);
    const url2 = page.url();
    assert(url2.includes('v=2'), `URL updated to include v=2: ${url2}`);

    // theme toggle works
    await page.evaluate(() => {
      const t = document.querySelector('theme-toggle button[data-value="dark"]');
      t.click();
    });
    await new Promise(r => setTimeout(r, 200));
    const t2 = await page.$eval('html', el => el.getAttribute('data-theme'));
    assert(t2 === 'dark', `theme toggle switches to dark on deploy (data-theme="${t2}")`);

    // screenshot for the record
    const ART = join(__dirname, 'artifacts');
    if (!existsSync(ART)) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(ART, { recursive: true });
    }
    // reset to light for the screenshot
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.setAttribute('data-theme-pref', 'light');
      // also reset variant
      document.querySelector('variant-switcher button[data-value="1"]').click();
    });
    await new Promise(r => setTimeout(r, 250));
    // force reveals
    await page.evaluate(() => {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    });
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: join(ART, 'deploy-live.png'), fullPage: true });
    dim(`saved ${join(ART, 'deploy-live.png')}`);

    log('');
    if (failures === 0) {
      ok(`DEPLOY VERIFIED — ${URL} passes all checks`);
    } else {
      bad(`${failures} CHECK(S) FAILED on deploy`);
    }
  } finally {
    await browser.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
