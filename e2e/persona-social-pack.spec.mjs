// e2e/persona-social-pack.spec.mjs
//
// Contract for the persona social pack: the lib (lib/persona-social-pack.js)
// and the page that hosts it (pages/persona-social-pack.html).
//
// NO LIVE KEY. The Gemini endpoint is intercepted: the CORS preflight is
// answered locally and the POST comes back with a fixture whose text is a
// two-persona JSON array. The page must render two persona cards, every
// tag must start with '#', the four social blocks must be there, and the
// theme toggle must persist under 'psp-theme'.
//
// Run:  cd e2e && PORT=5180 node persona-social-pack.spec.mjs
//   or: E2E_URL=https://<host> node persona-social-pack.spec.mjs

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || '5180';
const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/pages/persona-social-pack.html`;
const ARTIFACTS = path.join(__dirname, 'artifacts');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch { console.error('puppeteer missing: cd e2e && npm install'); process.exit(1); }

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (ok) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the fixture Gemini returns
// ---------------------------------------------------------------------------

const FIXTURE_PERSONAS = [
  {
    personaName: 'The Minimalist Home Decorator',
    description: 'Clean lines, neutral palettes, decluttered living spaces.',
    primarySet: ['#homedecor', '#minimalism', '#interiordesign', '#decor', '#home'],
    secondarySet: ['#minimalisthome', '#scandidecor', '#neutraldecor', '#simpleliving', '#modernhome', '#interiorstyling', '#beigedecor'],
    nicheSet: ['#japandi', '#minimaldecor', '#whiteinteriors', '#declutteryourlife', '#hyggehome', '#organicmodern', '#slowliving', '#neutralaesthetic'],
    youtube: {
      title: '5 Minutes of Japandi Calm',
      description: 'A slow pass through a neutral living room.',
      tags: ['#homedecor', '#minimalism', '#japandi'],
    },
    social: {
      instagram: { caption: 'One surface. One decision. Less, but better.' },
      tiktok: { caption: 'POV: you cleared one shelf and the whole room changed.' },
      twitter: { caption: 'A quiet room is a loud idea.' },
      facebook: { caption: 'I spent the weekend removing things and the room finally breathes.' },
    },
  },
  {
    personaName: 'The Midnight Jazz Guitarist',
    description: 'Smoky chords, late-night rooms, a horn somewhere off-frame.',
    primarySet: ['#jazzguitar', '#jazz', '#bluesguitar', '#acousticguitar', '#musician'],
    secondarySet: ['#jazzinstrumental', '#nightjazz', '#guitarplayer', '#swingmusic', '#bluesmusic', '#jazzsession', '#guitarlessons'],
    nicheSet: ['#midnightjazz', '#smokysax', '#chordsafterdark', '#acousticambient', '#bluestrumming', '#jazzfusion', '#late_night_guitar'],
    youtube: {
      title: 'Midnight Guitar — one take, no clicks',
      description: 'A single unamplified take, recorded at 1am.',
      tags: ['#jazzguitar', '#jazz', '#midnightjazz'],
    },
    social: {
      instagram: { caption: 'One take. No clicks. The room did the rest.' },
      tiktok: { caption: 'the chord at 1am hits different' },
      twitter: { caption: 'A quiet room is a loud idea.' },
      facebook: { caption: 'This one took four takes and the fourth was the truth.' },
    },
  },
];

const FIXTURE_TEXT = JSON.stringify(FIXTURE_PERSONAS);

// ---------------------------------------------------------------------------

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars'],
    });
  } catch (e) {
    console.error('could not launch Chrome: ' + e.message);
    process.exit(1);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  // --- the Gemini endpoint is intercepted; no live key, no live call ---
  let intercepted = 0;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('generativelanguage.googleapis.com')) { req.continue(); return; }
    intercepted++;
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-goog-api-key',
    };
    if (req.method() === 'OPTIONS') {
      // The preflight has to succeed here or the browser never sends the POST.
      req.respond({ status: 204, headers });
      return;
    }
    req.respond({
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: FIXTURE_TEXT }] } }],
      }),
    });
  });

  try { await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (e) { console.error('page load failed: ' + e.message); process.exit(1); }

  // ---- the page's own chrome ---------------------------------------------

  check('page: the h1 names the tool', await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent || '';
    return /persona/i.test(h1) && /pack/i.test(h1);
  }));

  check('page: exactly one skin link and one skin runtime', await page.evaluate(() => {
    const links = document.querySelectorAll('link[data-skin-stylesheet]');
    const runtime = document.querySelectorAll('script[src*="lib/skin.js"]');
    return links.length === 1 && runtime.length === 1;
  }));

  check('page: the skin runtime is the only one, and the page is skinned', await page.evaluate(() => {
    return !!window.SWR_SKIN || document.documentElement.hasAttribute('data-skin');
  }));

  check('page: the API key field says session only', await page.evaluate(() => {
    const hint = document.getElementById('psp-key-hint')?.textContent || '';
    return /session only/i.test(hint) && /sessionStorage/.test(hint);
  }));

  // ---- the no-key guard ----------------------------------------------------

  await page.type('#psp-url', 'https://example.com/personas');
  await page.click('#psp-generate');
  await wait(200);
  const guard = await page.evaluate(() => ({
    status: document.getElementById('psp-status')?.textContent || '',
    state: document.getElementById('psp-status')?.getAttribute('data-state') || '',
    cards: document.querySelectorAll('.psp-persona').length,
  }));
  check('guard: generating without a key says so and calls nothing',
    /API key/i.test(guard.status) && guard.state === 'error' && guard.cards === 0,
    guard.status + ' [' + guard.state + ']');
  check('guard: no request was made without a key', intercepted === 0,
    intercepted + ' request(s)');

  // ---- drive it ------------------------------------------------------------

  await page.type('#psp-key', 'test-key-not-real');
  await page.click('#psp-generate');

  await page.waitForSelector('.psp-persona', { timeout: 15000 }).catch(() => {});
  await wait(300);

  check('gemini: the request was intercepted, not sent to Google', intercepted >= 1,
    intercepted + ' request(s) intercepted');

  // ---- the results ---------------------------------------------------------

  const shape = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.psp-persona'));
    return {
      cards: cards.length,
      names: cards.map(c => c.querySelector('h2')?.textContent || ''),
      tags: Array.from(document.querySelectorAll('.psp-tag')).map(t => t.textContent),
      tierCounts: cards.map(c => Array.from(c.querySelectorAll('.psp-tags')).map(row => row.children.length)),
      youtubeTitles: Array.from(document.querySelectorAll('.psp-yt-title')).map(n => n.textContent),
      blocks: Array.from(document.querySelectorAll('.psp-persona .psp-block h3')).map(n => n.textContent),
      captions: Array.from(document.querySelectorAll('.psp-caption')).map(n => n.textContent),
      status: document.getElementById('psp-status')?.textContent || '',
      statusState: document.getElementById('psp-status')?.getAttribute('data-state') || '',
    };
  });

  check('results: two persona cards render', shape.cards === 2, String(shape.cards));
  check('results: the cards carry the fixture names',
    shape.names[0] === FIXTURE_PERSONAS[0].personaName &&
    shape.names[1] === FIXTURE_PERSONAS[1].personaName,
    shape.names.join(' | '));

  check('results: every tag starts with #', shape.tags.length > 0 && shape.tags.every(t => t.startsWith('#')),
    shape.tags.slice(0, 3).join(' '));

  check('results: the tier counts match the fixture', JSON.stringify(shape.tierCounts) === JSON.stringify([[5, 7, 8], [5, 7, 7]]),
    JSON.stringify(shape.tierCounts));

  check('results: the YouTube title is rendered', shape.youtubeTitles[0] === FIXTURE_PERSONAS[0].youtube.title,
    shape.youtubeTitles.join(' | '));

  const expectedBlocks = ['Primary set', 'Secondary set', 'Niche set', 'YouTube', 'instagram', 'tiktok', 'twitter', 'facebook'];
  check('results: every block is present for both personas',
    shape.blocks.length === 16 &&
      expectedBlocks.every(b => shape.blocks.includes(b)),
    shape.blocks.join(','));

  check('results: all four social blocks carry a caption',
    shape.captions.length === 8 && shape.captions.every(c => c.trim().length > 0),
    String(shape.captions.length));

  check('results: the status line reports success', /2 personas ready/.test(shape.status),
    shape.status + ' [' + shape.statusState + ']');

  // ---- the copy buttons ---------------------------------------------------

  const copyState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.psp-copy'));
    return {
      count: buttons.length,
      allExposeText: buttons.every(b => typeof b.getAttribute('data-copy') === 'string' && b.getAttribute('data-copy').length > 0),
      mismatches: buttons.filter(b => {
        const text = b.getAttribute('data-copy');
        const block = b.closest('.psp-block');
        if (!block) return true;
        const tags = block.querySelector('.psp-tags');
        if (tags) {
          const onScreen = Array.from(tags.querySelectorAll('.psp-tag')).map(t => t.textContent).join(' ');
          return onScreen !== text.trim();
        }
        const caption = block.querySelector('.psp-caption');
        if (caption) return caption.textContent.trim() !== text.trim();
        const title = block.querySelector('.psp-yt-title');
        if (title) {
          const desc = block.querySelector('.psp-yt-desc')?.textContent || '';
          const tagsCsv = block.querySelector('.psp-yt-tags')?.textContent || '';
          return [title.textContent, desc, tagsCsv].join('\n') !== text.trim();
        }
        return true;
      }).map(b => b.getAttribute('data-copy')),
    };
  });

  check('copy: every copy button exposes the text it copies', copyState.allExposeText,
    copyState.count + ' buttons');
  check('copy: the exposed text is the text on screen', copyState.mismatches.length === 0,
    copyState.mismatches.slice(0, 2).join(' | '));

  // Click a copy button for real. Headless Chrome can refuse the
  // clipboard write (NotAllowedError), and an uncaught rejection there
  // would surface as a pageerror — so the click has to be exercised,
  // not just the markup.
  const errorsBeforeCopy = errors.length;
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.psp-copy');
    btn.click();
    return { copied: btn.getAttribute('data-copied'), declared: btn.getAttribute('data-copy') };
  });
  await wait(300);
  check('copy: clicking a copy button copies exactly the exposed text',
    clicked.copied !== null && clicked.copied === clicked.declared,
    String(clicked.copied).slice(0, 40));
  check('copy: a refused clipboard write raises no page error',
    errors.length === errorsBeforeCopy,
    errors.slice(errorsBeforeCopy).slice(0, 3).join(' | '));

  const exportState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.psp-btn[data-content]'));
    return {
      count: buttons.length,
      labels: buttons.map(b => b.textContent),
      hasPostMd: buttons.filter(b => b.getAttribute('data-filename') === 'POST.md' &&
        b.getAttribute('data-content').startsWith('# The Minimalist Home Decorator')).length === 1,
      hasPersonaJson: buttons.filter(b => b.getAttribute('data-filename') === 'persona-metadata.json' &&
        b.getAttribute('data-content').includes('"tagsCsv"')).length === 2,
      hasPackJson: buttons.filter(b => b.getAttribute('data-filename') === 'persona-social-pack.json' &&
        b.getAttribute('data-content').includes('"personaName"')).length === 1,
    };
  });

  check('export: POST.md and metadata JSON are downloadable per persona, plus one pack JSON',
    exportState.count === 5 && exportState.hasPostMd && exportState.hasPersonaJson && exportState.hasPackJson,
    exportState.labels.join(','));

  const expectedTagCount = FIXTURE_PERSONAS.reduce((n, p) =>
    n + p.primarySet.length + p.secondarySet.length + p.nicheSet.length, 0);
  const allTags = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.psp-btn'))
      .find(b => /copy all hashtags/i.test(b.textContent));
    return btn ? btn.getAttribute('data-copy') : '';
  });
  const tagList = allTags.split(/\s+/).filter(Boolean);
  check('export: copy-all-hashtags carries every tag',
    tagList.length === expectedTagCount &&
      tagList.every(t => t.startsWith('#')) &&
      new Set(tagList).size === tagList.length,
    tagList.length + ' of ' + expectedTagCount);

  // ---- the rendered pack, in both themes -----------------------------------

  await page.screenshot({ path: path.join(ARTIFACTS, 'persona-social-pack-results-light.png'), fullPage: true });

  // ---- the key never touches localStorage ---------------------------------


  const keyStorage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  check('security: the key is not in localStorage',
    !keyStorage.local.some(k => /key/i.test(k)),
    keyStorage.local.join(','));
  check('security: the key is in sessionStorage',
    keyStorage.session.includes('psp-api-key'),
    keyStorage.session.join(','));

  // ---- the theme -----------------------------------------------------------

  await page.click('[data-theme-set="dark"]');
  await wait(200);
  const dark = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('psp-theme'),
  }));
  check('theme: the dark button flips the page to dark', dark.attr === 'dark', dark.attr);
  check('theme: the preference persists under psp-theme', dark.stored === 'dark', String(dark.stored));

  await page.screenshot({ path: path.join(ARTIFACTS, 'persona-social-pack-results-dark.png'), fullPage: true });

  await page.reload({ waitUntil: 'networkidle2' });
  const afterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('theme: the dark theme survives a reload', afterReload === 'dark', afterReload);

  await page.screenshot({ path: path.join(ARTIFACTS, 'persona-social-pack-dark.png'), fullPage: true });

  await page.evaluate(() => localStorage.removeItem('psp-theme'));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.screenshot({ path: path.join(ARTIFACTS, 'persona-social-pack-light.png'), fullPage: true });

  // ---- the empty-result path -----------------------------------------------
  // A second page whose Gemini always answers "[]" — the base prompt AND
  // the fallback — so the page's "no personas" branch is the one that runs.

  const emptyPage = await browser.newPage();
  const emptyErrors = [];
  emptyPage.on('pageerror', e => emptyErrors.push('pageerror: ' + e.message));
  emptyPage.on('console', m => { if (m.type() === 'error') emptyErrors.push('console.error: ' + m.text()); });
  await emptyPage.setRequestInterception(true);
  emptyPage.on('request', req => {
    if (!req.url().includes('generativelanguage.googleapis.com')) { req.continue(); return; }
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-goog-api-key',
    };
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers }); return; }
    req.respond({
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }),
    });
  });
  await emptyPage.goto(PAGE, { waitUntil: 'networkidle2' });
  await emptyPage.type('#psp-url', 'https://example.com/nothing-here');
  await emptyPage.type('#psp-key', 'test-key-not-real');
  await emptyPage.click('#psp-generate');
  await wait(1200);
  const empty = await emptyPage.evaluate(() => ({
    status: document.getElementById('psp-status')?.textContent || '',
    state: document.getElementById('psp-status')?.getAttribute('data-state') || '',
    cards: document.querySelectorAll('.psp-persona').length,
  }));
  check('empty: no personas is reported as an error, not as a blank page',
    /no personas/i.test(empty.status) && empty.state === 'error' && empty.cards === 0,
    empty.status + ' [' + empty.state + ']');
  check('empty: the empty path throws no console errors', emptyErrors.length === 0,
    emptyErrors.slice(0, 3).join(' | '));
  await emptyPage.close();

  // ---- console hygiene -----------------------------------------------------

  check('page: 0 console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  await browser.close();

  console.log('');
  console.log(failed === 0 ? `OK — all ${results.length} checks passed` : `FAILED — ${failed} of ${results.length} checks failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
