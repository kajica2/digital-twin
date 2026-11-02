#!/usr/bin/env node
'use strict';
// lib/suno-humanize.js
//
// The HUMANIZE layer — the raw / unpolished suffix.
//
// WHY IT IS SEPARATE
//
// A descriptor says what the music IS. The humanize layer says what it
// is NOT: not quantised, not mastered, not polished, not clean.
//
// Suno's default sound IS polished — that is the thing standing
// between a style and the raw take it describes. A descriptor that
// says "live to two-track, audible breathing" will still come back
// smooth unless something says otherwise.
//
// It is a SUFFIX because it composes AFTER the descriptor, and because
// the house rule is that the DESCRIPTOR ALWAYS WINS when the two exceed
// the server's 1000-character tag limit. A variant that loses its
// descriptor is not a variant of the source song.
//
// THE VOCABULARY IS MEASURED, NOT INVENTED
//
// MEASURED 2026-11-02 by reading the account's own raw styles (the
// ones tagged "Raw & Imperfect", "raw unplugged acoustic demo", and
// the like), the phrases Suno has been shown to respond to on THIS
// account are concrete ones:
//
//   close-mic spit, lip buzz, unquantized timing drift
//   valve clicks, lip noise, tape saturation, human drift
//   live one-take room recording, slight timing imperfections
//   honest rough performance, unquantized timing drift
//   no autotune, no mastering, no compression, no quantized
//
// So the suffixes are built from THOSE rather than from adjectives like
// "authentic" or "lo-fi", which say nothing about what to do.
//
// TWO FIELDS
//
// The suffix composes into `tags`. The exclusions go in
// `negative_tags` — the house's own rule for Pro and Premier, and a
// necessity: MEASURED, the account's "UNPLUGGED IMPERFECT TRUMPET"
// style is exactly 1000 characters, which is the tag limit. The
// exclusions cannot ride along in the same field.

const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

/**
 * The suffixes.
 *
 * `suffix`    composes AFTER the descriptor
 * `negatives` goes in the negative-tags field
 * `note`      what the suffix is FOR, in the operator's words
 */
const HUMANIZE_SUFFIXES = {
    // The general one — the brief's "raw unpolished imperfect".
    raw: {
        name: 'Raw',
        suffix: 'raw unprocessed recording, rough and imperfect takes, unpolished and unquantized, '
            + 'tape wobble and bleed, no gloss no polish, dry close-mic room tone, honest mistakes left in',
        negatives: 'no autotune, no mastering, no compression, no quantized, no glossy production',
        note: 'The general raw layer. Names the defects to KEEP, because Suno\'s default is polished.',
    },

    // The house's own most-developed raw vocabulary: a close-mic'd
    // acoustic horn with the player's noise intact.
    unplugged: {
        name: 'Unplugged',
        suffix: 'raw unplugged acoustic demo, close-mic spit and lip buzz, valve clicks and lip noise, '
            + 'unquantized timing drift, live one-take room recording, human drift and honest rough performance',
        negatives: 'no autotune, no mastering, no compression, no reverb, no quantization',
        note: 'The house\'s own raw vocabulary, taken from the account\'s UNPLUGGED IMPERFECT TRUMPET style.',
    },

    // One take. No edits, no second pass.
    'one-take': {
        name: 'One Take',
        suffix: 'live one-take room recording, single pass with no edits or second takes, '
            + 'slight timing imperfections, natural drift, honest rough performance left in',
        negatives: 'no autotune, no mastering, no overdubs, no quantization',
        note: 'One take, no edits. For when the performance itself is the point.',
    },

    // The tape. The house leans on tape more than anything else.
    tape: {
        name: 'Tape',
        suffix: 'raw tape-saturated room, tape wobble and flutter, wow and flutter on imperfect human takes, '
            + 'tape hiss and bleed, unquantized timing drift, honest rough performance',
        negatives: 'no autotune, no digital precision, no mastering, no quantization',
        note: 'The tape layer. The house\'s most-used warmth.',
    },
};

const DEFAULT_SUFFIX = 'raw';

/** The suffix names, in order. */
function listSuffixes() {
    return Object.keys(HUMANIZE_SUFFIXES);
}

