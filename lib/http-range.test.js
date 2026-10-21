'use strict';
// lib/http-range.test.js
//
// Pure-Node assertions for the Range parser serve.js depends on. No server,
// no socket, no deps — same convention as chart-watcher.test.js.
//
// Run: npm run test:range

const assert = require('node:assert/strict');
const { parseRange } = require('./http-range.js');

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${label}\n    ${e.message.split('\n')[0]}`);
  }
}

const SIZE = 1000;

// --- absent / ignored forms -> null (caller sends the full 200) ------------
check('no header -> null', () => {
  assert.equal(parseRange(undefined, SIZE), null);
  assert.equal(parseRange(null, SIZE), null);
  assert.equal(parseRange('', SIZE), null);
});
check('non-bytes unit -> null', () => {
  assert.equal(parseRange('items=0-10', SIZE), null);
});
check('multi-range -> null (we serve 200, not multipart)', () => {
  assert.equal(parseRange('bytes=0-10,20-30', SIZE), null);
});
check('bare "bytes=-" -> null', () => {
  assert.equal(parseRange('bytes=-', SIZE), null);
});
check('garbage -> null', () => {
  assert.equal(parseRange('bytes=abc-def', SIZE), null);
});
check('float offsets -> null, not a silent truncation', () => {
  assert.equal(parseRange('bytes=1.5-2.5', SIZE), null);
});

// --- satisfiable single ranges --------------------------------------------
check('closed range', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
});
check('open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=500-', SIZE), { start: 500, end: 999 });
});
check('mid-file range', () => {
  assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 });
});
check('end past EOF is clamped, not rejected', () => {
  assert.deepEqual(parseRange('bytes=900-5000', SIZE), { start: 900, end: 999 });
});
check('single byte', () => {
  assert.deepEqual(parseRange('bytes=0-0', SIZE), { start: 0, end: 0 });
});
check('last byte', () => {
  assert.deepEqual(parseRange('bytes=999-999', SIZE), { start: 999, end: 999 });
});
check('whole file', () => {
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 });
});
check('surrounding whitespace tolerated', () => {
  assert.deepEqual(parseRange('  bytes=10-20  ', SIZE), { start: 10, end: 20 });
});

// --- suffix ranges ("last N bytes") ---------------------------------------
check('suffix of 100', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 });
});
check('suffix longer than the file yields the whole file', () => {
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
});
check('suffix of 1 is the last byte', () => {
  assert.deepEqual(parseRange('bytes=-1', SIZE), { start: 999, end: 999 });
});
check('suffix of 0 -> unsatisfiable', () => {
  assert.equal(parseRange('bytes=-0', SIZE), 'unsatisfiable');
});

// --- unsatisfiable (caller answers 416) -----------------------------------
check('start beyond EOF -> unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', SIZE), 'unsatisfiable');
  assert.equal(parseRange('bytes=5000-6000', SIZE), 'unsatisfiable');
});
check('inverted range -> unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-100', SIZE), 'unsatisfiable');
});
check('any range on an empty file -> unsatisfiable', () => {
  assert.equal(parseRange('bytes=0-10', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=-10', 0), 'unsatisfiable');
});

// --- invariants over a sweep ----------------------------------------------
check('every satisfiable result is in-bounds and non-empty', () => {
  for (const size of [1, 2, 7, 512, 1000, 65_536]) {
    for (const h of ['bytes=0-', 'bytes=0-0', 'bytes=1-', `bytes=0-${size}`,
                     `bytes=${size - 1}-${size - 1}`, 'bytes=-3', `bytes=0-${size * 2}`]) {
      const r = parseRange(h, size);
      if (r === null || r === 'unsatisfiable') continue;
      assert.ok(r.start >= 0, `${h} @${size}: start ${r.start} < 0`);
      assert.ok(r.end < size, `${h} @${size}: end ${r.end} >= ${size}`);
      assert.ok(r.start <= r.end, `${h} @${size}: start > end`);
    }
  }
});
check('length is always end-start+1 (what serve.js writes)', () => {
  for (const h of ['bytes=0-0', 'bytes=10-20', 'bytes=999-', 'bytes=-7']) {
    const r = parseRange(h, SIZE);
    if (!r || r === 'unsatisfiable') continue;
    assert.equal(r.end - r.start + 1, r.end - r.start + 1);
    assert.ok(r.end - r.start + 1 >= 1);
  }
});

// --- report ---------------------------------------------------------------
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n  ${failures.length} of ${total} checks FAILED:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error('');
  process.exit(1);
}
console.log(`  range parser: ${pass}/${total} checks pass`);
