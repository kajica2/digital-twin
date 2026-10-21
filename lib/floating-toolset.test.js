// lib/floating-toolset.test.js — unit suite for the floating toolset.
//
// Pure functions only: the payload merge, the viewport clamp, the HTML
// escaping and the four panel renderers. No DOM, no browser.
//
// Run: node lib/floating-toolset.test.js

'use strict';

const path = require('node:path');
const assert = require('node:assert');
const ft = require('./floating-toolset.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

console.log('floating-toolset');

// ---- mergePayload --------------------------------------------------------

check('mergePayload with no patch returns the demo state', () => {
    const out = ft.mergePayload(ft.DEMO, null);
    assert.strictEqual(out.title, ft.DEMO.title);
    assert.strictEqual(out.panels.today.items.length, 3);
    assert.strictEqual(out.panels.nowPlaying.title, 'Coltrane — Naima');
});

check('mergePayload never mutates the demo state', () => {
    ft.mergePayload(ft.DEMO, { title: 'changed', panels: { today: { items: [] } } });
    assert.strictEqual(ft.DEMO.title, '~/twin — online · local');
    assert.strictEqual(ft.DEMO.panels.today.items.length, 3);
});

check('mergePayload keeps the other panels when one is patched', () => {
    const out = ft.mergePayload(ft.DEMO, { panels: { today: { items: [{ time: '11:11', label: 'x' }] } } });
    assert.strictEqual(out.panels.today.items.length, 1);
    assert.strictEqual(out.panels.code.items.length, 3);
    assert.strictEqual(out.panels.patterns.items.length, 3);
});

check('mergePayload overrides the title', () => {
    assert.strictEqual(ft.mergePayload(ft.DEMO, { title: '~/other' }).title, '~/other');
});

check('mergePayload overrides live', () => {
    assert.strictEqual(ft.mergePayload(ft.DEMO, { live: false }).live, false);
    assert.strictEqual(ft.mergePayload(ft.DEMO, { live: true }).live, true);
});

check('mergePayload ignores a non-object patch', () => {
    assert.strictEqual(ft.mergePayload(ft.DEMO, 'nope').title, ft.DEMO.title);
    assert.strictEqual(ft.mergePayload(ft.DEMO, 42).title, ft.DEMO.title);
});

check('mergePayload ignores a non-string title', () => {
    assert.strictEqual(ft.mergePayload(ft.DEMO, { title: 5 }).title, ft.DEMO.title);
});

check('mergePayload merges the footer key by key', () => {
    const out = ft.mergePayload(ft.DEMO, { footer: { right: 'remote' } });
    assert.strictEqual(out.footer.right, 'remote');
    assert.ok(out.footer.left.length > 0);
});

check('mergePayload drops unknown keys', () => {
    const out = ft.mergePayload(ft.DEMO, { nope: 1 });
    assert.strictEqual(out.nope, undefined);
});

// ---- clampPosition -------------------------------------------------------

check('clampPosition keeps a position inside the viewport', () => {
    const p = ft.clampPosition(100, 120, 380, 400, 1200, 800);
    assert.strictEqual(p.x, 100);
    assert.strictEqual(p.y, 120);
});

check('clampPosition pushes an off-screen panel back in', () => {
    const p = ft.clampPosition(5000, 5000, 380, 400, 1200, 800);
    assert.strictEqual(p.x, 1200 - 380);
    assert.strictEqual(p.y, 800 - 400);
});

check('clampPosition pulls a negative position to zero', () => {
    const p = ft.clampPosition(-50, -30, 380, 400, 1200, 800);
    assert.strictEqual(p.x, 0);
    assert.strictEqual(p.y, 0);
});

check('clampPosition rounds to whole pixels', () => {
    const p = ft.clampPosition(10.4, 20.6, 380, 400, 1200, 800);
    assert.strictEqual(p.x, 10);
    assert.strictEqual(p.y, 21);
});

check('clampPosition survives a viewport smaller than the panel', () => {
    const p = ft.clampPosition(10, 10, 380, 400, 200, 150);
    assert.strictEqual(p.x, 0);
    assert.strictEqual(p.y, 0);
});

// ---- escapeHtml ----------------------------------------------------------

check('escapeHtml escapes the dangerous characters', () => {
    assert.strictEqual(ft.escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});

check('escapeHtml escapes null and undefined as empty strings', () => {
    assert.strictEqual(ft.escapeHtml(null), '');
    assert.strictEqual(ft.escapeHtml(undefined), '');
});

// ---- panel renderers -----------------------------------------------------

check('renderToday renders one row per item', () => {
    const html = ft.renderToday({ items: [{ time: '09:00', label: 'warm-up' }, { time: '10:30', label: 'deep work' }] });
    assert.strictEqual((html.match(/class="row"/g) || []).length, 2);
    assert.ok(html.includes('09:00'));
    assert.ok(html.includes('deep work'));
});

check('renderToday escapes the label', () => {
    const html = ft.renderToday({ items: [{ time: '09:00', label: '<script>x</script>' }] });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

check('renderToday renders an empty state when there are no items', () => {
    const html = ft.renderToday({ items: [] });
    assert.ok(html.includes('nothing scheduled'));
});

check('renderNowPlaying renders the title, the meta and one bar per peak', () => {
    const html = ft.renderNowPlaying({ title: 'Coltrane — Naima', meta: 'Bb minor · 76 BPM', peaks: [0.2, 0.8, 0.5] });
    assert.ok(html.includes('Coltrane — Naima'));
    assert.ok(html.includes('Bb minor'));
    assert.strictEqual((html.match(/<span style="height:/g) || []).length, 3);
});

check('renderNowPlaying renders no wave without peaks', () => {
    const html = ft.renderNowPlaying({ title: 'x', meta: 'y' });
    assert.ok(!html.includes('data-wave'));
});

check('renderNowPlaying gives every bar a non-zero height', () => {
    const html = ft.renderNowPlaying({ title: 'x', meta: 'y', peaks: [0, 0] });
    assert.ok(!/height:0px/.test(html));
    assert.ok(/height:2px/.test(html));
});

check('renderCode renders a filled tick for a done item and an empty one otherwise', () => {
    const html = ft.renderCode({ items: [{ repo: 'resona', task: 'fix', done: true }, { repo: 'lyra', task: 'wire' }] });
    assert.strictEqual((html.match(/class="check"/g) || []).length, 2);
    assert.ok(html.includes('background:transparent'));
    assert.ok(html.includes('resona'));
    assert.ok(html.includes('lyra'));
});

check('renderCode renders an empty state when there are no items', () => {
    assert.ok(ft.renderCode({ items: [] }).includes('no open work'));
});

check('renderPatterns renders the arrow between the label and the detail', () => {
    const html = ft.renderPatterns({ items: [{ when: '9am', label: 'warm-up', detail: 'always jazz' }] });
    assert.ok(html.includes('▸'));
    assert.ok(html.includes('always jazz'));
});

check('renderPatterns renders an empty state when there are no items', () => {
    assert.ok(ft.renderPatterns({ items: [] }).includes('nothing noticed yet'));
});

check('renderFooter renders both sides', () => {
    const html = ft.renderFooter({ left: 'twin  3 agents running', right: 'local' });
    assert.ok(html.includes('3 agents running'));
    assert.ok(html.includes('local'));
    assert.ok(html.includes('foot-right'));
});

// ---- the shipped payload -------------------------------------------------

check('the shipped payload matches the demo state it mirrors', () => {
    const fs = require('node:fs');
    const file = path.resolve(__dirname, '..', 'data', 'twin', 'toolset.json');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(payload.title, ft.DEMO.title);
    assert.strictEqual(payload.panels.today.items.length, 3);
    assert.strictEqual(payload.panels.nowPlaying.peaks.length, ft.DEMO.panels.nowPlaying.peaks.length);
    assert.strictEqual(payload.panels.code.items.length, 3);
    assert.strictEqual(payload.panels.patterns.items.length, 3);
    assert.strictEqual(payload.footer.right, 'local');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
