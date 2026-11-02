#!/usr/bin/env node
'use strict';
// lib/suno-meter-roll.js
//
// Roll the uncommon-meter Suno prompts as COVERS of the house source.
//
// WHY COVERS AND NOT PLAIN GENERATIONS
//
// MEASURED 2026-11-02 on this account:
//
//   * A plain text generation is REFUSED. The submit answers with a
//     clip id, the balance does not move (7 -> 7), and the clip's audio
//     URL points at studio-api.prod.suno.com/api/forbidden.
//   * A COVER of an existing track RENDERS, and costs nothing.
//
// The workspace at /create?wid=8fccfe6f-… ("kais_style new", 593
// clips) is entirely made of covers — every clip on its first page is
// `task: cover` — so this is how the house already works.
//
// WHY THE STYLE BOX REPLACES THE DESCRIPTOR
//
// On a cover, `override_fields: ['prompt','tags']` means the style box
// takes the source's place. MEASURED on the workspace's own clips: they
// carry the meter style ("Nordic modern jazz big band with 16-piece
// ensemble…"), NOT the source's "Dark jazz electronica", while the
// lyrics travel in the prompt field.
//
// So the meter style is NOT composed with the source descriptor. It
// replaces it. That is the opposite of `lib/suno-mutator.js`'s rule
// (descriptor + mutation), and deliberately so: a meter prompt is a
// whole style, not an amendment.
//
// WHY FOUR ROLLS EACH
//
// The house rule for meter prompts: meter tags are probability weights,
// not commands. Suno approximates rather than counts — 13/8 often lands
// as 7/8 with extra weight, and 7/8 straightens into 4/4 the moment
// density drops. So generate four and keep the one where the bars
// actually line up.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { humanizeFields } = require('./suno-humanize.js');

// Server-side limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

const PROMPTS_PATH = path.join(__dirname, 'suno-meter-prompts.json');

/** The meter prompts, read from disk. */
function loadPrompts() {
    return JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8')).prompts;
}

/** One prompt by slug or display name. */
function findPrompt(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return null;
    return loadPrompts().find(
        (p) => String(p.slug).toLowerCase() === k || String(p.name).toLowerCase() === k
    ) || null;
}

/**
 * The negative tags every roll carries.
 *
 * The house rule: the negatives close the style box, and Suno drops
 * tags from the MIDDLE past a certain count — so the exclusions go
 * LAST, where they survive.
 */
function negativeTagsFor(prompt) {
    const style = String((prompt && prompt.style) || '');
    const negatives = [];
    // Pull the "no X" clauses the style box already names.
    for (const m of style.matchAll(/no ([a-z ]+?)(?:,|$)/g)) {
        negatives.push(`no ${m[1].trim()}`);
    }
    // The house exclusions that are always worth stating.
    for (const n of ['no drum machine', 'no fusion']) {
        if (!negatives.some((x) => x.includes(n.slice(3).split(' ')[0]))) negatives.push(n);
    }
    return negatives.join(', ').slice(0, LIMITS.negative_tags);
}

/**
 * The cover body for one roll.
 *
 * @param {object} o
 * @param {object} o.prompt          one entry from the registry
 * @param {string} o.sourceClipId    the clip to cover
 * @param {number} o.sourceDuration  the source's length in seconds
 * @param {string} o.title
 * @param {string} o.workspace       the project id (the workspace's wid)
 * @param {number} o.influence
 * @returns {object} the request body
 */
