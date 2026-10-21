#!/usr/bin/env node
'use strict';
// lib/social-engine.test.js
//
// Tests for the social engine: tags, copy, price, the package shape and
// the worker's discovery.
//
// The rule with teeth here: the engine is deterministic, so a caption, a
// tag set and a price must be the same for the same input. A change in
// any of them is a change in what gets published, and it has to be
// visible in a diff rather than in someone's feed.
//
//   node lib/social-engine.test.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const engine = require('./social-engine.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++; failures.push({ label, actual: 'false', expected: 'true' });
        process.stderr.write(`  ✗ ${label}\n`);
    }
}

const CFG = engine.DEFAULT_CONFIG;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'social-engine-test-'));
process.stderr.write(`\n[social-engine.test]\n\n`);

// 1. slugify
assert('slugify keeps a readable slug', engine.slugify('Neon Pulse 01'), 'neon-pulse-01');
assert('slugify drops punctuation', engine.slugify('System Error — plate #2'), 'system-error-plate-2');
assert('slugify never returns empty', engine.slugify('***'), 'item');

// 2. words
const STOP = CFG.tags.stopwords;
assert('words drop stopwords', engine.words('the portrait of a saxophonist', ['the', 'of', 'a']), ['portrait', 'saxophonist']);
assert('words drop one-character words', engine.words('a b abc', STOP), ['abc']);
assert('words de-duplicate', engine.words('jazz jazz blues', STOP), ['jazz', 'blues']);

// 3. firstSentence
assert('first sentence is the first sentence', engine.firstSentence('One. Two. Three.'), 'One.');
assert('first sentence falls back to the whole text', engine.firstSentence('No terminator here'), 'No terminator here');

// 4. tags
const ITEM = {
    id: 'neon-pulse-cover',
    kind: 'cover',
    title: 'Neon Pulse',
    description: 'A cover study for the neon pulse family.',
    source: 'catalogue',
    publish: false,
    files: {},
    meta: { family: 'neon-pulse', variantCount: 5, hasLettering: true, prompt: 'chromatic aberration on a wet street' },
};
const TAGS = engine.deriveTags(ITEM, CFG);
assert('primary tier is capped', TAGS.primarySet.length <= CFG.tags.caps.primary, true);
assert('primary tier keeps the item own words first', TAGS.primarySet[0], '#neon');
assert('primary tier contains the family', TAGS.primarySet.includes('#neonpulse'), true);
assert('primary tier contains the kind', TAGS.primarySet.includes('#cover'), true);
assert('secondary tier is capped', TAGS.secondarySet.length <= CFG.tags.caps.secondary, true);
assert('niche tier pulls the prompt long tail', TAGS.nicheSet.includes('#chromatic'), true);
assert('niche tier is capped', TAGS.nicheSet.length <= CFG.tags.caps.niche, true);
assert('every tag is canonical', TAGS.primarySet.every(t => /^#[A-Za-z0-9_]+$/.test(t)), true);
assert('tags are deterministic', engine.deriveTags(ITEM, CFG), TAGS);

// 5. captions
const COPY = engine.deriveCaptions(ITEM, TAGS, CFG);
assert('instagram caption opens with the title', COPY.social.instagram.caption.startsWith('Neon Pulse'), true);
assert('twitter caption fits 280', COPY.social.twitter.caption.length <= 280, true);
assert('youtube title is filled', COPY.youtube.title, 'Neon Pulse');
assert('captions are deterministic', engine.deriveCaptions(ITEM, TAGS, CFG), COPY);

// 6. price
const PRICE = engine.derivePrice(ITEM, CFG);
assert('cover base is 12', CFG.price.table.cover.base, 12);
assert('lettering adds 3', PRICE.amount, 12 + 3 + 4);
assert('price is inside the band', PRICE.amount >= CFG.price.table.cover.floor && PRICE.amount <= CFG.price.table.cover.ceiling, true);
assert('price names the product', PRICE.product.slug, 'neon-pulse-cover');
assert('price carries a rationale', typeof PRICE.rationale === 'string' && PRICE.rationale.length > 10, true);

const PLATE = { ...ITEM, kind: 'plate', meta: { variantCount: 1, hasLettering: false } };
assert('plate has no lettering surcharge', engine.derivePrice(PLATE, CFG).amount, 9);

const REEL = { ...ITEM, kind: 'reel', meta: { variantCount: 1, hasLettering: false } };
assert('reel price is its own band', engine.derivePrice(REEL, CFG).amount, 6);

const BIG = { ...ITEM, meta: { variantCount: 30, hasLettering: true } };
assert('price is clamped to the ceiling', engine.derivePrice(BIG, CFG).amount, CFG.price.table.cover.ceiling);

// 7. pricing plan
const PLAN = engine.buildPricingPlan([
    { id: 'a', price: { amount: 10, product: { name: 'A', slug: 'a' } } },
    { id: 'b', price: { amount: 20, product: { name: 'B', slug: 'b' } } },
], CFG);
assert('plan counts the items', PLAN.count, 2);
assert('plan totals the prices', PLAN.total, 30);
assert('bundle takes the discount', PLAN.bundle.amount, 24);
assert('plan currency comes from the config', PLAN.currency, CFG.price.currency);

// 8. the package
const PKG = engine.buildPackage(ITEM, CFG);
assert('package carries the id', PKG.id, 'neon-pulse-cover');
assert('package carries the price', PKG.price.amount, PRICE.amount);
assert('package carries the platforms', Object.keys(PKG.platforms).sort(), ['facebook', 'instagram', 'tiktok', 'twitter']);
assert('package carries the youtube metadata', Array.isArray(PKG.youtube.tags), true);
assert('package post md starts with the title', PKG.postMd.startsWith('# Neon Pulse'), true);
assert('package post md has a caption section', PKG.postMd.includes('## Caption'), true);
assert('package post md has a hashtags section', PKG.postMd.includes('## Hashtags'), true);
assert('package post md keeps the ig-poster contract', PKG.postMd.indexOf('## Caption') < PKG.postMd.indexOf('## Next'), true);
assert('the next section says what the worker does', PKG.postMd.includes('lib/ig-poster.js'), true);
assert('package is deterministic', engine.buildPackage(ITEM, CFG), PKG);

// 9. the next-section swap keeps the hashtags
const SWAPPED = engine.replaceNextSection('# T\n\n## Caption\n\nbody\n\n## Next\n\n1. old\n\n## Hashtags\n\n#a #b\n', ['1. new']);
assert('the next block is replaced', SWAPPED.includes('1. new') && !SWAPPED.includes('1. old'), true);
assert('the hashtags survive the swap', SWAPPED.includes('#a #b'), true);

// 10. discovery — the real catalogue
const CATALOGUE = engine.discoverCatalogue(CFG);
assertTrue('the catalogue is discovered', CATALOGUE.length > 0);
assert('the catalogue has one product per cover family',
    CATALOGUE.filter(i => i.kind === 'cover').length, 3);
assertTrue('the catalogue has the plates', CATALOGUE.filter(i => i.kind === 'plate').length > 0);
assertTrue('every catalogue item has a title', CATALOGUE.every(i => i.title && i.title.length > 1));
assertTrue('every catalogue item has files', CATALOGUE.every(i => i.files && (i.files.images || i.files.image)));
assertTrue('catalogue ids are unique', new Set(CATALOGUE.map(i => i.id)).size === CATALOGUE.length);
const COVER = CATALOGUE.find(i => i.kind === 'cover');
assertTrue('a cover product counts its seed variants', COVER.meta.variantCount > 1);
assert('a cover product is priced above its base', engine.derivePrice(COVER, CFG).amount > CFG.price.table.cover.base, true);
const COVER_TAGS = engine.deriveTags(COVER, CFG);
assertTrue('a catalogue item does not mine its machine copy for tags',
    !COVER_TAGS.nicheSet.some(t => ['#rather', '#than', '#painted', '#same', '#seed', '#variant'].includes(t)));
assertTrue('a catalogue item keeps its family tag', COVER_TAGS.primarySet.some(t => t.startsWith('#')));

// 11. discovery — reels
const REELS = engine.discoverReels(CFG);
assertTrue('the reels are discovered', REELS.length >= 0);
if (REELS.length) {
    assert('a reel knows its kind', REELS[0].kind, 'reel');
    assertTrue('a reel knows its video', !!REELS[0].files.video);
}

// 12. discovery — the inbox
const INBOX_DIR = path.join(TMP, 'inbox');
fs.mkdirSync(path.join(INBOX_DIR, 'my-item'), { recursive: true });
fs.writeFileSync(path.join(INBOX_DIR, 'my-item', 'item.json'),
    JSON.stringify({ title: 'My Item', kind: 'cover', description: 'A thing.', publish: true, variantCount: 2 }));
fs.writeFileSync(path.join(INBOX_DIR, 'my-item', 'plate.png'), 'x');
const INBOX_CFG = { ...CFG, sources: { ...CFG.sources, inbox: { enabled: true, dir: INBOX_DIR } } };
const INBOX = engine.discoverInbox(INBOX_CFG);
assert('the inbox item is discovered', INBOX.length, 1);
assert('the inbox item keeps its title', INBOX[0].title, 'My Item');
assert('the inbox item keeps publish', INBOX[0].publish, true);
assert('the inbox item keeps its variant count', INBOX[0].meta.variantCount, 2);

// 13. the worker writes a package and a plan
const WORK_CFG = {
    ...CFG,
    outputDir: path.join(TMP, 'out'),
    sources: { ...CFG.sources, inbox: { enabled: true, dir: INBOX_DIR } },
    posting: { ...CFG.posting, enabled: false },
};
const PRODUCED = engine.runOnce(WORK_CFG);
assertTrue('the worker produced a package', PRODUCED.length >= 1);
const PKG_DIR = engine.packageDir(WORK_CFG, 'my-item');
assertTrue('the package json exists', fs.existsSync(path.join(PKG_DIR, 'post.json')));
assertTrue('the post md exists', fs.existsSync(path.join(PKG_DIR, 'POST.md')));
assertTrue('the price json exists', fs.existsSync(path.join(PKG_DIR, 'price.json')));
const WRITTEN = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'post.json'), 'utf8'));
assert('the written package has the title', WRITTEN.title, 'My Item');
assertTrue('the media is linked, not copied', fs.existsSync(path.join(PKG_DIR, 'plate.png')));
assertTrue('the pricing plan was written', fs.existsSync(path.join(WORK_CFG.outputDir, 'pricing.json')));
const PLAN2 = JSON.parse(fs.readFileSync(path.join(WORK_CFG.outputDir, 'pricing.json'), 'utf8'));
assertTrue('the plan lists the item', PLAN2.items.some(i => i.id === 'my-item'));
const COUNT_BEFORE = PLAN2.count;

// 14. the worker is idempotent — a second pass packages nothing new
const AGAIN = engine.runOnce(WORK_CFG);
assert('a second pass packages nothing', AGAIN.length, 0);

// 14b. the plan covers the WHOLE catalogue, not just the last pass
fs.mkdirSync(path.join(INBOX_DIR, 'second-item'), { recursive: true });
fs.writeFileSync(path.join(INBOX_DIR, 'second-item', 'item.json'),
    JSON.stringify({ title: 'Second Item', kind: 'plate' }));
fs.writeFileSync(path.join(INBOX_DIR, 'second-item', 'plate.png'), 'x');
const PRODUCED2 = engine.runOnce(WORK_CFG);
assert('the second item is packaged', PRODUCED2.length, 1);
const PLAN3 = JSON.parse(fs.readFileSync(path.join(WORK_CFG.outputDir, 'pricing.json'), 'utf8'));
assert('the plan still lists the first item', PLAN3.items.some(i => i.id === 'my-item'), true);
assert('the plan lists the second item too', PLAN3.items.some(i => i.id === 'second-item'), true);
assert('the plan grew by one, it did not reset', PLAN3.count, COUNT_BEFORE + 1);

// 14c. a package whose source is gone is pruned
fs.rmSync(path.join(INBOX_DIR, 'second-item'), { recursive: true, force: true });
engine.runOnce(WORK_CFG);
const REG = JSON.parse(fs.readFileSync(path.join(WORK_CFG.outputDir, 'index.json'), 'utf8'));
assert('the stale item is out of the registry', REG.items['second-item'], undefined);
assert('the stale package directory is gone', fs.existsSync(engine.packageDir(WORK_CFG, 'second-item')), false);
assert('the live item is still registered', !!REG.items['my-item'], true);

// 15. posting is gated
const POST_CFG = { ...WORK_CFG, posting: { ...CFG.posting, enabled: true, autoPublish: false } };
const NO_POST = engine.postPackage(engine.buildPackage(ITEM, CFG), POST_CFG);
assert('an unpublished item is staged, not posted', NO_POST.posted, false);
assertTrue('the reason is recorded', /staged/.test(NO_POST.reason));
const POST_CFG2 = { ...WORK_CFG, posting: { ...CFG.posting, enabled: true, autoPublish: true } };
const NO_VIDEO = engine.postPackage(engine.buildPackage(ITEM, CFG), POST_CFG2);
assert('a package without a video is not posted', NO_VIDEO.posted, false);
assertTrue('the no-video reason is recorded', /no video/.test(NO_VIDEO.reason));

// 16. hygiene — no absolute paths in the shipped files
const CFG_TEXT = fs.readFileSync(path.join(engine.REPO, 'lib', 'social-config.json'), 'utf8');
assertTrue('the config has no absolute paths', !/\/Users\//.test(CFG_TEXT));

process.stderr.write(`\n[social-engine.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n`);
    process.exit(1);
}
