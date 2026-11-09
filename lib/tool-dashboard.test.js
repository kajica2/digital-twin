// lib/tool-dashboard.test.js — unit suite for the tool-dashboard component.
//
// Pure functions only: family → payload, catalog merge, find/list, clamp,
// escape. No DOM, no browser.
//
// Run: node lib/tool-dashboard.test.js

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const td = require('./tool-dashboard.js');

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
        console.log(`      ${err && err.message ? err.message : err}`);
    }
}

console.log('tool-dashboard');

// ---- catalog on disk -----------------------------------------------------

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'twin', 'tool-dashboards.json');
let CATALOG = null;
check('shipped catalog exists and parses', () => {
    assert.ok(fs.existsSync(CATALOG_PATH), 'data/twin/tool-dashboards.json missing');
    CATALOG = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    assert.ok(Array.isArray(CATALOG.families));
    assert.ok(CATALOG.families.length >= 8);
});

check('catalog familyCount and suiteCount match the lists', () => {
    assert.strictEqual(CATALOG.familyCount, CATALOG.families.length);
    const n = CATALOG.families.reduce((s, f) => s + (f.suites ? f.suites.length : 0), 0);
    assert.strictEqual(CATALOG.suiteCount, n);
});

check('every family has id, label, suites, run, docs, status', () => {
    for (const f of CATALOG.families) {
        assert.ok(f.id && typeof f.id === 'string', 'missing id');
        assert.ok(f.label && typeof f.label === 'string', 'missing label on ' + f.id);
        assert.ok(Array.isArray(f.suites) && f.suites.length > 0, 'empty suites on ' + f.id);
        assert.ok(Array.isArray(f.run) && f.run.length > 0, 'empty run on ' + f.id);
        assert.ok(Array.isArray(f.docs) && f.docs.length > 0, 'empty docs on ' + f.id);
        assert.ok(f.status && typeof f.status.state === 'string', 'missing status on ' + f.id);
        for (const r of f.run) {
            assert.ok(r.cmd && typeof r.cmd === 'string', 'run.cmd missing on ' + f.id);
        }
        for (const d of f.docs) {
            assert.ok(d.href && typeof d.href === 'string', 'docs.href missing on ' + f.id);
            assert.ok(!d.href.startsWith('/Users/'), 'absolute path in docs for ' + f.id);
            assert.ok(!d.href.startsWith('/home/'), 'absolute path in docs for ' + f.id);
        }
    }
});

check('suite ids are unique across the catalog', () => {
    const seen = new Set();
    for (const f of CATALOG.families) {
        for (const s of f.suites) {
            assert.ok(!seen.has(s), 'duplicate suite ' + s);
            seen.add(s);
        }
    }
    assert.strictEqual(seen.size, CATALOG.suiteCount);
});

check('catalog covers every npm run in test:all', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const chain = pkg.scripts['test:all'];
    assert.ok(chain, 'test:all missing');
    const parts = chain.match(/npm run ([^&\s]+)/g).map((m) => m.replace(/^npm run /, ''));
    const covered = new Set();
    for (const f of CATALOG.families) for (const s of f.suites) covered.add(s);
    const missing = parts.filter((p) => !covered.has(p));
    assert.deepStrictEqual(missing, [], 'missing from catalog: ' + missing.join(', '));
    const extra = [...covered].filter((s) => !parts.includes(s));
    assert.deepStrictEqual(extra, [], 'extra in catalog: ' + extra.join(', '));
});

// ---- familyToPayload -----------------------------------------------------

check('familyToPayload builds the four panels from a family', () => {
    const fam = CATALOG.families[0];
    const out = td.familyToPayload(fam);
    assert.ok(out.title.indexOf(fam.label) >= 0 || out.title.indexOf(fam.id) >= 0);
    assert.strictEqual(out.live, true);
    assert.ok(out.panels.tests.items.length === fam.suites.length);
    assert.ok(out.panels.run.items.length === fam.run.length);
    assert.ok(out.panels.docs.items.length === fam.docs.length);
    assert.ok(out.panels.status && typeof out.panels.status.state === 'string');
    assert.ok(out.footer.left.length > 0);
});

check('familyToPayload never mutates the family', () => {
    const fam = JSON.parse(JSON.stringify(CATALOG.families[0]));
    const before = JSON.stringify(fam);
    td.familyToPayload(fam);
    assert.strictEqual(JSON.stringify(fam), before);
});

check('familyToPayload falls back to the demo family on a bad input', () => {
    const out = td.familyToPayload(null);
    assert.strictEqual(out.title, td.familyToPayload(td.DEMO_FAMILY).title);
    assert.ok(out.panels.tests.items.length > 0);
});

