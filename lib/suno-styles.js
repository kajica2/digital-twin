#!/usr/bin/env node
'use strict';
// lib/suno-styles.js
//
// Pure logic for building Suno **style variants** from the
// "Suno Audio Upload Reference Lock Protocols" presets that already live
// in pages/suno-prompts.html.
//
// The rules encoded here were reverse-engineered from the user's own
// saved style batch (28 styles, fetched live from
// GET studio-api-prod.suno.com/api/prompts/v2):
//
//   * A Suno style is `{ title, tags }` — POST /api/prompts/v2 with
//     `{ tags, id: null, title }`. There is no separate "prompt" field.
//   * The batch's own composition rule (reconstructed from the style
//     titled "Kai record") is:
//         tags = <reference-lock directive> + <the song's style descriptor>
//     capped at the server's 1000-character limit, with the DESCRIPTOR
//     always preserved — the directive is what gives way.
//   * Field limits (from GET /api/custom-model/shared): title 100,
//     tags 1000, negative_tags 1000, prompt 5000.
//
// Nothing here touches the network. lib/suno-web.js does that.

const fs = require('node:fs');
const path = require('node:path');

// Server-side limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

/**
 * Pull the PRESETS array out of pages/suno-prompts.html.
 * The page is the canonical home of the 10 protocols; this reads them
 * rather than duplicating a second copy that could drift.
 */
function parsePresetsFromHtml(html) {
    const start = html.indexOf('const PRESETS');
    if (start === -1) throw new Error('PRESETS array not found in HTML');
    const open = html.indexOf('[', start);
    if (open === -1) throw new Error('PRESETS array opener not found');

    // Bracket-match to the array's own closing bracket. A plain
    // indexOf('];') is not safe: a protocol's prose could contain "]".
    let depth = 0;
    let close = -1;
    let quote = null;
    for (let i = open; i < html.length; i += 1) {
        const ch = html[i];
        if (quote) {
            if (ch === '\\') { i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '[') depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0) { close = i; break; }
        }
    }
    if (close === -1) throw new Error('PRESETS array is not terminated');

    const literal = html.slice(open, close + 1);
    // The literal is plain data (object literals + template strings).
    // eslint-disable-next-line no-eval
    const presets = eval(literal);
    if (!Array.isArray(presets) || !presets.length) {
        throw new Error('PRESETS array parsed empty');
    }
    return presets.map(p => ({
        name: String(p.name || '').trim(),
        target: String(p.target || '').trim(),
        influence: String(p.influence || '').trim(),
        prompt: String(p.prompt || ''),
    }));
}

function loadPresets(repoRoot = path.resolve(__dirname, '..')) {
    const file = path.join(repoRoot, 'pages', 'suno-prompts.html');
    return parsePresetsFromHtml(fs.readFileSync(file, 'utf8'));
}

/**
 * The "Copy Prompt" block is the part of a protocol that is actually
 * pasted into Suno — the directive. The surrounding "Master Conditioning
 * Directive:" / "Best for:" / "Execution Instructions:" scaffolding is
 * documentation for the human, not model input.
 */
function copyPrompt(protocolPrompt) {
    const body = protocolPrompt.split('Copy Prompt')[1];
    if (!body) return protocolPrompt.trim();
    const cut = body.split(/Best for:/)[0];
    return cut.trim();
}

/**
 * Cut `text` to at most `budget` characters, preferring a sentence
 * boundary so the directive still reads as a complete instruction.
 */
function truncateAtBoundary(text, budget) {
    if (budget <= 0) return '';
    if (text.length <= budget) return text;
    const slice = text.slice(0, budget);
    const sentence = slice.lastIndexOf('. ');
    if (sentence > budget * 0.5) return slice.slice(0, sentence + 1);
    const space = slice.lastIndexOf(' ');
    if (space > 0) return slice.slice(0, space);
    return slice.trimEnd();
}

/**
 * Compose a style's tags the way the user's own batch does:
 * directive first, song descriptor always preserved, total within the
 * server's tag limit.
 */
function composeTags(directive, descriptor, limit = LIMITS.tags) {
    const d = String(directive || '').trim();
    const s = String(descriptor || '').trim();
    if (!s) return d.slice(0, limit);
    // An empty directive must not leave a leading space in the tags.
    if (!d) return s.slice(0, limit);
    if (d.length + 1 + s.length <= limit) return `${d} ${s}`;
    const budget = limit - s.length - 1;
    if (budget <= 0) return s.slice(0, limit);
    return `${truncateAtBoundary(d, budget)} ${s}`;
}

/**
 * "90% - 95%" -> 0.92. The midpoint, floored to two decimals so the
 * value never exceeds the protocol's stated maximum.
 */
function influenceValue(range) {
    const nums = String(range || '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const lo = Number(nums[0]);
    const hi = nums.length > 1 ? Number(nums[1]) : lo;
    const mid = (lo + hi) / 2;
    return Math.floor(mid) / 100;
}

/**
 * Build one style variant per protocol.
 *
 * @param {object} o
 * @param {Array}  o.presets     the 10 protocols
 * @param {string} o.descriptor  the song's style descriptor (its `tags`)
 * @param {string} o.songTitle   short song title used in the style title
 * @param {number} o.limit       tag limit (default 1000)
 */
function buildVariants({ presets, descriptor, songTitle, limit = LIMITS.tags } = {}) {
    return presets.map(p => {
        const directive = copyPrompt(p.prompt);
        const tags = composeTags(directive, descriptor, limit);
        const title = `${songTitle} - ${p.name}`.slice(0, LIMITS.title);
        return {
            preset: p.name,
            target: p.target,
            influence: p.influence,
            influenceValue: influenceValue(p.influence),
            directive,
            tags,
            title,
            tagsLength: tags.length,
            titleLength: title.length,
        };
    });
}

module.exports = {
    LIMITS,
    parsePresetsFromHtml,
    loadPresets,
    copyPrompt,
    truncateAtBoundary,
    composeTags,
    influenceValue,
    buildVariants,
};
