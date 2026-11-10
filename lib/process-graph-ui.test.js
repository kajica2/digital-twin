#!/usr/bin/env node
'use strict';
/**
 * Pure checks for lib/process-graph-ui.js — no DOM, no network.
 */
const assert = require('assert');
const path = require('path');
const {
  escapeHtml,
  findPackage,
  listPackages,
  apiBaseFrom,
} = require('./process-graph-ui.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name);
    console.log('  ' + (err && err.message ? err.message : err));
  }
}

const catalog = {
  version: 1,
  packages: [
    {
      id: 'lyrics-to-frames',
      title: 'Lyrics → frames',
      summary: 'lyric pack → cut',
      browserOk: true,
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [['a', 'b']],
    },
    {
      id: 'evolution',
      title: 'Evolution',
      summary: 'CLIP walk',
      browserOk: false,
      nodes: [{ id: 'x' }],
      edges: [],
    },
  ],
};

check('escapeHtml escapes angle brackets and quotes', () => {
  assert.strictEqual(escapeHtml('<a "b">'), '&lt;a &quot;b&quot;&gt;');
});

check('listPackages returns id/title/browserOk/counts', () => {
  const list = listPackages(catalog);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'lyrics-to-frames');
  assert.strictEqual(list[0].browserOk, true);
  assert.strictEqual(list[0].nodes, 2);
  assert.strictEqual(list[0].edges, 1);
  assert.strictEqual(list[1].browserOk, false);
});

check('listPackages tolerates a missing catalog', () => {
  assert.deepStrictEqual(listPackages(null), []);
  assert.deepStrictEqual(listPackages({}), []);
});

check('findPackage returns the named package', () => {
  const pkg = findPackage(catalog, 'evolution');
  assert.ok(pkg);
  assert.strictEqual(pkg.title, 'Evolution');
});

check('findPackage returns null for unknown / empty', () => {
  assert.strictEqual(findPackage(catalog, 'nope'), null);
  assert.strictEqual(findPackage(catalog, ''), null);
  assert.strictEqual(findPackage(null, 'x'), null);
});

check('apiBaseFrom always points at /api/process', () => {
  assert.strictEqual(apiBaseFrom('../../data/twin/process-graphs.json'), '/api/process');
  assert.strictEqual(apiBaseFrom('/data/twin/process-graphs.json'), '/api/process');
});

check('the four MJ flows are in the shipped catalog', () => {
  const shipped = require(path.join(__dirname, '..', 'data', 'twin', 'process-graphs.json'));
  const ids = shipped.packages.map((p) => p.id);
  for (const id of ['lyrics-to-frames', 'next-in-order', 'evolution', 'mutation']) {
    assert.ok(ids.includes(id), 'missing ' + id);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
