'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./twin-memory.js');
const note = (id = 'note-1', text = 'Practice #jazz with Željko') => ({ id, text, pinned: false,
  createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z' });
const state = () => ({ ...M.empty(), notes: [note()] });
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
test('first launch is empty; saved notes round-trip and tags are derived from text', () => {
  const store = storage(); assert.deepEqual(M.read(store), M.empty());
  M.write(store, state());
  assert.deepEqual(M.read(store).notes[0].tags, ['jazz']);
});
test('search matches all words regardless of case, order or accents', () => {
  assert.ok(M.matches(note().text, 'zeljko JAZZ'));
  assert.ok(!M.matches(note().text, 'jazz piano'));
  assert.deepEqual(M.tags('#Jazz #jazz #киша #référence'), ['jazz', 'киша', 'reference']);
});
test('corrupt stored data is surfaced and never silently overwritten by read', () => {
  const store = storage(); store.setItem(M.KEY, '{broken');
  assert.throws(() => M.read(store)); assert.equal(store.getItem(M.KEY), '{broken');
});
test('unsupported versions, invalid records, repeated IDs and malformed dates fail', () => {
  for (const invalid of [null, { ...state(), version: 2 }, { ...state(), notes: [null] },
    { ...state(), notes: [note(), note()] }, { ...state(), notes: [{ ...note(), updatedAt: 'yesterday' }] },
    { ...state(), notes: [{ ...note(), pinned: 'yes' }] }, { ...state(), notes: [note('../bad')] }])
    assert.throws(() => M.validate(invalid));
});
test('backup import validates every record before write and is idempotent', () => {
  const current = state(); const incoming = { ...M.empty(), notes: [note('note-1', 'older copy'), note('note-2')],
    spaces: [{ id: 'space-1', name: 'Jazz', query: '#jazz' }] };
  const parsed = M.parseBackup(JSON.stringify({ app: 'digital-twin-memory', ...incoming }));
  const merged = M.merge(current, parsed);
  assert.equal(merged.notes.length, 2); assert.equal(merged.notes[0].text, current.notes[0].text);
  assert.deepEqual(M.merge(merged, parsed), merged);
  assert.throws(() => M.parseBackup(JSON.stringify({ app: 'other', ...state() })));
  assert.throws(() => M.parseBackup(JSON.stringify({ app: 'digital-twin-memory', ...incoming, notes: [note(), null] })));
});
test('capacity limits apply to merged backups, text length and serialized bytes', () => {
  assert.throws(() => M.validate({ ...state(), notes: [note('n', 'x'.repeat(5001))] }));
  const full = { ...state(), notes: Array.from({ length: 1000 }, (_, i) => note('n-' + i)) };
  assert.throws(() => M.merge(full, state()));
  assert.throws(() => M.parseBackup(' '.repeat(M.MAX_BYTES + 1)));
});
test('quota rejection leaves the prior record intact', () => {
  const store = storage(); M.write(store, state()); const before = store.getItem(M.KEY);
  store.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  assert.throws(() => M.write(store, M.empty()), { name: 'QuotaExceededError' });
  assert.equal(store.getItem(M.KEY), before);
});
test('untrusted HTML is retained as plain text and never interpreted by the model', () => {
  const text = '<img src=x onerror=alert(1)> #reference';
  assert.equal(M.validate({ ...M.empty(), notes: [note('n', text)] }).notes[0].text, text);
});
