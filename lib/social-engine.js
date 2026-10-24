#!/usr/bin/env node
'use strict';
// lib/social-engine.js — the social engine.
//
// One asset in, one social package out: tags, per-platform copy, a
// price, and a post that the poster can publish.
//
//   node lib/social-engine.js            # worker: poll and process
//   node lib/social-engine.js --once     # one pass, then exit
//   node lib/social-engine.js --dry-run  # compute, print, write nothing
//
// The engine is deterministic: no model call, no network. The copy is
// written from the item's own fields, the tags from the item's own
// words plus the configured pools, the price from the configured table.
// A worker you can reason about is worth more here than a worker that
// surprises you.
//
// The caption/tag layer is NOT reimplemented: lib/social-shared.js owns
// hashtag canonicalisation, the per-platform caption builder, the
// YouTube metadata shape and the POST.md contract that
// lib/ig-poster.js reads. This file builds a persona-shaped object and
// hands it to that module, so there is exactly one implementation of
// "what a caption is".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const pack = require('./social-shared.js');
const xtext = require('./x-text.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'social-config.json');
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const KIND_LABELS = {
    cover: 'cover study',
    plate: 'art plate',
    reel: 'reel',
    generic: 'asset',
};

function log(msg) { process.stdout.write(`[social-engine] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[social-engine] ${msg}\n`); }

function readConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function repoPath(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return path.isAbsolute(p) ? p : path.join(REPO, p);
}

// ---------------------------------------------------------------------------
// pure: text
// ---------------------------------------------------------------------------

function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'item';
}

