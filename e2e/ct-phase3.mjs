import puppeteer from 'puppeteer';

const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5173';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
// /pages/cognitive-twin.html on the deployed Pages site and on the launchd dev
// server alike — both serve the repo root. CI's PR-mode server must too.
const URL = `${BASE}/pages/cognitive-twin.html`;

const errors = [];
const fails = [];
function assert(label, ok, detail) {
    if (ok) { console.log('  ✓', label); }
    else    { fails.push(label); console.log('  ✗', label, detail ? '- ' + detail : ''); }
}

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
await page.evaluate(() => localStorage.removeItem('theme'));
await page.reload({ waitUntil: 'networkidle0' });

console.log('\n1. og:image + canonical');
const meta = await page.evaluate(() => {
    const get = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
    const ogImage = get('meta[property="og:image"]');
    const ogImageWidth = get('meta[property="og:image:width"]');
    const ogImageHeight = get('meta[property="og:image:height"]');
    const ogImageAlt = get('meta[property="og:image:alt"]');
    const twitterCard = get('meta[name="twitter:card"]');
    const twitterImage = get('meta[name="twitter:image"]');
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null;
    const ogUrl = get('meta[property="og:url"]');
    return { ogImage, ogImageWidth, ogImageHeight, ogImageAlt, twitterCard, twitterImage, canonical, ogUrl };
});
assert('og:image set', !!meta.ogImage);
assert('og:image is GitHub Pages URL', meta.ogImage && meta.ogImage.includes('kajica2.github.io/digital-twin'));
assert('og:image:width="1200"', meta.ogImageWidth === '1200');
assert('og:image:height="630"', meta.ogImageHeight === '630');
assert('og:image:alt present', !!meta.ogImageAlt && meta.ogImageAlt.length > 10);
assert('twitter:card=summary_large_image', meta.twitterCard === 'summary_large_image');
assert('twitter:image set', !!meta.twitterImage);
assert('canonical URL set', !!meta.canonical);
assert('og:url set', !!meta.ogUrl);

// Verify the OG image file actually exists and is a real PNG with the right dimensions
if (meta.ogImage) {
    try {
        // Resolve against the repo checkout (works on CI runners, not just this machine)
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const specDir = dirname(fileURLToPath(import.meta.url));
        const ogPath = join(specDir, '..', 'assets', 'cognitive-twin-og.png');
        const { existsSync, statSync } = await import('node:fs');
        const exists = existsSync(ogPath);
        assert('og:image file exists on disk', exists);
        if (exists) {
            const size = statSync(ogPath).size;
            assert('og:image > 10KB', size > 10000, `size=${size}`);
            // Check PNG signature
            const { readFileSync } = await import('node:fs');
            const buf = readFileSync(ogPath);
            const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
            assert('og:image is a valid PNG', isPng);
            // Width is at offset 16-19, height at 20-23 (big-endian)
            const width = buf.readUInt32BE(16);
            const height = buf.readUInt32BE(20);
            assert('og:image width is 1200', width === 1200, `width=${width}`);
            assert('og:image height is 630', height === 630, `height=${height}`);
        }
    } catch (e) {
        assert('og:image file check passed', false, e.message);
    }
}

console.log('\n2. URL hash routing — layer state');
// Navigate to ?l=reasoner
await page.goto(URL + '?l=reasoner', { waitUntil: 'networkidle0' });
const fromUrl = await page.evaluate(() => ({
    visible: document.querySelector('.layer-details.visible')?.id,
    active: document.querySelector('.arch-node.active')?.dataset.layer,
}));
assert('?l=reasoner → layer-reasoner visible', fromUrl.visible === 'layer-reasoner');
assert('?l=reasoner → arch-node[reasoner] active', fromUrl.active === 'reasoner');

