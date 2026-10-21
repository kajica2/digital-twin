#!/usr/bin/env node
'use strict';
// lib/social-shared.js — the rules the social layer shares.
//
// One tag alphabet, one tier contract, one POST.md shape. The poster
// (lib/ig-poster.js) and the worker (lib/social-engine.js) both depend
// on this file, and so does the browser-side persona pack.
//
// NOTE: lib/persona-social-pack.js (a parallel session's work, still
// uncommitted) carries its own copy of these rules. When it lands, it
// should require this module instead of keeping a second copy — the
// rules below are the ones the poster's parser expects, and two copies
// would be two conventions.

const TIER_ORDER = ['primarySet', 'secondarySet', 'nicheSet'];
const TIER_CAPS = { primarySet: 7, secondarySet: 10, nicheSet: 15 };
const TIER_MINIMUMS = { primarySet: 5, secondarySet: 7, nicheSet: 10 };
const PLATFORMS = ['instagram', 'tiktok', 'twitter', 'facebook'];
const TAG_ALPHABET = /[^A-Za-z0-9_]/g;
const HASHTAG_TOKEN = /#[A-Za-z0-9_]+/g;

function asText(value) {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
}

/**
 * A hashtag is one word. "Minimalist Home Decor" is not a tag, and its
 * first word is the only honest reading of it.
 */
function normalizeTag(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    let tag = String(value).trim().split(/\s+/)[0];
    if (!tag) return '';
    tag = tag.replace(/^#+/, '');
    tag = tag.replace(TAG_ALPHABET, '');
    if (!tag) return '';
    return '#' + tag;
}

/** A list of tags: canonicalised, de-duplicated, order preserved. */
function normalizeTagList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const tag = normalizeTag(raw);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/**
 * One tier: canonicalised, de-duplicated, capped at the declared
 * maximum. A tier shorter than its minimum is reported as a warning —
 * never padded, because padding invents reach nobody promised.
 */
function normalizeTier(list, name, warnings) {
    const tags = normalizeTagList(list);
    const capped = tags.slice(0, TIER_CAPS[name]);
    if (capped.length < TIER_MINIMUMS[name]) {
        warnings.push(
            name + ' has ' + capped.length + ' tag(s); the target is ' +
            TIER_MINIMUMS[name] + '-' + TIER_CAPS[name] + '.'
        );
    }
    if (tags.length > capped.length) {
        warnings.push(
            name + ' had ' + tags.length + ' tags; the ' + capped.length +
            ' that fit the cap were kept.'
        );
    }
    return capped;
}

/** A social caption: a bare string or { caption }. */
function normalizeCaption(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof value.caption === 'string') {
        return value.caption.trim();
    }
    return '';
}

/**
 * A raw object → the persona the rest of the social layer works with.
 * Missing pieces are coerced, never thrown on.
 */
function normalizePersona(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const warnings = [];

    const youtube = source.youtube && typeof source.youtube === 'object' ? source.youtube : {};
    const socialSource = source.social && typeof source.social === 'object' ? source.social : {};

    const social = {};
    for (const platform of PLATFORMS) {
        social[platform] = { caption: normalizeCaption(socialSource[platform]) };
    }

    return {
        personaName: asText(source.personaName) || 'Untitled persona',
        description: asText(source.description),
        primarySet: normalizeTier(source.primarySet, 'primarySet', warnings),
        secondarySet: normalizeTier(source.secondarySet, 'secondarySet', warnings),
        nicheSet: normalizeTier(source.nicheSet, 'nicheSet', warnings),
        youtube: {
            title: asText(youtube.title),
            description: asText(youtube.description),
            tags: normalizeTagList(youtube.tags),
        },
        social,
        warnings,
    };
}

/** Every '#tag' token in a caption, canonicalised. */
function inlineTags(text) {
    if (typeof text !== 'string') return [];
    const found = text.match(HASHTAG_TOKEN) || [];
    return normalizeTagList(found);
}

/**
 * The persona's hashtag union: the three tiers in tier order, plus any
 * tag the captions already carry, de-duplicated.
 */
function personaHashtags(persona, options) {
    const opts = options || {};
    const p = persona && typeof persona === 'object' ? persona : {};
    const out = [];
    const seen = new Set();
    const push = (tag) => {
        if (!tag) return;
        const key = tag.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(tag);
    };
    for (const tier of TIER_ORDER) {
        for (const tag of p[tier] || []) push(normalizeTag(tag));
    }
    if (opts.includeInline !== false) {
        for (const platform of PLATFORMS) {
            const block = p.social && p.social[platform];
            const caption = block && typeof block === 'object' ? block.caption : '';
            for (const tag of inlineTags(caption)) push(tag);
        }
    }
    return out;
}