function titleCase(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Capitalise the first letter, leave the rest as it is. */
function sentenceCase(text) {
    const t = String(text || '').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * The usable words of a text: lowercased, stopwords and one-character
 * words removed. Numbers are kept — "1975" is a tag, "1950s" too.
 */
function words(text, stopwords) {
    const stop = new Set((stopwords || []).map(w => w.toLowerCase()));
    const out = [];
    const seen = new Set();
    const raw = String(text || '').toLowerCase().split(/[^a-z0-9']+/);
    for (const w of raw) {
        const clean = w.replace(/'/g, '');
        if (clean.length < 3) continue;
        if (stop.has(clean)) continue;
        // "832" is a pixel count, not a tag. A year might be.
        if (/^\d+$/.test(clean) && !/^(19|20)\d{2}$/.test(clean)) continue;
        if (seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

function firstSentence(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t) return '';
    const m = t.match(/^(.+?[.!?])\s/);
    if (m) return m[1].trim();
    return t.length > 180 ? t.slice(0, 177).trim() + '…' : t;
}

// ---------------------------------------------------------------------------
// pure: tags
// ---------------------------------------------------------------------------

/**
 * The item's own tags, in three tiers.
 *
 * primary   — the item's own strongest words (title, family, kind)
 * secondary — the configured pool plus the item's kind words
 * niche     — long-tail words pulled from the prompt/alt text
 *
 * A tier is never padded with invented reach: if the item is thin, the
 * tier is thin and the warning says so (same rule as the persona pack).
 */
function deriveTags(item, cfg) {
    const tags = cfg.tags || {};
    const caps = tags.caps || { primary: 7, secondary: 10, niche: 15 };
    const stopwords = tags.stopwords || [];
    const warnings = [];

    const own = words(
        [item.title, item.meta && item.meta.family, item.kind, item.meta && item.meta.pack]
            .filter(Boolean).join(' '),
        stopwords
    );
    // A family like "neon-pulse" is two words, and a hashtag is one
    // word. Both forms are worth having: "#neon" "#pulse" reach the
    // broad audience, "#neonpulse" is the one people actually follow.
    const family = item.meta && item.meta.family;
    const squashed = family ? String(family).replace(/[^A-Za-z0-9]+/g, '') : '';
    if (squashed && !own.includes(squashed.toLowerCase())) {
        own.splice(Math.min(1, own.length), 0, squashed.toLowerCase());
    }
    const kindWords = words(item.kind === 'reel' ? 'video reel audio music' : `${item.kind} artwork`, stopwords);
    // An explicit tagText wins even when it is empty: a catalogue item
    // with no human text must not mine the machine-written description
    // for tags ("#rather" "#than" are not tags).
    const tagSource = item.meta && item.meta.tagText !== undefined
        ? item.meta.tagText
        : (item.meta && (item.meta.prompt || item.meta.alt)) || item.description || '';
    const longTail = words(tagSource, stopwords);

    const tier = (name, list) => {
        const canonical = pack.normalizeTagList(list);
        const capped = canonical.slice(0, caps[name] || canonical.length);
        if (capped.length < canonical.length) {
            warnings.push(`${name} had ${canonical.length} tags; the ${capped.length} that fit the cap were kept.`);
        }
        return capped;
    };

    return {
        primarySet: tier('primary', [...own, ...(tags.primary || [])]),
        secondarySet: tier('secondary', [...kindWords, ...(tags.secondary || [])]),
        nicheSet: tier('niche', [...longTail, ...(tags.niche || [])]),
        warnings,
    };
}

// ---------------------------------------------------------------------------
// pure: copy
// ---------------------------------------------------------------------------

/**
 * The per-platform copy. Templates, not a model: the same item always
 * produces the same caption, so a diff between two runs means the
 * inputs changed and nothing else.
 */
function deriveCaptions(item, tags, cfg) {
    const title = item.title || 'Untitled';
    let hook = firstSentence(
        (item.meta && (item.meta.caption || item.meta.alt)) || item.description || ''
    );
    // A hook that just repeats the title is noise, not a hook.
    if (hook.toLowerCase() === String(title).toLowerCase()) hook = '';
    const body = String(item.description || '').trim();
    const kindLabel = KIND_LABELS[item.kind] || item.kind;
    const tagLine = [...tags.primarySet, ...tags.secondarySet];

    const instagram = [
        `${title} — ${kindLabel}.`,
        '',
        hook,
        body && body !== hook ? `\n${body}` : '',
    ].filter(Boolean).join('\n');

    const tiktok = [
        `${title} — ${kindLabel}.`,
        hook ? hook.split(/[.!?]/)[0].trim() : '',
    ].filter(Boolean).join(' ');

    const twitter = `${title} — ${kindLabel}. ${hook}`.replace(/\s+/g, ' ').trim().slice(0, 240);

    const facebook = [
        `${title} — ${kindLabel}.`,
        '',
        hook,
        body && body !== hook ? `\n${body}` : '',
    ].filter(Boolean).join('\n');

    return {
        youtube: {
            title: title.slice(0, 100),
            description: [hook, body].filter(Boolean).join('\n\n'),
            tags: tagLine,
        },
        social: {
            instagram: { caption: instagram },
            tiktok: { caption: tiktok },
            twitter: { caption: twitter },
            facebook: { caption: facebook },
        },
    };
}

// ---------------------------------------------------------------------------
// pure: price
// ---------------------------------------------------------------------------

/**
 * The price of one item.
 *
 * base            — the kind's base price
 * + lettering     — the type was set in layout, not painted in
 * + variant × n   — each extra seed/format of the same work
 * clamped to the kind's floor/ceiling and rounded to the configured step.
 */
function derivePrice(item, cfg) {
    const table = (cfg.price && cfg.price.table) || {};
    const row = table[item.kind] || table.generic || { base: 8, floor: 5, ceiling: 20 };
    const currency = (cfg.price && cfg.price.currency) || 'EUR';
    const step = (cfg.price && cfg.price.roundTo) || 1;

    const variants = Math.max(1, (item.meta && item.meta.variantCount) || 1);
    const hasLettering = !!(item.meta && item.meta.hasLettering);
    const lettering = hasLettering ? (row.lettering || 0) : 0;
    const variantAdd = (row.variant || 0) * (variants - 1);

    let amount = (row.base || 0) + lettering + variantAdd;
    const floor = row.floor != null ? row.floor : 0;
    const ceiling = row.ceiling != null ? row.ceiling : Infinity;
    const clamped = Math.min(Math.max(amount, floor), ceiling);
    if (clamped !== amount) {
        amount = clamped;
    }
    amount = Math.round(amount / step) * step;

    const rationale = [
        `${KIND_LABELS[item.kind] || item.kind} base ${row.base}`,
        hasLettering ? `+${lettering} lettering set in layout` : null,
        variants > 1 ? `+${variantAdd} for ${variants - 1} extra variant(s)` : null,
        `clamped to [${floor}, ${ceiling}]`,
    ].filter(Boolean).join(' · ');

    return {
        amount,
        currency,
        rationale,
        product: {
            name: `${item.title} — ${KIND_LABELS[item.kind] || item.kind}`,
            slug: slugify(`${item.title}-${item.kind}`),
        },
    };
}

/**
 * The store's price plan: every item, the catalogue total, and the
 * bundle (the whole catalogue at a fifth off). Gumroad has no API
 * wired here, so this is the plan a human applies — not a mutation.
 */
function buildPricingPlan(packages, cfg) {
    const currency = (cfg.price && cfg.price.currency) || 'EUR';
    const discount = (cfg.price && cfg.price.bundleDiscount) || 0;
    const items = packages.map(p => ({
        id: p.id,
        name: p.price.product.name,
        slug: p.price.product.slug,
        amount: p.price.amount,
        currency,
        rationale: p.price.rationale,
    }));
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    const bundle = Math.round(total * (1 - discount) * 100) / 100;
    return {
        currency,
        count: items.length,
        items,
        total,
        bundle: {
            name: 'The whole catalogue',
            slug: 'the-whole-catalogue',
            amount: bundle,
            discount,
        },
    };
}

// ---------------------------------------------------------------------------
// pure: the package
// ---------------------------------------------------------------------------

/**
 * The whole package for one item: identity, tags, copy, price, and the
 * POST.md the poster reads.
 */
function buildPackage(item, cfg) {
    const tags = deriveTags(item, cfg);
    const copy = deriveCaptions(item, tags, cfg);
    const price = derivePrice(item, cfg);

    // The persona shape is what lib/social-shared.js consumes, so
    // the caption/tag/POST.md rules stay in one place.
    const persona = pack.normalizePersona({
        personaName: item.title,
        description: item.description || '',
        primarySet: tags.primarySet,
        secondarySet: tags.secondarySet,
        nicheSet: tags.nicheSet,
        youtube: copy.youtube,
        social: copy.social,
    });

    const content = pack.buildPlatformContent(persona);

    // X counts 280 weighted characters, and the shared builder gives
    // every platform the same full hashtag line — 424 characters for a
    // typical package. The trim happens HERE, in the engine, not in
    // lib/social-shared.js: the shared module is the one implementation
    // of "what a caption is" and must not grow a per-platform rule.
    //
    // Trimming at build time is what makes the stored caption and the
    // published caption the same string. A package that says one thing
    // and posts another is a lie in the record.
    const tweet = xtext.fit({
        body: xtext.splitCaption(content.social.twitter.caption).body,
        hashtags: content.hashtags,
    });
    content.social.twitter = { caption: tweet.text };

    const postMd = replaceNextSection(pack.toIgPostMd(persona), [
        '1. The worker hands this package to lib/ig-poster.js when the',
        '   item is published (publish: true, or posting.autoPublish).',
        '2. Otherwise it stays staged in data/social/<id>/.',
    ]);

    return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        description: item.description || '',
        source: item.source,
        files: item.files || {},
        meta: item.meta || {},
        publish: !!item.publish,
        tags: {
            primarySet: persona.primarySet,
            secondarySet: persona.secondarySet,
            nicheSet: persona.nicheSet,
            all: content.hashtags,
        },
        platforms: content.social,
        youtube: pack.toYoutubeMetadata(persona),
        price,
        warnings: persona.warnings.concat(tags.warnings),
        postMd,
    };
}

/**
 * Swap the POST.md's "## Next" block. The pack writes manual upload
 * steps; the worker may publish automatically, and the file should say
 * what actually happens to it.
 */
function replaceNextSection(postMd, lines) {
    const text = String(postMd || '');
    const marker = '\n## Next\n';
    const idx = text.indexOf(marker);
    if (idx === -1) return text;
    const head = text.slice(0, idx);
    const rest = text.slice(idx + marker.length);
    const hashtagIdx = rest.indexOf('\n## Hashtags');
    const tail = hashtagIdx === -1 ? '' : rest.slice(hashtagIdx);
    return `${head}\n## Next\n\n${lines.join('\n')}\n${tail}`;
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

function listDir(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return null; }
}

function fileMtime(p) {
    try { return fs.statSync(p).mtimeMs; }
    catch { return 0; }
}

/**
 * The daily bundle directories, newest first.
 *
 * A bundle is named by its KEY: the daily run keys by the date
 * ('2026-10-24'), the hourly burst keys by the hour ('2026-10-24T13'),
 * so one day can carry a dozen collections and every one of them becomes
 * its own product.
 */
function listDateDirs(root) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return []; }
    return names
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(e.name))
        .map(e => e.name)
        .sort()
        .reverse();
}

/** The inbox: one directory per item, with an optional item.json. */
function discoverInbox(cfg) {
    const src = (cfg.sources && cfg.sources.inbox) || {};
    if (src.enabled === false) return [];
    const dir = repoPath(src.dir || 'social-inbox');
    const out = [];
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const itemDir = path.join(dir, entry.name);
        const meta = readJson(path.join(itemDir, 'item.json')) || {};
        const files = listDir(itemDir).map(f => f.name);
        const image = files.find(f => /\.(jpe?g|png)$/i.test(f));
        const video = files.find(f => /\.(mp4|mov)$/i.test(f));
        const kind = meta.kind || (video ? 'reel' : image ? 'generic' : 'generic');
        out.push({
            id: slugify(meta.id || entry.name),
            kind,
            title: meta.title || meta.name || entry.name.replace(/[-_]+/g, ' '),
            description: meta.description || '',
            source: 'inbox',
            publish: meta.publish === true,
            files: {
                dir: itemDir,
                image: image ? path.join(itemDir, image) : null,
                video: video ? path.join(itemDir, video) : null,
            },
            meta: {
                family: meta.family || null,
                variantCount: Number(meta.variantCount) || 1,
                hasLettering: meta.hasLettering === true,
                prompt: meta.prompt || null,
                alt: meta.alt || null,
                caption: meta.caption || null,
                tagText: meta.description || '',
                pack: meta.pack || null,
            },
            mtime: fileMtime(itemDir),
        });
    }
    return out;
}

/**
 * The reels the reel-watcher already produced.
 *
 * Two layouts are read, because both exist on disk:
 *  - FLAT, which is what the watcher writes: `<base>.mp4`,
 *    `<base>_cover.jpg`, `<base>_POST.md` and the parked
 *    `<base>_source.mp4` / `<base>_audio.mp3` in the same directory;
 *  - a directory per reel, which is the older hand-made layout.
 * The parked source is not a reel and must not be picked up as one.
 */
function discoverReels(cfg) {
    const src = (cfg.sources && cfg.sources.reels) || {};
    if (src.enabled === false) return [];
    const dir = repoPath(src.dir || 'reel-inbox/processed');
    const out = [];

    // --- flat: what the watcher writes ---
    const flatFiles = listDir(dir).filter(f => f.isFile()).map(f => f.name);
    const flatBases = new Set();
    for (const f of flatFiles) {
        const m = f.match(/^(.+)\.mp4$/i);
        if (!m) continue;
        if (/_source$/i.test(m[1])) continue;          // the parked input
        flatBases.add(m[1]);
    }
    for (const base of flatBases) {
        const video = flatFiles.find(f => f.toLowerCase() === `${base}.mp4`.toLowerCase());
        const image = flatFiles.find(f => f.toLowerCase() === `${base}_cover.jpg`.toLowerCase());
        const postMd = flatFiles.find(f => f.toLowerCase() === `${base}_post.md`.toLowerCase());
        let title = base.replace(/[-_]+/g, ' ');
        let description = '';
        if (postMd) {
            const sheet = readPostSheet(path.join(dir, postMd));
            if (sheet.title) title = sheet.title;
            if (sheet.description) description = sheet.description;
        }
        out.push({
            id: slugify(base),
            kind: 'reel',
            title,
            description,
            source: 'reels',
            publish: false,
            files: {
                dir,
                image: image ? path.join(dir, image) : null,
                video: path.join(dir, video),
            },
            meta: { variantCount: 1, hasLettering: false, layout: 'flat' },
            mtime: fileMtime(path.join(dir, video)),
        });
    }

    // --- one directory per reel (the older layout) ---
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const reelDir = path.join(dir, entry.name);
        const files = listDir(reelDir).map(f => f.name);
        const video = files.find(f => /\.mp4$/i.test(f));
        if (!video) continue;
        const image = files.find(f => /\.(jpe?g|png)$/i.test(f));
        const postMd = files.find(f => f.toUpperCase() === 'POST.MD');
        let title = entry.name.replace(/[-_]+/g, ' ');
        let description = '';
        if (postMd) {
            const text = fs.readFileSync(path.join(reelDir, postMd), 'utf8');
            const heading = text.match(/^#\s+(.+)$/m);
            if (heading) title = heading[1].trim();
            const body = text.split(/\n##\s/)[0].split('\n').slice(1)
                .map(l => l.trim()).filter(l => l && !l.startsWith('#'))[0];
            if (body) description = body;
        }
        out.push({
            id: slugify(entry.name),
            kind: 'reel',
            title,
            description,
            source: 'reels',
            publish: false,
            files: {
                dir: reelDir,
                image: image ? path.join(reelDir, image) : null,
                video: path.join(reelDir, video),
            },
            meta: { variantCount: 1, hasLettering: false, layout: 'directory' },
            mtime: fileMtime(reelDir),
        });
    }
    return out;
}

/**
 * A reel's POST sheet: the caption the watcher wrote is the reel's
 * title and its description — the caption's first segment is the plate's
 * own caption ("switchboard · lamp — Digital Twin (Relay) …").
 */
function readPostSheet(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { return { title: '', description: '' }; }
    const cap = text.match(/##\s*Caption\s*\n+([\s\S]*?)(?:\n##\s|$)/i);
    const caption = cap ? cap[1].trim().split('\n')[0].trim() : '';
    // The watcher's caption carries its own hashtag tail; the engine
    // derives its own, so the tail is dropped here rather than shipped
    // twice (and mined as a tag called "#hashtags").
    const body = caption.replace(/\s*Hashtags:.*$/i, '').trim();
    const heading = text.match(/^#\s+(.+)$/m);
    return {
        title: body ? body.split(/\s+—\s+/)[0].trim() : (heading ? heading[1].trim() : ''),
        description: body,
    };
}

/**
 * The catalogue: one product per cover FAMILY (the seeds are variants of
 * one work) and one product per plate (each plate is its own prompt).
 */
function discoverCatalogue(cfg) {
    const src = (cfg.sources && cfg.sources.catalogue) || {};
    if (src.enabled === false) return [];
    const dir = repoPath(src.dir || 'assets/marketplace');
    const out = [];

    // covers: lettering-manifest.json holds the family + title
    const covers = readJson(path.join(dir, 'covers', 'lettering-manifest.json'));
    if (covers && Array.isArray(covers.covers)) {
        const families = new Map();
        for (const c of covers.covers) {
            const family = c.family || 'covers';
            if (!families.has(family)) families.set(family, []);
            families.get(family).push(c);
        }
        for (const [family, list] of families) {
            const title = list[0].title || family;
            out.push({
                id: slugify(`${family}-cover`),
                kind: 'cover',
                title,
                description: `${list.length} seed variants of the same cover at 832×832, with the title set in layout rather than painted in.`,
                source: 'catalogue',
                publish: false,
                files: {
                    dir: path.join(dir, 'covers'),
                    images: list.map(c => path.join(dir, 'covers', path.basename(c.out))),
                },
                meta: {
                    family,
                    variantCount: list.length,
                    hasLettering: true,
                    title,
                    tagText: '',
                },
                mtime: fileMtime(path.join(dir, 'covers')),
            });
        }
    }

    // plates: plates.json holds one entry per plate
    const plates = readJson(path.join(dir, 'system-error', 'plates.json'));
    if (plates && Array.isArray(plates.plates)) {
        for (const p of plates.plates) {
            const title = p.caption || path.basename(p.file, path.extname(p.file));
            out.push({
                id: slugify(path.basename(p.file, path.extname(p.file))),
                kind: 'plate',
                title: sentenceCase(title),
                description: p.alt || p.prompt || '',
                source: 'catalogue',
                publish: false,
                files: {
                    dir: path.join(dir, 'system-error'),
                    images: [path.join(dir, 'system-error', p.file)],
                },
                meta: {
                    family: 'system-error',
                    pack: plates.pack,
                    variantCount: 1,
                    hasLettering: false,
                    prompt: p.prompt || null,
                    alt: p.alt || null,
                    caption: p.caption || null,
                    tagText: [p.prompt, p.alt].filter(Boolean).join(' '),
                    seed: p.seed,
                    width: p.width,
                    height: p.height,
                },
                mtime: fileMtime(path.join(dir, 'system-error')),
            });
        }
    }

    // daily: one product per plate, the same rule as the System Error
    // plates — every plate is its own prompt, so every plate is its own
    // product. The daily run writes one bundle per day, each with its
    // own plates.json, so the directories are read rather than listed in
    // a manifest.
    const dailyRoot = path.join(dir, 'daily');
    for (const date of listDateDirs(dailyRoot)) {
        const bundle = readJson(path.join(dailyRoot, date, 'plates.json'));
        if (!bundle || !Array.isArray(bundle.plates)) continue;
        for (const p of bundle.plates) {
            const title = p.caption || path.basename(p.file, path.extname(p.file));
            out.push({
                id: slugify(`daily-${date}-${path.basename(p.file, path.extname(p.file))}`),
                kind: 'plate',
                title: sentenceCase(title),
                description: p.alt || p.prompt || '',
                source: 'catalogue',
                publish: false,
                files: {
                    dir: path.join(dailyRoot, date),
                    images: [path.join(dailyRoot, date, p.file)],
                },
                meta: {
                    family: 'daily',
                    pack: bundle.pack || null,
                    date,
                    collection: bundle.title || null,
                    badge: bundle.badge || null,
                    teaser: bundle.teaser || null,
                    variantCount: 1,
                    hasLettering: false,
                    prompt: p.prompt || null,
                    alt: p.alt || null,
                    caption: p.caption || null,
                    tagText: [p.prompt, p.alt].filter(Boolean).join(' '),
                    taskId: p.taskId || null,
                    width: p.width,
                    height: p.height,
                },
                mtime: fileMtime(path.join(dailyRoot, date)),
            });
        }
    }
    return out;
}

function discoverItems(cfg) {
    const items = [
        ...discoverCatalogue(cfg),
        ...discoverReels(cfg),
        ...discoverInbox(cfg),
    ];
    const seen = new Set();
    return items.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function packageDir(cfg, id) {
    return path.join(repoPath((cfg.outputDir || 'data/social')), id);
}

function writePackage(pkg, cfg, deps) {
    const dir = packageDir(cfg, pkg.id);
    const write = (deps && deps.write) || ((p, s) => fs.writeFileSync(p, s));
    const mkdir = (deps && deps.mkdir) || ((p) => fs.mkdirSync(p, { recursive: true }));
    mkdir(dir);
    write(path.join(dir, 'post.json'), JSON.stringify(pkg, null, 2) + '\n');
    write(path.join(dir, 'POST.md'), pkg.postMd);
    write(path.join(dir, 'price.json'), JSON.stringify(pkg.price, null, 2) + '\n');
    return dir;
}

/**
 * The media the poster needs, next to the POST.md it reads. Symlinks,
 * not copies: a 1080×1920 reel is not something to duplicate per package.
 */
function linkMedia(item, pkgDir) {
    const links = [];
    const media = [];
    if (item.files && item.files.video) media.push([item.files.video, path.basename(item.files.video)]);
    if (item.files && item.files.image) media.push([item.files.image, path.basename(item.files.image)]);
    if (item.files && Array.isArray(item.files.images)) {
        for (const img of item.files.images) media.push([img, path.basename(img)]);
    }
    for (const [src, name] of media) {
        const dest = path.join(pkgDir, name);
        try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.symlinkSync(src, dest);
            links.push(dest);
        } catch (e) {
            warn(`could not link ${name}: ${e.message}`);
        }
    }
    return links;
}

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

/**
 * Hand the package to the posters.
 *
 * Two platforms, two different shapes of content:
 *
 *   - Instagram takes a REEL. lib/ig-poster.js uploads the video and
 *     needs pkg.files.video. A package without one cannot go there.
 *   - X takes TEXT. lib/x-poster.js types the caption into the web
 *     composer, so a cover study or a plate is postable — there is no
 *     video requirement.
 *
 * The gates are the same for both: the master switch, the per-item
 * opt-in, and the per-channel dry-run flag. A channel that is not
 * armed, or that the package cannot fill, is skipped — it is not an
 * error, and it does not stop the other channel.
 *
 * The result keeps the shape the registry reads: `posted` is true when
 * something was REALLY published (not a dry run), and `channels` says
 * what happened to each one.
 */
function postPackage(pkg, cfg, deps) {
    const posting = cfg.posting || {};
    if (!posting.enabled) return { posted: false, reason: 'posting disabled', channels: [] };

    const wants = posting.autoPublish || pkg.publish;
    if (!wants) return { posted: false, reason: 'not marked for publish — staged', channels: [] };

    const channels = [];

    // X — text. A package with a twitter caption can go here.
    const twitter = posting.twitter || {};
    if (twitter.enabled) {
        const caption = String((pkg.platforms && pkg.platforms.twitter && pkg.platforms.twitter.caption) || '').trim();
        if (caption) {
            channels.push(postToTwitter(pkg, cfg, deps));
        }
    }

    // Instagram — a reel. A package without a video cannot go here.
    if (pkg.files && pkg.files.video) {
        channels.push(postToInstagram(pkg, cfg, deps));
    }

    if (!channels.length) {
        // Nothing could take it. "no video" alone is no longer the whole
        // story now that there are two channels: the reel has no video
        // for Instagram, and X either is not armed or has no caption.
        return {
            posted: false,
            reason: 'no video for Instagram, and X is not armed or has no caption — staged, not posted',
            channels: [],
        };
    }

    // `posted` means something was REALLY published. A dry run is not a
    // post — the registry keys "already published" off this field, and
    // a dry run that claimed it would keep the item from ever being
    // picked up again.
    return {
        posted: channels.some(c => c.posted && !c.dryRun),
        dryRun: channels.every(c => c.dryRun),
        reason: channels.map(c => `${c.channel}: ${c.reason}`).join(' · '),
        channels,
    };
}

/**
 * Hand the package to lib/ig-poster.js. Only a reel has a video the
 * poster can upload.
 */
function postToInstagram(pkg, cfg, deps) {
    const posting = cfg.posting || {};
    const poster = repoPath(posting.poster || 'lib/ig-poster.js');
    const dir = packageDir(cfg, pkg.id);
    const args = [poster, dir];
    if (posting.dryRunPoster) args.push('--dry-run');
    const res = runPoster(poster, args, deps);
    const ok = res.status === 0;
    return {
        channel: 'instagram',
        posted: ok,
        dryRun: !!posting.dryRunPoster,
        reason: ok ? (posting.dryRunPoster ? 'poster dry-run ok' : 'posted') : `poster exit ${res.status}`,
        output: [res.stdout, res.stderr].filter(Boolean).join('').trim().split('\n').slice(-4).join('\n'),
    };
}

/**
 * Hand the package to lib/x-poster.js.
 *
 * The poster is given the package DIRECTORY, exactly like the
 * Instagram poster: it reads the caption from post.json and the media
 * from the package's own symlinks. That keeps the two posters on the
 * same contract, and the caption it posts is the one the engine built
 * and stored — they cannot drift apart.
 */
function postToTwitter(pkg, cfg, deps) {
    const posting = cfg.posting || {};
    const twitter = posting.twitter || {};
    const poster = repoPath(twitter.poster || 'lib/x-poster.js');
    const dir = packageDir(cfg, pkg.id);
    const args = [poster, dir];
    if (twitter.dryRunPoster) args.push('--dry-run');
    const res = runPoster(poster, args, deps);
    const ok = res.status === 0;
    return {
        channel: 'twitter',
        posted: ok,
        dryRun: !!twitter.dryRunPoster,
        reason: ok ? (twitter.dryRunPoster ? 'poster dry-run ok' : 'posted') : `poster exit ${res.status}`,
        output: [res.stdout, res.stderr].filter(Boolean).join('').trim().split('\n').slice(-4).join('\n'),
    };
}

/**
 * Run a poster. `deps.spawn` is the seam the tests use.
 */
function runPoster(poster, args, deps) {
    const run = (deps && deps.spawn) || ((cmd, cmdArgs) =>
        spawnSync(process.execPath, cmdArgs, { encoding: 'utf8', timeout: 300000 }));
    return run(poster, args) || { status: 1, stdout: '', stderr: '' };
}

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

function registryPath(cfg) {
    return path.join(repoPath(cfg.outputDir || 'data/social'), 'index.json');
}

function loadRegistry(cfg) {
    const reg = readJson(registryPath(cfg));
    return (reg && reg.items) || {};
}

function saveRegistry(cfg, items) {
    const dir = repoPath(cfg.outputDir || 'data/social');
    fs.mkdirSync(dir, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), items };
    fs.writeFileSync(registryPath(cfg), JSON.stringify(payload, null, 2) + '\n');
}

/**
 * One pass: discover, package what is new or changed, write the plan.
 * Returns the packages it produced.
 */
function runOnce(cfg, deps) {
    const items = discoverItems(cfg);
    const registry = loadRegistry(cfg);
    const produced = [];

    for (const item of items) {
        const seen = registry[item.id];
        if (seen && seen.mtime === item.mtime && seen.packagedAt) continue;

        const pkg = buildPackage(item, cfg);
        const dir = writePackage(pkg, cfg, deps);
        linkMedia(item, dir);
        const post = postPackage(pkg, cfg, deps);
        pkg.post = post;
        fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(pkg, null, 2) + '\n');

        registry[item.id] = {
            title: item.title,
            kind: item.kind,
            source: item.source,
            mtime: item.mtime,
            packagedAt: Date.now(),
            // A dry run is not a post: it must not claim the item was
            // published, or the item would never be picked up again.
            postedAt: (post.posted && !post.dryRun) ? Date.now() : (seen && seen.postedAt) || null,
            price: pkg.price,
            currency: pkg.price.currency,
            post: post.reason,
        };
        produced.push(pkg);
        log(`[${pkg.id}] packaged — ${pkg.price.amount} ${pkg.price.currency} · ${post.posted ? 'posted' : post.reason}`);
    }

    if (produced.length) {
        // The plan covers the WHOLE catalogue, not just this pass — a
        // plan that shrinks every time one item is added is not a plan.
        const plan = buildPricingPlan(Object.entries(registry).map(([id, entry]) => ({
            id,
            price: entry.price,
        })), cfg);
        fs.mkdirSync(repoPath(cfg.outputDir || 'data/social'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath(cfg.outputDir || 'data/social'), 'pricing.json'),
            JSON.stringify(plan, null, 2) + '\n'
        );
        log(`pricing plan — ${plan.count} product(s), total ${plan.total} ${plan.currency}, bundle ${plan.bundle.amount} ${plan.currency}`);
    }
    // A package whose source is gone is stale. The registry and the
    // package directory are both generated state, so they are pruned
    // rather than left to rot — the source is the truth, and anything
    // else can be rebuilt from it.
    const current = new Set(items.map(i => i.id));
    for (const id of Object.keys(registry)) {
        if (current.has(id)) continue;
        delete registry[id];
        const dir = packageDir(cfg, id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
        log(`pruned stale package ${id}`);
    }

    saveRegistry(cfg, registry);
    return produced;
}

/** A blocking sleep that can be interrupted by a signal. */
function sleepSync(ms) {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
}

function loop(cfg, deps) {
    let stopping = false;
    const stop = () => { stopping = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    while (!stopping) {
        try {
            runOnce(cfg, deps);
        } catch (e) {
            warn(`pass failed: ${e.message}`);
        }
        sleepSync(cfg.intervalMs || 5000);
    }
    log('stopped');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const DRY = ARGV.includes('--dry-run');
const INTERVAL_IDX = ARGV.indexOf('--interval');

function main() {
    const cfg = readConfig();
    if (INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]) {
        cfg.intervalMs = Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000);
    }
    if (DRY) {
        const items = discoverItems(cfg);
        const packages = items.map(i => buildPackage(i, cfg));
        for (const p of packages) {
            log(`${p.id} · ${p.kind} · ${p.price.amount} ${p.price.currency} · ${p.title}`);
            log(`  tags: ${p.tags.all.join(' ')}`);
            log(`  ig:   ${p.platforms.instagram.caption.split('\n')[0]}`);
        }
        const plan = buildPricingPlan(packages.map(p => ({ id: p.id, price: p.price })), cfg);
        log(`plan: ${plan.count} product(s), total ${plan.total} ${plan.currency}, bundle ${plan.bundle.amount}`);
        return 0;
    }
    if (ONCE) {
        const produced = runOnce(cfg);
        log(`${produced.length} package(s) written`);
        return 0;
    }
    log(`worker started — every ${cfg.intervalMs}ms`);
    loop(cfg);
    return 0;
}

if (require.main === module) {
    const code = main();
    if (code) process.exit(code);
}

module.exports = {
    slugify,
    words,
    firstSentence,
    deriveTags,
    deriveCaptions,
    derivePrice,
    buildPricingPlan,
    buildPackage,
    replaceNextSection,
    discoverItems,
    discoverCatalogue,
    discoverReels,
    discoverInbox,
    runOnce,
    packageDir,
    writePackage,
    postPackage,
    DEFAULT_CONFIG,
    REPO,
};
