#!/usr/bin/env node
'use strict';
// e2e/temple-of-control.spec.mjs
//
// Contract for the Temple of Control (pages/temple-of-control.html) and the
// <meditate-temperature> component it hosts. Runs WITHOUT MIDI hardware and
// WITHOUT any audio stack: the score path is exercised through the exposed API
// (loadMidi on a synthetic score is covered by the unit suite) and the automap
// is exercised through its mode cycling, which needs no device.
//
// Mirrors the repo-root URL convention of the clip/refael/how-to/marketplace
// specs:
//   PORT=5180 node temple-of-control.spec.mjs   # after python3 -m http.server 5180 --directory .

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/temple-of-control.html`;
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
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('⚠ page load failed: ' + e.message); process.exit(1); }

  check('temple: hero <h1> "Temple of Control"', await page.evaluate(() =>
    document.querySelector('h1')?.textContent === 'Temple of Control'));

  // The component must actually mount: defined as a custom element, and it
  // renders a canvas internally (not just an empty tag).
  const mounted = await page.evaluate(() => ({
    defined: !!customElements.get('meditate-temperature'),
    canvas: !!document.querySelector('meditate-temperature canvas'),
    readout: !!document.querySelector('meditate-temperature .readout'),
  }));
  check('temple: <meditate-temperature> defined + canvas mounted',
    mounted.defined && mounted.canvas, JSON.stringify(mounted));

  // Three temperature sliders — the whole premise of the page.
  const sliders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[data-temp]')).map(i => i.getAttribute('data-temp')));
  check('temple: three temperature sliders (heat/breath/glow)',
    sliders.length === 3 && ['heat', 'breath', 'glow'].every(k => sliders.includes(k)),
    sliders.join(','));

  // The slider must move the component, not just its label.
  const moved = await page.evaluate(() => {
    const input = document.querySelector('input[data-temp="heat"]');
    input.value = '0.91';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const v = document.querySelector('meditate-temperature');
    return { heat: v.heat, label: document.querySelector('[data-val="heat"]')?.textContent };
  });
  check('temple: slider drives the component', moved.heat === 0.91 && moved.label === '0.91',
    JSON.stringify(moved));

  // Presets are temperature triples; ember must land on its documented values.
  const preset = await page.evaluate(() => {
    document.querySelector('[data-preset="ember"]')?.click();
    const v = document.querySelector('meditate-temperature');
    return { heat: v.heat, breath: v.breath, glow: v.glow };
  });
  check('temple: preset "ember" applies its triple',
    preset.heat === 0.78 && preset.breath === 0.62 && preset.glow === 0.66, JSON.stringify(preset));

  // Public API contract of the component (what "plugged in on any page" uses).
  const api = await page.evaluate(() => {
    const v = document.querySelector('meditate-temperature');
    const canSet = typeof v?.setTemp === 'function';
    if (canSet) v.setTemp({ heat: 0.25, glow: 0.75 });
    return {
      heat: v?.heat, glow: v?.glow,
      hasLoadMidi: typeof v?.loadMidi === 'function',
      hasPlayPause: typeof v?.play === 'function' && typeof v?.pause === 'function',
      canSet,
      autoMap: typeof window.MIDI_AUTOMAP?.create === 'function',
    };
  });
  check('temple: component API (setTemp / loadMidi / play / pause)',
    api.canSet && api.heat === 0.25 && api.glow === 0.75 && api.hasLoadMidi && api.hasPlayPause,
    JSON.stringify(api));
  check('temple: MIDI automap module loaded', api.autoMap === true);

  // Automap modes must cycle without hardware.
  const modeBefore = await page.evaluate(() => document.getElementById('automapMode').textContent);
  await page.evaluate(() => document.getElementById('modeBtn').click());
  const modeAfter = await page.evaluate(() => document.getElementById('automapMode').textContent);
  check('temple: automap mode cycles', modeBefore !== modeAfter && /mode: \w+/.test(modeAfter),
    `${modeBefore.trim()} -> ${modeAfter.trim()}`);

  // MIDI input accepts a score.
  check('temple: MIDI file input accepts .mid', await page.evaluate(() =>
    /\.mid|midi/i.test(document.getElementById('midiInput').getAttribute('accept'))));

  // Copy blocks: one per snippet, and a click must never throw.
  const copy = await page.evaluate(() => {
    const blocks = document.querySelectorAll('[data-copy-source]').length;
    const btns = document.querySelectorAll('[data-copy]');
    let clicked = 'none';
    try {
      btns[0].click();
      clicked = btns[0].textContent.trim();
      // second block too
      btns[1] && btns[1].click();
    } catch (e) { clicked = 'threw: ' + e.message; }
    return { blocks, btns: btns.length, clicked };
  });
  check('temple: copy blocks + buttons', copy.blocks === 3 && copy.btns === 3, JSON.stringify(copy));
  check('temple: copy click flips the label without throwing', copy.clicked === 'copied', copy.clicked);

  // Theme: toggle to dark and persist across reload.
  await page.evaluate(() => document.getElementById('themeToggle').click());
  const darkNow = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark');
  await page.reload({ waitUntil: 'networkidle2' });
  const darkAfter = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark');
  check('temple: theme click → dark', darkNow === true);
  check('temple: dark theme persists on reload', darkAfter === true);

  // Internal links must resolve (the 0.31 lesson: relative links 404 quietly).
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && !/^(https?:|mailto:|#)/.test(h)));
  const dead = [];
  for (const href of hrefs) {
    const url = new URL(href, PAGE).toString();
    try {
      const r = await fetch(url, { method: 'GET' });
      if (!(r.status < 400)) dead.push(`${href} -> ${r.status}`);
    } catch (e) { dead.push(`${href} -> ${e.message}`); }
  }
  check('temple: internal links resolve', dead.length === 0, dead.join(' | ') || `${hrefs.length} checked`);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'temple-dark.png'), fullPage: true });

  check('temple: 0 console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // Light pass for the screenshot pair.
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('tc-theme', 'light'); } catch (e) {}
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.screenshot({ path: path.join(ARTIFACTS, 'temple-light.png'), fullPage: true });

  await browser.close();
  console.log(failed === 0 ? 'OK — all temple-of-control checks passed' : `FAILED — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
