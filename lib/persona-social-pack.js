// lib/persona-social-pack.js — personas → hashtags + platform copy.
//
// Port of https://github.com/kajica2/Persona-hashtags to the twin's
// conventions: no build step, no dependencies, plain DOM on the page and
// a CommonJS module in Node.
//
// The Gemini call happens IN THE BROWSER. The user pastes an API key, it
// lives in sessionStorage for the lifetime of the tab, and the request
// goes straight to generativelanguage.googleapis.com. The key is never
// written to the repo, never to localStorage, and never echoed back in
// an error message — only a redacted preview is ever shown.
//
// API:
//   buildPrompt(url)           the base prompt (personas + 3 tiers + youtube + 4 socials)
//   buildFallbackPrompt(url)   upstream's "find a better URL, then analyse it"
//   parsePersonas(text)        strip fences → JSON.parse → must be an array
//   normalizePersona(raw)      '#'-prefix, dedupe, tier caps, coerce missing fields
//   buildPlatformContent(p,o)  assemble youtube + the four social captions
//   toIgPostMd(p)              ig-poster-compatible POST.md
//   toYoutubeMetadata(p)       { title, description, tags[], tagsCsv }
//   generatePack(url, o)       the Gemini call; o = {apiKey, baseUrl, model, fetch}
//
// Two-phase generation is preserved from upstream: the base prompt runs
// first, and only if it comes back empty does the fallback prompt run
// (search for a better URL, then analyse that).
//
// A NOTE ON THE SHARED RULES. The tag/tier/POST.md rules below are
// duplicated in lib/social-shared.js, which the social worker
// (lib/social-engine.js) uses. The two copies are byte-for-byte
// equivalent today, and the unit suite PROVES it — it runs both
// implementations over the same fixtures and fails if they ever
// diverge. That is deliberate: this module stays standalone (no
// cross-module require, so it can be dropped into the browser and into
// Node without a bundler), while the duplication is kept honest by a
// test instead of left to rot silently. When the two sides are next
// edited together, the fix is to make one of them require the other —
// not to leave two conventions to drift apart.

'use strict';

