// lib/daily-content.test.js
//
// Pure-Node tests for the daily content run. Same convention as the
// rest of the repo: `node:assert/strict`, a `check(name, cond)`
// helper, plain `node <file>` runner, non-zero exit on failure.
//
// The network parts (Midjourney submission, the CDN download) are not
// exercised here — they are verified by a real run, the way the MJ
// submitter and the contact sheet are.

'use strict';

const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const {
  formatDate, dayOfYear, parseLocalDate, pickCollection, buildPromptPack,
  plateFileName, buildEntry, updateIndex, offendingPaths, PUBLISH_ALLOW,
} = require('./daily-content.js');

const LIBRARY = JSON.parse(readFileSync(join(__dirname, 'daily-collections.json'), 'utf8'));

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}
function section(n) { console.log(`${n}.`); }
function freshDate(y, m, d) { return new Date(y, m - 1, d); }

// --------------------------------------------------------------------
section('the library');
// --------------------------------------------------------------------

(function () {
  const list = LIBRARY.collections || [];
  check('the library has collections', list.length > 0);
  check('every collection has an id, title, badge and teaser',
    list.every(c => c.id && c.title && c.badge && c.teaser));
  check('every collection has three plates', list.every(c => (c.plates || []).length === 3));
  check('every plate has a caption, alt text and prompt',
    list.every(c => c.plates.every(p => p.caption && p.alt && p.prompt)));
  check('the ids are unique', new Set(list.map(c => c.id)).size === list.length);
  check('every prompt is subject-first (no leading camera clause)',
    list.every(c => c.plates.every(p => !/^(shot|photo|photograph|camera)\b/i.test(p.prompt.trim()))));
  check('every prompt asks for no text', list.every(c => c.plates.every(p => /no text/i.test(p.prompt))));
  check('no prompt carries its own --ar (the pipeline appends it)',
    list.every(c => c.plates.every(p => !/--ar\b/.test(p.prompt))));
  check('no absolute path leaks into the library',
    !JSON.stringify(LIBRARY).includes('/Users/'));
})();

// --------------------------------------------------------------------
section('formatDate / dayOfYear / parseLocalDate');
// --------------------------------------------------------------------

(function () {
  check('Jan 1  -> 2026-01-01', formatDate(freshDate(2026, 1, 1)) === '2026-01-01');
  check('pads single-digit month + day', formatDate(freshDate(2026, 4, 9)) === '2026-04-09');
  check('day of year: Jan 1 is 1', dayOfYear(freshDate(2026, 1, 1)) === 1);
  check('day of year: Dec 31 is 365 in a common year', dayOfYear(freshDate(2026, 12, 31)) === 365);
  check('parseLocalDate reads a valid date', formatDate(parseLocalDate('2026-10-22')) === '2026-10-22');
  check('parseLocalDate rejects a bad month', parseLocalDate('2026-13-01') === null);
  check('parseLocalDate rejects a bad day', parseLocalDate('2026-02-31') === null);
  check('parseLocalDate rejects junk', parseLocalDate('yesterday') === null);
})();

// --------------------------------------------------------------------
section('pickCollection');
// --------------------------------------------------------------------

(function () {
  const d = freshDate(2026, 10, 22);
  const c = pickCollection(LIBRARY, d, null);
  check('a date picks a collection', !!c);
  check('the same date always picks the same collection',
    pickCollection(LIBRARY, d, null).id === pickCollection(LIBRARY, new Date(d), null).id);
  check('a different date in the cycle picks a different collection',
    pickCollection(LIBRARY, freshDate(2026, 10, 23), null).id !== c.id);
  check('an explicit id wins', pickCollection(LIBRARY, d, 'last-ferry').id === 'last-ferry');
  check('an unknown id returns null', pickCollection(LIBRARY, d, 'nope') === null);
  check('the cycle wraps (day 1 and day 1+n agree)',
    pickCollection(LIBRARY, freshDate(2026, 1, 1), null).id ===
    pickCollection(LIBRARY, freshDate(2026, 1, 1 + LIBRARY.collections.length), null).id);
})();

// --------------------------------------------------------------------
section('buildPromptPack');
// --------------------------------------------------------------------

(function () {
  const collection = LIBRARY.collections[0];
  const { markdown, prompts, plates } = buildPromptPack(collection, 3);
  check('one prompt per plate', prompts.length === 3 && plates.length === 3);
  check('every prompt ends with --ar 16:9', prompts.every(p => /--ar 16:9$/.test(p)));
  check('every prompt carries the library text', prompts.every((p, i) => p.startsWith(collection.plates[i].prompt)));
  check('the pack has one top-level bullet per prompt',
    markdown.split('\n').filter(l => l.startsWith('- ')).length === 3);
  check('the pack has no other bullet', !/^\s*[-*]\s/m.test(markdown.split('\n').filter(l => !l.startsWith('- ')).join('\n')));
  check('--count truncates', buildPromptPack(collection, 2).prompts.length === 2);
  check('the profile codes are appended',
    buildPromptPack(collection, 1, '16:9', ['abc', 'def']).prompts[0].includes('--profile abc def'));
  check('the profile codes come after the text and before --ar',
    /--profile abc def --ar 16:9$/.test(buildPromptPack(collection, 1, '16:9', ['abc', 'def']).prompts[0]));
  check('no profile codes means no --profile flag',
    !buildPromptPack(collection, 1, '16:9', []).prompts[0].includes('--profile'));
  check('a prompt that already carries --ar does not get a second one',
    buildPromptPack({ plates: [{ prompt: 'a wet street at night --ar 1:1' }] }, 1).prompts[0].match(/--ar/g).length === 1);
})();

