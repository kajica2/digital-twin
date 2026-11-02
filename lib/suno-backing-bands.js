#!/usr/bin/env node
'use strict';

// lib/suno-backing-bands.js — the seven backing-band briefs.
//
// WHAT A "BAND" IS HERE
// A brief for a rhythm section and a horn section that plays BEHIND a
// soloist. It is not a song and not a solo: what it reserves is SPACE.
// Every band carries two `[Open Trumpet Space: 32 bars, ...]` sections —
// that is the contract, and it is what the test asserts.
//
// THE THREE FIELDS, AND WHY THEY ARE THREE
//
//   style          -> Suno's style/tags field. Global: it governs the
//                     whole track, and Suno weights it far more heavily
//                     than the lyrics field. Hard limit: 1000 CHARACTERS
//                     (measured, 2026-11-02).
//   negativeTags   -> Suno's exclusions field. The house rule for
//                     Pro/Premier is that exclusions live in their own
//                     field ("Exclude Styles" under Advanced Options) —
//                     the account's own "UNPLUGGED IMPERFECT TRUMPET"
//                     style is exactly 1000 characters, so the
//                     exclusions cannot ride along in the same field.
//   arrangement    -> Suno's lyrics/prompt field, as square-bracketed
//                     section tags. Section-by-section, so it cannot go
//                     in the global style box: that would spend the
//                     characters the timbre needs.
//
// THE SPLIT IS NOT COSMETIC
// Suno PARAPHRASES the style box (measured: a style submitted as
// "Recorded live to two-track in a natural concert hall, authentic room
// reflections, audible breathing, loose human timing" came back as "raw
// two-track concert-hall recording with room reflections, audible
// breaths, tape wobble, bleed, dry close-mic room tone and unquantized
// timing"), but the ARRANGEMENT comes back VERBATIM — the clock times,
// the movement titles, every tag. So the arrangement field is the part
// that is a contract, and the style box is a description of intent.
//
// A note on what is NOT here: these briefs never name the subject's race
// or ethnicity. The house rule (AGENTS.md) is about image prompts, but
// the vocabulary here is deliberately free of it — see `_why-vocabulary`.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, 'suno-backing-bands.json');

/** Suno's style field is limited to this many characters (measured). */
const STYLE_LIMIT = 1000;

/** Every band reserves this many open solo spaces. */
const OPEN_SPACES = 2;

/** The marker that opens a reserved solo space. */
const OPEN_SPACE_MARK = '[Open Trumpet Space:';

/** The lines every arrangement ends with. */
const CLOSING_LINES = ['[No lead melody]', '[No horn solos]', '[No vocals]'];

let _registry = null;

/** The parsed registry. */
function registry() {
    if (_registry) return _registry;
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    _registry = JSON.parse(raw);
    return _registry;
}

/** Every band, in house order. */
function bands() {
    return registry().bands.slice();
}

/** One band by its slug. */
function bySlug(slug) {
    const b = registry().bands.find(x => x.slug === slug);
    if (!b) throw new Error(`no backing band with slug '${slug}'`);
    return b;
}

/** One band by its house index (1..7). */
function byIndex(index) {
    const b = registry().bands.find(x => x.index === index);
    if (!b) throw new Error(`no backing band with index ${index}`);
    return b;
}

/** The slugs, in house order. */
function slugs() {
    return registry().bands.map(b => b.slug);
}

/**
 * The ARRANGEMENT as one string — the shape Suno's lyrics field wants.
 * The registry keeps it as an array of section tags (that is what it IS);
 * this joins them with newlines so the sections stay legible.
 */
function arrangementText(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    return b.arrangement.join('\n');
}

/**
 * The arrangement as a single line — for a field that cannot hold
 * newlines, or for a comparison that should not care about wrapping.
 */
function arrangementFlat(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    return b.arrangement.join(' ');
}

/** How many reserved solo spaces a band has. */
function openSpaceCount(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    return b.arrangement.filter(a => a.startsWith(OPEN_SPACE_MARK)).length;
}

/** The style field's length — the number the 1000-char limit is about. */
function styleLength(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    return b.style.length;
}

/** The exclusions field's length. */
function negativeLength(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    return (b.negativeTags || '').length;
}

/**
 * Does this band fit the measured limits? `style` must be non-empty and
 * within the 1000-character cap; the arrangement must reserve exactly
 * two open solo spaces and end with the three closing lines.
 */
function isWellFormed(band) {
    const b = typeof band === 'string' ? bySlug(band) : band;
    if (!b.style || !b.style.trim()) return false;
    if (b.style.length > STYLE_LIMIT) return false;
    if (!Array.isArray(b.arrangement) || b.arrangement.length === 0) return false;
    if (openSpaceCount(b) !== OPEN_SPACES) return false;
    const tail = b.arrangement.slice(-CLOSING_LINES.length);
    return CLOSING_LINES.every((line, i) => tail[i] === line);
}

/** The registry's own notes — the "why" behind the shape. */
function notes() {
    const r = registry();
    return {
        note: r._note,
        split: r['_why-split'],
        limits: r['_why-limits'],
        openSpace: r['_why-open-space'],
        raw: r['_why-raw'],
        vocabulary: r['_why-vocabulary'],
        source: r._source,
    };
}

module.exports = {
    STYLE_LIMIT,
    OPEN_SPACES,
    OPEN_SPACE_MARK,
    CLOSING_LINES,
    registry,
    bands,
    bySlug,
    byIndex,
    slugs,
    arrangementText,
    arrangementFlat,
    openSpaceCount,
    styleLength,
    negativeLength,
    isWellFormed,
    notes,
};

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--list') {
        for (const b of bands()) {
            const ok = isWellFormed(b) ? 'ok' : 'MALFORMED';
            console.log(`${b.index}. ${b.name}  [${b.slug}]  ${b.tempo || ''} ${b.meter || ''}`);
            console.log(`   style ${styleLength(b)}/${STYLE_LIMIT}  negative ${negativeLength(b)}  open-spaces ${openSpaceCount(b)}  ${ok}`);
        }
    } else if (arg === '--one' && process.argv[3]) {
        const b = bySlug(process.argv[3]);
        console.log(JSON.stringify(b, null, 2));
    } else {
        console.log('usage: suno-backing-bands.js --list | --one <slug>');
    }
}
