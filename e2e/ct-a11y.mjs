import puppeteer from 'puppeteer';

const DEPLOYED_URL = process.env.E2E_URL || null;
const PORT = process.env.PORT || '5173';
const BASE = DEPLOYED_URL || `http://127.0.0.1:${PORT}`;
const URL = `${BASE}${DEPLOYED_URL ? '/pages/cognitive-twin.html' : '/pages/cognitive-twin.html'}`;

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

console.log('\n1. Semantic structure');
const semantic = await page.evaluate(() => {
    const hasMain = !!document.querySelector('main');
    const headingCounts = {};
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
        const level = h.tagName.toLowerCase();
        headingCounts[level] = (headingCounts[level] || 0) + 1;
    });
    // No h4 should exist (all promoted to h3)
    const noH4 = !document.querySelector('h4');
    const noH5 = !document.querySelector('h5');
    // Main should wrap container
    const mainChildren = document.querySelector('main')?.children || [];
    const containerIsInside = Array.from(mainChildren).some(c => c.classList.contains('container'));
    return { hasMain, headingCounts, noH4, noH5, containerIsInside };
});
assert('has <main>', semantic.hasMain);
assert('no h4 elements', semantic.noH4);
assert('no h5 elements', semantic.noH5);
assert('<main> contains .container', semantic.containerIsInside);
// h1, at least 5 h2 (sections), several h3 (details + cards)
assert('has h1', semantic.headingCounts.h1 === 1);
assert('5+ h2 (sections)', semantic.headingCounts.h2 >= 5);
assert('h3 present', semantic.headingCounts.h3 > 0);

console.log('\n2. Navigation ARIA');
// Scroll into a section so a nav link is active
await page.evaluate(() => window.scrollTo(0, 500));
await new Promise(r => setTimeout(r, 200));
const navAria = await page.evaluate(() => {
    const nav = document.querySelector('nav');
    const ariaLabel = nav?.getAttribute('aria-label');
    const links = document.querySelectorAll('.nav-link');
    const activeLink = document.querySelector('.nav-link.active');
    const ariaCurrent = activeLink ? activeLink.getAttribute('aria-current') : null;
    // No element should have href="#" (logo changed to "/")
    const hashHref = document.querySelector('a[href="#"]');
    return { navLabel: ariaLabel, linkCount: links.length, activeAriaCurrent: ariaCurrent, hashHrefExists: !!hashHref };
});
assert('nav has aria-label', navAria.navLabel && navAria.navLabel.length > 0);
assert('no href="#" elements', !navAria.hashHrefExists);
assert('active link has aria-current', navAria.activeAriaCurrent === 'true');

console.log('\n3. Theme toggle ARIA');
const toggleAria = await page.evaluate(() => {
    const btn = document.getElementById('themeToggle');
    if (!btn) return { found: false };
    return {
        found: true,
        ariaLabel: btn.getAttribute('aria-label'),
        ariaPressed: btn.getAttribute('aria-pressed'),
        tag: btn.tagName,
    };
});
assert('themeToggle exists', toggleAria.found);
assert('themeToggle is <button>', toggleAria.found && toggleAria.tag === 'BUTTON');
assert('themeToggle has aria-label', toggleAria.ariaLabel && toggleAria.ariaLabel.length > 0);
assert('themeToggle has aria-pressed', toggleAria.ariaPressed === 'true' || toggleAria.ariaPressed === 'false');

console.log('\n4. Arch nodes are <button> elements with ARIA');
const archAria = await page.evaluate(() => {
    const nodes = document.querySelectorAll('.arch-node');
    const details = [];
    for (const n of nodes) {
        details.push({
            tag: n.tagName,
            layer: n.dataset.layer,
            ariaControls: n.getAttribute('aria-controls'),
            ariaExpanded: n.getAttribute('aria-expanded'),
            ariaLabel: n.getAttribute('aria-label'),
            hasOnclick: n.hasAttribute('onclick'),
        });
    }
    const hasArrow = document.querySelector('.arch-arrow[aria-hidden="true"]');
    return { nodes: details, arrowHidden: !!hasArrow };
});
assert('4 arch-node elements', archAria.nodes.length === 4);
for (const n of archAria.nodes) {
    assert(`arch-node[${n.layer}] is <button>`, n.tag === 'BUTTON', `${n.tag}`);
    assert(`arch-node[${n.layer}] has aria-controls="${n.layer}"`, n.ariaControls === 'layer-' + n.layer);
    assert(`arch-node[${n.layer}] has aria-label`, n.ariaLabel && n.ariaLabel.length > 0);
    assert(`arch-node[${n.layer}] no inline onclick`, !n.hasOnclick);
}
assert('arch-arrow has aria-hidden', archAria.arrowHidden);

