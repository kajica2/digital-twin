#!/usr/bin/env node
'use strict';
// lib/mj-feed.js
//
// Midjourney **feed API** — the ground truth for "which job did my prompt
// actually become?".
//
// WHY THIS EXISTS
//
// The web backend used to accept a submission by finding a DOM card whose
// text contained the prompt's excerpt. That matcher is unsound: the
// imagine feed is a shared timeline, and the account owner can be running
// their own Midjourney jobs at the same time as the automation. Their
// cards sit in the same feed, carry their own text, and the "walk up to
// the nearest text-bearing ancestor" heuristic eventually lands on one of
// theirs.
//
// Measured 2026-10-21 on a 12-prompt pack: 6 of 12 accepted task ids were
// wrong. Every prompt HAD been submitted correctly (verified against the
// feed API below) — the ids were simply attributed to the wrong cards.
//
// WHAT THE FEED API GIVES
//
//   GET https://www.midjourney.com/api/imagine
//       ?user_id=<uuid>&page_size=<n>
//   Header: X-CSRF-Protection: 1
//   Credentials: include (the session cookies)
//
// Without the `X-CSRF-Protection` header the endpoint answers 401
// {"error":"Unauthorized"}. With it, it returns the job list, newest
// first, each item carrying:
//
//   id, enqueue_time, job_type, full_command, batch_size, width, height,
//   personalization_codes, ...
//
// `full_command` is the string the job actually ran with — flags included.
// That makes it the only trustworthy answer to "did my prompt land, and
// did it land as I wrote it?".
//
// There is NO per-job route (`/api/jobs/<id>` and friends all 404), so
// the feed is the only place the truth lives.
//
// THE FOUR FAILURE MODES THIS MODULE EXISTS TO CATCH
//
// 1. WRONG CARD. The DOM matcher picked a card belonging to a
//    concurrently-running personal job. Fixed by matching on
//    `full_command` instead of card text.
//
// 2. `--edit` LEAKAGE. The composer still carries the account owner's
//    uploaded image, so the submission became an edit job
//    (`v8-2_edit_diffusion`, `full_command` contains `--edit <url>`)
//    instead of a plain generation. An edit job renders the OWNER's image,
//    not our prompt — a completely different picture.
//
// 3. FLAG FIDELITY. Midjourney's web UI silently overrides the typed
//    flags with its own UI state: the aspect-ratio button and the stylize
//    slider. A prompt typed with `--ar 16:9 --s 100` was enqueued as
//    `--ar 4:3 --stylize 0` — the UI's values, not ours. The image is
//    then the wrong shape AND the wrong stylization. Only `full_command`
//    reveals this; the composer looked correct.
//
// 4. VIDEO JOBS. `job_type` `vid_1.1_i2v_start_end_b_video` is the
//    owner's animation of our result, not a generation. Same prompt text,
//    unusable as a still.
//
// So a job is accepted only when ALL of the following hold:
//
//   a. `full_command` carries our prompt's prose (identity).
//   b. `job_type` is a plain diffusion job (no edit, no inpaint, no video).
//   c. The flags the caller asked for survived into `full_command`
//      (fidelity), and no reference flag appeared uninvited.
//
// (c) is what turns "the prompt landed" into "the prompt landed as
// written".
//
// The `user_id` is discovered in-page: the imagine page itself calls
// `/api/imagine?user_id=…`, so `performance.getEntriesByType('resource')`
// exposes it. A localStorage key carries it as a fallback.
//
// This module is deliberately split into a PURE half (parsers, matchers —
// unit-testable without a browser) and a thin BROWSER half (the two
// in-page expressions).

// ---------- pure half ----------

