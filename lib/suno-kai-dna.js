#!/usr/bin/env node
'use strict';
// lib/suno-kai-dna.js
//
// The KAI sound DNA — the Nordic Modern Jazz Big Band.
//
// THREE FIELDS, NOT ONE
//
// MEASURED against the server's limits: the master style is 856
// characters and the exclusions are 211. TOGETHER they are 1069 —
// over the 1000-character tag limit.
//
// They go in SEPARATE fields (`tags` and `negative_tags`), which is
// what the house rule says to do on Pro/Premier anyway: move the
// exclusions into Exclude Styles under Advanced Options. And the
// arrangement goes in the lyrics field, as section tags.
//
// THE SOUND
//
// Scandinavian contemporary orchestral jazz, restrained brass writing,
// spacious harmonies, asymmetric rhythmic phrasing, acoustic intimacy
// and natural ensemble dynamics. The defining character is a large
// ensemble playing with the intimacy of a small jazz group: not
// big-band blasts, but subtle tension, silence, shifting meters and
// carefully balanced instrumental colors.
//
// THE ARRANGEMENT
//
// Six movements, written as square-bracketed section tags carrying the
// clock time and the movement's title — the house rules: all
// instructions in brackets, blank lines between sections, and the
// METER in the style box (it is a global property and is weighted far
// more heavily there than inside a lyrics tag).

const fs = require('node:fs');
const path = require('node:path');

// Server-side limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

const DNA_PATH = path.join(__dirname, 'suno-kai-sound-dna.json');

/** The registry, read from disk. */
function loadDna() {
    return JSON.parse(fs.readFileSync(DNA_PATH, 'utf8'));
}

/** One style by slug or display name. */
function findStyle(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return null;
    return loadDna().styles.find(
        (s) => String(s.slug).toLowerCase() === k || String(s.name).toLowerCase() === k
    ) || null;
}

/**
 * The arrangement as a lyrics field: one bracketed section tag per
 * movement, each carrying its clock time and its title.
 *
 * @param {object} style
 * @returns {string}
 */
function arrangementLyrics(style) {
    const s = style || {};
    const arr = Array.isArray(s.arrangement) ? s.arrangement : [];
    return arr.map((m) => {
        const tag = String(m.tag || 'Instrumental');
        const time = `${m.start}-${m.end}`;
        const title = String(m.title || '').trim();
        const dir = String(m.direction || '').trim();
        const head = title ? `${tag} | ${time} | ${title}` : `${tag} | ${time}`;
        return dir ? `[${head} — ${dir}]` : `[${head}]`;
    }).join('\n');
}

/**
 * The three fields, ready to send.
 *
 * @param {object} style
 * @returns {{style: string, negativeTags: string, prompt: string}}
 */
function styleFields(style) {
    const s = style || {};
    return {
        style: String(s.style || '').slice(0, LIMITS.tags),
        negativeTags: String(s.negativeTags || '').slice(0, LIMITS.negative_tags),
        prompt: String(s.lyrics || arrangementLyrics(s)).slice(0, LIMITS.prompt),
    };
}

/**
 * The house's own suggested variation of a style.
 *
 * @param {object} style
 * @returns {{title: string, style: string, note: string}}
 */
function variationFields(style) {
    const s = style || {};
    const v = s.variation || {};
    return {
        title: String(v.name || `${s.name || 'Style'} — variation`).slice(0, LIMITS.title),
        style: String(v.style || s.style || '').slice(0, LIMITS.tags),
        note: String(v.note || ''),
    };
}

module.exports = {
    LIMITS,
    DNA_PATH,
    loadDna,
    findStyle,
    arrangementLyrics,
    styleFields,
    variationFields,
};

if (require.main === module) {
    const key = process.argv[2];
    const style = key ? findStyle(key) : loadDna().styles[0];
    if (!style) {
        process.stderr.write(`no style named "${key}"\n`);
        process.exit(2);
    }
    const f = styleFields(style);
    process.stdout.write(`\n=== ${style.name}  [${style.slug}]\n`);
    process.stdout.write(`\nSTYLE (${f.style.length} chars)\n${f.style}\n`);
    process.stdout.write(`\nEXCLUSIONS (${f.negativeTags.length} chars)\n${f.negativeTags}\n`);
    process.stdout.write(`\nARRANGEMENT / LYRICS FIELD (${f.prompt.length} chars)\n${f.prompt}\n`);
    const v = variationFields(style);
    process.stdout.write(`\nSUGGESTED VARIATION — ${v.title}\n${v.style}\n\n${v.note}\n`);
}