console.log('\n5. Twin tabs ARIA + keyboard');
const twinAria = await page.evaluate(() => {
    const tablist = document.querySelector('[role="tablist"]');
    if (!tablist) return { tablist: false };
    const tabs = tablist.querySelectorAll('[role="tab"]');
    const panels = document.querySelectorAll('[role="tabpanel"]');
    const activeTab = tablist.querySelector('[aria-selected="true"]');
    return {
        tablist: true,
        tablistLabel: tablist.getAttribute('aria-label'),
        tabCount: tabs.length,
        panelCount: panels.length,
        activeTabId: activeTab ? activeTab.id : null,
        tabs: Array.from(tabs).map(t => ({
            id: t.id, selected: t.getAttribute('aria-selected'),
            controls: t.getAttribute('aria-controls'),
        })),
        panels: Array.from(panels).map(p => ({
            id: p.id, labelledby: p.getAttribute('aria-labelledby'),
        })),
    };
});
assert('tablist exists', twinAria.tablist);
assert('tablist has aria-label', twinAria.tablistLabel && twinAria.tablistLabel.length > 0);
assert('4 tabs', twinAria.tabCount === 4);
assert('4 panels', twinAria.panelCount === 4);
assert('active tab selected', twinAria.activeTabId === 'tab-music');
for (const t of twinAria.tabs) {
    assert(`tab ${t.id} has aria-selected`, t.selected === 'true' || t.selected === 'false');
    assert(`tab ${t.id} has aria-controls`, t.controls && t.controls.startsWith('twin-'));
}
for (const p of twinAria.panels) {
    assert(`panel ${p.id} has aria-labelledby`, p.labelledby && p.labelledby.startsWith('tab-'));
}

// Keyboard navigation: arrow right
await page.evaluate(() => {
    document.querySelector('#tab-music').focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    document.querySelector('[role="tablist"]').dispatchEvent(ev);
});
await new Promise(r => setTimeout(r, 50));
const afterRight = await page.evaluate(() => {
    const active = document.querySelector('[aria-selected="true"]');
    return { id: active?.id, twin: active?.dataset?.twin, isTab: document.activeElement?.id };
});
assert('ArrowRight → next tab active', afterRight.twin === 'transcription');
assert('ArrowRight → focus moves', afterRight.isTab === 'tab-transcription');

// Keyboard navigation: End key
await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    document.querySelector('[role="tablist"]').dispatchEvent(ev);
});
await new Promise(r => setTimeout(r, 50));
const afterEnd = await page.evaluate(() => {
    const active = document.querySelector('[aria-selected="true"]');
    return { id: active?.id, twin: active?.dataset?.twin };
});
assert('End → last tab active', afterEnd.twin === 'research');

// Keyboard navigation: Home key
await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    document.querySelector('[role="tablist"]').dispatchEvent(ev);
});
await new Promise(r => setTimeout(r, 50));
const afterHome = await page.evaluate(() => {
    const active = document.querySelector('[aria-selected="true"]');
    return { id: active?.id, twin: active?.dataset?.twin };
});
assert('Home → first tab active', afterHome.twin === 'music');

// Arrow left from first tab wraps to last
await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    document.querySelector('[role="tablist"]').dispatchEvent(ev);
});
await new Promise(r => setTimeout(r, 50));
const afterLeft = await page.evaluate(() => {
    const active = document.querySelector('[aria-selected="true"]');
    return { id: active?.id, twin: active?.dataset?.twin };
});
assert('ArrowLeft from first → wraps to last', afterLeft.twin === 'research');

