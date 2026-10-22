import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tools Hub + Instagram Autopilot — page contract spec.
//
// Two pages arrived from the upstream media-toolchain commit with no e2e
// spec of their own, and both were broken in ways a screenshot cannot show:
//
//   1. Each carried its own copy of the house palette in a :root block while
//      loading NO skin, so every contract token they used (var(--primary),
//      var(--accent), var(--bg), …) resolved to nothing at runtime. Both now
//      load assets/skins/house.css + lib/skin.js. instagram-autopilot.html
//      keeps Instagram's brand colours as PAGE-LOCAL tokens (--ig-primary …)
//      — a page may derive from a skin token, it may not own one.
//
//   2. instagram-autopilot.html had an unescaped `"` inside a double-quoted
//      caption template. The ENTIRE inline script failed to parse, so every
//      feature on the page did nothing and the browser logged one
//      "Invalid or unexpected token". The page looked fine because the bug
//      is invisible until you click something.
//
// So this spec asserts the rendered result, not the markup: the skin is
// present AND the palette actually paints, and the JavaScript actually runs.
//
// URL convention (single path in every mode):
//   deployed → ${BASE}/pages/tools.html
//   local    → ${BASE}/pages/tools.html   (server runs --directory .)
//
//   E2E_URL=https://digitaltwin-ebon.vercel.app node tools-instagram.spec.mjs
//   PORT=5180 node tools-instagram.spec.mjs
const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5180';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const TOOLS_URL = `${BASE}/pages/tools.html`;
const IG_URL = `${BASE}/pages/instagram-autopilot.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failed += 1;
}

/** Read a token's computed value off the document element. */
const readToken = (page, name) =>
    page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/**
 * Expected content marker per internal link target.
 *
 * The deployed site is a Vercel project with a catch-all rewrite to
 * /pages/landing.html, so a 404 can come back as landing HTML with a 200.
 * A status check therefore proves nothing — every link is checked for the
 * CONTENT of the page it is supposed to point at.
 */
const LINK_MARKERS = {
    'pages/dashboard.html': 'Dashboard — Digital Twin',
    'pages/landing.html': 'digital_twin — the meta-layer',
    'pages/twin-os/index.html': 'Twin OS — digital_twin',
    'pages/instagram-autopilot.html': 'Instagram Autopilot — Digital Twin',
    'pages/suno-prompts.html': 'Suno Reference Prompts',
    'pages/mj-style-prefix.html': 'MJ Prompt Studio',
    'pages/vhs-gif-maker.html': 'VHS GIF Maker',
    'pages/images-to-mov.html': 'Images → MOV',
    'pages/email-watermark.html': 'Email Watermarked Image',
    'pages/gallery.html': 'Gallery — Digital Twin',
    'pages/garageband-mixer.html': 'GarageBand Mixer',
    'pages/loopable-video-segmenter.html': 'Loopable Video Segmenter',
};

const browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

/**
 * A page with console/network error collection.
 *
 * requestfailed is scoped to the origin under test: the pages pull their
 * fonts from a third-party CDN, and a blocked CDN is not a contract
 * failure of the page. Every same-origin request must succeed.
 */
async function freshPage() {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const ownOrigin = new URL(BASE).origin;
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => {
        if (m.type() !== 'error') return;
        const url = m.location().url || '';
        // A blocked third-party CDN (the pages pull fonts from Google Fonts)
        // is not a contract failure of the page under test. Everything the
        // page itself serves must be clean.
        if (/Failed to load resource/i.test(m.text()) && url && !url.startsWith(ownOrigin)) return;
        errors.push('console.error: ' + m.text() + (url ? ' (' + url + ')' : ''));
    });
    p.on('requestfailed', (r) => {
        const url = r.url();
        const err = r.failure()?.errorText || '';
        if (!url.startsWith(BASE)) return; // third-party asset, out of contract
        errors.push('reqfail: ' + url + ' ' + err);
    });
    p.__errors = errors;
    return p;
}

/**
 * Load a page in the DARK theme, from the very first byte.
 *
 * These two pages do not ship lib/theme.js, so the stored preference does
 * nothing on them; the palette switch is the `data-theme` attribute on
 * <html>, which assets/skins/house.css keys off (`:root[data-theme="dark"]`).
 * The attribute is set at document-start so the page is painted dark — a
 * post-load attribute flip would miss the paint and the load-time errors.
 */
async function openDark(page, url) {
    await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('dt-theme-pref', 'dark'); } catch (e) { /* ignore */ }
        const paint = () => {
            if (document.documentElement) {
                document.documentElement.setAttribute('data-theme', 'dark');
                return true;
            }
            return false;
        };
        if (!paint()) {
            const obs = new MutationObserver(() => { if (paint()) obs.disconnect(); });
            obs.observe(document, { childList: true, subtree: true });
        }
    });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
}

/**
 * The shared skin contract: exactly one skin stylesheet, exactly one skin
 * runtime, the skin is named, the palette is DECLARED and the palette is
 * actually PAINTED.
 */
async function assertSkinContract(page, label) {
    const skin = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[data-skin-stylesheet]'));
        const scripts = Array.from(document.querySelectorAll('script[src]'))
            .filter((s) => (s.getAttribute('src') || '').endsWith('lib/skin.js'));
        return {
            linkCount: links.length,
            linkHrefs: links.map((l) => l.getAttribute('href')),
            scriptCount: scripts.length,
            scriptSrcs: scripts.map((s) => s.getAttribute('src')),
            skin: document.documentElement.getAttribute('data-skin'),
        };
    });

    check(`${label}: exactly one skin stylesheet link`, skin.linkCount === 1, `found ${skin.linkCount}: ${skin.linkHrefs.join(', ')}`);
    check(`${label}: skin stylesheet is house.css`,
        skin.linkCount === 1 && /house\.css$/.test(skin.linkHrefs[0] || ''), skin.linkHrefs.join(', '));
    check(`${label}: exactly one lib/skin.js script`, skin.scriptCount === 1, `found ${skin.scriptCount}: ${skin.scriptSrcs.join(', ')}`);
    check(`${label}: data-skin is "house"`, skin.skin === 'house', skin.skin || 'none');

    // Declared …
    const primary = await readToken(page, '--primary');
    const bg = await readToken(page, '--bg');
    check(`${label}: --primary resolves to #c97b3f`, primary === '#c97b3f', primary || 'empty');
    check(`${label}: --bg resolves to #f7f5f0`, bg === '#f7f5f0', bg || 'empty');

    // … and painted. A declared-but-unused token is the bug this page had.
    const body = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { bg: cs.backgroundColor, color: cs.color };
    });
    check(`${label}: body background is the house cream rgb(247, 245, 240)`,
        body.bg === 'rgb(247, 245, 240)', body.bg);
    check(`${label}: body colour is the house ink rgb(20, 23, 30)`,
        body.color === 'rgb(20, 23, 30)', body.color);
}

