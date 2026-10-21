#!/usr/bin/env node
'use strict';
// e2e/floating-toolset.spec.mjs
//
// Contract for the floating toolset: the component (lib/floating-toolset.js)
// and the page that hosts it (pages/floating-toolset.html).
//
// The component lives in a shadow root, so the spec reaches into it with
// page.evaluate rather than with a CSS selector.
//
// Mirrors the repo-root URL convention of the other tool specs:
//   PORT=5180 node floating-toolset.spec.mjs   # after node lib/serve.js --port 5180

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/floating-toolset.html`;
const ARTIFACTS = path.join(process.cwd(), 'artifacts');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch { console.error('puppeteer missing: cd e2e && npm install'); process.exit(1); }

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (ok) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// The component lives in a shadow root, so each evaluate() body re-derives
// the root itself (puppeteer cannot serialize a function argument).

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    console.error('could not launch Chrome: ' + e.message);
    process.exit(1);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); process.exit(1); }

  // ---- the page ----------------------------------------------------------

  check('page: hero h1 names the tool', await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent || '';
    return /panel/i.test(h1) && /floating/i.test(h1);
  }));

  check('page: the component is defined and mounted', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    return !!customElements.get('floating-toolset') && !!el && !!el.shadowRoot;
  }));

  check('page: the panel loads the shipped payload', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    return el?.data?.panels?.today?.items?.length === 3;
  }));

  check('page: the payload file itself is served', await page.evaluate(async () => {
    const r = await fetch('/data/twin/toolset.json');
    if (!r.ok) return false;
    const j = await r.json();
    return j.panels.nowPlaying.title === 'Coltrane — Naima';
  }));

  // ---- the panel's structure --------------------------------------------

  const structure = await page.evaluate(() => {
    const root = document.querySelector('floating-toolset').shadowRoot;
    return {
      panels: root.querySelectorAll('.card').length,
      names: Array.from(root.querySelectorAll('.card')).map(c => c.getAttribute('data-panel')),
      title: root.querySelector('.bar-title')?.textContent,
      live: !!root.querySelector('.live:not([hidden])'),
      lights: root.querySelectorAll('.light').length,
      todayRows: root.querySelectorAll('[data-panel="today"] .row').length,
      waveBars: root.querySelectorAll('[data-panel="now-playing"] .wave span').length,
      codeRows: root.querySelectorAll('[data-panel="code"] .code-row').length,
      patternRows: root.querySelectorAll('[data-panel="patterns"] .pat').length,
      footerLeft: root.querySelector('.foot-left')?.textContent,
      footerRight: root.querySelector('.foot-right')?.textContent,
    };
  });

  check('panel: four cards, one per surface', structure.panels === 4,
    structure.names.join(','));
  check('panel: the cards are today / now playing / code / patterns',
    JSON.stringify(structure.names) === JSON.stringify(['today', 'now-playing', 'code', 'patterns']),
    structure.names.join(','));
  check('panel: chrome bar shows the twin title', /twin/.test(structure.title || ''),
    structure.title);
  check('panel: the live badge is showing', structure.live === true);
  check('panel: three window lights', structure.lights === 3, String(structure.lights));
  check('panel: three agenda rows', structure.todayRows === 3, String(structure.todayRows));
  check('panel: the equalizer has bars', structure.waveBars >= 20, String(structure.waveBars));
  check('panel: three code rows', structure.codeRows === 3, String(structure.codeRows));
  check('panel: three pattern rows', structure.patternRows === 3, String(structure.patternRows));
  check('panel: the footer carries the twin numbers and the locality',
    /agents running/.test(structure.footerLeft || '') && structure.footerRight === 'local',
    `${structure.footerLeft} | ${structure.footerRight}`);

  // ---- behaviour: open, collapse, zoom, close, drag ----------------------

  check('panel: the page opens it on demand', await page.evaluate(() => {
    document.querySelector('[data-act="toggle"]').click();
    const el = document.querySelector('floating-toolset');
    const win = el.shadowRoot.querySelector('.win');
    return getComputedStyle(win).display !== 'none' && win.getBoundingClientRect().height > 100;
  }));

  check('panel: collapse hides the body but keeps the chrome bar', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    document.querySelector('[data-act="collapse"]').click();
    const grid = el.shadowRoot.querySelector('.grid');
    const bar = el.shadowRoot.querySelector('.bar');
    const collapsed = grid.getBoundingClientRect().height === 0 && bar.getBoundingClientRect().height > 0;
    document.querySelector('[data-act="collapse"]').click();
    return collapsed;
  }));

  check('panel: zoom widens the panel', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    const before = el.shadowRoot.querySelector('.win').getBoundingClientRect().width;
    document.querySelector('[data-act="zoom"]').click();
    const after = el.shadowRoot.querySelector('.win').getBoundingClientRect().width;
    document.querySelector('[data-act="zoom"]').click();
    return after > before;
  }));

  check('panel: close hides the window and leaves a VISIBLE restore tab', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    document.querySelector('[data-act="toggle"]').click(); // close
    const restore = el.shadowRoot.querySelector('.restore');
    const win = el.shadowRoot.querySelector('.win');
    // The window must be gone AND the restore tab must be genuinely
    // on screen (a non-zero box), not merely un-hidden.
    const closed = getComputedStyle(win).display === 'none';
    const restoreVisible = !restore.hidden && restore.getBoundingClientRect().width > 0;
    restore.click();
    const reopened = getComputedStyle(win).display !== 'none' && restore.hidden;
    return closed && restoreVisible && reopened;
  }));

  check('panel: a re-render does not stack the click listeners', await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    // setData() re-renders. If the delegated click handler were attached
    // per render, the .win element (which survives a re-render) would
    // hold N listeners and one click would fire the action N times.
    el.setData({ title: '~/twin — online · local' });
    el.setData({ title: '~/twin — online · local' });
    el.setData({ title: '~/twin — online · local' });
    let closes = 0;
    el.addEventListener('toolset:close', () => { closes++; });
    el.shadowRoot.querySelector('.light.red').click();
    const restore = el.shadowRoot.querySelector('.restore');
    restore.click(); // put it back
    return closes === 1;
  }));

  const drag = await page.evaluate(() => {
    const el = document.querySelector('floating-toolset');
    const win = el.shadowRoot.querySelector('.win');
    const bar = el.shadowRoot.querySelector('.bar');
    const before = win.getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    // Drag LEFT and UP: the panel starts anchored to the right edge, so a
    // rightward drag would be stopped by the viewport clamp rather than by
    // the drag itself.
    const opts = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 1 });
    bar.dispatchEvent(new PointerEvent('pointerdown', opts(rect.left + 140, rect.top + 30)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(rect.left + 40, rect.top - 30)));
    window.dispatchEvent(new PointerEvent('pointerup', opts(rect.left + 40, rect.top - 30)));
    const after = win.getBoundingClientRect();
    return {
      dx: Math.round(after.left - before.left),
      dy: Math.round(after.top - before.top),
    };
  });
  check('panel: the chrome bar drags the panel', drag.dx === -100 && drag.dy === -60,
    `moved ${drag.dx}px / ${drag.dy}px`);

  check('panel: the dragged position is remembered', await page.evaluate(() => {
    const raw = localStorage.getItem('dt-floating-toolset-pos');
    if (!raw) return false;
    const saved = JSON.parse(raw);
    return typeof saved.x === 'number' && typeof saved.y === 'number';
  }));

  check('panel: the panel stays inside the viewport after a drag', await page.evaluate(() => {
    const win = document.querySelector('floating-toolset').shadowRoot.querySelector('.win');
    const r = win.getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 &&
      r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
  }));

  // ---- the page's own copy ----------------------------------------------

  check('page: the embed snippet is present and copyable', await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('pre code'));
    const hasSnippet = blocks.some(b => b.textContent.includes('floating-toolset.js')
      && b.textContent.includes('<floating-toolset'));
    const copyBtns = document.querySelectorAll('.copy-btn[data-copy]').length;
    return hasSnippet && copyBtns === blocks.length && copyBtns > 0;
  }));

  const copyBefore = errors.length;
  await page.click('.copy-btn[data-copy]');
  await new Promise(r => setTimeout(r, 250));
  check('page: copy click throws no errors', errors.length === copyBefore,
    errors.slice(copyBefore).join(' | '));

  // ---- theme -------------------------------------------------------------

  check('page: theme toggle flips to dark and persists', async () => {
    await page.evaluate(() => document.getElementById('themeToggle').click());
    await new Promise(r => setTimeout(r, 100));
    const dark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.reload({ waitUntil: 'networkidle2' });
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    return dark === 'dark' && after === 'dark';
  });

  // ---- console -----------------------------------------------------------

  check('page: 0 console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  // ---- screenshots -------------------------------------------------------
  // Reload first so the panel is back in its default corner: the drag test
  // above deliberately moved it, and its position is remembered.
  await page.evaluate(() => localStorage.removeItem('dt-floating-toolset-pos'));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.evaluate(() => document.querySelector('[data-act="toggle"]').click());
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(ARTIFACTS, 'floating-toolset.png') });

  await page.evaluate(() => document.getElementById('themeToggle').click());
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(ARTIFACTS, 'floating-toolset-dark.png') });

  await browser.close();

  console.log('');
  console.log(failed === 0 ? `OK — all ${results.length} checks passed` : `FAILED — ${failed} of ${results.length} checks failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
