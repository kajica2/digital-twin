#!/usr/bin/env node
'use strict';
// e2e/mj-dashboard.spec.mjs
//
// Contract for the Midjourney dashboard (pages/midjourney-dashboard.html).
// Mirrors the repo-root URL convention of the marketplace/temple/how-to specs:
//   PORT=5180 node mj-dashboard.spec.mjs   # after python3 -m http.server 5180 --directory .
//
//   E2E_URL=https://kajica2.github.io/digital-twin node mj-dashboard.spec.mjs
//
// CONSOLE-ERROR POLICY — a deliberate, documented exception.
//
// The spec runs headless. Cloudflare challenges headless clients on
// cdn.midjourney.com, so every Midjourney thumbnail request in THIS browser
// fails — even though the same images load fine in a real headed browser
// (verified: 640x358 and 1141x640 real pixels, full 4-up). Those failures
// are filtered out of the console-error assertion by URL. Every OTHER host
// still fails the spec, and the page's own fallback (a labelled tile when
// the image is blocked) is asserted directly below, so the contract "the
// page shows MJ thumbnails" is still guarded.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/midjourney-dashboard.html`;
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
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  const cdnErrors = [];
  // Cloudflare challenges headless clients on cdn.midjourney.com: the images
  // load in a real browser but every request in THIS headless browser is a
  // 403 bot challenge. Those are separated out — and ONLY those. Any other
  // host still fails the console-error check.
  const isCdnChallenge = (url) => /(^|\/\/|\.)cdn\.midjourney\.com(\/|$|\?)/i.test(url || '');
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = (m.location && m.location() && m.location().url) || '';
    if (isCdnChallenge(loc) || isCdnChallenge(text)) cdnErrors.push(text);
    else errors.push('console.error: ' + text);
  });
  page.on('requestfailed', (r) => {
    const line = 'reqfail: ' + r.url();
    if (isCdnChallenge(r.url())) cdnErrors.push(line);
    else errors.push(line);
  });

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800));

  // --- structure ---
  check('mj: title names the dashboard', /Midjourney/i.test(await page.title()) && /dashboard/i.test(await page.title()));
  check('mj: hero heading present', (await page.$eval('h1', (e) => e.textContent.trim())).length > 0);

  // --- the headline numbers ---
  const stats = await page.$$eval('#stats .stat', (els) =>
    els.map((e) => ({ value: e.querySelector('b')?.textContent.trim() || '', label: e.querySelector('span')?.textContent.trim() || '' })));
  check('mj: six headline stats render', stats.length === 6, `${stats.length}`);
  const num = (s) => (s.value.replace(/[^\d]/g, '') !== '' ? Number(s.value.replace(/[^\d]/g, '')) : 0);
  const findStat = (re) => stats.find((s) => re.test(s.label));
  for (const [label, re] of [['generations', /generations/i], ['packs', /^packs$/i], ['task ids', /task ids/i], ['images', /images/i]]) {
    const s = findStat(re);
    check(`mj: the ${label} stat is non-zero`, !!s && num(s) > 0, s ? `${s.value} ${s.label}` : 'missing');
  }
  const promptStat = findStat(/^prompts$/i);
  check('mj: the prompts stat is non-zero', !!promptStat && num(promptStat) > 0, promptStat ? promptStat.value : 'missing');
  const promptPackStat = findStat(/prompt packs/i);
  check('mj: the prompt-packs stat is non-zero', !!promptPackStat && num(promptPackStat) > 0, promptPackStat ? promptPackStat.value : 'missing');

  // --- the CDN disclosure, scoped to the callout ---
  const callout = await page.$eval('#cdncallout', (e) => e.innerText);
  check('mj: the CDN callout is present', callout.length > 0);
  check('mj: the callout discloses the bot challenge', /cloudflare|bot challenge|403/i.test(callout), callout.slice(0, 80));
  check('mj: the callout says the CDN serves real browsers', /real browser/i.test(callout));
  check('mj: the callout does not claim the images are gone', !/images are gone|no longer resolve|deleted/i.test(callout));

  // --- the run record ---
  const rowCount = await page.$$eval('#recbody tr', (r) => r.length);
  check('mj: the run record has rows', rowCount > 0, `${rowCount} rows`);

  const firstRow = await page.$eval('#recbody tr', (r) => ({
    cells: r.querySelectorAll('td').length,
    task: r.querySelector('.tid')?.textContent.trim() || '',
    prompt: r.querySelector('.pr')?.textContent.trim() || '',
  }));
  check('mj: a record row has all seven columns', firstRow.cells === 7, `${firstRow.cells}`);
  check('mj: a record row carries a task id', firstRow.task.length > 4, firstRow.task);
  check('mj: a record row carries prompt text', firstRow.prompt.length > 20);

  const recCount = await page.$eval('#reccount', (e) => e.textContent.trim());
  check('mj: the record reports how many match', /\d/.test(recCount), recCount);

  // --- MJ thumbnails: the elements exist and point at the CDN ---
  // A thumbnail that has already been replaced by its fallback tile still
  // carries the url (data-src), so the "this is a MJ thumbnail" contract is
  // assertable whether or not the image has loaded yet.
  const thumbs = await page.$$eval('#recbody img.thumb, #recbody .thumb-fallback[data-src]', (nodes) => nodes.map((i) => ({
    src: i.getAttribute('src') || i.getAttribute('data-src') || '',
    alt: i.getAttribute('alt') || i.getAttribute('data-alt') || '',
    label: (i.textContent || '').trim(),
  })));
  check('mj: the record renders MJ thumbnails', thumbs.length > 0, `${thumbs.length} thumbnails`);
  check('mj: every thumbnail points at the MJ CDN',
    thumbs.length > 0 && thumbs.every((t) => t.src.startsWith('https://cdn.midjourney.com/')),
    thumbs[0] ? thumbs[0].src.slice(0, 60) : 'none');
  check('mj: every thumbnail has alt text',
    thumbs.length > 0 && thumbs.every((t) => t.alt.trim().length > 20),
    thumbs[0] ? thumbs[0].alt : 'none');

  // The page's own fallback: a thumbnail that fails to load becomes a
  // labelled tile, never a broken image. In this headless browser the CDN
  // challenges every request, so the fallback IS the expected state here.
  const settled = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('#recbody img.thumb'));
    // Give the lazy-loaded thumbnails a chance to fetch and fail.
    for (const i of imgs) { i.loading = 'eager'; }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 2500));
    window.scrollTo(0, 0);
    const all = Array.from(document.querySelectorAll('#recbody img.thumb, #recbody .thumb-fallback'));
    const broken = all.filter((n) => n.tagName === 'IMG' && n.complete && n.naturalWidth === 0);
    const loaded = all.filter((n) => n.tagName === 'IMG' && n.complete && n.naturalWidth > 0);
    const labelled = all.filter((n) => n.classList.contains('thumb-fallback'));
    return {
      total: all.length,
      broken: broken.length,
      loaded: loaded.length,
      labelled: labelled.length,
      blocked: labelled.filter((n) => n.getAttribute('data-fallback') === 'blocked').length,
      unlabelled: labelled.filter((n) => !(n.textContent || '').trim()).length,
    };
  });
  check('mj: every thumbnail tile resolved to a picture or a label',
    settled.total > 0 && settled.broken === 0 && settled.unlabelled === 0,
    `${settled.total} tiles, ${settled.loaded} loaded, ${settled.labelled} labelled, ${settled.broken} broken`);
  check('mj: a blocked thumbnail is labelled, not broken',
    settled.broken === 0 && (settled.blocked > 0 || settled.loaded > 0),
    `${settled.blocked} blocked tiles, ${settled.loaded} loaded`);

  // --- search actually filters (a term that really matches) ---
  await page.type('#q', 'music video');
  await new Promise((r) => setTimeout(r, 700));
  const filtered = await page.$$eval('#recbody tr', (r) => r.length);
  const filteredCount = await page.$eval('#reccount', (e) => e.textContent.trim());
  const filteredTotal = Number((filteredCount.match(/([\d,]+)\s+of/) || [])[1]?.replace(/,/g, '') || 0);
  check('mj: search narrows the record to a non-empty subset',
    filtered > 0 && filtered < rowCount,
    `${filtered} rows of ${rowCount}, count="${filteredCount}"`);
  check('mj: the search match count is strictly between 0 and the total',
    filteredTotal > 0 && filteredTotal < (await page.evaluate(() => Number(document.querySelector('#stats .stat b')?.textContent.replace(/[^\d]/g, '') || 0))),
    `${filteredTotal} matches`);

  await page.$eval('#q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await new Promise((r) => setTimeout(r, 500));

  // --- pack filter ---
  const packButtons = await page.$$eval('#packbar button', (b) => b.length);
  check('mj: pack filter bar is populated', packButtons > 5, `${packButtons} buttons`);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#packbar button')].find((x) => x.dataset.p);
    b.click();
  });
  await new Promise((r) => setTimeout(r, 700));
  const onePack = await page.$$eval('#recbody tr', (r) => r.length);
  check('mj: a pack filter narrows the record', onePack > 0 && onePack < rowCount, `${onePack} rows`);
  check('mj: the active pack is marked pressed',
    await page.$$eval('#packbar button[aria-pressed="true"]', (b) => b.length) === 1);

  await page.evaluate(() => {
    [...document.querySelectorAll('#packbar button')].find((x) => !x.dataset.p).click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // --- the lightbox opens the 4-up grid ---
  // The tile may already be the labelled fallback (the CDN challenges this
  // headless client), so click whichever the record is showing.
  const lightbox = await page.evaluate(async () => {
    const tile = document.querySelector('#recbody img.thumb, #recbody .thumb-fallback[data-pack]');
    if (!tile) return { ok: false, why: 'no thumbnail in the record' };
    tile.click();
    await new Promise((r) => setTimeout(r, 600));
    const lb = document.querySelector('#lightbox');
    const frames = Array.from(lb.querySelectorAll('img.lframe, .blocked'));
    return {
      ok: !lb.hidden && frames.length > 0,
      why: `hidden=${lb.hidden} frames=${frames.length}`,
      frames: frames.length,
      title: document.querySelector('#lbTitle')?.textContent || '',
    };
  });
  check('mj: clicking a thumbnail opens the 4-up lightbox', lightbox.ok, lightbox.why);
  check('mj: the lightbox names the generation', /prompt\s+\d+/.test(lightbox.title), lightbox.title);
  await page.evaluate(() => { document.querySelector('#lightbox').hidden = true; });

  // --- surviving artwork ---
  const art = await page.$$eval('#artgrid figure', (f) => f.length);
  check('mj: surviving artwork is rendered', art > 0, `${art} figures`);

  const artImgs = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('#artgrid img'));
    for (const i of imgs) { i.loading = 'eager'; }
    await new Promise((r) => setTimeout(r, 2000));
    const all = Array.from(document.querySelectorAll('#artgrid img'));
    return {
      total: all.length,
      loaded: all.filter((i) => i.complete && i.naturalWidth > 0).length,
      broken: all.filter((i) => i.complete && i.naturalWidth === 0).length,
      altOk: all.every((i) => (i.getAttribute('alt') || '').trim().length > 20),
    };
  });
  check('mj: every artwork image actually loads', artImgs.broken === 0 && artImgs.loaded > 0,
    `${artImgs.loaded}/${artImgs.total} loaded, ${artImgs.broken} broken`);
  check('mj: every artwork image has alt text', artImgs.altOk, `${artImgs.total} images`);

  // --- prompt library ---
  const lib = await page.$$eval('#lib a', (a) => a.length);
  check('mj: the prompt library lists packs', lib > 5, `${lib} packs`);

  // --- theme ---
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeBtn');
  await new Promise((r) => setTimeout(r, 400));
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('mj: theme toggle flips the theme', before !== after, `${before} -> ${after}`);

  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));
  const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('mj: the theme choice persists across a reload', persisted === after, `${persisted}`);

  await page.click('#themeBtn');
  await new Promise((r) => setTimeout(r, 500));

  // --- internal links must resolve (a relative href that 404s is a broken nav) ---
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && !/^(https?:|mailto:|#)/.test(h)));
  const dead = [];
  for (const href of hrefs) {
    const url = new URL(href, PAGE).toString();
    try {
      const r = await fetch(url, { method: 'GET' });
      if (!(r.status < 400)) dead.push(`${href} -> ${r.status}`);
    } catch (e) { dead.push(`${href} -> ${e.message}`); }
  }
  check('mj: internal links resolve', dead.length === 0, dead.join(' | ') || `${hrefs.length} checked`);

  // --- console errors ---
  // cdn.midjourney.com failures are the documented headless-challenge
  // exception; every other error still fails the spec.
  check('mj: 0 console errors (cdn.midjourney.com challenge excluded)',
    errors.length === 0, errors.slice(0, 3).join(' | '));
  if (cdnErrors.length) {
    console.log(`  (note: ${cdnErrors.length} cdn.midjourney.com challenge failure(s) in headless — expected, see the header comment)`);
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'mj-dashboard.png'), fullPage: true });

  await browser.close();
  console.log(failed === 0 ? 'OK — all mj-dashboard checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
