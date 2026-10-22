#!/usr/bin/env node
'use strict';
// e2e/marketplace.spec.mjs
//
// Contract for the marketplace listing page (pages/marketplace.html).
// Runs WITHOUT the drawthings/midjourney stack. Mirrors the repo-root
// URL convention of the clip/refael/how-to specs:
//   PORT=5180 node marketplace.spec.mjs   # after node lib/serve.js --port 5180

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/marketplace.html`;
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
  const errors = [];
  const mediaAborts = [];
  const dailyCatalogueMisses = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // The daily catalogue is optional: a checkout that has never run the daily
  // pipeline has no assets/marketplace/daily/index.json, and Chrome logs a
  // fetch for a missing file as a console error however the page handles it.
  // The page's own handling (it states the empty state instead) is asserted
  // below. The twin-os specs filter the song catalogue the same way.
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/assets\/marketplace\/daily\/index\.json/.test(url)) {
      dailyCatalogueMisses.push(m.text());
      return;
    }
    errors.push('console.error: ' + m.text());
  });
  // A <video> element cancels its own in-flight range request once it has
  // buffered enough, which Chrome surfaces as net::ERR_ABORTED. That happens
  // on GitHub Pages and Vercel exactly as it does locally, so counting it as a
  // console error made this spec fail against correct code. Media is asserted
  // separately below on readyState/duration — real evidence, not a noisy proxy.
  page.on('requestfailed', r => {
    const line = 'reqfail: ' + r.url();
    if (/\.(mp4|webm|mp3|m4a|mov)(\?|$)/i.test(r.url())) mediaAborts.push(line);
    else errors.push(line);
  });

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); process.exit(1); }

  check('market: hero <h1> "Mood Frames"', await page.evaluate(() =>
    document.querySelector('h1')?.textContent === 'Mood Frames'));

  // The catalogue is the shelf; Gumroad is the checkout. Both the header
  // CTA and the footer line must point at the store, and the link is
  // external — so it opens in a new tab with rel=noopener, and it is
  // deliberately NOT marked data-rel (that attribute is the spec's
  // "internal link, please resolve this" marker).
  const store = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[data-store-gumroad]'));
    return {
      count: links.length,
      hrefs: links.map(a => a.getAttribute('href')),
      external: links.every(a =>
        a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') || '')),
      cta: !!document.querySelector('.store-cta'),
      inHeader: !!document.querySelector('header a[data-store-gumroad]'),
      inFooter: !!document.querySelector('footer a[data-store-gumroad]'),
    };
  });
  check('market: Gumroad store linked from header and footer',
        store.count >= 2 && store.hrefs.every(h => h === 'https://kaidjuric.gumroad.com/'),
        `${store.count} links: ${store.hrefs.join(', ')}`);
  check('market: store link is a header CTA and a footer line',
        store.cta && store.inHeader && store.inFooter);
  check('market: store links open externally, safely',
        store.external, 'target=_blank + rel=noopener');

  check('market: eight story cards', await page.evaluate(() =>
    document.querySelectorAll('.story').length === 8));
  check('market: story badges present', await page.evaluate(() =>
    document.querySelectorAll('.badge').length >= 7));
  check('market: extras row has 3 figures', await page.evaluate(() =>
    document.querySelectorAll('#extras figure').length === 3));
  check('market: cover studies has 12 figures', await page.evaluate(() =>
    document.querySelectorAll('#covers figure').length === 12), 'covers');
  check('market: cover studies has 3 family groups', await page.evaluate(() =>
    document.querySelectorAll('#covers .grid').length === 3));
  check('market: covers are square (832x832)', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#covers img'));
    return imgs.length === 12 && imgs.every(i =>
      i.getAttribute('width') === '832' && i.getAttribute('height') === '832');
  }));
  check('market: every cover has alt text', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#covers img'));
    return imgs.length > 0 && imgs.every(i => (i.getAttribute('alt') || '').trim().length > 20);
  }));
  // TD-007: the lettering is SET IN LAYOUT, not generated. Two things are
  // asserted — the page says so, and each displayed caption matches the title
  // that was actually drawn onto that plate (from lettering-manifest.json).
  // That ties the art to the caption at the source instead of trusting markup.
  check('market: lettering is described as set in layout', await page.evaluate(() => {
    const t = document.querySelector('#covers')?.innerText || '';
    return /lettering/i.test(t) && /(layout|font)/i.test(t);
  }), 'type is real, not generated');

  const captionCheck = await page.evaluate(async () => {
    const rel = '../assets/marketplace/covers/lettering-manifest.json';
    const res = await fetch(new URL(rel, location.href).href, { cache: 'no-store' });
    if (!res.ok) return { ok: false, why: 'manifest HTTP ' + res.status };
    const man = await res.json();
    const byFile = {};
    for (const c of (man.covers || [])) {
      byFile[String(c.out || '').split('/').pop()] = c.title;
    }
    const figs = Array.from(document.querySelectorAll('#covers figure'));
    const bad = [];
    for (const f of figs) {
      const img = f.querySelector('img');
      const cap = f.querySelector('figcaption');
      const file = (img?.getAttribute('src') || '').split('/').pop();
      const want = byFile[file];
      const got = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
      if (want === undefined) bad.push(`${file}: not in manifest`);
      else if (got !== want) bad.push(`${file}: caption ${JSON.stringify(got)} != manifest ${JSON.stringify(want)}`);
    }
    return { ok: bad.length === 0, why: bad.join(' | '), n: figs.length, listed: Object.keys(byFile).length };
  });
  check('market: every caption matches the title actually drawn',
        captionCheck.ok,
        captionCheck.ok
          ? `${captionCheck.n} captions vs ${captionCheck.listed} manifest entries`
          : captionCheck.why);

  // System Error plates — same contract shape as the covers: count, shape,
  // alt text, and the caption tied to the tracked plates.json provenance.
  check('market: system error has 10 plates', await page.evaluate(() =>
    document.querySelectorAll('#plates figure').length === 10));
  check('market: plates are 16:9 (832x464)', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#plates img'));
    return imgs.length === 10 && imgs.every(i =>
      i.getAttribute('width') === '832' && i.getAttribute('height') === '464');
  }));
  check('market: every plate has alt text', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#plates img'));
    return imgs.length > 0 && imgs.every(i => (i.getAttribute('alt') || '').trim().length > 20);
  }));
  check('market: plates are described as text-free', await page.evaluate(() => {
    const t = document.querySelector('#plates')?.innerText || '';
    return /text-free|no lettering/i.test(t);
  }));

  const plateCheck = await page.evaluate(async () => {
    const rel = '../assets/marketplace/system-error/plates.json';
    const res = await fetch(new URL(rel, location.href).href, { cache: 'no-store' });
    if (!res.ok) return { ok: false, why: 'plates.json HTTP ' + res.status };
    const man = await res.json();
    const byFile = {};
    for (const p of (man.plates || [])) byFile[p.file] = p;
    const figs = Array.from(document.querySelectorAll('#plates figure'));
    const bad = [];
    for (const f of figs) {
      const img = f.querySelector('img');
      const cap = f.querySelector('figcaption');
      const file = (img?.getAttribute('src') || '').split('/').pop();
      const src = byFile[file];
      const got = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!src) bad.push(`${file}: not in plates.json`);
      else if (got !== src.caption) bad.push(`${file}: caption ${JSON.stringify(got)} != ${JSON.stringify(src.caption)}`);
      else if ((img.getAttribute('alt') || '').trim() !== src.alt) bad.push(`${file}: alt text != plates.json`);
      else if (src.width !== 832 || src.height !== 464) bad.push(`${file}: manifest ${src.width}x${src.height}`);
    }
    return { ok: bad.length === 0, why: bad.join(' | '), n: figs.length, listed: Object.keys(byFile).length };
  });
  check('market: every plate matches its plates.json entry',
        plateCheck.ok,
        plateCheck.ok
          ? `${plateCheck.n} plates vs ${plateCheck.listed} manifest entries`
          : plateCheck.why);

  // Daily Frames — the daily run publishes assets/marketplace/daily/index.json
  // and the page renders it. Both states are legal: a published bundle (the
  // plates render and match the catalogue) or no bundle yet (the page says so
  // plainly). The contract is that whichever state holds, the page tells the
  // truth and the captions match the catalogue.
  const daily = await page.evaluate(async () => {
    const rel = '../assets/marketplace/daily/index.json';
    const res = await fetch(new URL(rel, location.href).href, { cache: 'no-store' });
    if (!res.ok) return { state: 'none', status: res.status };
    // A missing catalogue does not have to be a 404: Vercel's catch-all
    // rewrite answers unknown paths with the landing page and a 200. So the
    // body is parsed defensively — a non-JSON body means "no catalogue
    // yet", never a crash.
    const txt = await res.text();
    let idx = null;
    try { idx = JSON.parse(txt); } catch { idx = null; }
    if (!idx) return { state: 'none', status: res.status, note: 'body is not JSON' };
    const list = idx.collections || [];
    return { state: list.length ? 'published' : 'empty', collections: list.length, index: idx };
  });

  if (daily.state === 'published') {
    // The daily plates are lazy-loaded, so they have to be scrolled into
    // view before they can be asserted on.
    await page.evaluate(() => document.querySelector('#daily')?.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#daily img')];
      return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
    }, { timeout: 20000 });

    check('market: the daily section renders plates', await page.evaluate(() =>
      document.querySelectorAll('#daily figure').length > 0),
      await page.evaluate(() => `${document.querySelectorAll('#daily figure').length} figures`));

    check('market: every daily plate has alt text', await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('#daily img'));
      return imgs.length > 0 && imgs.every(i => (i.getAttribute('alt') || '').trim().length > 20);
    }));

    const dailyCheck = await page.evaluate((idx) => {
      const newest = (idx.collections || [])[0];
      if (!newest) return { ok: false, why: 'no collections in the index' };
      const byFile = {};
      for (const p of (newest.plates || [])) byFile[p.file] = p;
      const figs = Array.from(document.querySelectorAll('#daily figure'));
      const bad = [];
      for (const f of figs) {
        const img = f.querySelector('img');
        const cap = f.querySelector('figcaption');
        const file = (img?.getAttribute('src') || '').split('/').pop();
        const src = byFile[file];
        const got = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!src) bad.push(`${file}: not in the catalogue`);
        else if (got !== src.caption) bad.push(`${file}: caption ${JSON.stringify(got)} != ${JSON.stringify(src.caption)}`);
        else if ((img.getAttribute('alt') || '').trim() !== src.alt) bad.push(`${file}: alt text != the catalogue`);
        else if (img.getAttribute('width') !== String(src.width)) bad.push(`${file}: declared width != the catalogue`);
        else if (img.getAttribute('height') !== String(src.height)) bad.push(`${file}: declared height != the catalogue`);
      }
      return { ok: bad.length === 0, why: bad.join(' | '), n: figs.length, listed: Object.keys(byFile).length };
    }, daily.index);
    check('market: every daily plate matches the catalogue',
          dailyCheck.ok,
          dailyCheck.ok
            ? `${dailyCheck.n} plates vs ${dailyCheck.listed} catalogue entries`
            : dailyCheck.why);
  } else {
    check('market: the daily section states that nothing is published yet', await page.evaluate(() => {
      const t = document.querySelector('#daily')?.innerText || '';
      return /has not published a collection yet/i.test(t);
    }));
  }

  // every image must actually render (naturalWidth > 0)
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.length >= 10 && imgs.every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 10000 });
  const imgs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('img'));
    return { count: all.length, ok: all.every(i => i.naturalWidth > 0) };
  });
  check('market: images load (naturalWidth > 0)', imgs.ok, `count=${imgs.count}`);

  // theme toggle → dark persists on reload
  await page.evaluate(() => document.querySelector('[data-theme-btn="dark"]').click());
  await new Promise(r => setTimeout(r, 200));
  check('market: theme click → dark', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.reload({ waitUntil: 'networkidle2' });
  check('market: dark theme persists on reload', await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'));
  await page.evaluate(() => document.querySelector('[data-theme-btn="auto"]').click());

  // internal links must resolve ≤ 400
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[data-rel]')).map(a => a.getAttribute('href')));
  const dead = [];
  for (const h of hrefs) {
    const u = new URL(h, `${BASE}/pages/`);
    const r = await fetch(u.href, { method: 'HEAD' }).catch(() => null);
    if (!r || r.status > 400) dead.push(h);
  }
  check('market: internal links resolve', dead.length === 0, dead.join(' | ') || `${hrefs.length} checked`);

  check('market: 0 console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // The Motion video is asserted on what the element actually loaded, which is
  // strictly stronger than "no aborted media request" — and it is the check
  // that would catch a 404 poster or a Range-less server.
  const video = await page.evaluate(async () => {
    const v = document.querySelector('#motion video');
    if (!v) return { ok: false, why: 'no <video> in #motion' };
    if (v.readyState < 1) {
      await new Promise((res) => {
        const done = () => res();
        v.addEventListener('loadedmetadata', done, { once: true });
        v.addEventListener('error', done, { once: true });
        setTimeout(done, 15000);
      });
    }
    return {
      ok: v.readyState >= 2 && v.videoWidth > 0 && v.duration > 0,
      why: `readyState=${v.readyState} ${v.videoWidth}x${v.videoHeight} duration=${v.duration}`
           + (v.error ? ` mediaError=${v.error.code}` : ''),
    };
  });
  check('market: motion video loaded and is playable', video.ok, video.why);
  if (mediaAborts.length) {
    console.log(`  (note: ${mediaAborts.length} media range abort(s) — expected, see the handler above)`);
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'marketplace-light.png'), fullPage: true });
  await browser.close();

  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(failed === 0 ? 'OK — all marketplace checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });