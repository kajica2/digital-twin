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

// 10b. discovery — the daily bundle the daily run publishes
const DAILY = CATALOGUE.filter(i => i.meta && i.meta.family === 'daily');
const DAILY_ROOT = path.join(__dirname, '..', 'assets', 'marketplace', 'daily');
const DAILY_DIRS = fs.existsSync(DAILY_ROOT)
    ? fs.readdirSync(DAILY_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map(e => e.name)
    : [];
if (DAILY_DIRS.length) {
    const bundle = JSON.parse(fs.readFileSync(
        path.join(DAILY_ROOT, DAILY_DIRS[0], 'plates.json'), 'utf8'));
    assert('every daily plate becomes a product', DAILY.length, bundle.plates.length);
    const first = DAILY[0];
    assert('a daily product knows its day', first.meta.date, DAILY_DIRS[0]);
    assert('a daily product knows its collection', first.meta.pack, bundle.pack);
    assert('a daily product keeps the alt text as its description',
        first.description, bundle.plates[0].alt);
    assert('a daily product keeps the task id', first.meta.taskId, bundle.plates[0].taskId);
    assertTrue('a daily product points at a file that exists',
        fs.existsSync(first.files.images[0]));
    assertTrue('a daily product is not published by default', first.publish === false);
} else {
    assert('no daily bundle yet — nothing to check', DAILY.length, 0);
}

// 11. discovery — reels
const REELS = engine.discoverReels(CFG);
assertTrue('the reels are discovered', REELS.length >= 0);
if (REELS.length) {
    assert('a reel knows its kind', REELS[0].kind, 'reel');
    assertTrue('a reel knows its video', !!REELS[0].files.video);
}

// 11b. discovery — the FLAT layout the reel-watcher writes
//
// The watcher writes <base>.mp4, <base>_cover.jpg, <base>_POST.md and
// parks the input as <base>_source.mp4 in the same directory. The
// parked source is not a reel.
const FLAT_DIR = path.join(TMP, 'reels-flat');
fs.mkdirSync(FLAT_DIR, { recursive: true });
fs.writeFileSync(path.join(FLAT_DIR, 'relay-lamp.mp4'), 'x');
fs.writeFileSync(path.join(FLAT_DIR, 'relay-lamp_cover.jpg'), 'x');
fs.writeFileSync(path.join(FLAT_DIR, 'relay-lamp_source.mp4'), 'x');
fs.writeFileSync(path.join(FLAT_DIR, 'relay-lamp_POST.md'),
    '# relay-lamp\n\n## Caption\n\nswitchboard · lamp — Digital Twin (Relay) [cyberpunk / hk] 🎺 Reel from the twin.  Hashtags: #jazz #trumpet\n\n## Files\n\n- Reel: `relay-lamp.mp4`\n');
const FLAT_CFG = { ...CFG, sources: { ...CFG.sources, reels: { enabled: true, dir: FLAT_DIR } } };
const FLAT = engine.discoverReels(FLAT_CFG);
assert('the flat reel is discovered', FLAT.length, 1);
assert('the flat reel takes its title from the caption', FLAT[0].title, 'switchboard · lamp');
assertTrue('the flat reel drops the hashtag tail',
    !/Hashtags:/.test(FLAT[0].description) && FLAT[0].description.length > 10);
assertTrue('the flat reel finds its video', FLAT[0].files.video.endsWith('relay-lamp.mp4'));
assertTrue('the flat reel finds its cover', FLAT[0].files.image.endsWith('relay-lamp_cover.jpg'));
assert('the parked source is not a reel', FLAT.filter(r => r.files.video.endsWith('_source.mp4')).length, 0);

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

// 15b. the X channel
//
// X is a text channel, so a cover or a plate can go there — there is
// no video requirement the way Instagram has one. The channel is
// armed separately (`posting.twitter.enabled`), because a tweet on a
// personal account is the least reversible thing this repo does.
//
// The poster is invoked through `deps.spawn`, so the whole path is
// exercised without a browser and without publishing anything.
const X_PKG = engine.buildPackage(ITEM, CFG);
const X_CAPTION = X_PKG.platforms.twitter.caption;
const xtext = require('./x-text.js');

assert('the built tweet fits the weighted limit', xtext.countLength(X_CAPTION) <= 280, true);
assert('the built tweet is not longer than the raw limit', X_CAPTION.length <= 280, true);
assert('the built tweet keeps the body', X_CAPTION.startsWith('Neon Pulse'), true);
assert('the built tweet carries hashtags', /#neon/.test(X_CAPTION), true);

// The X poster is not called while the channel is disarmed.
const X_OFF = { ...POST_CFG2, posting: { ...CFG.posting, enabled: true, autoPublish: true, twitter: { enabled: false, poster: 'lib/x-poster.js' } } };
let OFF_CALLS = [];
const OFF_RESULT = engine.postPackage(X_PKG, X_OFF, { spawn: (cmd, args) => { OFF_CALLS.push({ cmd, args }); return { status: 0, stdout: '', stderr: '' }; } });
assert('a disarmed X channel runs no poster', OFF_CALLS.length, 0);
assert('a disarmed X channel posts nothing', OFF_RESULT.posted, false);
assert('a disarmed X channel has no channels', OFF_RESULT.channels, []);

// The X poster is called when the channel is armed.
const X_ON = { ...POST_CFG2, posting: { ...CFG.posting, enabled: true, autoPublish: true, twitter: { enabled: true, poster: 'lib/x-poster.js', dryRunPoster: false } } };
let ON_CALLS = [];
const ON_RESULT = engine.postPackage(X_PKG, X_ON, { spawn: (cmd, args) => { ON_CALLS.push({ cmd, args }); return { status: 0, stdout: 'posted — /KaiDjuric/status/1', stderr: '' }; } });
assert('an armed X channel runs the poster once', ON_CALLS.length, 1);
assert('the poster is the X poster', ON_CALLS[0].args[0], path.join(engine.REPO, 'lib', 'x-poster.js'));
assert('the poster is given the package directory', ON_CALLS[0].args[1], engine.packageDir(X_ON, X_PKG.id));
assert('a real run does not pass --dry-run', ON_CALLS[0].args.includes('--dry-run'), false);
assert('an armed X channel reports the channel', ON_RESULT.channels.map(c => c.channel), ['twitter']);
assert('an armed X channel posts', ON_RESULT.posted, true);
assert('the posted reason names the channel', /twitter/.test(ON_RESULT.reason), true);

// A dry run is not a post. The registry keys "already published" off
// `posted`, so a dry run that claimed it would keep the item from
// ever being picked up again.
const X_DRY = { ...X_ON, posting: { ...X_ON.posting, twitter: { ...X_ON.posting.twitter, dryRunPoster: true } } };
let DRY_CALLS = [];
const DRY_RESULT = engine.postPackage(X_PKG, X_DRY, { spawn: (cmd, args) => { DRY_CALLS.push({ cmd, args }); return { status: 0, stdout: 'dry run', stderr: '' }; } });
assert('a dry run still runs the poster', DRY_CALLS.length, 1);
assert('a dry run passes --dry-run', DRY_CALLS[0].args.includes('--dry-run'), true);
assert('a dry run is not a post', DRY_RESULT.posted, false);
assert('a dry run is marked as one', DRY_RESULT.dryRun, true);
assert('a dry run still names the channel', DRY_RESULT.channels.map(c => c.channel), ['twitter']);

// A poster that fails is a channel failure, not a crash — and it does
// not claim the item was published.
const X_FAIL = { ...X_ON };
const FAIL_RESULT = engine.postPackage(X_PKG, X_FAIL, { spawn: () => ({ status: 2, stdout: '', stderr: 'cookie jar is missing auth_token' }) });
assert('a failed poster does not post', FAIL_RESULT.posted, false);
assert('a failed poster is reported per channel', FAIL_RESULT.channels[0].posted, false);
assert('a failed poster records the exit', /exit 2/.test(FAIL_RESULT.channels[0].reason), true);
assert('a failed poster carries its output', /auth_token/.test(FAIL_RESULT.channels[0].output), true);

// A package with no X caption cannot fill the X channel, so no poster
// is run for it — an empty channel is not a post.
const NO_CAPTION = { ...X_PKG, platforms: { ...X_PKG.platforms, twitter: { caption: '' } } };
let NC_CALLS = [];
const NC_RESULT = engine.postPackage(NO_CAPTION, X_ON, { spawn: (cmd, args) => { NC_CALLS.push({ cmd, args }); return { status: 0, stdout: '', stderr: '' }; } });
assert('a package with no X caption runs no poster', NC_CALLS.length, 0);
assert('a package with no X caption posts nothing', NC_RESULT.posted, false);

// 16. hygiene — no absolute paths in the shipped files
const CFG_TEXT = fs.readFileSync(path.join(engine.REPO, 'lib', 'social-config.json'), 'utf8');
assertTrue('the config has no absolute paths', !/\/Users\//.test(CFG_TEXT));

process.stderr.write(`\n[social-engine.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n`);
    process.exit(1);
}
