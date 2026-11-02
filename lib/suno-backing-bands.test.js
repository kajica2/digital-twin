#!/usr/bin/env node
'use strict';

// lib/suno-backing-bands.test.js — the seven backing-band briefs.
//
// Run: node lib/suno-backing-bands.test.js
//
// The contract this pins:
//   - all seven load
//   - every band has a slug, a name, a style and an arrangement
//   - every style is non-empty and within the measured 1000-char limit
//   - every arrangement reserves EXACTLY two open solo spaces
//   - every arrangement ends with the three closing lines
//   - every slug is unique, lowercase and URL-safe
//   - no band's text names the subject's race or ethnicity

const bands = require('./suno-backing-bands.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        const ok = fn();
        if (ok === false) {
            console.log(`  FAIL ${name}`);
            failed++;
        } else {
            console.log(`  ok   ${name}`);
            passed++;
        }
    } catch (e) {
        console.log(`  FAIL ${name} :: ${e.message}`);
        failed++;
    }
}

console.log('suno-backing-bands.test');

// --- the registry loads -------------------------------------------------

check('all seven bands load', () => {
    const list = bands.bands();
    if (list.length !== 7) throw new Error(`expected 7 bands, got ${list.length}`);
    return true;
});

check('every band has a slug, a name, a style and an arrangement', () => {
    for (const b of bands.bands()) {
        for (const k of ['slug', 'name', 'style', 'arrangement']) {
            if (!b[k]) throw new Error(`${b.slug || '?'} is missing ${k}`);
        }
    }
    return true;
});

check('every band has an index and they are 1..7 in order', () => {
    const list = bands.bands();
    list.forEach((b, i) => {
        if (b.index !== i + 1) throw new Error(`${b.slug} has index ${b.index}, expected ${i + 1}`);
    });
    return true;
});

// --- the style box ------------------------------------------------------

check('every style is non-empty', () => {
    for (const b of bands.bands()) {
        if (!b.style.trim()) throw new Error(`${b.slug} has an empty style`);
    }
    return true;
});

check(`every style is within the ${bands.STYLE_LIMIT}-character limit`, () => {
    for (const b of bands.bands()) {
        const n = bands.styleLength(b);
        if (n > bands.STYLE_LIMIT) throw new Error(`${b.slug} style is ${n} chars`);
    }
    return true;
});

check('every style leaves room for the exclusions to travel separately', () => {
    // The house rule: the exclusions live in their OWN field because the
    // account's own 1000-char style leaves no room in the same one.
    for (const b of bands.bands()) {
        if (!b.negativeTags || !b.negativeTags.trim()) {
            throw new Error(`${b.slug} has no exclusions`);
        }
    }
    return true;
});

// --- the arrangement ----------------------------------------------------

check('every arrangement is an array of section tags', () => {
    for (const b of bands.bands()) {
        if (!Array.isArray(b.arrangement)) throw new Error(`${b.slug} arrangement is not an array`);
        for (const a of b.arrangement) {
            if (typeof a !== 'string' || !a.startsWith('[') || !a.endsWith(']')) {
                throw new Error(`${b.slug} has a malformed section tag: ${a}`);
            }
        }
    }
    return true;
});

check(`every arrangement reserves exactly ${bands.OPEN_SPACES} open solo spaces`, () => {
    for (const b of bands.bands()) {
        const n = bands.openSpaceCount(b);
        if (n !== bands.OPEN_SPACES) {
            throw new Error(`${b.slug} reserves ${n} open spaces, expected ${bands.OPEN_SPACES}`);
        }
    }
    return true;
});

check('every arrangement ends with the three closing lines, in order', () => {
    for (const b of bands.bands()) {
        const tail = b.arrangement.slice(-bands.CLOSING_LINES.length);
        bands.CLOSING_LINES.forEach((line, i) => {
            if (tail[i] !== line) {
                throw new Error(`${b.slug} ends with ${JSON.stringify(tail)}, expected ${JSON.stringify(bands.CLOSING_LINES)}`);
            }
        });
    }
    return true;
});