function coverBody({
    prompt,
    sourceClipId,
    sourceDuration,
    title,
    workspace = 'default',
    influence = 0.7,
    // Explicit fields, for a caller that is not a registry entry — the
    // KAI sound DNA, whose style, exclusions and arrangement come from
    // three different places.
    style,
    lyrics,
    negativeTags,
    // The humanize layer: when set, the style is the descriptor WITH
    // the raw/unpolished suffix composed after it, and the suffix's
    // exclusions go into the negative field.
    humanize,
} = {}) {
    const p = prompt || {};
    let styleText = style !== undefined ? style : p.style;
    let lyricsText = lyrics !== undefined ? lyrics : p.lyrics;
    let negatives = negativeTags !== undefined ? negativeTags : negativeTagsFor(p);
    if (humanize) {
        // The humanize layer composes AFTER the descriptor, and its
        // exclusions go in the negative field — the house's own rule,
        // and a necessity: a full-length style plus its exclusions is
        // over the 1000-character tag limit.
        const h = humanizeFields({ descriptor: styleText, suffix: humanize });
        styleText = h.style;
        negatives = negatives && negatives.length ? negatives : h.negativeTags;
    }
    return {
        // The LYRICS FIELD travels in the prompt. The house rule is
        // that the lyrics are the lyrics — they are not paraphrased.
        prompt: String(lyricsText || '').slice(0, LIMITS.prompt),
        task: 'cover',
        cover_clip_id: sourceClipId,
        cover_start_s: 0,
        cover_end_s: Number(sourceDuration) || 0,
        mv: 'chirp-hawk',
        title: String(title || p.name || 'Untitled').slice(0, LIMITS.title),
        // The STYLE BOX replaces the source's descriptor.
        tags: String(styleText || '').slice(0, LIMITS.tags),
        negative_tags: String(negatives || '').slice(0, LIMITS.negative_tags),
        make_instrumental: true,
        duration: 198,
        generation_type: 'TEXT',
        // The two fields the style box and the lyrics field own.
        override_fields: ['prompt', 'tags'],
        project_id: String(workspace || 'default'),
        transaction_uuid: crypto.randomUUID(),
        metadata: {
            web_client_pathname: '/create',
            create_surface: 'home',
            create_mode: 'custom',
            is_max_mode: true,
            control_sliders: {
                audio_weight: Number(influence),
                weirdness_constraint: 0,
                aug_creativity: 1,
            },
        },
    };
}

/**
 * The roll plan: every prompt, four times, each with its own body.
 *
 * @param {object} o
 * @param {Array} o.prompts
 * @param {string} o.sourceClipId
 * @param {number} o.sourceDuration
 * @param {string} o.workspace
 * @param {number} o.roll       rolls per prompt (default 4)
 * @param {number} o.influence
 * @returns {Array<object>} [{ slug, name, roll, title, body }]
 */
function rollPlan({
    prompts,
    sourceClipId,
    sourceDuration,
    workspace = 'default',
    roll = 4,
    influence = 0.7,
} = {}) {
    const list = Array.isArray(prompts) ? prompts : [];
    const out = [];
    for (const p of list) {
        for (let i = 1; i <= roll; i += 1) {
            // Each roll gets its own title, so the account's clip list
            // shows which roll is which.
            const title = `${p.name} ${i}/${roll}`.slice(0, LIMITS.title);
            out.push({
                slug: p.slug,
                name: p.name,
                meter: p.meter,
                roll: i,
                title,
                body: coverBody({
                    prompt: p,
                    sourceClipId,
                    sourceDuration,
                    title,
                    workspace,
                    influence,
                }),
            });
        }
    }
    return out;
}

module.exports = {
    LIMITS,
    PROMPTS_PATH,
    loadPrompts,
    findPrompt,
    negativeTagsFor,
    coverBody,
    rollPlan,
};

if (require.main === module) {
    const prompts = loadPrompts();
    const key = process.argv[2];
    const one = key ? findPrompt(key) : null;
    if (key && !one) {
        process.stderr.write(`no prompt named "${key}"\n`);
        process.exit(2);
    }
    for (const p of (one ? [one] : prompts)) {
        process.stdout.write(`\n=== ${p.name}  [${p.slug}]  ${p.meter}\n`);
        process.stdout.write(`STYLE BOX (${p.style.length} chars)\n${p.style}\n`);
        process.stdout.write(`\nLYRICS FIELD (${p.lyrics.length} chars)\n${p.lyrics}\n`);
        process.stdout.write(`\nNOTE\n${p.note}\n`);
    }
}