// Click an arch-node, verify URL updates without navigation
await page.evaluate(() => showLayer('orchestrator'));
await new Promise(r => setTimeout(r, 100));
const afterClick = await page.evaluate(() => ({
    visible: document.querySelector('.layer-details.visible')?.id,
    search: location.search,
}));
assert('after click → layer-orchestrator visible', afterClick.visible === 'layer-orchestrator');
assert('URL has ?l=orchestrator', afterClick.search.includes('l=orchestrator'), afterClick.search);

// Back button restores previous state
await page.goBack({ waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 100));
const afterBack = await page.evaluate(() => ({
    visible: document.querySelector('.layer-details.visible')?.id,
    search: location.search,
}));
assert('back button → layer-reasoner', afterBack.visible === 'layer-reasoner');
assert('back button → ?l=reasoner', afterBack.search.includes('l=reasoner'));

console.log('\n3. URL hash routing — twin state');
await page.goto(URL + '?t=web', { waitUntil: 'networkidle0' });
const fromTwinUrl = await page.evaluate(() => ({
    active: document.querySelector('.twin-content.active')?.id,
    selected: document.querySelector('[aria-selected="true"]')?.dataset?.twin,
}));
assert('?t=web → twin-web active', fromTwinUrl.active === 'twin-web');
assert('?t=web → tab[web] selected', fromTwinUrl.selected === 'web');

// Combined params
await page.goto(URL + '?l=model&t=research', { waitUntil: 'networkidle0' });
const combined = await page.evaluate(() => ({
    visible: document.querySelector('.layer-details.visible')?.id,
    twin: document.querySelector('.twin-content.active')?.id,
}));
assert('?l=model&t=research → layer-model visible', combined.visible === 'layer-model');
assert('?l=model&t=research → twin-research active', combined.twin === 'twin-research');

// Bad values are ignored
await page.goto(URL + '?l=nonexistent&t=garbage', { waitUntil: 'networkidle0' });
const fallback = await page.evaluate(() => ({
    visible: document.querySelector('.layer-details.visible')?.id,
    twin: document.querySelector('.twin-content.active')?.id,
}));
assert('invalid ?l= → defaults to scanner', fallback.visible === 'layer-scanner');
assert('invalid ?t= → defaults to music', fallback.twin === 'twin-music');

console.log('\n4. aria-live on scanner demo');
await page.goto(URL, { waitUntil: 'networkidle0' });
const scannerAria = await page.evaluate(() => {
    const out = document.getElementById('scannerOutput');
    const btn = document.getElementById('runScanner');
    return {
        outAriaLive: out?.getAttribute('aria-live'),
        outRole: out?.getAttribute('role'),
        outLabel: out?.getAttribute('aria-label'),
        btnAriaPressed: btn?.getAttribute('aria-pressed'),
        btnAriaControls: btn?.getAttribute('aria-controls'),
    };
});
assert('scanner output has aria-live="polite"', scannerAria.outAriaLive === 'polite');
assert('scanner output has role="region"', scannerAria.outRole === 'region');
assert('scanner output has aria-label', !!scannerAria.outLabel);
assert('scanner button has aria-pressed', scannerAria.btnAriaPressed === 'false');
assert('scanner button has aria-controls', scannerAria.btnAriaControls === 'scannerOutput');

// Click toggles aria-pressed
await page.click('#runScanner');
await new Promise(r => setTimeout(r, 50));
const pressedAfter = await page.evaluate(() => document.getElementById('runScanner').getAttribute('aria-pressed'));
assert('scanner button aria-pressed="true" after click', pressedAfter === 'true');

await page.click('#runScanner');
await new Promise(r => setTimeout(r, 50));
const pressedAgain = await page.evaluate(() => document.getElementById('runScanner').getAttribute('aria-pressed'));
assert('scanner button aria-pressed="false" after second click', pressedAgain === 'false');

console.log('\n5. Mobile nav drawer');
// Switch to mobile viewport
await page.setViewport({ width: 390, height: 800 });
await new Promise(r => setTimeout(r, 100));

