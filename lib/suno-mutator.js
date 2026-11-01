#!/usr/bin/env node
'use strict';
// lib/suno-mutator.js
//
// Send a Suno URL, get custom variants.
//
// WHAT IT DOES
//
//   1. Takes a URL — a song page, a share link, a workspace, or a bare
//      clip id.
//   2. Reads that clip's own settings (model, duration, style tags,
//      influence, and the SOURCE clip it was made from).
//   3. Composes a set of custom VARIANTS of it: the same audio, a
//      different style applied to each.
//   4. Optionally saves each variant as a CUSTOM STYLE in the account
//      (so it appears in the studio's own style picker), and/or generates
//      a cover of the source using that style.
//
// WHY IT EXISTS
//
// `lib/suno-run.js` generates variants of a clip using the ten
// reference-lock PROTOCOLS — a fixed library of "keep the source
// faithful" directives. This is the other half: the user names the
// mutations they want ("dub", "orchestral", "lo-fi tape") and the
// mutator builds a custom style for each one.
//
// THE COMPOSITION RULE
//
//     tags = <the source's own style descriptor> + <the mutation>
//
// with the DESCRIPTOR always preserved — the mutation gives way. That is
// the same rule `lib/suno-styles.js` already established from the user's
// own saved style batch: a variant that loses the descriptor is not a
// variant of the source song, it is a different song.
//
// THE LIMITS
//
// Mirrored from GET /api/custom-model/shared (see docs/SUNO-STYLES.md):
// title 100, tags 1000, negative_tags 1000, prompt 5000.
//
// Pure Node, no deps. The network half is in main() and lives on
// `SunoClient` (lib/suno-web.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The server's field limits, mirrored from /api/custom-model/shared.
const LIMITS = {
    title: 100,
    tags: 1000,
    negative_tags: 1000,
    prompt: 5000,
};

// A clip id is a UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The browser identity the public pages answer. suno.com serves a
// bot-challenge to an obvious script.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------
// The URL
// ---------------------------------------------------------------------

/**
 * Read a Suno URL (or a bare clip id) into a clip id.
 *
 * The shapes:
 *   https://suno.com/song/<uuid>     a song page
 *   https://suno.com/s/<uuid>         a share link
 *   https://suno.com/create?wid=<uuid> a workspace
 *   <uuid>                           a bare clip id
 *
 * @param {string} input
 * @returns {{kind: string, clipId: string}|null} null when the input is
 *          not a Suno reference
 */
function parseSunoUrl(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return null;

    // A bare clip id.
    if (UUID_RE.test(raw)) return { kind: 'clip', clipId: raw.toLowerCase() };

    // A URL. The host must be Suno's, or a lookalike would send the
    // mutator to some other site with a Suno-shaped path.
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (!/(^|\.)suno\.com$/i.test(u.hostname)) return null;

    // A workspace: /create?wid=<uuid>
    const wid = u.searchParams.get('wid');
    if (wid && UUID_RE.test(wid)) {
        return { kind: 'workspace', clipId: wid.toLowerCase() };
    }

    // A song page or a share link: /song/<uuid> or /s/<uuid>
    const m = u.pathname.match(/\/(?:song|s)\/([0-9a-f-]{36})/i);
    if (m && UUID_RE.test(m[1])) {
        return { kind: 'song', clipId: m[1].toLowerCase() };
    }

    // A HOOK link: /hook/<uuid>. A hook is a section of a song, not the
    // song itself — but it carries the clip id, and the clip is what the
    // mutator needs.
    const hook = u.pathname.match(/\/hook\/([0-9a-f-]{36})/i);
    if (hook && UUID_RE.test(hook[1])) {
        return { kind: 'hook', clipId: hook[1].toLowerCase() };
    }

    // A SHORT share link: /s/<slug>. The slug is not a uuid, so the id
    // is not in the URL — suno.com answers with a 307 to /song/<uuid>.
    // MEASURED 2026-11-01. The resolve needs the network, so this is
    // returned with no id and resolved by resolveShortLink().
    const short = u.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
    if (short) {
        return { kind: 'short', clipId: null, slug: short[1] };
    }

    return null;
}