(function () {

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const TIMEOUT_MS = 120000;

// The tier sizes the prompt asks for. The caps are hard limits on what
// we keep; the minimums are what we WARN about. A short tier is never
// padded — a short tier is a short tier, and the warning says so.
const TIER_ORDER = ['primarySet', 'secondarySet', 'nicheSet'];
const TIER_CAPS = { primarySet: 7, secondarySet: 10, nicheSet: 15 };
const TIER_MINIMUMS = { primarySet: 5, secondarySet: 7, nicheSet: 10 };

// The four platforms the pack carries copy for.
const PLATFORMS = ['instagram', 'tiktok', 'twitter', 'facebook'];

// lib/ig-poster.js extracts hashtags with /#[a-zA-Z0-9_]+/g, so a tag
// that carries anything else is truncated on the way to the caption.
// Tags are normalised to that alphabet here so the file on disk and the
// caption that gets posted are the same string.
const TAG_ALPHABET = /[^A-Za-z0-9_]/g;

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

/**
 * The base prompt: find the personas on the page, give each one three
 * hashtag tiers, YouTube metadata and four social posts.
 */
function buildPrompt(url) {
    return `
  Analyze the content of the webpage at this URL: ${url}

  Your task is to identify all distinct creative persona templates or content style descriptions on that page.
  For EACH persona you identify, you must generate three distinct sets of hashtags, YouTube metadata, and four social posts.

  The hashtag sets should be structured as follows:
  1.  **Primary Set**: 5-7 popular, broad hashtags for maximum reach.
  2.  **Secondary Set**: 7-10 medium-sized, more specific hashtags to target relevant communities.
  3.  **Niche Set**: 10-15 highly specialized, long-tail hashtags to attract a dedicated, niche audience.

  Each hashtag must start with a '#'.

  For each persona, also write:
  - **YouTube metadata**: a "title" (a searchable video title), a "description" (two or three sentences about the persona and what the video shows), and "tags" (an array of keyword tags, each starting with a '#').
  - **Social posts**: one caption per platform — "instagram", "tiktok", "twitter" and "facebook". Write each caption in that persona's own voice. Do NOT append a hashtag list to a caption; the hashtags are delivered in the three sets above.

  Your entire response MUST be a single, valid JSON array. Do not include any text, markdown formatting, or explanations before or after the JSON block.
  The JSON structure must be an array of objects, where each object represents a persona and has the following keys:
  - "personaName": A short, descriptive name for the persona.
  - "description": A brief, one-sentence summary of the persona.
  - "primarySet": An array of strings, where each string is a hashtag.
  - "secondarySet": An array of strings.
  - "nicheSet": An array of strings.
  - "youtube": An object with "title" (string), "description" (string) and "tags" (an array of strings).
  - "social": An object with "instagram", "tiktok", "twitter" and "facebook", each an object with a "caption" (string).

  Example of a single object in the array:
  {
    "personaName": "The Minimalist Home Decorator",
    "description": "Focuses on clean lines, neutral palettes, and decluttered living spaces.",
    "primarySet": ["#homedecor", "#minimalism", "#interiordesign", "#decor", "#home"],
    "secondarySet": ["#minimalisthome", "#scandidecor", "#neutraldecor", "#simpleliving", "#modernhome", "#interiorstyling"],
    "nicheSet": ["#japandi", "#minimaldecor", "#whiteinteriors", "#declutteryourlife", "#hyggehome", "#organicmodern", "#slowliving", "#neutralaesthetic"],
    "youtube": {
      "title": "5 Minutes of Japandi Calm — a decluttered room",
      "description": "A slow pass through a neutral living room, one surface at a time.",
      "tags": ["#homedecor", "#minimalism", "#japandi"]
    },
    "social": {
      "instagram": "One surface. One decision. Less, but better.",
      "tiktok": "POV: you cleared one shelf and the whole room changed.",
      "twitter": "A quiet room is a loud idea.",
      "facebook": "I spent the weekend removing things and the room finally breathes."
    }
  }

  If you cannot access the URL or find any personas, return an empty array [].
`;
}

/**
 * The fallback prompt: the base prompt found nothing, so search for a
 * better URL and analyse that instead. The JSON contract is repeated
 * because this is a second, independent request.
 */
function buildFallbackPrompt(originalUrl) {
    return `
  The previous attempt to find creative personas at the URL "${originalUrl}" failed because it returned no results.

  Your new task is a two-step process:
  1. First, perform a Google search to find a *better, more relevant URL* that is explicitly about creative personas, content creator archetypes, or brand personalities. The new URL should be closely related to the topic of the original URL if possible.
  2. Once you find a suitable new URL, immediately analyze its content and generate the hashtag sets, the YouTube metadata and the four social posts for all personas you find there.

  The hashtag sets are structured as follows:
  1.  **Primary Set**: 5-7 popular, broad hashtags for maximum reach.
  2.  **Secondary Set**: 7-10 medium-sized, more specific hashtags to target relevant communities.
  3.  **Niche Set**: 10-15 highly specialized, long-tail hashtags to attract a dedicated, niche audience.

  Each hashtag must start with a '#'.

  Your entire response MUST be a single, valid JSON array based on the content of the NEW URL you found. Do not mention the fallback process or the new URL in your final output. Just provide the JSON. The JSON structure must be an array of objects, where each object represents a persona and has the following keys:
  - "personaName": A short, descriptive name for the persona.
  - "description": A brief, one-sentence summary of the persona.
  - "primarySet": An array of strings, where each string is a hashtag.
  - "secondarySet": An array of strings.
  - "nicheSet": An array of strings.
  - "youtube": An object with "title" (string), "description" (string) and "tags" (an array of strings).
  - "social": An object with "instagram", "tiktok", "twitter" and "facebook", each an object with a "caption" (string).

  If you still cannot find any personas after searching, return an empty array [].
`;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** Remove a ```json fence around the payload, if there is one. */
function stripFences(text) {
    return String(text)
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
}

/**
 * Pull the first balanced [...] block out of a response that has prose
 * around it. String-aware, so a ']' inside a caption does not end the
 * array early.
 */
function extractJsonArray(text) {
    const start = text.indexOf('[');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

function tryParseJson(source) {
    try {
        return { ok: true, value: JSON.parse(source) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

/**
 * The model's answer → an array of personas. A non-array is an error,
 * never a silent empty result: an empty result means "the fallback
 * should run", and that decision must not be made by a misparse.
 */
function parsePersonas(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw fail('EMPTY_RESPONSE', 'Gemini returned an empty response.');
    }
    const cleaned = stripFences(text);

    let parsed = tryParseJson(cleaned);
    if (!parsed.ok) {
        const block = extractJsonArray(cleaned);
        if (block) parsed = tryParseJson(block);
    }
    if (!parsed.ok) {
        throw fail('INVALID_JSON',
            'Could not parse the Gemini response as JSON: ' + parsed.error.message);
    }
    if (!Array.isArray(parsed.value)) {
        throw fail('NOT_AN_ARRAY',
            'The Gemini response was valid JSON but not an array of personas.');
    }
    return parsed.value;
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

function asText(value) {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
}

/**
 * One tag → one canonical tag: '#' in front, letters/digits/underscore
 * only, no spaces. Returns '' when there is nothing usable left.
 */
function normalizeTag(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    // A hashtag is one word. "Minimalist Home Decor" is not a tag, and
    // its first word is the only honest reading of it.
    let tag = String(value).trim().split(/\s+/)[0];
    if (!tag) return '';
    tag = tag.replace(/^#+/, '');
    tag = tag.replace(TAG_ALPHABET, '');
    if (!tag) return '';
    return '#' + tag;
}

/** A list of tags: canonicalised, de-duplicated, order preserved. */
function normalizeTagList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const tag = normalizeTag(raw);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/**
 * One tier: canonicalised, de-duplicated, capped at the declared
 * maximum. A tier shorter than its minimum is reported as a warning —
 * never padded, because padding invents reach the model did not promise.
 */
function normalizeTier(list, name, warnings) {
    const tags = normalizeTagList(list);
    const capped = tags.slice(0, TIER_CAPS[name]);
    if (capped.length < TIER_MINIMUMS[name]) {
        warnings.push(
            name + ' has ' + capped.length + ' tag(s); the target is ' +
            TIER_MINIMUMS[name] + '-' + TIER_CAPS[name] + '.'
        );
    }
    if (tags.length > capped.length) {
        warnings.push(
            name + ' had ' + tags.length + ' tags; the ' + TIER_CAPS[name] +
            ' that fit the cap were kept.'
        );
    }
    return capped;
}

/** A social caption: the model may give {caption} or a bare string. */
function normalizeCaption(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof value.caption === 'string') {
        return value.caption.trim();
    }
    return '';
}

/**
 * A raw model object → the persona the rest of the twin works with.
 * Missing pieces are coerced, never thrown on: a persona without a
 * YouTube block is still a persona.
 */
function normalizePersona(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const warnings = [];

    const youtube = source.youtube && typeof source.youtube === 'object' ? source.youtube : {};
    const socialSource = source.social && typeof source.social === 'object' ? source.social : {};

    const social = {};
    for (const platform of PLATFORMS) {
        social[platform] = { caption: normalizeCaption(socialSource[platform]) };
    }

    return {
        personaName: asText(source.personaName) || 'Untitled persona',
        description: asText(source.description),
        primarySet: normalizeTier(source.primarySet, 'primarySet', warnings),
        secondarySet: normalizeTier(source.secondarySet, 'secondarySet', warnings),
        nicheSet: normalizeTier(source.nicheSet, 'nicheSet', warnings),
        youtube: {
            title: asText(youtube.title),
            description: asText(youtube.description),
            tags: normalizeTagList(youtube.tags),
        },
        social,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// platform content
// ---------------------------------------------------------------------------

// The token shape lib/ig-poster.js matches over a whole POST.md.
const HASHTAG_TOKEN = /#[A-Za-z0-9_]+/g;

/** Every '#tag' token in a caption, canonicalised. */
function inlineTags(text) {
    if (typeof text !== 'string') return [];
    const found = text.match(HASHTAG_TOKEN) || [];
    return normalizeTagList(found);
}

/**
 * The persona's hashtag union: the three tiers in tier order, plus any
 * tag the captions already carry, de-duplicated. The tier caps (7/10/15)
 * are the contract, so nothing here is truncated behind the user's back.
 */
function personaHashtags(persona, options) {
    const opts = options || {};
    const p = persona && typeof persona === 'object' ? persona : {};
    const out = [];
    const seen = new Set();
    const push = (tag) => {
        if (!tag) return;
        const key = tag.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(tag);
    };
    for (const tier of TIER_ORDER) {
        for (const tag of p[tier] || []) push(normalizeTag(tag));
    }
    if (opts.includeInline !== false) {
        for (const platform of PLATFORMS) {
            const block = p.social && p.social[platform];
            const caption = block && typeof block === 'object' ? block.caption : '';
            for (const tag of inlineTags(caption)) push(tag);
        }
    }
    return out;
}

/**
 * Strip every hashtag token out of a caption body.
 *
 * This is not a style choice: ig-poster matches /#[a-zA-Z0-9_]+/ over
 * the WHOLE file, so a tag left in the body would be counted twice —
 * once in the body, once in the trailing tag section. The body keeps
 * the prose; the tags live in one place.
 */
function stripTags(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(HASHTAG_TOKEN, '')
        .split('\n')
        .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
        .join('\n')
        .trim();
}

/**
 * The caption, then the hashtag line. An empty caption stays empty: a
 * persona the model gave no caption for must not come back wearing a
 * stranger's hashtag line.
 */
function appendHashtags(caption, tags) {
    if (!caption) return caption || '';
    if (!tags || !tags.length) return caption;
    return caption + '\n\n' + tags.join(' ');
}

/**
 * The platform content for one persona: the YouTube block and the four
 * social captions, with the hashtags carried on their own line so no
 * caption ever repeats a tag.
 *
 * o.includeHashtags (default true) — put the hashtag line on the captions.
 * o.includeInlineTags (default true) — count a caption's own tags in the union.
 */
function buildPlatformContent(persona, o) {
    const opts = o || {};
    const includeHashtags = opts.includeHashtags !== false;
    const p = persona && typeof persona === 'object' ? persona : {};

    const hashtags = personaHashtags(p, { includeInline: opts.includeInlineTags !== false });
    const social = {};
    for (const platform of PLATFORMS) {
        const block = p.social && p.social[platform];
        const caption = block && typeof block === 'object'
            ? (typeof block.caption === 'string' ? block.caption : '')
            : '';
        const body = stripTags(caption);
        social[platform] = {
            caption: includeHashtags ? appendHashtags(body, hashtags) : body,
        };
    }

    const youtube = p.youtube && typeof p.youtube === 'object' ? p.youtube : {};
    const title = asText(youtube.title) || asText(p.personaName);
    const description = asText(youtube.description) || asText(p.description);
    const tags = youtube.tags && youtube.tags.length
        ? normalizeTagList(youtube.tags)
        : personaHashtags(p, { includeInline: false });

    return {
        youtube: { title, description, tags },
        social,
        hashtags,
    };
}

/**
 * The YouTube metadata, in the shape lib/youtube-poster.js wants:
 * { title, description, tags[], tagsCsv }. The tags keep their '#'; the
 * CSV drops it, because that is what YouTube's own tag field takes.
 */
function toYoutubeMetadata(persona) {
    const content = buildPlatformContent(persona, { includeHashtags: false });
    const tags = content.youtube.tags;
    return {
        title: content.youtube.title,
        description: content.youtube.description,
        tags: tags.slice(),
        tagsCsv: tags.map((tag) => tag.replace(/^#/, '')).join(','),
    };
}

/**
 * The POST.md that lib/ig-poster.js reads.
 *
 * ig-poster's readCaption() walks the file: the first '# ' heading is
 * the title, a '## ' heading switches "inNext" on when the heading says
 * Next, the first non-empty line after that BREAKS the loop, and the
 * hashtags are matched over the whole file. So the caption body carries
 * no tags at all, and the tag list lives in a trailing section — which
 * sits after the break, and is therefore not part of the body.
 *
 * The body is also stripped of leading '#' markers: a '## ' line inside
 * the caption would otherwise be read as a section heading, and the
 * first '## Next' in the file ends the body early.
 */
function toIgPostMd(persona) {
    const p = persona && typeof persona === 'object' ? persona : {};
    const content = buildPlatformContent(p, { includeHashtags: false });
    const caption = content.social.instagram.caption
        .split('\n')
        .map((line) => line.replace(/^#{1,6}\s*/, ''))
        .join('\n')
        .trim();
    const tags = content.hashtags;
    // A '#' inside the title would be read back as a hashtag.
    const title = (asText(p.personaName).replace(HASHTAG_TOKEN, '').replace(/\s{2,}/g, ' ').trim())
        || 'Untitled persona';

    return [
        '# ' + title,
        '',
        '## Caption',
        '',
        caption,
        '',
        '## Next',
        '',
        '1. Open the Instagram app → Reel → Upload.',
        '2. Paste the caption above, then the hashtag line.',
        '',
        '## Hashtags',
        '',
        tags.join(' '),
        ''
    ].join('\n');
}

// ---------------------------------------------------------------------------
// the Gemini call
// ---------------------------------------------------------------------------

function envValue(name) {
    if (typeof process === 'undefined' || !process.env) return '';
    return process.env[name] || '';
}

/** A preview of the key that cannot be pasted back into the API. */
function redactedKey(key) {
    if (!key) return '(none)';
    if (key.length <= 8) return '***';
    return key.slice(0, 4) + '…' + key.slice(-4);
}

/**
 * One generateContent request. The tool keys are snake_case in the
 * v1beta REST body; camelCase is SDK-only. url_context reads the page at
 * the URL, google_search backs the fallback prompt's "find a better URL".
 */
async function callGemini(prompt, opts) {
    const apiKey = opts.apiKey;
    const model = opts.model;
    const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) {
        throw fail('NO_FETCH', 'No fetch implementation is available.');
    }

    const url = baseUrl + '/' + API_VERSION + '/models/' + encodeURIComponent(model) + ':generateContent';
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ url_context: {} }, { google_search: {} }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
    let res;
    try {
        res = await doFetch(url, {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw fail('TIMEOUT', 'The Gemini request timed out after ' + (opts.timeoutMs || TIMEOUT_MS) + 'ms.');
        }
        throw fail('NETWORK', 'Could not reach Gemini: ' + (err && err.message ? err.message : String(err)));
    } finally {
        clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }

    if (!res.ok) {
        const apiError = json && json.error ? json.error : {};
        const err = fail(apiError.code || ('http_' + res.status),
            'Gemini returned HTTP ' + res.status + ': ' +
            (apiError.message || text || 'no message'));
        err.status = res.status;
        throw err;
    }

    if (!json || !Array.isArray(json.candidates)) {
        // A 200 with no candidates array at all is a broken contract, not
        // an empty answer. A candidate with no text IS an empty answer.
        throw fail('NO_CANDIDATES', 'Gemini returned no candidates for this prompt.');
    }
    const candidates = json.candidates;
    const parts = candidates[0] && candidates[0].content && candidates[0].content.parts
        ? candidates[0].content.parts
        : [];
    const out = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
    // A blank answer is "no personas found", NOT an error — upstream says
    // the same, and the reason matters: it is what lets the second phase
    // (search for a better URL) run at all.
    return out;
}

/**
 * One phase of the two-phase run: prompt → personas.
 *
 * A blank answer is an empty result, not a throw, so the fallback phase
 * gets its turn. A malformed answer (not JSON, or JSON that is not an
 * array) is still a clear error — a misparse must never be mistaken for
 * "nothing found", because that decision drives the fallback.
 */
async function runPhase(prompt, callOpts) {
    const text = await callGemini(prompt, callOpts);
    if (!text || !text.trim()) return [];
    return parsePersonas(text);
}

/**
 * The whole run: base prompt, and — only if it found nothing — the
 * fallback prompt. Returns the normalised personas.
 *
 * o = { apiKey, baseUrl, model, fetch, timeoutMs }
 */
async function generatePack(url, o) {
    const opts = o || {};
    const target = asText(url);
    if (!target) {
        throw fail('NO_URL', 'A URL is required.');
    }
    const apiKey = opts.apiKey || envValue('PERSONA_PACK_API_KEY');
    if (!apiKey) {
        throw fail('NO_KEY',
            'persona-social-pack: no Gemini API key. Paste one into the page, or export ' +
            'PERSONA_PACK_API_KEY in your shell. Get a key at https://aistudio.google.com/apikey');
    }
    const model = opts.model || envValue('PERSONA_PACK_MODEL') || DEFAULT_MODEL;
    const baseUrl = opts.baseUrl || envValue('PERSONA_PACK_BASE_URL') || DEFAULT_BASE_URL;

    const callOpts = {
        apiKey,
        model,
        baseUrl,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
    };

    const first = await runPhase(buildPrompt(target), callOpts);
    if (first.length) return first.map(normalizePersona);

    const second = await runPhase(buildFallbackPrompt(target), callOpts);
    return second.map(normalizePersona);
}

const api = {
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    API_VERSION,
    TIER_CAPS,
    TIER_MINIMUMS,
    PLATFORMS,
    buildPrompt,
    buildFallbackPrompt,
    parsePersonas,
    normalizePersona,
    normalizeTag,
    normalizeTagList,
    personaHashtags,
    buildPlatformContent,
    toIgPostMd,
    toYoutubeMetadata,
    redactedKey,
    generatePack,
};

// Node export for the unit suite; the browser gets the global.
if (typeof module === 'object' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.PersonaSocialPack = api;
}

}());