check('the arrangement joins into the lyrics field without losing a section', () => {
    for (const b of bands.bands()) {
        const text = bands.arrangementText(b);
        const flat = bands.arrangementFlat(b);
        if (text.split('\n').length !== b.arrangement.length) {
            throw new Error(`${b.slug} lost a section when joined`);
        }
        if (flat.split(' ').length < b.arrangement.length) {
            throw new Error(`${b.slug} lost a section when flattened`);
        }
    }
    return true;
});

// --- slugs --------------------------------------------------------------

check('every slug is unique', () => {
    const s = bands.slugs();
    if (new Set(s).size !== s.length) throw new Error('duplicate slugs');
    return true;
});

check('every slug is lowercase and URL-safe', () => {
    for (const slug of bands.slugs()) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`slug '${slug}' is not URL-safe`);
        }
    }
    return true;
});

// --- the house vocabulary rule ------------------------------------------

check("no band's text names the subject's race or ethnicity", () => {
    // The house rule (AGENTS.md) forbids naming the subject's race or
    // ethnicity. It is written about image prompts, but the vocabulary
    // here is deliberately free of it too — and these are the terms that
    // would override a reference photo if they ever leaked into an
    // image prompt.
    //
    // "Afro-Latin" in band 01 is a GENRE lineage, not a subject
    // descriptor, so the matcher looks for the whole phrase and for the
    // standalone ethnicity words — not for "afro" alone.
    const banned = [
        'black', 'white', 'african', 'african-american', 'asian', 'hispanic',
        'latino', 'caucasian', 'ebony', 'negro', 'ethnic', 'racially',
    ];
    for (const b of bands.bands()) {
        const text = [
            b.style, b.negativeTags, b.arrangement.join(' '), b.name, b.note || '',
        ].join(' ').toLowerCase();
        for (const term of banned) {
            const re = new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, 'i');
            if (re.test(text)) {
                throw new Error(`${b.slug} contains the ethnicity descriptor '${term}'`);
            }
        }
    }
    return true;
});

check("no arrangement names the subject's race or ethnicity", () => {
    const banned = ['black', 'white', 'african', 'asian', 'hispanic', 'caucasian', 'ebony'];
    for (const b of bands.bands()) {
        const text = b.arrangement.join(' ').toLowerCase();
        for (const term of banned) {
            const re = new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, 'i');
            if (re.test(text)) throw new Error(`${b.slug} arrangement contains '${term}'`);
        }
    }
    return true;
});

// --- the accessors ------------------------------------------------------

check('bySlug finds every band and refuses a bad slug', () => {
    for (const b of bands.bands()) {
        if (bands.bySlug(b.slug).slug !== b.slug) throw new Error(`bySlug failed for ${b.slug}`);
    }
    let threw = false;
    try {
        bands.bySlug('no-such-band');
    } catch {
        threw = true;
    }
    if (!threw) throw new Error('bySlug did not refuse an unknown slug');
    return true;
});

check('byIndex finds every band', () => {
    for (const b of bands.bands()) {
        if (bands.byIndex(b.index).slug !== b.slug) throw new Error(`byIndex failed for ${b.index}`);
    }
    return true;
});

check('isWellFormed agrees with the individual checks', () => {
    for (const b of bands.bands()) {
        if (!bands.isWellFormed(b)) throw new Error(`${b.slug} is not well formed`);
    }
    return true;
});

check('the registry carries its own notes', () => {
    const n = bands.notes();
    for (const k of ['note', 'split', 'limits', 'openSpace']) {
        if (!n[k] || !String(n[k]).trim()) throw new Error(`the registry's ${k} note is empty`);
    }
    return true;
});

console.log(`\n[suno-backing-bands.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