// Normalise a command string for comparison: collapse whitespace, turn
// em/en dashes into spaces (Midjourney's own renderer drops them, so a
// prompt containing " — " never matched its own card until this was
// stripped — 2026-09-29).
function normText(s) {
    return (s || '')
        .replace(/[\u2014\u2013]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// A parameter token is a `--word`. Midjourney's parameters always come
// AFTER the prompt prose, and it re-orders them when it re-serialises
// (`--no text, watermark, logo` moves ahead of `--ar 16:9`, and
// `--profile … --stylize 0` of its own is appended).
const PARAM_TOKEN = /^--[a-z]/i;

// The PROSE of a command — the prompt text with every parameter removed.
//
// Cutting at the first parameter token is exact for both sides of the
// comparison: our composed prompt is "<prose> <params>", and Midjourney's
// re-serialised command is "<prose> <params, reordered>". The prose
// itself is never rewritten by Midjourney.
//
// This is deliberately NOT a "remove every --flag and its values" scan:
// `--no text, watermark, logo` is three whitespace-separated tokens with
// the commas attached, and a greedy scan leaves "watermark, logo" behind
// as prose. Cutting at the first parameter token avoids that class of
// bug entirely.
function proseOf(cmd) {
    const tokens = (cmd || '').split(/\s+/);
    const out = [];
    for (const t of tokens) {
        if (PARAM_TOKEN.test(t)) break;
        out.push(t);
    }
    return normText(out.join(' '));
}

// Parse a command's parameters into a map.
//
// Later duplicates win — that is how Midjourney itself resolves a
// doubled flag (the last one counts).
//
// Flag aliases are folded so `--s` and `--stylize` are the same flag:
// Midjourney echoes back whichever spelling it prefers.
const FLAG_ALIASES = { s: 'stylize', v: 'version', tile: 'tile', no: 'no' };

function parseFlags(cmd) {
    const flags = {};
    const tokens = (cmd || '').split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!PARAM_TOKEN.test(t)) continue;
        const raw = t.slice(2).toLowerCase();
        const name = FLAG_ALIASES[raw] || raw;
        const values = [];
        while (i + 1 < tokens.length && !PARAM_TOKEN.test(tokens[i + 1])) {
            values.push(tokens[i + 1]);
            i++;
            if (values.length >= 8) break;
        }
        flags[name] = values.length ? values.join(' ') : true;
    }
    return flags;
}

// The aspect ratio a command was enqueued with, normalised ("16:9",
// "4:3", "1:1"). Null when the command carries none.
function commandAspect(cmd) {
    const f = parseFlags(cmd);
    const ar = f['ar'];
    if (!ar || ar === true) return null;
    return String(ar).trim().toLowerCase();
}

// True when the command edits or references someone else's image rather
// than generating from the prompt text alone.
function commandIsEdit(cmd) {
    const f = parseFlags(cmd);
    return !!(f['edit'] || f['cref'] || f['oref']);
}

// Plain generation jobs only. These are the ones whose output is the
// prompt rendered from scratch.
//
// This used to be a hardcoded whitelist of job_type strings. A whitelist
// of third-party vocabulary always lags: `v6-1_raw_diffusion` and
// `v6_raw_diffusion_anime` were missing, so every v6.1 and every Niji job
// was rejected as "not a plain generation". The matcher then reported
// "no matching job in the feed" for a job that had in fact been accepted,
// and the caller re-submitted — MEASURED 2026-10-25: a 10-prompt v6.1 /
// Niji batch submitted every prompt twice and wrote no metadata at all,
// because the acceptance gate could not recognise the job its own
// submission had just created.
//
// The rule is structural instead: a plain generation is a `…diffusion`
// job with none of the MODIFIER kinds in its name. New versions and new
// engines (h, 8.3, niji, an anime model) satisfy it without an edit here;
// an edit / inpaint / variation / video job never does.
// `draft` and `video` are modifiers the old whitelist rejected by
// omission. Under a structural rule they have to be named, or a draft
// (`v8-2_draft_bs24_diffusion`) would be accepted as a full still.
const NOT_PLAIN_MODIFIERS = [
    'vid_', 'video', 'edit', 'inpaint', 'variation', 'upsample', 'blend', 'remix', 'draft',
];

// True when the job is a plain text-to-image generation.
function isPlainJob(job) {
    if (!job || typeof job !== 'object') return false;
    const t = String(job.job_type || '').toLowerCase();
    if (!t) return false;
    if (!t.includes('diffusion')) return false;
    for (const mod of NOT_PLAIN_MODIFIERS) {
        if (t.startsWith(mod) || t.includes(mod)) return false;
    }
    return true;
}

// The distinctive text that identifies a prompt inside a command.
//
// A short distinctive window is used rather than the whole prose because
// Midjourney rewrites the command (parameter reordering, `--profile`
// injection) but never rewrites the prose itself. Requiring the FULL
// prose would be stricter and still correct — but a caller may pass a
// prompt whose prose legitimately differs in whitespace, so a normalised
// comparison is the robust form.
//
// A command may carry an extra leading image URL (the owner pasted an
// image alongside the prompt), so a suffix match is allowed. A prompt
// that merely CONTAINS another prompt's prose is NOT a match — that is
// the direction that causes misattribution.
function commandMatchesPrompt(cmd, promptText) {
    const want = proseOf(promptText);
    if (!want) return false;
    const have = proseOf(cmd);
    if (!have) return false;
    if (have === want) return true;
    return have.endsWith(want);
}

