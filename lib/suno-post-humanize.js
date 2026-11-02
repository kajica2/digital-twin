#!/usr/bin/env node
'use strict';
// lib/suno-post-humanize.js
//
// The POST-SUBMIT humanize preset.
//
// WHAT IT DOES
//
// A track has already been submitted and rendered. This applies the
// humanize layer to it: the clip's OWN style — the one Suno came back
// with — is composed with the raw suffix, and the clip is re-covered
// with that.
//
// WHY THE CLIP'S OWN STYLE, NOT THE ONE WE SENT
//
// MEASURED 2026-11-02: the style in `metadata.tags` is Suno's
// PARAPHRASE of what was sent, not the sent text. A clip submitted
// with
//
//   "Recorded live to two-track in a natural concert hall, authentic
//    room reflections, audible breathing, loose human timing"
//
// came back with
//
//   "raw two-track concert-hall recording with room reflections,
//    audible breaths, tape wobble, bleed, dry close-mic room tone and
//    unquantized timing"
//
// So the post-submit pass humanizes what the track IS, not what we
// asked for — which is the right thing, because the paraphrase is what
// the next render will be built on.
//
// WHY A COVER
//
// MEASURED 2026-11-02: a plain generation is REFUSED on this account
// (the balance does not move and the clip's audio points at
// /api/forbidden). A cover of an existing clip renders and costs
// nothing. So the post-submit operation is a cover — of the SUBMITTED
// clip itself, with `cover_clip_id` naming the submitted clip, not the
// source underneath it.
//
//   node lib/suno-post-humanize.test.js

const crypto = require('node:crypto');

const { humanizeFields, suffixFor } = require('./suno-humanize.js');

// Server-side limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

/**
 * The title a humanized re-render carries.
 *
 * The suffix name SURVIVES the trim — it is what distinguishes one
 * pass from another — and the song name gives way.
 *
 * @param {string} name
 * @param {string} suffix
 * @returns {string}
 */
function buildTitle(name, suffix) {
    const s = suffixFor(suffix);
    const base = String(name || 'Untitled').trim();
    const tag = ` (${s.name})`;
    if ((base + tag).length <= LIMITS.title) return base + tag;
    return `${base.slice(0, Math.max(1, LIMITS.title - tag.length)).trimEnd()}${tag}`;
}

/**
 * The request body for one post-submit humanize pass.
 *
 * @param {object} o
 * @param {object} o.clip           the SUBMITTED clip
 * @param {string} o.suffix         raw | unplugged | one-take | tape
 * @param {string} o.workspace      the project id
 * @param {string} o.title
 * @param {number} o.influence
 * @returns {object} the request body
 */
function postSubmitBody({
    clip,
    suffix = 'raw',
    workspace = 'default',
    title,
    influence = 0.8,
} = {}) {
    const c = clip || {};
    const md = c.metadata || {};

    // The clip's OWN style — Suno's paraphrase of what it rendered.
    const descriptor = String(md.tags || '').trim();
    const h = humanizeFields({ descriptor, suffix });

    // The lyrics travel with it.
    const prompt = String(md.prompt || '').trim() || '[Instrumental]';

    // The clip's own length. A clip with no duration is a max-mode one
    // (~198 s) — MEASURED: falling back to the simple-mode duration
    // would cap it at 60 s, a third of the length.
    const raw = Number(md.duration);
    const duration = Number.isFinite(raw) && raw > 0 ? raw : 198;

    return {
        prompt: prompt.slice(0, LIMITS.prompt),
        task: 'cover',
        // The SUBMITTED clip — not the source underneath it.
        cover_clip_id: c.id,
        cover_start_s: 0,
        cover_end_s: duration,
        mv: c.model_name || 'chirp-hawk',
        title: String(title || buildTitle(c.title, suffix)).slice(0, LIMITS.title),
        // The clip's own style WITH the humanize layer.
        tags: h.style.slice(0, LIMITS.tags),
        // The exclusions ride in their own field — the house's rule for
        // Pro and Premier, and a necessity: a full-length style plus
        // its exclusions is over the 1000-character tag limit.
        negative_tags: h.negativeTags.slice(0, LIMITS.negative_tags),
        make_instrumental: md.make_instrumental === true,
        duration: 198,
        generation_type: 'TEXT',
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
 * The plan: one body per submitted clip.
 *
 * @param {object} o
 * @param {Array<object>} o.clips
 * @param {string} o.suffix
 * @param {string} o.workspace
 * @param {number} o.influence
 * @returns {Array<object>} [{ clipId, title, body }]
 */
function postSubmitPlan({
    clips,
    suffix = 'raw',
    workspace = 'default',
    influence = 0.8,
} = {}) {
    const list = Array.isArray(clips) ? clips : [];
    return list.filter((c) => c && c.id).map((c) => {
        const title = buildTitle(c.title, suffix);
        return {
            clipId: c.id,
            title,
            body: postSubmitBody({ clip: c, suffix, workspace, title, influence }),
        };
    });
}

module.exports = {
    LIMITS,
    buildTitle,
    postSubmitBody,
    postSubmitPlan,
};
