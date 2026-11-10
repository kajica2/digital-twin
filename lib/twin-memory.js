/* Local memory model. Classic browser script + CommonJS for the same validation in tests. */
(function (root) {
  'use strict';
  const KEY = 'dt-memory-v1';
  const MAX_BYTES = 2 * 1024 * 1024;
  const empty = () => ({ version: 1, notes: [], spaces: [] });
  const id = () => 'm-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2));
  const normalize = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tags = text => [...new Set((text.match(/#[\p{L}\p{N}_-]+/gu) || []).map(x => normalize(x.slice(1))))];
  const matches = (text, query) => normalize(query).trim().split(/\s+/).every(word => normalize(text).includes(word));
  function validate(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.notes) || !Array.isArray(state.spaces))
      throw new Error('This is not a supported memory backup (version 1).');
    if (state.notes.length > 1000 || state.spaces.length > 20) throw new Error('Memory supports up to 1,000 notes and 20 saved searches.');
    const ids = new Set();
    function validId(value) {
      if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value) || ids.has(value)) throw new Error('Memory contains an invalid or repeated ID.');
      ids.add(value);
      return value;
    }
    function text(value, max) {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Memory contains missing or oversized text.');
      return value.trim();
    }
    function date(value) {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Memory contains an invalid date.');
      return new Date(value).toISOString();
    }
    return {
      version: 1,
      notes: state.notes.map(note => {
        if (!note || typeof note.pinned !== 'boolean') throw new Error('Memory contains an invalid note.');
        const body = text(note.text, 5000);
        return { id: validId(note.id), text: body, tags: tags(body), pinned: note.pinned,
          createdAt: date(note.createdAt), updatedAt: date(note.updatedAt) };
      }),
      spaces: state.spaces.map(space => {
        if (!space) throw new Error('Memory contains an invalid saved search.');
        return { id: validId(space.id), name: text(space.name, 60), query: text(space.query, 200) };
      })
    };
  }
  function read(storage) {
    const raw = storage.getItem(KEY);
    return raw === null ? empty() : validate(JSON.parse(raw));
  }
  function write(storage, state) {
    const valid = validate(state);
    const raw = JSON.stringify(valid);
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Memory is too large. Export a backup, then remove older notes.');
    storage.setItem(KEY, raw); // One atomic write; a quota failure leaves the previous state intact.
    return valid;
  }
  function parseBackup(raw) {
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Choose a memory backup smaller than 2 MB.');
    const backup = JSON.parse(raw);
    if (!backup || backup.app !== 'digital-twin-memory') throw new Error('Choose a Digital Twin memory backup.');
    return validate(backup);
  }
  function merge(current, incoming) {
    validate(current); validate(incoming);
    // Existing IDs always win. Reimporting a backup never duplicates or overwrites a note.
    const ids = new Set([...current.notes, ...current.spaces].map(item => item.id));
    return validate({ version: 1,
      notes: [...current.notes, ...incoming.notes.filter(item => !ids.has(item.id))],
      spaces: [...current.spaces, ...incoming.spaces.filter(item => !ids.has(item.id))] });
  }
  const api = { KEY, MAX_BYTES, empty, id, tags, matches, validate, read, write, parseBackup, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TwinMemory = api;
})(globalThis);