check('familyToPayload marks a missing status as unknown', () => {
    const out = td.familyToPayload({ id: 'x', label: 'X', suites: ['test:x'], run: [], docs: [] });
    assert.strictEqual(out.panels.status.state, 'unknown');
});

// ---- mergeCatalog / findFamily / listSuites ------------------------------

check('mergeCatalog with no patch returns the demo catalog', () => {
    const out = td.mergeCatalog(td.DEMO_CATALOG, null);
    assert.strictEqual(out.families.length, td.DEMO_CATALOG.families.length);
    assert.strictEqual(out.families[0].id, td.DEMO_CATALOG.families[0].id);
});

check('mergeCatalog never mutates the demo catalog', () => {
    const before = JSON.stringify(td.DEMO_CATALOG);
    td.mergeCatalog(td.DEMO_CATALOG, { families: [] });
    assert.strictEqual(JSON.stringify(td.DEMO_CATALOG), before);
});

check('mergeCatalog accepts a shipped catalog shape', () => {
    const out = td.mergeCatalog(td.DEMO_CATALOG, CATALOG);
    assert.strictEqual(out.families.length, CATALOG.families.length);
    assert.strictEqual(out.suiteCount, CATALOG.suiteCount);
});

check('findFamily returns the matching family by id', () => {
    const hit = td.findFamily(CATALOG, 'midjourney');
    assert.ok(hit);
    assert.strictEqual(hit.id, 'midjourney');
});

check('findFamily returns null for an unknown id', () => {
    assert.strictEqual(td.findFamily(CATALOG, 'nope'), null);
    assert.strictEqual(td.findFamily(null, 'watchers'), null);
});

// The pending-family race depends on mergeCatalog accepting an empty
// families array (so a pre-catalog showFamily cannot find the request)
// and on findFamily returning null for that request against the empty
// catalog. Pin both halves here so the e2e is not the only guard.
check('mergeCatalog with empty families yields an empty catalog', () => {
    const out = td.mergeCatalog(td.DEMO_CATALOG, { families: [] });
    assert.strictEqual(out.families.length, 0);
    assert.strictEqual(out.familyCount, 0);
    assert.strictEqual(td.findFamily(out, 'suno'), null);
    assert.strictEqual(td.findFamily(out, 'watchers'), null);
});

check('findFamily resolves every shipped family id', () => {
    for (const f of CATALOG.families) {
        const hit = td.findFamily(CATALOG, f.id);
        assert.ok(hit, 'missing ' + f.id);
        assert.strictEqual(hit.id, f.id);
    }
});

check('listSuites flattens every suite across families', () => {
    const list = td.listSuites(CATALOG);
    assert.strictEqual(list.length, CATALOG.suiteCount);
    assert.ok(list.includes('test:watcher'));
    assert.ok(list.includes('skin:check'));
    assert.ok(list.includes('prompt:check'));
});

check('listSuites on the demo catalog is non-empty', () => {
    assert.ok(td.listSuites(td.DEMO_CATALOG).length >= 1);
});

// ---- clampPosition / escapeHtml ------------------------------------------

check('clampPosition keeps a point inside the viewport', () => {
    const out = td.clampPosition(10, 10, 200, 100, 800, 600);
    assert.ok(out.x >= 0 && out.y >= 0);
    assert.ok(out.x + 200 <= 800);
    assert.ok(out.y + 100 <= 600);
});

check('clampPosition pulls an off-screen panel back in', () => {
    const out = td.clampPosition(9000, 9000, 200, 100, 800, 600);
    assert.ok(out.x + 200 <= 800 + 1);
    assert.ok(out.y + 100 <= 600 + 1);
});

check('escapeHtml escapes the five markup characters', () => {
    assert.strictEqual(td.escapeHtml('<a href="x">&\'</a>'),
        '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

check('escapeHtml returns empty string for nullish', () => {
    assert.strictEqual(td.escapeHtml(null), '');
    assert.strictEqual(td.escapeHtml(undefined), '');
});

// ---- DEMO exports --------------------------------------------------------

check('DEMO_FAMILY and DEMO_CATALOG are exported', () => {
    assert.ok(td.DEMO_FAMILY && td.DEMO_FAMILY.id);
    assert.ok(td.DEMO_CATALOG && Array.isArray(td.DEMO_CATALOG.families));
});

check('family ids in the shipped catalog are the eight expected', () => {
    const ids = CATALOG.families.map((f) => f.id).sort();
    assert.deepStrictEqual(ids, [
        'marketplace', 'media', 'midjourney', 'platform',
        'social', 'suno', 'treblo', 'watchers',
    ].sort());
});

// ---- summary -------------------------------------------------------------

console.log('');
console.log(failed === 0
    ? `tool-dashboard — ${passed} passed, 0 failed`
    : `tool-dashboard — ${passed} passed, ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