/**
 * Every internal link must resolve to the page it names. Asserted on
 * CONTENT, because the catch-all rewrite can answer a dead path with the
 * landing page and a 200.
 */
async function assertInternalLinks(page, label) {
    const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.getAttribute('href'))
            .filter((h) => h && !/^(https?:|mailto:|tel:|#|data:)/.test(h)));

    const dead = [];
    const checked = [];
    for (const h of new Set(hrefs)) {
        const url = new URL(h, page.url());
        if (url.origin !== new URL(BASE).origin) continue;
        const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
        const marker = LINK_MARKERS[key];
        let body = '';
        try {
            const resp = await fetch(url.toString());
            body = await resp.text();
        } catch (err) {
            dead.push(`${h} → fetch failed: ${err.message}`);
            continue;
        }
        checked.push(key);
        if (!marker) {
            dead.push(`${h} → no known marker for ${key}`);
            continue;
        }
        if (!body.includes(marker)) {
            dead.push(`${h} → content mismatch (expected "${marker}")`);
        }
    }
    check(`${label}: every internal link resolves to its own page`,
        dead.length === 0 && checked.length > 0,
        dead.slice(0, 4).join(' | ') || `${checked.length} link(s) verified by content`);
}

try {
    // ==================================================================
    // 1. pages/tools.html — light theme
    // ==================================================================
    const tools = await freshPage();
    await tools.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    try {
        await tools.goto(TOOLS_URL, { waitUntil: 'networkidle0', timeout: 20000 });
    } catch (err) {
        console.log('⚠ server unreachable: ' + err.message);
        console.log('start a static server first: node lib/serve.js --port 5180 --host 127.0.0.1');
        for (const r of results) console.log(r);
        console.log(`FAILED — ${failed} check(s) failed (0 assertions could run)`);
        process.exit(1);
    }

    await assertSkinContract(tools, 'tools');

    const toolsGradient = await tools.evaluate(() =>
        getComputedStyle(document.querySelector('.header')).backgroundImage);
    check('tools: .header gradient uses the house primary rgb(201, 123, 63)',
        toolsGradient.includes('rgb(201, 123, 63)'), toolsGradient);
    check('tools: .header gradient uses the house primary-2 rgb(168, 95, 40)',
        toolsGradient.includes('rgb(168, 95, 40)'), toolsGradient);

    await tools.screenshot({ path: path.join(ARTIFACTS, 'tools-light.png'), fullPage: true });
    console.log('wrote artifacts/tools-light.png');

    await assertInternalLinks(tools, 'tools');

    check('tools: 0 console errors, 0 pageerrors, 0 failed requests (light)',
        tools.__errors.length === 0, tools.__errors.slice(0, 4).join(' | ') || 'clean');

    // ==================================================================
    // 2. pages/tools.html — dark theme
    // ==================================================================
    const toolsDark = await freshPage();
    await openDark(toolsDark, TOOLS_URL);
    const toolsDarkBody = await toolsDark.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { bg: cs.backgroundColor, theme: document.documentElement.getAttribute('data-theme') };
    });
    check('tools: dark theme is applied to <html>', toolsDarkBody.theme === 'dark', toolsDarkBody.theme || 'none');
    check('tools: dark theme repaints the body rgb(26, 24, 18)',
        toolsDarkBody.bg === 'rgb(26, 24, 18)', toolsDarkBody.bg);
    check('tools: 0 console errors, 0 pageerrors, 0 failed requests (dark)',
        toolsDark.__errors.length === 0, toolsDark.__errors.slice(0, 4).join(' | ') || 'clean');
    await toolsDark.screenshot({ path: path.join(ARTIFACTS, 'tools-dark.png'), fullPage: true });
    console.log('wrote artifacts/tools-dark.png');
    await toolsDark.close();

    // ==================================================================
    // 3. pages/instagram-autopilot.html — light theme
    // ==================================================================
    const ig = await freshPage();
    await ig.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await ig.goto(IG_URL, { waitUntil: 'networkidle0', timeout: 20000 });

    await assertSkinContract(ig, 'instagram');

    const igGradient = await ig.evaluate(() =>
        getComputedStyle(document.querySelector('.header')).backgroundImage);
    check('instagram: .header gradient uses Instagram pink rgb(225, 48, 108)',
        igGradient.includes('rgb(225, 48, 108)'), igGradient);
    check('instagram: .header gradient uses Instagram purple rgb(131, 58, 180)',
        igGradient.includes('rgb(131, 58, 180)'), igGradient);
    check('instagram: .header gradient uses Instagram blue rgb(64, 93, 230)',
        igGradient.includes('rgb(64, 93, 230)'), igGradient);

    const igBtn = await ig.evaluate(() => {
        const btn = document.querySelector('button.btn[onclick="generateCaption()"]');
        return btn ? getComputedStyle(btn).backgroundColor : 'missing';
    });
    check('instagram: primary .btn background is rgb(225, 48, 108)',
        igBtn === 'rgb(225, 48, 108)', igBtn);

    const igPrimary = await readToken(ig, '--ig-primary');
    check('instagram: --ig-primary resolves to #E1306C', igPrimary === '#E1306C', igPrimary || 'empty');

    // ------------------------------------------------------------------
    // The JavaScript must actually RUN. The bug was an unescaped quote in
    // the caption template: the whole inline script failed to parse, so
    // every handler was dead. A parse error surfaces as a pageerror, not
    // as a console error — hence the explicit assertion below.
    // ------------------------------------------------------------------
    check('instagram: no pageerror — the inline script parses',
        !ig.__errors.some((e) => e.startsWith('pageerror:')),
        ig.__errors.filter((e) => e.startsWith('pageerror:')).join(' | ') || 'none');

    await ig.type('#topic', 'five secrets to growing your following');
    await ig.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button.btn'))
            .find((b) => (b.textContent || '').includes('Generate Caption'));
        if (!btn) throw new Error('Generate Caption button not found');
        btn.click();
    });
    const caption = await ig.evaluate(() => {
        const out = document.querySelector('#captionOutput');
        return out ? out.textContent : '';
    });
    check('instagram: Generate Caption fills #captionOutput',
        caption.length > 0 && !caption.includes('Your viral caption will appear here'),
        `${caption.length} chars`);
    check('instagram: caption contains STOP SCROLLING',
        caption.includes('STOP SCROLLING'), caption.slice(0, 80));
    check('instagram: caption contains the literal Drop a "🔥" (inner quotes intact)',
        caption.includes('Drop a "🔥"'), caption.slice(0, 160));

    // Tab strip: the active class must move, not just the panel.
    const tabBefore = await ig.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.tab-btn'));
        return btns.map((b) => b.classList.contains('active'));
    });
    await ig.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.tab-btn'));
        if (btns[1]) btns[1].click();
    });
    const tabAfter = await ig.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.tab-btn'));
        return {
            actives: btns.map((b) => b.classList.contains('active')),
            hashtagsPanelVisible: (() => {
                const p = document.querySelector('#panel-hashtags');
                return !!p && getComputedStyle(p).display !== 'none';
            })(),
        };
    });
    check('instagram: the first tab starts active',
        tabBefore[0] === true && tabBefore.filter(Boolean).length === 1,
        JSON.stringify(tabBefore));
    check('instagram: clicking the second tab moves .active off the first',
        tabAfter.actives[0] === false, JSON.stringify(tabAfter.actives));
    check('instagram: clicking the second tab puts .active on it',
        tabAfter.actives[1] === true, JSON.stringify(tabAfter.actives));
    check('instagram: clicking the second tab shows its panel',
        tabAfter.hashtagsPanelVisible === true, String(tabAfter.hashtagsPanelVisible));

    await ig.screenshot({ path: path.join(ARTIFACTS, 'instagram-autopilot-light.png'), fullPage: true });
    console.log('wrote artifacts/instagram-autopilot-light.png');

    await assertInternalLinks(ig, 'instagram');

    check('instagram: 0 console errors, 0 pageerrors, 0 failed requests (light)',
        ig.__errors.length === 0, ig.__errors.slice(0, 4).join(' | ') || 'clean');

    // ==================================================================
    // 4. pages/instagram-autopilot.html — dark theme
    // ==================================================================
    const igDark = await freshPage();
    await openDark(igDark, IG_URL);
    const igDarkBody = await igDark.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { bg: cs.backgroundColor, theme: document.documentElement.getAttribute('data-theme') };
    });
    check('instagram: dark theme is applied to <html>', igDarkBody.theme === 'dark', igDarkBody.theme || 'none');
    check('instagram: dark theme repaints the body rgb(26, 24, 18)',
        igDarkBody.bg === 'rgb(26, 24, 18)', igDarkBody.bg);
    check('instagram: 0 console errors, 0 pageerrors, 0 failed requests (dark)',
        igDark.__errors.length === 0, igDark.__errors.slice(0, 4).join(' | ') || 'clean');
    await igDark.screenshot({ path: path.join(ARTIFACTS, 'instagram-autopilot-dark.png'), fullPage: true });
    console.log('wrote artifacts/instagram-autopilot-dark.png');
    await igDark.close();
} finally {
    await browser.close();
}

for (const r of results) console.log(r);
console.log(failed === 0 ? 'OK — all tools/instagram checks passed' : `FAILED — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