/**
 * Resolve a short /s/<slug> share link to its clip id.
 *
 * MEASURED 2026-11-01: suno.com answers `https://suno.com/s/<slug>`
 * with a 307 to `/song/<uuid>?sh=<slug>`, and the uuid is the clip.
 *
 * @param {string} slug
 * @param {object} [opts]
 * @param {Function} [opts.fetch] injectable, for the test
 * @returns {Promise<string|null>} the clip id, or null when it cannot be
 *          resolved — a network failure is a null, never a throw.
 */
async function resolveShortLink(slug, opts = {}) {
    const doFetch = opts.fetch || globalThis.fetch;
    if (!doFetch) return null;
    try {
        const res = await doFetch(`https://suno.com/s/${encodeURIComponent(slug)}`, {
            redirect: 'follow',
            headers: { 'user-agent': UA },
        });
        if (!res || !res.ok) return null;
        const final = String(res.url || '');
        const m = final.match(/\/(?:song|s|hook)\/([0-9a-f-]{36})/i);
        return (m && UUID_RE.test(m[1])) ? m[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * Find the clip a URL really points at, and the SOURCE clip behind it.
 *
 * A cover is made FROM another clip. Mutating the cover mutates the
 * cover; mutating the SOURCE is what "give me variants of this song"
 * means. So the source is followed one hop.
 *
 * @param {object} clip the clip the link resolves to
 * @param {object} deps
 * @param {Function} deps.getClip (id) => clip|null (async)
 * @returns {Promise<object>} { clipId, clipTitle, sourceClipId, sourceTitle, coverClipId }
 */
async function resolveClipId(clip, { getClip, follow = true } = {}) {
    const md = (clip && clip.metadata) || {};
    const coverClipId = md.cover_clip_id || md.edited_clip_id || null;
    const out = {
        clipId: (clip && clip.id) || null,
        clipTitle: (clip && clip.title) || null,
        coverClipId,
        sourceClipId: null,
        sourceTitle: null,
    };
    // `follow: false` mutates the clip the LINK pointed at, rather than
    // the clip it was made from.
    //
    // MEASURED 2026-11-01, on the artist's own chain: the link clip
    // carried the lyric sheet ("I keep the window open") while the clip
    // it was made from carried a different one (a Serbian hymn) — and
    // different TAGS too (Nordic modern jazz big band vs dark jazz
    // electronica). Following the chain is right for "variants of the
    // original recording"; NOT following it is right for "variants of
    // THIS version, the one I just made".
    if (!follow) {
        out.sourceClipId = out.clipId;
        out.sourceTitle = out.clipTitle;
        return out;
    }
    if (!coverClipId) {
        // A plain generation is its own source.
        out.sourceClipId = out.clipId;
        out.sourceTitle = out.clipTitle;
        return out;
    }
    out.sourceClipId = coverClipId;
    // getClip is async — the source's title is only known after a call.
    const source = typeof getClip === 'function' ? await getClip(coverClipId) : null;
    out.sourceTitle = (source && source.title) || null;
    return out;
}

// ---------------------------------------------------------------------
// The settings a variant inherits
// ---------------------------------------------------------------------

/**
 * The settings a variant carries over from the source clip.
 *
 * @param {object} clip
 * @returns {object} { mv, duration, descriptor, influence, isMaxMode, sourceDuration }
 */
function clipSettings(clip) {
    const md = (clip && clip.metadata) || {};
    const sliders = md.control_sliders || {};

    // Duration: the server wants a whole number of seconds.
    //
    // The 60 s cap is for SIMPLE mode, and simple mode is what the
    // server allows for a track SHORTER than 60 s. A source clip that is
    // 172 s long is not a 60 s track waiting to be trimmed — it is a
    // max-mode-shaped track, and capping it would silently replace the
    // song with a third of itself.
    //
    // MEASURED 2026-11-01: the first live run of this tool read a
    // 172 s source and produced `duration: 60` — the source's own
    // length, misread as a simple-mode length.
    const raw = Number(md.duration);
    const hasDuration = Number.isFinite(raw) && raw > 0;
    const declaredMax = md.is_max_mode !== undefined ? !!md.is_max_mode : null;
    // With no duration information at all, the track is a MAX-mode one
    // (~198 s). Falling back to simple mode would cap it at 60 s — a
    // third of the length, and a different piece of music.
    const isMax = declaredMax !== null ? declaredMax : (!hasDuration || raw >= 180);
    let duration = hasDuration ? Math.round(raw) : 198;
    if (isMax) duration = Math.max(180, duration);
    // The cap only applies BELOW the simple-mode ceiling — a source
    // longer than 60 s keeps its length.
    else if (duration > 60) duration = duration;
    else duration = Math.max(10, Math.min(60, duration));

    // The influence (Audio Weight). The server's slider runs 0..1.
    let influence = Number(sliders.audio_weight);
    if (!Number.isFinite(influence)) influence = 0.65;
    influence = Math.max(0, Math.min(1, influence));

    // The MODEL lives at the clip's TOP LEVEL, not in `metadata`.
    //
    // MEASURED 2026-11-01 on a live clip: `metadata.model_name` is
    // undefined and `metadata.major_model_version` is undefined, while
    // the clip itself carries `model_name: "chirp-hawk"` and
    // `major_model_version: "Custom"`. Reading only `metadata` meant the
    // mutator fell back to the default on every real clip.
    //
    // A "Custom" major version is not a model id, so it is not used as
    // one — the clip's own `model_name` is the model.
    const mv = (clip && clip.model_name)
        || md.model_name
        || (md.major_model_version && md.major_model_version !== 'Custom'
            ? md.major_model_version : null)
        || (clip && clip.major_model_version && clip.major_model_version !== 'Custom'
            ? clip.major_model_version : null)
        || 'chirp-hawk';

    return {
        mv,
        duration,
        descriptor: String(md.tags || '').trim(),
        // The PROMPT is the LYRICS (or the instrumental marker), and it
        // has to travel with the variant.
        //
        // MEASURED 2026-11-01: the clip the artist handed over carries
        // its whole lyric sheet in `metadata.prompt`, in Suno's own
        // bracketed form —
        //
        //   [Intro | 4/4 | instrumental, full band]
        //   [Verse | 4/4 | alto female, soft]
        //   I keep the window open
        //   ...
        //
        // A variant that carried only the TAGS would drop the lyrics
        // and become a different song with the same instrumentation.
        // For an instrumental there is no prompt to carry (Suno's own
        // marker), and the cover's own prompt is the right one.
        prompt: String(md.prompt || '').trim(),
        influence,
        isMaxMode: isMax,
        sourceDuration: Number(md.duration) || 0,
    };
}

// ---------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------

/**
 * "<song> - <mutation>" — the title a variant carries.
 *
 * The mutation name is what distinguishes one variant from another in
 * the studio's library, so it survives the trim even when the song name
 * does not.
 *
 * @param {string} songTitle
 * @param {string} mutationName
 * @returns {string}
 */
function variantTitle(songTitle, mutationName) {
    const song = String(songTitle || 'Untitled').trim() || 'Untitled';
    const mutation = String(mutationName || 'Variant').trim() || 'Variant';
    const full = `${song} - ${mutation}`;
    if (full.length <= LIMITS.title) return full;
    // Trim the SONG first — the mutation name is the distinguishing part.
    const room = LIMITS.title - mutation.length - 3;
    return `${song.slice(0, Math.max(1, room)).trim()} - ${mutation}`;
}

// ---------------------------------------------------------------------
// The composition rule
// ---------------------------------------------------------------------

/**
 * Compose one variant's tags.
 *
 *     tags = <the source's own descriptor> + <the mutation>
 *
 * The DESCRIPTOR is preserved: when the two together exceed the server's
 * 1000-character limit, the mutation gives way, not the descriptor. That
 * is the rule the user's own saved style batch already follows, and the
 * reason a variant stays a variant of the source song.
 *
 * @param {object} o
 * @param {string} o.descriptor the source clip's own style tags
 * @param {string} o.mutation  the mutation's style text
 * @param {number} [o.limit]
 * @returns {string}
 */
function composeTags({ descriptor, mutation, limit = LIMITS.tags }) {
    const d = String(descriptor || '').trim();
    const m = String(mutation || '').trim();
    if (!d) return m.slice(0, limit);
    if (!m) return d.slice(0, limit);
    if (d.length + 1 + m.length <= limit) return `${d}, ${m}`;

    // The descriptor wins. The mutation is cut back to fit — and a
    // mutation cut to nothing is reported by the caller as a real
    // failure rather than silently shipping the source unchanged.
    const room = limit - d.length - 2;   // ", " between them
    if (room <= 0) return d.slice(0, limit);
    return `${d}, ${m.slice(0, room).replace(/[\s,]+$/, '')}`;
}

// ---------------------------------------------------------------------
// The variants
// ---------------------------------------------------------------------

/**
 * Build the variant list.
 *
 * @param {object} o
 * @param {object} o.settings    from clipSettings()
 * @param {Array}  o.mutations   [{ slug, name, tags, influence }]
 * @param {string} o.songTitle
 * @returns {Array<object>}
 */
function buildVariants({ settings, mutations, songTitle } = {}) {
    const s = settings || {};
    const list = Array.isArray(mutations) ? mutations : [];
    return list.map((mut) => {
        const tags = composeTags({ descriptor: s.descriptor, mutation: mut.tags });
        const influence = Number.isFinite(Number(mut.influence))
            ? Math.max(0, Math.min(1, Number(mut.influence)))
            : (s.influence ?? 0.65);
        return {
            slug: mut.slug || mut.name || 'variant',
            name: mut.name || mut.slug || 'Variant',
            tags,
            tagsLength: tags.length,
            influence,
            title: variantTitle(songTitle, mut.name || mut.slug),
            sourceDescriptor: s.descriptor || '',
            mutationTags: mut.tags || '',
            // The lyrics travel with the variant.
            prompt: s.prompt || '',
            // A mutation that was cut away entirely is not a variant.
            truncated: !!(s.descriptor && mut.tags &&
                tags.length < (s.descriptor + ', ' + mut.tags).length),
        };
    });
}

// ---------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------

/**
 * The generation body for one variant — a cover of the source.
 *
 * @param {object} o
 * @param {object} o.variant
 * @param {string} o.sourceClipId
 * @param {number} [o.sourceDuration]
 * @returns {object}
 */
function buildCoverBody({ variant, sourceClipId, sourceDuration } = {}) {
    const v = variant || {};
    return {
        // The variant's own prompt — the source's lyrics, or the
        // instrumental marker when the source has none. Never a
        // hardcoded '[Instrumental]' for a song that has words.
        prompt: v.prompt || '[Instrumental]',
        task: 'cover',
        cover_clip_id: sourceClipId,
        cover_start_s: 0,
        cover_end_s: Number(sourceDuration) || 0,
        mv: v.mv || 'chirp-hawk',
        title: v.title,
        tags: v.tags,
        negative_tags: '',
        make_instrumental: true,
        duration: v.duration || 198,
        generation_type: 'TEXT',
        override_fields: ['prompt', 'tags'],
        project_id: 'default',
        transaction_uuid: crypto.randomUUID(),
        metadata: {
            web_client_pathname: '/create',
            create_surface: 'home',
            create_mode: 'custom',
            is_max_mode: v.isMaxMode !== false,
            control_sliders: {
                audio_weight: v.influence ?? 0.65,
                weirdness_constraint: 0,
                aug_creativity: 1,
            },
        },
    };
}

/**
 * The body for a SAVED custom style — the studio's own style picker.
 *
 * `id: null` creates; `id: <existing>` updates. That makes this
 * idempotent: re-running updates the same styles rather than piling up
 * duplicates.
 *
 * @param {object} o
 * @param {object} o.variant
 * @returns {{tags: string, id: null, title: string}}
 */
function buildStyleBody({ variant } = {}) {
    const v = variant || {};
    return {
        tags: String(v.tags || '').slice(0, LIMITS.tags),
        id: null,
        title: String(v.title || 'Variant').slice(0, LIMITS.title),
    };
}

// ---------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------

/**
 * The record of a run.
 *
 * @param {object} o
 * @returns {object}
 */
function buildManifest({ source, settings, variants, mutations } = {}) {
    return {
        schema: 'suno-mutator/v1',
        generatedAt: new Date().toISOString(),
        source: {
            // The clip to MUTATE — the source behind the link.
            clipId: source && source.sourceClipId,
            title: source && source.sourceTitle,
            // What the URL actually pointed at. A different clip when the
            // link was to a cover.
            linkClipId: source && source.clipId,
            linkTitle: source && source.clipTitle,
            coverClipId: (source && source.coverClipId) || null,
        },
        settings: settings || null,
        mutations: (mutations || []).map((m) => ({
            slug: m.slug, name: m.name, tags: m.tags, influence: m.influence,
        })),
        variants: (variants || []).map((v) => ({
            slug: v.slug,
            name: v.name,
            title: v.title,
            tags: v.tags,
            tagsLength: v.tagsLength,
            influence: v.influence,
            truncated: !!v.truncated,
            // The lyrics the variant carries. Recorded so a run is
            // auditable — a variant that dropped the words would not be
            // the song.
            prompt: v.prompt || '',
            styleId: null,
            clipId: null,
            ok: null,
        })),
    };
}

// ---------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------

// Is this failure the studio API's rate limit?
//
// MEASURED 2026-11-01: a live run hit
//   429 {"status_code": 429, "detail": "Too many requests.",
//        "error_type": "rate_limited", "retryable": true}
// on a plain clip read, and the whole run failed on it. The body says
// `retryable: true` — so retrying is not a guess, it is what the server
// asked for.
//
// The shape differs by where the error came from: `apiOk` throws with
// the status in the MESSAGE ("GET /api/... -> 429 {...}"), while a raw
// `api()` call returns the body. So both are checked.
function isRateLimited(err) {
    if (!err) return false;
    const status = Number(err.status);
    if (status === 429) return true;
    const text = `${err.message || ''} ${err.body || ''}`;
    if (!/429|too many requests|rate_limited/i.test(text)) return false;
    // A body that says `retryable: false` is asking for something else.
    if (/"?retryable"?\s*:\s*false/i.test(text)) return false;
    return true;
}

/**
 * Run an async operation, retrying the studio API's rate limit.
 *
 * @param {Function} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts] total attempts (default 4)
 * @param {number} [opts.delayMs] base backoff (default 4000)
 * @param {Function} [opts.log]
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
    const attempts = Math.max(1, Number(opts.attempts) || 4);
    const delayMs = Number(opts.delayMs) || 4000;
    const log = opts.log || (() => {});
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (i >= attempts || !isRateLimited(e)) throw e;
            const wait = delayMs * i;
            log(`rate limited (attempt ${i}/${attempts}) — retrying in ${Math.round(wait / 1000)}s`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw lastErr;
}

// ---------------------------------------------------------------------
// The mutations that ship with the tool
// ---------------------------------------------------------------------

/**
 * A small default library of mutations.
 *
 * Each one is a STYLE, not a new song — the source's descriptor rides
 * along underneath, so the result is still the source song in that style.
 */
const DEFAULT_MUTATIONS = [
    { slug: 'dub', name: 'Dub', tags: 'dub techno, tape delay, submerged basslines, cavernous reverb', influence: 0.75 },
    { slug: 'orchestral', name: 'Orchestral', tags: 'symphonic orchestra, cinematic strings, brass section, timpani', influence: 0.6 },
    { slug: 'lofi-tape', name: 'Lo-Fi Tape', tags: 'lo-fi hip hop, cassette saturation, vinyl crackle, dusty drums', influence: 0.8 },
    { slug: 'afro-house', name: 'Afro House', tags: 'afro house, log drum, shuffled percussion, warm sub bass', influence: 0.7 },
    { slug: 'ambient', name: 'Ambient', tags: 'ambient drone, long reverb tails, soft pads, no percussion', influence: 0.55 },
    { slug: 'breaks', name: 'Breaks', tags: 'broken beat, amen break, live drum breaks, vinyl swing', influence: 0.78 },
];

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

function parseMutations(spec) {
    // The grammar:
    //
    //   dub                              a built-in, by name
    //   orchestral:0.6:symphonic strings a name, an influence, a style
    //   orchestral:symphonic strings     a name and a style
    //
    // and several mutations separated by a SEMICOLON — not a comma,
    // because a comma is INSIDE a style text ("symphonic strings, brass")
    // and splitting on it broke a single mutation into two.
    //
    // MEASURED 2026-11-01: `--mutation "orchestral:0.6:symphonic strings,
    // brass"` used to produce two mutations, the second one named "brass".
    const out = [];
    for (const chunk of String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)) {
        const parts = chunk.split(':');
        const name = parts[0].trim();
        if (!name) continue;
        const known = DEFAULT_MUTATIONS.find(
            (m) => m.slug === name || m.name.toLowerCase() === name.toLowerCase());
        if (known && parts.length === 1) { out.push({ ...known }); continue; }
        // The influence is the second field ONLY when it is a number;
        // otherwise the rest is the style text.
        const maybeInfluence = Number(parts[1]);
        const hasInfluence = parts.length > 1 && Number.isFinite(maybeInfluence);
        const tags = (hasInfluence ? parts.slice(2) : parts.slice(1)).join(':').trim()
            || (known ? known.tags : name);
        out.push({
            slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            name: known ? known.name : name,
            tags,
            influence: hasInfluence ? maybeInfluence : (known ? known.influence : 0.7),
        });
    }
    return out;
}

const HELP = `Suno mutator — send a URL, get custom variants.

Usage:
  node lib/suno-mutator.js --url <suno url> [options]

Options:
  --url <url>          a song page, a share link, a workspace, or a clip id
  --mutation <spec>    comma-separated mutations. Each is "name" (from the
                       built-in library), "name:influence:tags", or
                       "name:tags". Repeatable.
  --no-follow          mutate the clip the link points at, instead of the
                       clip it was made from (the link's own lyrics and
                       tags, not the original's)
  --save-styles        save each variant as a custom style in the account
  --generate           generate a cover of the source for each variant
  --apply              do it (without it, this is a dry run)
  --out <path>         the manifest path (default data/suno/mutator.json)
  --port <n>           the CDP port (default 9455)
  --cookies <path>     the cookie jar (default ~/.suno-cookies.txt)
  --help               this text

The built-in mutations: ${DEFAULT_MUTATIONS.map((m) => m.slug).join(', ')}`;

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
    };
    const has = (name) => argv.includes(`--${name}`);
    if (has('help') || has('h')) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }

    const input = flag('url');
    if (!input) throw new Error('--url <suno url> is required');
    let parsed = parseSunoUrl(input);
    if (!parsed) {
        throw new Error(`not a Suno reference: ${input}\n` +
            'Expected https://suno.com/song/<id>, https://suno.com/s/<id>, '
            + 'https://suno.com/create?wid=<id>, or a bare clip id.');
    }

    // A SHORT share link carries no uuid — suno.com answers it with a
    // 307 to /song/<uuid>. MEASURED 2026-11-01. Resolve it here, before
    // anything else, so the rest of the run works with a clip id.
    if (parsed.kind === 'short') {
        const log0 = (m) => process.stdout.write(`[suno-mutator] ${m}\n`);
        log0(`short link ${parsed.slug} — resolving`);
        const clipId = await resolveShortLink(parsed.slug);
        if (!clipId) {
            throw new Error(`could not resolve the short link: ${input}\n` +
                'The song may be private or deleted. Open it in a browser and ' +
                'copy the full https://suno.com/song/<id> link.');
        }
        parsed = { kind: 'song', clipId };
        log0(`resolved -> ${clipId}`);
    }

    // The mutations.
    const specs = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--mutation' || !argv[i + 1]) continue;
        specs.push(argv[i + 1]);
    }
    const mutations = specs.length ? parseMutations(specs.join(',')) : DEFAULT_MUTATIONS;
    if (!mutations.length) throw new Error('no mutations to apply');

    const apply = has('apply');
    const saveStyles = has('save-styles');
    const generate = has('generate');
    const REPO = path.resolve(__dirname, '..');
    const outPath = path.resolve(REPO, flag('out', 'data/suno/mutator.json'));

    const log = (m) => process.stdout.write(`[suno-mutator] ${m}\n`);
    const warn = (m) => process.stderr.write(`[suno-mutator] ${m}\n`);

    log(`url:    ${input}`);
    log(`parsed: ${parsed.kind} ${parsed.clipId}`);
    log(`mutations: ${mutations.length} (${mutations.map((m) => m.slug).join(', ')})`);

    if (!apply) {
        log('dry run — nothing submitted (add --apply)');
        log('note: the source clip is read on a live run, so the exact');
        log('      tags and influence below are the plan, not the result.');
        return 2;
    }

    const { SunoClient } = require('./suno-web.js');
    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    try {
        // The studio API rate-limits, and it says so in the body
        // (`retryable: true`). MEASURED 2026-11-01 — a plain clip read
        // came back 429 and failed the whole run.
        const getClip = (id) => withRetry(() => client.getClip(id), {
            attempts: 4,
            delayMs: 4000,
            log: (m) => log(m),
        });

        const clip = await getClip(parsed.clipId);
        if (!clip) throw new Error(`clip not found: ${parsed.clipId}`);
        const source = await resolveClipId(clip, { getClip, follow: !has('no-follow') });
        log(`clip:   "${source.clipTitle}" (${source.clipId})`);
        log(`source: "${source.sourceTitle}" (${source.sourceClipId})`);

        const sourceClip = await getClip(source.sourceClipId);
        if (!sourceClip) throw new Error(`source clip not found: ${source.sourceClipId}`);
        const settings = clipSettings(sourceClip);
        // The SOURCE's duration is what a cover spans.
        settings.sourceDuration = Number((sourceClip.metadata || {}).duration) || settings.sourceDuration;

        log(`descriptor: ${settings.descriptor.length} chars`);
        log(`model ${settings.mv} · ${settings.duration}s · influence ${settings.influence}`);

        const songTitle = String(source.clipTitle || source.sourceTitle || 'Untitled')
            .split(/\s[_|]\s/)[0].trim();
        const variants = buildVariants({ settings, mutations, songTitle });
        const manifest = buildManifest({ source, settings, variants, mutations });

        // The existing styles, so a re-run UPDATES rather than duplicates.
        const existing = saveStyles
            ? await withRetry(() => client.listStyles(), { attempts: 4, delayMs: 4000, log: (m) => log(m) })
            : [];
        const byTitle = new Map(existing.map((s) => [String(s.title || ''), s]));

        for (const v of variants) {
            const entry = manifest.variants.find((x) => x.slug === v.slug);
            const prior = byTitle.get(v.title);

            if (saveStyles) {
                const body = buildStyleBody({ variant: v });
                try {
                    const r = await withRetry(
                        () => client.createStyle({ title: body.title, tags: body.tags }),
                        { attempts: 4, delayMs: 4000, log: (m) => log(m) });
                    entry.styleId = (r && (r.id || r.prompt_id)) || prior?.id || null;
                    entry.ok = true;
                    log(`style ${prior ? 'updated' : 'saved'}: ${v.title}`);
                } catch (e) {
                    entry.ok = false;
                    entry.error = e.message;
                    warn(`style FAILED ${v.title}: ${e.message}`);
                }
            }

            if (!generate) continue;

            const body = buildCoverBody({
                variant: { ...v, mv: settings.mv, duration: settings.duration, isMaxMode: settings.isMaxMode },
                sourceClipId: source.sourceClipId,
                sourceDuration: settings.sourceDuration,
            });
            // The captcha is per-request.
            try {
                const check = await client.captchaCheck();
                if (check.required) {
                    body.token = await client.captchaToken();
                    body.token_provider = check.captcha_version;
                }
                const r = await withRetry(
                    () => client.api('/api/generate/v2-web/', { method: 'POST', body }),
                    { attempts: 4, delayMs: 4000, log: (m) => log(m) });
                if (r.status < 200 || r.status >= 300) {
                    throw new Error(`${r.status} ${String(r.body).slice(0, 200)}`);
                }
                entry.clipId = (r.json && r.json.clips && r.json.clips[0] && r.json.clips[0].id) || null;
                entry.generationId = (r.json && r.json.id) || null;
                log(`cover ${v.title} -> ${entry.clipId || '(no id)'}`);
            } catch (e) {
                entry.error = entry.error || e.message;
                warn(`cover FAILED ${v.title}: ${e.message}`);
            }
        }

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`manifest -> ${path.relative(REPO, outPath)}`);
        return 0;
    } finally {
        await client.close();
    }
}

module.exports = {
    LIMITS,
    DEFAULT_MUTATIONS,
    UA,
    parseSunoUrl,
    resolveShortLink,
    resolveClipId,
    clipSettings,
    composeTags,
    variantTitle,
    buildVariants,
    buildCoverBody,
    buildStyleBody,
    buildManifest,
    parseMutations,
    isRateLimited,
    withRetry,
};

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        process.stderr.write(`[suno-mutator] fatal: ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    });
}
