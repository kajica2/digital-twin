#!/usr/bin/env node
'use strict';
// lib/x-text.js
//
// What a tweet is allowed to be.
//
// X counts a tweet in WEIGHTED characters, not raw ones, and the limit
// is 280. The rules that matter in practice:
//
//   - most Latin text counts 1 per character
//   - CJK, emoji and other wide characters count 2
//   - a URL counts as 23, no matter how long it is
//
// The engine's caption is body + a line of hashtags, and with a full
// tag set it is comfortably over 280 — so something has to give. This
// module decides what: the BODY wins, the hashtags fill what is left,
// and the least important tags (the tail of the tier order) are the
// ones that get dropped.
//
// Pure Node, no deps. The counting is the interesting part, so it is
// separated from the trimming and both are testable on their own.

/** X's hard limit, in weighted characters. */
const MAX_LENGTH = 280;

/** What any URL counts as, however long the URL is. */
const URL_LENGTH = 23;

/**
 * The code-point ranges X weighs as a single character. Everything
 * outside them weighs as two.
 */
const WEIGHT_ONE_RANGES = [
    [0, 4351],
    [8192, 8205],
    [8208, 8223],
    [8242, 8247],
];

/** The ellipsis used when a body is cut. It weighs 2. */
const ELLIPSIS = '…';

/**
 * The weight of one code point.
 * @param {number} cp
 * @returns {number} 1 or 2
 */
function codePointWeight(cp) {
    for (const [start, end] of WEIGHT_ONE_RANGES) {
        if (cp >= start && cp <= end) return 1;
    }
    return 2;
}

/** The weighted length of a run of text with no URLs in it. */
function plainLength(text) {
    let total = 0;
    // Iterate by code point, not by UTF-16 unit: an emoji is one
    // character to a human even though it is two units in a string.
    for (const ch of String(text || '')) {
        total += codePointWeight(ch.codePointAt(0));
    }
    return total;
}

/**
 * The weighted length of a tweet.
 *
 * @param {string} text
 * @returns {number} the length X would count
 */
function countLength(text) {
    const str = String(text == null ? '' : text);
    let total = 0;
    let cursor = 0;
    const url = /https?:\/\/[^\s]+/g;
    let m;
    while ((m = url.exec(str)) !== null) {
        total += plainLength(str.slice(cursor, m.index));
        total += URL_LENGTH;
        cursor = m.index + m[0].length;
    }
    total += plainLength(str.slice(cursor));
    return total;
}

/**
 * Cut a body so it fits, on a word boundary, with an ellipsis.
 *
 * @param {string} text
 * @param {number} limit weighted characters available
 * @returns {string} the shortened text
 */
function truncate(text, limit) {
    const str = String(text || '');
    if (countLength(str) <= limit) return str;

    const budget = limit - codePointWeight(ELLIPSIS.codePointAt(0));
    let out = '';
    let used = 0;
    for (const ch of str) {
        const w = codePointWeight(ch.codePointAt(0));
        if (used + w > budget) break;
        out += ch;
        used += w;
    }
    // Drop the half-finished word, then any punctuation left hanging.
    out = out.replace(/\s+\S*$/, '');
    out = out.replace(/[\s,.;:!?—–-]+$/, '');
    return out + ELLIPSIS;
}

/**
 * Fit a tweet.
 *
 * The body is kept (shortened only if it cannot fit on its own) and the
 * hashtags are added in priority order while they still fit. The first
 * hashtag that does not fit ends the list — the tiers are ordered by
 * importance, so a shorter tag from a later tier must not displace an
 * earlier one.
 *
 * @param {object} input
 * @param {string} input.body            the caption without hashtags
 * @param {Array<string>} [input.hashtags] the tags, most important first
 * @param {number} [input.limit]         weighted characters available
 * @param {string} [input.separator]     what goes between body and tags
 * @returns {object} { text, body, hashtags, dropped, truncated, length }
 */
function fit(input) {
    const opts = input || {};
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_LENGTH;
    const separator = opts.separator == null ? '\n\n' : String(opts.separator);
    const rawBody = String(opts.body == null ? '' : opts.body).trim();
    const tags = (Array.isArray(opts.hashtags) ? opts.hashtags : [])
        .map(t => String(t == null ? '' : t).trim())
        .filter(Boolean);

    let body = rawBody;
    let truncated = false;
    if (countLength(body) > limit) {
        body = truncate(body, limit);
        truncated = true;
    }

    const used = [];
    const dropped = [];
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const candidate = used.concat([tag]).join(' ');
        const attempt = body ? body + separator + candidate : candidate;
        if (countLength(attempt) <= limit) { used.push(tag); continue; }
        // Priority order: the first tag that does not fit ends the list.
        // Every tag from here on is dropped, and ALL of them are
        // reported — a silently discarded tail is a lie about what was
        // cut, and the poster tells the user what was lost.
        dropped.push(...tags.slice(i));
        break;
    }

    const text = body && used.length
        ? body + separator + used.join(' ')
        : (body || used.join(' '));

    return {
        text,
        body,
        hashtags: used,
        dropped,
        truncated,
        length: countLength(text),
    };
}

/**
 * Split a caption into its body and its trailing hashtag line.
 *
 * The engine assembles a caption as body + a blank line + the tags, so
 * the tags are the last block. This is used when a caption arrives from
 * somewhere else and has to be re-fitted.
 *
 * @param {string} caption
 * @returns {object} { body, hashtags }
 */
function splitCaption(caption) {
    const text = String(caption == null ? '' : caption);
    const blocks = text.split(/\n\s*\n/);
    if (blocks.length < 2) {
        return { body: text.trim(), hashtags: [] };
    }
    const last = blocks[blocks.length - 1].trim();
    const tokens = last.match(/#[A-Za-z0-9_]+/g) || [];
    const isTagBlock = tokens.length > 0 &&
        last.replace(/#[A-Za-z0-9_]+/g, '').trim() === '';
    if (!isTagBlock) {
        return { body: text.trim(), hashtags: [] };
    }
    return {
        body: blocks.slice(0, -1).join('\n\n').trim(),
        hashtags: tokens,
    };
}

module.exports = {
    MAX_LENGTH,
    URL_LENGTH,
    WEIGHT_ONE_RANGES,
    ELLIPSIS,
    codePointWeight,
    plainLength,
    countLength,
    truncate,
    fit,
    splitCaption,
};