const mobileInit = await page.evaluate(() => {
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    const backdrop = document.getElementById('navBackdrop');
    return {
        toggleExists: !!toggle,
        toggleVisible: toggle ? getComputedStyle(toggle).display !== 'none' : false,
        linksOpen: links?.classList.contains('open'),
        backdropHidden: backdrop?.hidden,
        backdropOpen: backdrop?.classList.contains('open'),
    };
});
assert('mobile: hamburger toggle exists', mobileInit.toggleExists);
assert('mobile: hamburger is visible', mobileInit.toggleVisible);
assert('mobile: drawer starts closed', !mobileInit.linksOpen);
assert('mobile: backdrop starts hidden', mobileInit.backdropHidden);
assert('mobile: backdrop starts without .open', !mobileInit.backdropOpen);

// Open the drawer
await page.click('#navToggle');
await new Promise(r => setTimeout(r, 100));
const openedState = await page.evaluate(() => {
    const links = document.getElementById('navLinks');
    const backdrop = document.getElementById('navBackdrop');
    const toggle = document.getElementById('navToggle');
    return {
        linksOpen: links?.classList.contains('open'),
        linksVisible: getComputedStyle(links).visibility === 'visible',
        backdropHidden: backdrop?.hidden,
        backdropOpen: backdrop?.classList.contains('open'),
        toggleAriaExpanded: toggle?.getAttribute('aria-expanded'),
        toggleAriaLabel: toggle?.getAttribute('aria-label'),
    };
});
assert('open: drawer has .open class', openedState.linksOpen);
assert('open: drawer is visible', openedState.linksVisible);
assert('open: backdrop shown', !openedState.backdropHidden);
assert('open: backdrop has .open', openedState.backdropOpen);
assert('open: hamburger aria-expanded="true"', openedState.toggleAriaExpanded === 'true');
assert('open: hamburger label changed', openedState.toggleAriaLabel && openedState.toggleAriaLabel.includes('Close'));

// Click backdrop to close
await page.evaluate(() => document.getElementById('navBackdrop').click());
await new Promise(r => setTimeout(r, 100));
const closedByBackdrop = await page.evaluate(() => ({
    linksOpen: document.getElementById('navLinks')?.classList.contains('open'),
}));
assert('backdrop click closes drawer', !closedByBackdrop.linksOpen);

// Open again, then click a nav link
await page.click('#navToggle');
await new Promise(r => setTimeout(r, 100));
await page.click('.nav-link[href="#architecture"]');
await new Promise(r => setTimeout(r, 100));
const closedByLink = await page.evaluate(() => ({
    linksOpen: document.getElementById('navLinks')?.classList.contains('open'),
}));
assert('nav link click closes drawer', !closedByLink.linksOpen);

// Open, then Escape closes
await page.click('#navToggle');
await new Promise(r => setTimeout(r, 100));
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 100));
const closedByEscape = await page.evaluate(() => ({
    linksOpen: document.getElementById('navLinks')?.classList.contains('open'),
    focusedId: document.activeElement?.id,
}));
assert('Escape closes drawer', !closedByEscape.linksOpen);
assert('Escape returns focus to hamburger', closedByEscape.focusedId === 'navToggle');

// Back to desktop viewport, hamburger should hide
await page.setViewport({ width: 1280, height: 900 });
await new Promise(r => setTimeout(r, 100));
const desktopHamburger = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('navToggle')).display,
}));
assert('desktop: hamburger is hidden', desktopHamburger.display === 'none');

console.log(`\nTotal failures: ${fails.length}`);
console.log('Console errors:', JSON.stringify(errors));
if (fails.length > 0) console.log('FAILED checks:', fails.join(', '));
console.log(fails.length === 0 ? 'ALL PASS' : 'SOME FAILED');

await browser.close();
process.exit(fails.length === 0 ? 0 : 1);