// The flag fidelity check.
//
// `expect` maps a flag name to the value it must carry. A flag that is
// ABSENT satisfies the expectation only when its name is not listed in
// `expectStrict`.
//
// The absent case matters: Midjourney omits `--stylize` entirely when
// the value equals its default (a `--s 100` request came back with no
// `--stylize` at all), so "the flag is missing" is NOT evidence of a
// wrong value for stylize — but it IS evidence of a wrong value for
// `--ar`, which Midjourney always echoes when it is not 1:1.
//
// `forbid` lists flags that must NOT be present. `edit` is the one that
// matters: its presence means the owner's image was sent instead of our
// prompt.
//
// Aspect-ratio aliases.
//
// Midjourney names some ratios differently from the way people ask for
// them: a request for `--ar 21:9` comes back recorded as `--ar 7:3`
// (2.333:1 either way). Verified 2026-10-22: the job was created at
// 3376x1440 and 1680x720 — exactly the requested ratio — but the flag
// read "7:3", and a strict string comparison called it a mismatch.
//
// The alias list keeps the comparison honest: same picture, different
// spelling.
const AR_ALIASES = {
    '7:3': ['7:3', '21:9'],
    '21:9': ['7:3', '21:9'],
    '2:1': ['2:1'],
    '1:1': ['1:1'],
    '3:2': ['3:2'],
    '2:3': ['2:3'],
    '4:3': ['4:3'],
    '3:4': ['3:4'],
    '9:16': ['9:16', '2:3'],
    '16:9': ['16:9', '3:2'],
    '5:4': ['5:4'],
    '4:5': ['4:5'],
    '1:2': ['1:2'],
    '2:3 ': ['2:3'],
};

function sameAspect(have, want) {
    const a = String(have || '').trim().toLowerCase();
    const b = String(want || '').trim().toLowerCase();
    if (a === b) return true;
    const group = AR_ALIASES[b] || [b];
    return group.includes(a);
}

// Returns `{ ok, reasons }` — `reasons` is empty when `ok` is true.
function checkFlags(cmd, { expect = {}, expectStrict = [], forbid = [] } = {}) {
    const reasons = [];
    const f = parseFlags(cmd);

    for (const [name, want] of Object.entries(expect)) {
        if (want === undefined || want === null) continue;
        const have = f[name];
        if (have === undefined) {
            if (expectStrict.includes(name)) reasons.push(`missing --${name} (expected ${want})`);
            continue;
        }
        const haveStr = (have === true ? '' : String(have)).trim().toLowerCase();
        const wantStr = String(want).trim().toLowerCase();
        if (name === 'ar') {
            if (!sameAspect(haveStr, wantStr)) {
                reasons.push(`--${name} is ${haveStr || '(empty)'}, expected ${wantStr}`);
            }
            continue;
        }
        if (haveStr !== wantStr) reasons.push(`--${name} is ${haveStr || '(empty)'}, expected ${wantStr}`);
    }

    for (const name of forbid) {
        if (f[name] !== undefined) reasons.push(`unexpected --${name} (${f[name] === true ? '' : f[name]})`);
    }

    return { ok: reasons.length === 0, reasons };
}

// Match one feed item against a prompt.
//
// Returns `{ ok, reasons, job }`. `ok` means this job IS our prompt,
// rendered exactly as we asked.
function matchJob(job, promptText, opts = {}) {
    const { expect = {}, expectStrict = [], forbid = [] } = opts;
    const reasons = [];

    if (!job || !job.id) {
        return { ok: false, reasons: ['job has no id'], job: job || null };
    }
    if (!isPlainJob(job)) {
        reasons.push(`job_type ${job.job_type} is not a plain generation`);
        return { ok: false, reasons, job };
    }
    if (!commandMatchesPrompt(job.full_command || '', promptText)) {
        reasons.push('command does not carry this prompt');
        return { ok: false, reasons, job };
    }
    const flagCheck = checkFlags(job.full_command || '', { expect, expectStrict, forbid });
    if (!flagCheck.ok) reasons.push(...flagCheck.reasons);

    return { ok: reasons.length === 0, reasons, job };
}

