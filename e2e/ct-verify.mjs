import puppeteer from 'puppeteer';

// Cognitive-twin contract spec.
//
// E2E_URL — when set, runs against the deployed GitHub Pages site.
// Otherwise hits a local server: the launchd-managed server at repo root
// (PORT default 5173) or an ad-hoc one, e.g.
//   python3 -m http.server 5180 --directory .   # PORT=5180
// Both serve the repo root, so the page lives at /pages/cognitive-twin.html
// in every mode (production, launchd dev, CI PR-mode server).
//   E2E_URL=https://kajica2.github.io/digital-twin node ct-verify.mjs
//   PORT=5180 node ct-verify.mjs                   # ad-hoc repo-root server
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5173';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
// /pages/cognitive-twin.html on the deployed Pages site and on the launchd dev
// server alike — both serve the repo root. CI's PR-mode server must too.
const PAGE_URL = `${BASE}/pages/cognitive-twin.html`;

const errors = [];
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}

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

  try {
    await page.goto(PAGE_URL, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch (err) {
    console.log('⚠ server unreachable: ' + err.message);
    console.log('start a server first: python3 -m http.server 5180 --directory .');
    for (const r of results) console.log(r);
    console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
    process.exit(1);
  }

  // LIGHT
  await page.screenshot({ path: '/tmp/ct_light.png', fullPage: true });

  // exercise: layer toggle
  await page.evaluate(() => showLayer('reasoner'));
  await new Promise(r => setTimeout(r, 250));
  const layerVisible = await page.evaluate(() => document.getElementById('layer-reasoner').classList.contains('visible'));
  check('ct: layer toggle shows reasoner', layerVisible);

  // exercise: twin tab switch
  await page.evaluate(() => showTwin('web'));
  await new Promise(r => setTimeout(r, 250));
  const twinActive = await page.evaluate(() => document.querySelector('.twin-content.active')?.id);
  check('ct: twin tab switches to web', twinActive === 'twin-web', twinActive || 'no active twin');

  // exercise: scanner demo
  await page.evaluate(() => document.getElementById('runScanner').click());
  await new Promise(r => setTimeout(r, 250));
  const demoVisible = await page.evaluate(() => document.getElementById('scannerOutput').classList.contains('visible'));
  check('ct: scanner demo runs', demoVisible);

  // exercise: theme toggle
  await page.evaluate(() => document.getElementById('themeToggle').click());
  await new Promise(r => setTimeout(r, 250));
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('ct: theme toggle yields valid data-theme', theme === 'light' || theme === 'dark', theme || 'none');
  await page.screenshot({ path: '/tmp/ct_dark.png', fullPage: true });

  // contract checks (page structure)
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
  check('ct: all required sections present', checks.found.every(Boolean),
    requiredDetail(checks.found, ['scan','architecture','processes','instances','toolchain']));
  check('ct: all 5 twin panels present', checks.twins.every(Boolean),
    requiredDetail(checks.twins, ['twin-music','twin-transcription','twin-web','twin-research','twin-agent-loop']));
  check('ct: all 4 layers present', checks.layers.every(Boolean),
    requiredDetail(checks.layers, ['layer-scanner','layer-model','layer-reasoner','layer-orchestrator']));
  check('ct: 4 architecture nodes', checks.archNodes === 4, 'found ' + checks.archNodes);
  check('ct: 4 running processes', checks.processItems === 4, 'found ' + checks.processItems);
  check('ct: 6 domain twins', checks.domainCards === 6, 'found ' + checks.domainCards);
  check('ct: 12 toolchain items', checks.toolItems === 12, 'found ' + checks.toolItems);

  // Agent-loop dashboard iframe: must resolve to a real served page (no 404).
  const iframeSrc = await page.evaluate(() =>
    document.querySelector('iframe[title="Agent Loop Dashboard"]')?.getAttribute('src'));
  check('ct: agent-loop iframe present', !!iframeSrc, iframeSrc || 'missing');
  if (iframeSrc) {
    const resolved = new URL(iframeSrc, page.url());
    let status = 'fetch failed';
    try {
      const resp = await fetch(resolved.toString(), { method: 'HEAD' });
      status = String(resp.status);
    } catch { /* status stays 'fetch failed' */ }
    check('ct: agent-loop dashboard resolves (no 404)', status.startsWith('2'),
      `${resolved.pathname} → ${status}`);
    check('ct: dashboard src is a served non-dot path', !iframeSrc.includes('.agent/'),
      resolved.toString());
  }

  // Console hygiene — this is the regression gate that used to be print-only.
  check('ct: 0 console errors', errors.length === 0, errors.slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all ct-verify checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

function requiredDetail(mask, names) {
  return names.filter((_, i) => !mask[i]).join(', ') || 'all present';
}