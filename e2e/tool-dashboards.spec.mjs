#!/usr/bin/env node
'use strict';
// e2e/tool-dashboards.spec.mjs
//
// Contract for the tool-dashboard component (lib/tool-dashboard.js)
// and the host page (pages/tool-dashboards.html).
//
// The component lives in a shadow root, so the spec reaches into it with
// page.evaluate rather than with a CSS selector.
//
// Mirrors the repo-root URL convention of the other tool specs:
//   PORT=5180 node tool-dashboards.spec.mjs   # after node lib/serve.js --port 5180

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/tool-dashboards.html`;
const CATALOG = `${BASE}/data/twin/tool-dashboards.json`;
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
  page.on('requestfailed', r => {
    const u = r.url();
    // Range-abort on media is not a page error; ignore favicon noise.
    if (/favicon|ERR_ABORTED/i.test(u + ' ' + (r.failure()?.errorText || ''))) return;
    errors.push('reqfail: ' + u);
  });

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) {
    console.error('⚠ page load failed: ' + e.message);
    console.error('hint: start the repo-root server with `node lib/serve.js --port 5180`');
    process.exit(1);
  }

  // Wait for the catalog fetch to populate the component.
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('tool-dashboard');
      return el && el.catalog && el.catalog.families && el.catalog.families.length >= 8;
    }, { timeout: 8000 });
  } catch (_) { /* assertions below will fail */ }

  // ---- the page ----------------------------------------------------------

  check('page: hero h1 names family panels', await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent || '';
    return /family/i.test(h1) && /panel/i.test(h1);
  }));

  check('page: the component is defined and mounted', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    return !!customElements.get('tool-dashboard') && !!el && !!el.shadowRoot;
  }));

  check('page: catalog meta mentions 8 families', await page.evaluate(() => {
    const t = document.querySelector('[data-catalog-meta]')?.textContent || '';
    return /8/.test(t) && /famil/i.test(t);
  }));

  check('page: family grid has 8 cards', await page.evaluate(() => {
    return document.querySelectorAll('[data-family-grid] .family-card').length === 8;
  }));

  check('page: every expected family id is present', await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-family-grid] .family-card')]
      .map(c => c.getAttribute('data-family')).sort();
    const want = ['marketplace', 'media', 'midjourney', 'platform',
      'social', 'suno', 'treblo', 'watchers'].sort();
    return ids.join(',') === want.join(',');
  }));

  check('page: house skin is loaded', await page.evaluate(() => {
    const link = document.querySelector('link[data-skin-stylesheet]');
    return !!link && /house\.css/.test(link.getAttribute('href') || '');
  }));

  check('page: theme toggle is present', await page.evaluate(() => {
    return !!document.getElementById('themeToggle');
  }));

  // ---- catalog endpoint --------------------------------------------------

  const catalogRes = await page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json();
      return {
        ok: true,
        familyCount: j.familyCount,
        suiteCount: j.suiteCount,
        ids: (j.families || []).map(f => f.id),
      };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }, CATALOG);

  check('catalog: resolves 200 with 8 families', catalogRes.ok && catalogRes.familyCount === 8,
    catalogRes.ok ? `${catalogRes.suiteCount} suites` : JSON.stringify(catalogRes));

  check('catalog: suiteCount is 86', catalogRes.ok && catalogRes.suiteCount === 86);

  // ---- component behaviour -----------------------------------------------

  check('component: starts closed (restore tab path)', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    return el.closed === true || el.hasAttribute('closed');
  }));

  // Open via the primary button.
  await page.click('[data-action="open"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('tool-dashboard');
    return el && !el.hasAttribute('closed');
  }, { timeout: 3000 }).catch(() => {});

  check('component: open() clears the closed attribute', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    return !el.hasAttribute('closed');
  }));

  check('component: shadow has four panel cards', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    const root = el.shadowRoot;
    return root.querySelectorAll('.card').length === 4;
  }));

  check('component: panel titles are TESTS / RUN / DOCS / STATUS', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    const titles = [...el.shadowRoot.querySelectorAll('.card-head')]
      .map(t => t.textContent.replace(/\s+/g, ' ').trim().toUpperCase());
    return titles.includes('TESTS') && titles.includes('RUN') &&
      titles.includes('DOCS') && titles.includes('STATUS');
  }));

  check('component: three traffic lights are present', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    return el.shadowRoot.querySelectorAll('.light').length === 3;
  }));

  check('component: default family is watchers with 3 suites', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    return el.familyId === 'watchers' &&
      el.data?.panels?.tests?.items?.length === 3;
  }));

  // Click the Midjourney family card.
  await page.click('[data-family="midjourney"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('tool-dashboard');
    return el && el.familyId === 'midjourney';
  }, { timeout: 3000 }).catch(() => {});

  check('component: switching family updates familyId', await page.evaluate(() => {
    return document.querySelector('tool-dashboard').familyId === 'midjourney';
  }));

  check('component: midjourney TESTS panel lists many suites', await page.evaluate(() => {
    const n = document.querySelector('tool-dashboard').data?.panels?.tests?.items?.length || 0;
    return n >= 15;
  }));

  check('component: midjourney RUN panel has commands', await page.evaluate(() => {
    const items = document.querySelector('tool-dashboard').data?.panels?.run?.items || [];
    return items.length >= 1 && items.every(i => typeof i.cmd === 'string' && i.cmd.length > 0);
  }));

  check('component: midjourney DOCS panel has hrefs', await page.evaluate(() => {
    const items = document.querySelector('tool-dashboard').data?.panels?.docs?.items || [];
    return items.length >= 1 && items.every(i => typeof i.href === 'string' && i.href.length > 0);
  }));

  // Pending-family race: a non-default family= must survive a showFamily
  // call against an empty/demo catalog, then land once the real catalog
  // arrives via setData. This is the review comment that forced the
  // _pendingFamily path — without it, family="suno" was rewritten to
  // "watchers" before the fetch completed.
  check('component: non-default family attr survives a missing-catalog showFamily', await page.evaluate(() => {
    const host = document.querySelector('tool-dashboard');
    const real = host.catalog;
    const el = document.createElement('tool-dashboard');
    el.setAttribute('closed', '');
    document.body.appendChild(el);
    el.setAttribute('family', 'suno');
    // Empty the in-memory catalog so showFamily cannot find "suno".
    el.setData({ families: [] });
    el.showFamily('suno');
    const attrKept = el.getAttribute('family') === 'suno';
    const pendingKept = el._pendingFamily === 'suno';
    // Now feed the real catalog — the pending request must win.
    el.setData(real);
    const afterId = el.familyId === 'suno';
    const afterAttr = el.getAttribute('family') === 'suno';
    const afterPendingCleared = el._pendingFamily === null;
    const suites = el.data?.panels?.tests?.items?.length || 0;
    el.remove();
    return attrKept && pendingKept && afterId && afterAttr &&
      afterPendingCleared && suites >= 1;
  }));

  // Mobile width: the panel must fit a phone viewport. Fixed 490px
  // overflowed; min(490px, calc(100vw - 32px)) is the contract.
  const mobileFit = await page.evaluate(async () => {
    const el = document.querySelector('tool-dashboard');
    el.open();
    el.removeAttribute('collapsed');
    // Force a phone-sized layout viewport via the panel's own CSS.
    // We measure the computed width of .win against the current
    // window.innerWidth — the e2e page is desktop-sized, so shrink
    // the CSS viewport by temporarily setting a style on :host and
    // reading the min() result via getComputedStyle.
    const win = el.shadowRoot.querySelector('.win');
    if (!win) return { ok: false, reason: 'no .win' };
    const before = win.getBoundingClientRect().width;
    // Inject a narrow host width so min(490px, 100vw - 32px) collapses.
    const style = document.createElement('style');
    style.textContent = 'tool-dashboard { display: block; width: 360px; max-width: 360px; }';
    document.head.appendChild(style);
    // Also set the html/body width so 100vw tracks the phone.
    const prevHtml = document.documentElement.style.width;
    const prevBody = document.body.style.width;
    document.documentElement.style.width = '360px';
    document.body.style.width = '360px';
    // Force a reflow then read.
    void win.offsetWidth;
    // 100vw is the layout viewport, which puppeteer keeps at the
    // launch size — so assert the CSS declaration itself instead:
    const decl = getComputedStyle(win).getPropertyValue('width');
    // Fallback: check the stylesheet rule contains the min() form.
    const sheet = el.shadowRoot.querySelector('style')?.textContent || '';
    const hasMin = /width:\s*min\(\s*490px\s*,\s*calc\(\s*100vw\s*-\s*32px\s*\)\s*\)/.test(sheet);
    const hasBorderBox = /box-sizing:\s*border-box/.test(sheet);
    document.documentElement.style.width = prevHtml;
    document.body.style.width = prevBody;
    style.remove();
    return {
      ok: hasMin && hasBorderBox && before > 0,
      hasMin,
      hasBorderBox,
      before,
      decl
    };
  });
  check('component: .win width uses min(490px, 100vw - 32px)',
    !!(mobileFit && mobileFit.ok),
    mobileFit ? JSON.stringify(mobileFit) : 'no result');

  // Real phone viewport — the panel must not exceed the screen.
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  check('component: panel fits a 375px phone viewport', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    el.open();
    el.removeAttribute('collapsed');
    const win = el.shadowRoot.querySelector('.win');
    if (!win) return false;
    // Force layout against the new viewport.
    void win.offsetWidth;
    const box = win.getBoundingClientRect();
    // 32px gutters on a 375px phone → max 343px. border-box keeps the
    // 1px border inside that width so the measured box matches.
    return box.width > 0 && box.width <= 375 - 32 + 1;
  }));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  // Late catalog: after the host's ~2s poll gives up, a dashboard:catalog
  // event must still refresh the family grid. The grid is marked with
  // [data-family-grid] (there is no #familyGrid id). Clear to a single
  // demo card first so the refresh is observable, not a no-op on 8/8.
  check('page: late dashboard:catalog refreshes the family grid', await page.evaluate(() => {
    const grid = document.querySelector('[data-family-grid]');
    if (!grid) return false;
    grid.innerHTML = '<button type="button" class="family-card" data-family="watchers">demo</button>';
    const before = grid.querySelectorAll('[data-family]').length;
    const el = document.querySelector('tool-dashboard');
    el.dispatchEvent(new CustomEvent('dashboard:catalog', {
      detail: { catalog: el.catalog },
      bubbles: true
    }));
    const after = grid.querySelectorAll('[data-family]').length;
    return before === 1 && after >= 8;
  }));

  // Collapse via yellow light.
  await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    const yellow = el.shadowRoot.querySelector('.light[data-action="collapse"]') ||
      el.shadowRoot.querySelectorAll('.light')[1];
    yellow.click();
  });
  check('component: collapse sets the collapsed attribute', await page.evaluate(() => {
    return document.querySelector('tool-dashboard').hasAttribute('collapsed');
  }));

  // Close via red light → restore tab must stay reachable.
  await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    const red = el.shadowRoot.querySelector('.light[data-action="close"]') ||
      el.shadowRoot.querySelectorAll('.light')[0];
    red.click();
  });
  check('component: close sets closed and shows restore', await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    const restore = el.shadowRoot.querySelector('.restore');
    const box = restore?.getBoundingClientRect();
    return el.hasAttribute('closed') && restore && box && box.width > 0 && box.height > 0;
  }));

  // Restore.
  await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    el.shadowRoot.querySelector('.restore').click();
  });
  check('component: restore clears closed', await page.evaluate(() => {
    return !document.querySelector('tool-dashboard').hasAttribute('closed');
  }));

  // Theme flip + persistence.
  await page.click('#themeToggle');
  await page.click('#themeToggle'); // system → light → dark (or similar)
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('page: theme toggle writes data-theme', !!themeAfter && themeAfter !== '');

  await page.reload({ waitUntil: 'networkidle2' });
  const themePersisted = await page.evaluate(() => {
    const stored = localStorage.getItem('td-theme');
    return !!stored;
  });
  check('page: theme preference persists under td-theme', themePersisted);

  // Re-open after reload (page starts closed).
  await page.waitForFunction(() => {
    const el = document.querySelector('tool-dashboard');
    return el && el.catalog && el.catalog.families && el.catalog.families.length >= 8;
  }, { timeout: 8000 }).catch(() => {});
  await page.click('[data-action="open"]');

  // Embed snippet + copy click.
  check('page: embed snippet mentions tool-dashboard', await page.evaluate(() => {
    const code = document.querySelector('.code-wrap pre code')?.textContent || '';
    return /tool-dashboard/.test(code) && /tool-dashboards\.json/.test(code);
  }));

  const copyErrorsBefore = errors.length;
  await page.click('[data-copy]');
  await new Promise(r => setTimeout(r, 200));
  check('page: copy click throws no errors', errors.length === copyErrorsBefore);

  // Internal links resolve.
  const linkStatuses = await page.evaluate(async () => {
    const hrefs = [...document.querySelectorAll('a[href]')]
      .map(a => a.getAttribute('href'))
      .filter(h => h && !h.startsWith('http') && !h.startsWith('mailto:') && !h.startsWith('#'));
    const out = [];
    for (const h of hrefs) {
      try {
        const u = new URL(h, location.href);
        const r = await fetch(u.href, { method: 'HEAD', cache: 'no-store' });
        out.push({ h, status: r.status });
      } catch (e) {
        out.push({ h, status: 0, err: String(e) });
      }
    }
    return out;
  });
  const badLinks = linkStatuses.filter(l => l.status > 400 || l.status === 0);
  check('page: internal links resolve ≤ 400', badLinks.length === 0,
    badLinks.length ? JSON.stringify(badLinks.slice(0, 5)) : `${linkStatuses.length} links`);

  // Screenshots.
  await page.evaluate(() => {
    const el = document.querySelector('tool-dashboard');
    el?.open();
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'tool-dashboards-light.png'), fullPage: true });

  await page.evaluate(() => {
    if (window.DTTheme) DTTheme.set('dark');
    else {
      localStorage.setItem('td-theme', 'dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'tool-dashboards-dark.png'), fullPage: true });

  const pageErrors = errors.filter(e => !/favicon/i.test(e));
  check('page: 0 console errors (light+dark pass)', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 5).join(' | ') : '');

  await browser.close();

  console.log('');
  console.log(failed === 0
    ? `ALL CHECKS PASSED (${results.length})`
    : `${failed} FAILED of ${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