/** One suffix by key, falling back to the default. */
function suffixFor(key) {
    const k = String(key || '').trim().toLowerCase();
    return HUMANIZE_SUFFIXES[k] || HUMANIZE_SUFFIXES[DEFAULT_SUFFIX];
}

/**
 * The composed style text: the descriptor, then the suffix.
 *
 * The descriptor ALWAYS WINS. When the two overflow the limit, the
 * suffix is cut back — and a suffix cut to nothing is reported as a
 * real failure by the caller, not silently shipped.
 *
 * @param {object} o
 * @param {string} o.descriptor
 * @param {string} o.suffix
 * @param {number} o.limit
 * @returns {string}
 */
function humanizeText({ descriptor, suffix, limit = LIMITS.tags } = {}) {
    const d = String(descriptor || '').trim();
    const s = suffixFor(suffix).suffix;
    if (!d) return s.slice(0, limit);

    // Do not apply the same layer twice.
    //
    // The test is the layer's DISTINCTIVE phrase, not its first comma
    // segment: with a long descriptor neither segment contains the
    // other, so the first-segment comparison silently failed and the
    // suffix was appended to a style that already had it.
    const MARKERS = {
        raw: 'raw unprocessed recording',
        unplugged: 'raw unplugged acoustic demo',
        'one-take': 'live one-take room recording',
        tape: 'tape-saturated room',
    };
    const marker = MARKERS[String(suffix || '').trim().toLowerCase()] || MARKERS[DEFAULT_SUFFIX];
    const lower = d.toLowerCase();
    if (marker && lower.includes(marker.toLowerCase())) return d.slice(0, limit);

    if (d.length + 2 + s.length <= limit) return `${d}, ${s}`;

    // It does not fit. WHICH end gives way?
    //
    // The house rule is "the descriptor always wins" — and that is
    // right for a mutation, where the descriptor is the song and the
    // mutation is the amendment. But the HUMANIZE layer is the
    // opposite: the raw clause IS the point of the exercise, and a
    // style that ends "close-mic roo" has lost the thing it was asked
    // for.
    //
    // So the suffix keeps its TAIL (its meaning lives at the end —
    // "honest mistakes left in" is not optional) and the descriptor
    // gives way from the FRONT.
    //
    // MEASURED: the KAI master style is 856 characters and the raw
    // suffix is 176. Together they are 1034 — over the limit — and the
    // suffix's tail was being cut to "dry close-mic roo".
    const room = limit - s.length - 2;   // the ", " between them
    if (room <= 0) return s.slice(0, limit);

    // Cut the descriptor at a CLAUSE boundary, not mid-word — the
    // first version dropped the front and left the style starting
    // "big band, 16-piece…", which reads like a mistake.
    const tail = d.slice(-room);
    const cut = tail.search(/[,.;] /);
    const kept = cut > 0 ? tail.slice(cut + 1).replace(/^[\s,]+/, '') : tail.replace(/^[\s,]+/, '');
    return `${kept}, ${s}`;
}

/**
 * The two fields, ready to send.
 *
 * @param {object} o
 * @param {string} o.descriptor
 * @param {string} o.suffix
 * @returns {{style: string, negativeTags: string}}
 */
function humanizeFields({ descriptor, suffix } = {}) {
    const s = suffixFor(suffix);
    return {
        style: humanizeText({ descriptor, suffix }),
        negativeTags: String(s.negatives || '').slice(0, LIMITS.negative_tags),
    };
}

module.exports = {
    LIMITS,
    HUMANIZE_SUFFIXES,
    DEFAULT_SUFFIX,
    listSuffixes,
    suffixFor,
    humanizeText,
    humanizeFields,
};

if (require.main === module) {
    const key = process.argv[2] || DEFAULT_SUFFIX;
    const s = suffixFor(key);
    process.stdout.write(`\n=== ${s.name}  [${key}]\n`);
    process.stdout.write(`\nSUFFIX\n${s.suffix}\n`);
    process.stdout.write(`\nNEGATIVES\n${s.negatives}\n`);
    process.stdout.write(`\n${s.note}\n`);
}