/**
 * Strip every hashtag token out of a caption body.
 *
 * This is not a style choice: the poster matches /#[a-zA-Z0-9_]+/ over
 * the WHOLE file, so a tag left in the body would be counted twice —
 * once in the body, once in the trailing tag section. The body keeps
 * the prose; the tags live in one place.
 */
function stripTags(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(HASHTAG_TOKEN, '')
        .split('\n')
        .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
        .join('\n')
        .trim();
}

/** The caption, then the hashtag line. An empty caption stays empty. */
function appendHashtags(caption, tags) {
    if (!caption) return caption || '';
    if (!tags || !tags.length) return caption;
    return caption + '\n\n' + tags.join(' ');
}

/**
 * The platform content for one persona: the YouTube block and the four
 * social captions, with the hashtags carried on their own line so no
 * caption ever repeats a tag.
 */
function buildPlatformContent(persona, o) {
    const opts = o || {};
    const includeHashtags = opts.includeHashtags !== false;
    const p = persona && typeof persona === 'object' ? persona : {};

    const hashtags = personaHashtags(p, { includeInline: opts.includeInlineTags !== false });
    const social = {};
    for (const platform of PLATFORMS) {
        const block = p.social && p.social[platform];
        const caption = block && typeof block === 'object'
            ? (typeof block.caption === 'string' ? block.caption : '')
            : '';
        const body = stripTags(caption);
        social[platform] = {
            caption: includeHashtags ? appendHashtags(body, hashtags) : body,
        };
    }

    const youtube = p.youtube && typeof p.youtube === 'object' ? p.youtube : {};
    const title = asText(youtube.title) || asText(p.personaName);
    const description = asText(youtube.description) || asText(p.description);
    const tags = youtube.tags && youtube.tags.length
        ? normalizeTagList(youtube.tags)
        : personaHashtags(p, { includeInline: false });

    return {
        youtube: { title, description, tags },
        social,
        hashtags,
    };
}

/**
 * The YouTube metadata, in the shape the YouTube poster wants:
 * { title, description, tags[], tagsCsv }. The tags keep their '#'; the
 * CSV drops it, because that is what YouTube's own tag field takes.
 */
function toYoutubeMetadata(persona) {
    const content = buildPlatformContent(persona, { includeHashtags: false });
    const tags = content.youtube.tags;
    return {
        title: content.youtube.title,
        description: content.youtube.description,
        tags: tags.slice(),
        tagsCsv: tags.map((tag) => tag.replace(/^#/, '')).join(','),
    };
}

/**
 * The POST.md that lib/ig-poster.js reads.
 *
 * The poster's readCaption() walks the file: the first '# ' heading is
 * the title, a '## ' heading switches "inNext" on when the heading says
 * Next, the first non-empty line after that BREAKS the loop, and the
 * hashtags are matched over the whole file. So the caption body carries
 * no tags at all, and the tag list lives in a trailing section — which
 * sits after the break, and is therefore not part of the body.
 */
function toIgPostMd(persona) {
    const p = persona && typeof persona === 'object' ? persona : {};
    const content = buildPlatformContent(p, { includeHashtags: false });
    const caption = content.social.instagram.caption
        .split('\n')
        .map((line) => line.replace(/^#{1,6}\s*/, ''))
        .join('\n')
        .trim();
    const tags = content.hashtags;
    // A '#' inside the title would be read back as a hashtag.
    const title = (asText(p.personaName).replace(HASHTAG_TOKEN, '').replace(/\s{2,}/g, ' ').trim())
        || 'Untitled persona';

    return [
        '# ' + title,
        '',
        '## Caption',
        '',
        caption,
        '',
        '## Next',
        '',
        '1. Open the Instagram app → Reel → Upload.',
        '2. Paste the caption above, then the hashtag line.',
        '',
        '## Hashtags',
        '',
        tags.join(' '),
        ''
    ].join('\n');
}

module.exports = {
    TIER_ORDER,
    TIER_CAPS,
    TIER_MINIMUMS,
    PLATFORMS,
    normalizeTag,
    normalizeTagList,
    normalizeTier,
    normalizeCaption,
    normalizePersona,
    personaHashtags,
    stripTags,
    appendHashtags,
    buildPlatformContent,
    toYoutubeMetadata,
    toIgPostMd,
};