// --------------------------------------------------------------------
section('plateFileName / buildEntry');
// --------------------------------------------------------------------

(function () {
  check('the first plate is frame-01.jpg', plateFileName(1) === 'frame-01.jpg');
  check('the tenth plate is frame-10.jpg', plateFileName(10) === 'frame-10.jpg');
  const collection = LIBRARY.collections[0];
  const entry = buildEntry({
    date: '2026-10-22', collection,
    plates: [{ caption: 'a', alt: 'b', prompt: 'c', taskId: 't', width: 640, height: 360 }],
  });
  check('the entry carries the collection copy',
    entry.title === collection.title && entry.badge === collection.badge && entry.teaser === collection.teaser);
  check('the entry points at its published dir', entry.dir === 'assets/marketplace/daily/2026-10-22');
  check('the entry carries the plate copy and provenance',
    entry.plates[0].caption === 'a' && entry.plates[0].alt === 'b' &&
    entry.plates[0].taskId === 't' && entry.plates[0].width === 640);
})();

// --------------------------------------------------------------------
section('updateIndex');
// --------------------------------------------------------------------

(function () {
  const e1 = buildEntry({ date: '2026-10-21', collection: LIBRARY.collections[0], plates: [] });
  const e2 = buildEntry({ date: '2026-10-22', collection: LIBRARY.collections[1], plates: [] });
  const idx = updateIndex({ collections: [] }, e1);
  check('the first entry lands in the index', idx.collections.length === 1);
  check('a newer date goes first', updateIndex(idx, e2).collections[0].date === '2026-10-22');
  check('the count matches the list', updateIndex(idx, e2).count === 2);
  const again = updateIndex(updateIndex(idx, e2), e2);
  check('re-running the same date replaces it', again.collections.length === 2);
  check('the index carries an updatedAt stamp', typeof again.updatedAt === 'string' && again.updatedAt.length > 10);
  const many = { collections: [] };
  for (let i = 1; i <= 40; i++) {
    many.collections.push(buildEntry({ date: `2026-01-${String(i).padStart(2, '0')}`, collection: LIBRARY.collections[0], plates: [] }));
  }
  check('the index is capped', updateIndex(many, e2, 30).collections.length === 30);
})();

// --------------------------------------------------------------------
section('offendingPaths — the publish guard');
// --------------------------------------------------------------------

(function () {
  // The guard is about the INDEX: the publish stages an explicit file list
  // and commits it, so only what is already staged can be swallowed.
  check('a clean tree has no offenders', offendingPaths('').length === 0);
  check('a staged change under the allowlist is allowed',
    offendingPaths('M  assets/marketplace/daily/index.json').length === 0);
  check('a new file in the daily dir is allowed',
    offendingPaths('?? assets/marketplace/daily/2026-10-22/frame-01.jpg').length === 0);
  check('a staged change elsewhere is refused',
    offendingPaths('M  pages/marketplace.html').length === 1);
  check('the refusal names the path',
    offendingPaths('M  pages/marketplace.html')[0] === 'pages/marketplace.html');
  check('an unstaged change elsewhere is not the job\'s business',
    offendingPaths(' M pages/marketplace.html').length === 0);
  check('an untracked file elsewhere is not the job\'s business',
    offendingPaths('?? assets/mural-prompts/new-pack.md').length === 0);
  check('a staged addition elsewhere is refused',
    offendingPaths('A  lib/mj-web.js').length === 1);
  check('a staged deletion elsewhere is refused',
    offendingPaths('D  pages/twin-os/index.html').length === 1);
  check('two staged offenders are both reported',
    offendingPaths('M  pages/marketplace.html\nA  lib/mj-web.js').length === 2);
  check('the allowlist is the daily dir', PUBLISH_ALLOW.includes('assets/marketplace/daily/'));
})();

// --------------------------------------------------------------------
section('the published bundle contract');
// --------------------------------------------------------------------

(function () {
  // The page reads the index; the plates manifest is the evidence. Both
  // have to exist for the daily section to be checkable.
  const indexPath = join(__dirname, '..', 'assets', 'marketplace', 'daily', 'index.json');
  if (!existsSync(indexPath)) {
    console.log('  (no published daily bundle yet — nothing to check)');
    return;
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  check('the index has collections', Array.isArray(index.collections));
  check('every collection has a date, a title and a dir',
    index.collections.every(c => c.date && c.title && c.dir));
  check('every collection has at least one plate',
    index.collections.every(c => Array.isArray(c.plates) && c.plates.length > 0));
  check('every plate has a caption and alt text',
    index.collections.every(c => c.plates.every(p => p.caption && p.alt)));
  check('the newest collection is first',
    index.collections.length < 2 ||
    index.collections[0].date >= index.collections[1].date);
})();

console.log(`\n[daily-content.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