// Find the best matching job in a feed list.
//
// `excludeIds` holds ids already claimed — the pre-run feed snapshot
// (so a re-run of an already-shipped prompt file cannot match yesterday's
// card) plus ids consumed by earlier prompts in this run.
//
// When several jobs match — a retry, or the same prompt submitted twice —
// the EARLIEST enqueue time wins. A retry of a prompt that already landed
// is a duplicate generation, and the first one is the one whose parameters
// were correct; later ones can carry the UI's drifted flags.
//
// `after` bounds the search by enqueue time, so a re-run cannot adopt a
// job from an earlier run even if the id snapshot missed it.
function findJob(jobs, promptText, opts = {}) {
    const { expect = {}, expectStrict = [], forbid = [], excludeIds = [], after = null } = opts;
    const excluded = new Set(excludeIds);
    const afterMs = after ? Date.parse(after) : null;

    const matches = [];
    for (const job of jobs || []) {
        if (!job || excluded.has(job.id)) continue;
        if (afterMs !== null && !Number.isNaN(afterMs)) {
            const t = Date.parse(job.enqueue_time);
            if (!Number.isNaN(t) && t < afterMs) continue;
        }
        const m = matchJob(job, promptText, { expect, expectStrict, forbid });
        if (m.ok) matches.push(job);
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
        const ta = Date.parse(a.enqueue_time) || 0;
        const tb = Date.parse(b.enqueue_time) || 0;
        return ta - tb;
    });
    return matches[0];
}

// Build the CDN url for one grid slot of a job.
//
// The CDN answers curl and headless clients with a Cloudflare 403 —
// verified 2026-10-21 — but serves a real (headed) browser fine. The url
// shape is deterministic from the job id, so it does not need the DOM
// (the feed is virtualized; the card may not even be mounted).
function gridUrls(jobId, batchSize = 4) {
    const urls = [];
    for (let slot = 0; slot < Math.max(1, batchSize); slot++) {
        urls.push(`https://cdn.midjourney.com/${jobId}/0_${slot}_640_N.webp?method=shortest`);
    }
    return urls;
}

// ---------- browser half ----------

// The in-page expression that discovers the account's user_id.
//
// The imagine page calls `/api/imagine?user_id=…` itself, so the id is in
// the resource timing list. The localStorage key
// `v8.2_personalization_rollout_closed_v3:<uuid>` is the fallback.
const DISCOVER_USER_ID = `(() => {
  const fromPerf = (performance.getEntriesByType('resource') || [])
    .map(e => e.name || '')
    .filter(n => n.includes('/api/imagine'))
    .map(n => (n.match(/user_id=([0-9a-f-]{36})/) || [])[1])
    .filter(Boolean)[0];
  if (fromPerf) return fromPerf;
  for (const k of Object.keys(localStorage)) {
    const m = k.match(/^v[\\d.]+_personalization_rollout_closed_v\\d+:(.+)$/);
    if (m && m[1]) return m[1];
  }
  return null;
})()`;

// The in-page expression that fetches the feed.
//
// Runs in the page so the session cookies apply (`credentials: 'include'`)
// and so the Cloudflare clearance travels with the request.
const FETCH_FEED = (userId, pageSize = 200) => `(async () => {
  const uid = ${JSON.stringify(userId)};
  const r = await fetch('/api/imagine?user_id=' + encodeURIComponent(uid) + '&page_size=' + ${JSON.stringify(String(pageSize))}, {
    headers: { 'X-CSRF-Protection': '1' },
    credentials: 'include',
  });
  if (!r.ok) return { status: r.status, error: 'feed request failed', items: [] };
  const j = await r.json();
  const items = Array.isArray(j) ? j : (j.items || j.data || []);
  return { status: r.status, items };
})()`;

// The in-page expression that checks whether CDN urls are actually
// servable right now.
//
// The CDN challenges curl and headless clients, so this has to run in the
// headed browser. It reports the status per url, which is how the
// pipeline knows the images are really there rather than merely
// constructible.
const PROBE_URLS = (urls) => `(async () => {
  const urls = ${JSON.stringify(urls)};
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { credentials: 'omit', cache: 'no-store' });
      out.push({ url: u, status: r.status, ok: r.ok, bytes: Number(r.headers.get('content-length') || 0) });
    } catch (e) {
      out.push({ url: u, status: 0, ok: false, bytes: 0 });
    }
  }
  return out;
})()`;

module.exports = {
    normText,
    proseOf,
    parseFlags,
    commandAspect,
    commandIsEdit,
    isPlainJob,
    commandMatchesPrompt,
    checkFlags,
    matchJob,
    findJob,
    gridUrls,
    DISCOVER_USER_ID,
    FETCH_FEED,
    PROBE_URLS,
    NOT_PLAIN_MODIFIERS,
};