console.log('\n6. Decorative icon ARIA');
const iconAria = await page.evaluate(() => {
    const archIcons = document.querySelectorAll('.arch-icon[aria-hidden="true"]');
    const domainIcons = document.querySelectorAll('.domain-icon[aria-hidden="true"]');
    const toolIcons = document.querySelectorAll('.tool-icon[aria-hidden="true"]');
    const h3Spans = document.querySelectorAll('h3 span[aria-hidden="true"]');
    return {
        archIcons: archIcons.length,
        domainIcons: domainIcons.length,
        toolIcons: toolIcons.length,
        h3Spans: h3Spans.length,
    };
});
assert('4 arch-icons with aria-hidden', iconAria.archIcons === 4);
assert('6 domain-icons with aria-hidden', iconAria.domainIcons === 6);
assert('12 tool-icons with aria-hidden', iconAria.toolIcons === 12);
assert('h3 decorative spans with aria-hidden', iconAria.h3Spans > 0);

console.log('\n7. Progress bar');
const progressAria = await page.evaluate(() => {
    const bar = document.getElementById('progressBar');
    if (!bar) return { found: false };
    return {
        found: true,
        role: bar.getAttribute('role'),
        valuemin: bar.getAttribute('aria-valuemin'),
        valuemax: bar.getAttribute('aria-valuemax'),
    };
});
assert('progressBar has role="progressbar"', progressAria.role === 'progressbar');
assert('progressBar aria-valuemin="0"', progressAria.valuemin === '0');
assert('progressBar aria-valuemax="100"', progressAria.valuemax === '100');

console.log('\n8. Layer-details headings');
const layerH3 = await page.evaluate(() => {
    const details = document.querySelectorAll('.layer-details h3');
    return Array.from(details).map(h => ({
        color: h.getAttribute('style') || '',
        span: h.querySelector('span[aria-hidden="true"]'),
    }));
});
assert('4 layer-details h3 elements', layerH3.length === 4);
for (const h of layerH3) {
    assert('layer h3 uses -text var', h.color.includes('accent-') && h.color.includes('-text'));
    assert('layer h3 span is aria-hidden', !!h.span);
}

console.log('\n9. Twin-panel headings');
const twinH3 = await page.evaluate(() => {
    const panels = document.querySelectorAll('.twin-panel h3');
    return Array.from(panels).map(h => ({
        color: h.getAttribute('style') || '',
        span: h.querySelector('span[aria-hidden="true"]'),
    }));
});
assert('4 twin-panel h3 elements', twinH3.length === 4);
for (const h of twinH3) {
    assert('twin h3 uses -text var', h.color.includes('accent-') && h.color.includes('-text'));
}

console.log('\n10. Domain card headings');
const domainHeadings = await page.evaluate(() => {
    const names = document.querySelectorAll('.domain-name');
    return Array.from(names).map(n => n.tagName);
});
assert('6 domain-name h3 elements', domainHeadings.filter(t => t === 'H3').length === 6);

console.log('\n11. Process name headings');
const processHeadings = await page.evaluate(() => {
    const names = document.querySelectorAll('.process-name');
    return Array.from(names).map(n => n.tagName);
});
assert('4 process-name h3 elements', processHeadings.filter(t => t === 'H3').length === 4);

console.log('\n12. Tool name headings');
const toolHeadings = await page.evaluate(() => {
    const names = document.querySelectorAll('.tool-name');
    return Array.from(names).map(n => n.tagName);
});
assert('12 tool-name h3 elements', toolHeadings.filter(t => t === 'H3').length === 12);

console.log('\n13. Footer link');
const footerLink = await page.evaluate(() => {
    const link = document.querySelector('.footer-link');
    if (!link) return { found: false };
    return {
        found: true,
        rel: link.getAttribute('rel'),
        target: link.getAttribute('target'),
        span: link.querySelector('span[aria-hidden="true"]'),
    };
});
assert('footer-link exists', footerLink.found);
assert('footer-link has rel="noopener"', footerLink.rel === 'noopener');
assert('footer-link has target="_blank"', footerLink.target === '_blank');
assert('footer-link span has aria-hidden', !!footerLink.span);

// Final summary
console.log(`\nTotal failures: ${fails.length}`);
console.log('Console errors:', JSON.stringify(errors));
if (fails.length > 0) {
    console.log('FAILED checks:', fails.join(', '));
}
console.log(fails.length === 0 ? 'ALL PASS' : 'SOME FAILED');

await browser.close();
process.exit(fails.length === 0 ? 0 : 1);