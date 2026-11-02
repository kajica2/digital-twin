#!/usr/bin/env node
'use strict';
// lib/suno-style-library.js
//
// The Suno STYLE DESCRIPTOR registry — the Anchor Five and their Ten
// Extensions.
//
// WHAT A PRESET IS HERE
//
// A Suno style is `{ title, tags }`: POST /api/prompts/v2 with
// `{ tags, id, title }`. The `tags` field is the STYLE TEXT — a
// self-contained description of what the track should sound like.
//
// These presets are therefore NOT prompts for a model. They are
// finished style texts, written to be pasted into Suno's style field
// or saved as a custom style in the account.
//
// THE HOUSE RULE
//
// Every descriptor names the imperfections to KEEP: a flubbed horn
// attack, a tape dropout, room tone instead of a clean fade, a count-in
// left at the head. That is the point — a perfectly produced track is
// not this house. So the text is carried VERBATIM: a tool that rewords
// it is a tool that loses the details that carry the character.
//
// THE HEADER
//
// Each style opens with a bracketed title line and a tempo/mood/role
// line, then the descriptor. The header is how the account's own house
// styles are written (the "Serbian Byzantine Choir M" style is
// "[Trippy Microhouse Textural Fusion]" + named sections), so these sit
// beside the old ones rather than in a different shape.
//
// THE LIMITS
//
// The server's tag limit is 1000 characters and its title limit is 100.
// The longest style here is 689 characters including the header, so
// every one fits with room to spare. The cut in styleText() exists for
// a hand-edited preset, not for these.

const fs = require('node:fs');
const path = require('node:path');

// Server-side limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

const REGISTRY_PATH = path.join(__dirname, 'suno-style-library.json');

/**
 * The registry, read from disk.
 * @returns {object} the registry object
 */
function loadLibrary() {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

/**
 * A preset by slug or by display name.
 * @param {string} key
 * @returns {object|null}
 */
function findPreset(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return null;
    const lib = loadLibrary();
    return lib.presets.find(
        (p) => String(p.slug).toLowerCase() === k
            || String(p.name).toLowerCase() === k
    ) || null;
}

/**
 * The header a style opens with.
 *
 * `[<name> — <genre>]` then `<tempo> · <mood> · <role>`.
 *
 * @param {object} preset
 * @returns {string}
 */
function styleHeader(preset) {
    const p = preset || {};
    const title = String(p.name || 'Untitled').trim();
    const genre = String(p.genre || '').trim();
    const line = [p.tempo, p.mood, p.role]
        .map((x) => String(x == null ? '' : x).trim())
        .filter(Boolean)
        .join(' · ');
    const first = genre ? `[${title} — ${genre}]` : `[${title}]`;
    return line ? `${first}\n${line}` : first;
}

/**
 * The full style text: the header, then the descriptor VERBATIM.
 *
 * Cut to the server's limit if it overflows — the header first, because
 * it identifies the style and the descriptor is the artist's text.
 *
 * @param {object} preset
 * @param {number} limit
 * @returns {string}
 */
function styleText(preset, limit = LIMITS.tags) {
    const p = preset || {};
    const header = styleHeader(p);
    const body = String(p.descriptor || '').trim();
    const text = body ? `${header}\n\n${body}` : header;
    if (text.length <= limit) return text;
    // Keep the header whole and cut the body to what is left.
    const room = limit - header.length - 2;   // the blank line
    if (room <= 0) return header.slice(0, limit);
    return `${header}\n\n${body.slice(0, room).trimEnd()}`;
}

/**
 * The saved-style title for a preset.
 * @param {object} preset
 * @returns {string}
 */
function styleTitle(preset) {
    const p = preset || {};
    return String(p.name || 'Style').trim().slice(0, LIMITS.title);
}

/**
 * Every style in the library, as `{ title, tags }` — the exact shape
 * the server takes.
 *
 * @returns {Array<object>}
 */
function libraryStyles() {
    return loadLibrary().presets.map((p) => ({
        slug: p.slug,
        title: styleTitle(p),
        tags: styleText(p),
    }));
}

module.exports = {
    LIMITS,
    REGISTRY_PATH,
    loadLibrary,
    findPreset,
    styleHeader,
    styleText,
    styleTitle,
    libraryStyles,
};

if (require.main === module) {
    const lib = loadLibrary();
    const key = process.argv[2];
    const one = key ? findPreset(key) : null;
    if (key && !one) {
        process.stderr.write(`no preset named "${key}"\n`);
        process.exit(2);
    }
    const list = one ? [one] : lib.presets;
    for (const p of list) {
        process.stdout.write(`\n=== ${styleTitle(p)} (${p.slug})\n`);
        process.stdout.write(`${styleText(p)}\n`);
    }
}
