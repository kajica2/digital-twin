#!/usr/bin/env node
'use strict';
// lib/suno-create.js
//
// CREATE one song from a text brief on suno.com.
//
// `lib/suno-run.js` covers an existing clip; this is the other half — a
// text prompt becomes a track. The request shape is the same one the
// studio API validates against a pydantic model (POST
// /api/generate/v2-web/), so a wrong field name comes back as a 422 with
// the schema in the body rather than as a silent no-op.
//
// The generation is gated behind a Cloudflare Turnstile captcha: the
// widget only produces a token in a HEADED browser (measured 2026-10-21 —
// headless renders the widget and never gets a token, so the request dies
// at "captcha token timed out" after 45 s).
//
// CLI:
//   node lib/suno-create.js --tags "<style brief>" [--negative-tags "no vocals, …"]
//                            [--title "…"] [--prompt "[Instrumental]"]
//                            [--duration 198] [--mv chirp-hawk] [--out <dir>]
//                            [--apply] [--port 9455]
//
// Exit: 0 ok · 1 fatal · 2 nothing submitted (dry run) · 3 submit failed

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SunoClient } = require('./suno-web.js');

const REPO = path.resolve(__dirname, '..');

function log(msg) { process.stdout.write(`[suno-create] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-create] ${msg}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The `task` literal for a plain text generation.
//
// MEASURED 2026-10-30: the first submit came back 422 with the schema in
// the body — the accepted literals are 'extend', 'upload_extend', 'infill',
// 'fixed_infill', 'infill_intro', 'infill_outro', 'cover_infill',
// 'cover_extend', 'artist_infill', 'artist_consistency', 'cover',
// 'image_to_song', 'video_to_song', 'concat', 'concat_infilling',
// 'upsample', 'twitter_to_song', 'artist_cover', 'vox_cover',
// 'artist_extend', 'vox_extend', 'artist_cover_extend', 'vox',
// 'artist_vox', 'stem', 'gen_stem', 'generate', 'nonauth_preview',
// 'fast_nonauth_preview', 'holiday_card', 'pre_gen_song_d0',
// 'multi_artist_consistency', … — and the one for "make me a song from this
// text" is 'generate'. There is no 'create'.
//
// The prompt the model sees. "[Instrumental]" is the web app's own marker
// for a track with no sung words.
const INSTRUMENTAL_MARKER = '[Instrumental]';

// Suno's negative-tag field wants phrases ("no vocals"), not bare nouns.
// The brief may carry either, and with a non-breaking hyphen in front of
// them ("‑vocals"); both are normalised here rather than at the call site.
function normalizeNegatives(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const parts = raw
        .split(/[,;]/)
        .map((p) => p.trim().replace(/^[\s\u2011\u2013\u2014-]+/, '').trim())
        .filter(Boolean);
    const out = [];
    for (const p of parts) {
        if (!p || p.toLowerCase() === 'no') continue;
        // An acronym counts too: "EDM" must become "no EDM", so the test is
        // for a word, not for a lowercase letter.
        out.push(/^no\s+/i.test(p) ? p : `no ${p}`);
    }
    // The brief can name the same exclusion twice ("‑no vocals, ‑vocals").
    // Keep the first and drop the repeat — the field is a set.
    const seen = new Set();
    const unique = out.filter((p) => {
        const key = p.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return unique.join(', ');
}

/**
 * The request body for one text-generated track.
 *
 * Pure, so the shape can be asserted without a browser or an account.
 */
function buildBody({
    tags,
    negativeTags = '',
    title = 'Untitled',
    prompt = INSTRUMENTAL_MARKER,
    duration = 198,
    mv = 'chirp-hawk',
    instrumental = true,
    influence = 0.65,
    task = 'generate',
} = {}) {
    // Max mode and duration are one decision, not two.
    //
    // MEASURED 2026-10-30: a request with `is_max_mode: true` and a 60 s
    // duration comes back as a clip with `error_type:
    // "invalid_generation_request"` — the server accepts the body, spends
    // the credits, and then fails the clip. Max mode is the ~198 s track;
    // anything shorter is simple mode, and simple mode is capped at 60 s.
    const asked = Math.round(Number(duration) || 198);
    const isMax = asked >= 180;
    const body = {
        prompt: instrumental ? INSTRUMENTAL_MARKER : String(prompt || ''),
        task,
        title: String(title || 'Untitled').slice(0, 100),
        tags: String(tags || '').slice(0, 1000),
        negative_tags: String(negativeTags || '').slice(0, 1000),
        make_instrumental: !!instrumental,
        duration: isMax ? 198 : Math.max(10, Math.min(60, asked)),
        generation_type: 'TEXT',
        override_fields: ['prompt', 'tags'],
        project_id: 'default',
        transaction_uuid: crypto.randomUUID(),
        metadata: {
            web_client_pathname: '/create',
            create_surface: 'home',
            create_mode: 'custom',
            is_max_mode: isMax,
            control_sliders: {
                audio_weight: Number(influence),
                weirdness_constraint: 0,
                aug_creativity: 1,
            },
        },
    };
    // `--mv none` asks the server for its own default model. The v6 id
    // ('chirp-hawk') is right for a cover; a text generation is allowed to
    // pick, and a plan that does not include v6 will answer differently.
    if (mv && String(mv).toLowerCase() !== 'none') body.mv = mv;
    return body;
}

/**
 * What the submitted clip actually became.
 *
 * Pure, so the shape can be asserted without an account.
 *
 * MEASURED 2026-10-30: on an account with 7 credits left, EVERY request
 * came back `status: "error"` with its audio URL pointing at
 * `studio-api.prod.suno.com/api/forbidden` — a 198 s max-mode one, a
 * 60 s simple one, with and without an explicit model. The balance did
 * not move, so nothing was spent. The body was not the problem: the
 * ACCOUNT refused it, and the refusal only shows up on the clip.
 */
function clipVerdict(clip, balance) {
    if (!clip) {
        return { ok: false, status: 'missing', reason: 'the clip is not on the server yet' };
    }
    const status = String(clip.status || '').toLowerCase();
    const audio = clip.audio_url || clip.song_url || (clip.metadata && clip.metadata.audio_url) || '';
    if (status === 'error') {
        const forbidden = /forbidden/i.test(String(audio));
        return {
            ok: false,
            status,
            reason: forbidden
                ? `the account refused the generation (${balance} credit(s) left; the audio URL points at /api/forbidden)`
                : (clip.error_type ? `the generation failed: ${clip.error_type}` : 'the generation failed'),
        };
    }
    if (['complete', 'streaming', 'submitted', 'pending'].includes(status)) {
        return { ok: true, status, reason: '' };
    }
    return { ok: false, status: status || 'unknown', reason: `the clip is in an unexpected state ("${status}")` };
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };
    const has = (name) => argv.includes(`--${name}`);

    const tags = flag('tags', '');
    if (!tags) throw new Error('--tags <style brief> is required');
    const apply = has('apply');
    const outDir = path.resolve(REPO, flag('out', 'data/suno/created'));
    const title = flag('title', 'Untitled');
    const negativeTags = normalizeNegatives(flag('negative-tags', ''));
    const duration = Number(flag('duration', 198));
    const mv = flag('mv', 'chirp-hawk');
    const influence = Number(flag('influence', 0.65));
    const instrumental = !has('vocal');

    const body = buildBody({ tags, negativeTags, title, duration, mv, influence, instrumental });
    log(`title:      ${body.title}`);
    log(`tags:       ${body.tags.length} chars`);
    log(`negatives:  ${body.negative_tags || '(none)'}`);
    log(`duration:   ${body.duration}s · mv ${body.mv} · instrumental ${body.make_instrumental}`);

    if (!apply) {
        log('dry run — nothing submitted (add --apply to generate)');
        log(JSON.stringify(body, null, 2));
        process.exit(2);
    }

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    try {
        const before = await client.billing();
        log(`credits: ${before.credits}`);

        // The captcha is per-request: a fresh token each time, and the
        // provider is the version the server itself reported.
        const check = await client.captchaCheck();
        if (check.required) {
            body.token = await client.captchaToken();
            body.token_provider = check.captcha_version;
            log('captcha token acquired');
        }

        let r;
        let attempts = 0;
        while (attempts < 4) {
            attempts++;
            r = await client.api('/api/generate/v2-web/', { method: 'POST', body });
            if (r.status >= 200 && r.status < 300) break;
            const retryable = r.status === 429 ||
                /token_validation_failed|Too many requests|verify your request/i.test(String(r.body));
            if (!retryable || attempts >= 4) break;
            const backoff = 4000 * attempts;
            warn(`retry ${attempts}/3 in ${backoff}ms (${r.status})`);
            await sleep(backoff);
        }
        if (r.status < 200 || r.status >= 300) {
            throw new Error(`submit failed: ${r.status} ${String(r.body).slice(0, 600)}`);
        }

        const clipId = r.json && r.json.clips && r.json.clips[0] && r.json.clips[0].id;
        log(`submitted -> clip ${clipId || '(no id)'}`);
        const after = await client.billing();
        log(`credits: ${before.credits} -> ${after.credits}`);

        // A submitted clip is not a made track. The submit call answers
        // with an id whether or not the generation will ever render: the
        // account can refuse a request (balance, plan limit, a cap) and
        // the refusal only shows up on the clip. Reporting "submitted" as
        // if it were "made" is how a dead track looks alive — and then a
        // fetch polls for audio that will never arrive.
        let clip = null;
        for (let i = 0; i < 6 && clipId; i++) {
            await sleep(5000);
            try { clip = await client.getClip(clipId); } catch { /* keep polling */ }
            if (clip && clip.status && clip.status !== 'submitted' && clip.status !== 'pending') break;
        }
        const verdict = clipVerdict(clip, after.credits);
        if (!verdict.ok) {
            warn(`the generation did NOT render: ${verdict.reason}`);
        } else {
            log(`the clip is ${verdict.status}`);
        }

        fs.mkdirSync(outDir, { recursive: true });
        const record = {
            title: body.title,
            clipId: clipId || null,
            generationId: (r.json && r.json.id) || null,
            tags: body.tags,
            negative_tags: body.negative_tags,
            duration: body.duration,
            mv: body.mv,
            instrumental: body.make_instrumental,
            creditsBefore: before.credits,
            creditsAfter: after.credits,
            status: verdict.status,
            rendered: verdict.ok,
            verdict: verdict.reason || 'rendered',
            submittedAt: new Date().toISOString(),
            body,
        };
        fs.writeFileSync(path.join(outDir, `${slug(body.title)}.json`), JSON.stringify(record, null, 2));
        log(`record -> ${path.relative(REPO, path.join(outDir, `${slug(body.title)}.json`))}`);
        if (verdict.ok) {
            log(`next: node lib/suno-fetch.js --clip ${clipId}   (or fetch the audio from the studio)`);
        } else {
            warn(`nothing to fetch — fix the account, then re-run this command.`);
        }
        return verdict.ok ? 0 : 3;
    } finally {
        await client.close();
    }
}

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'track';
}

module.exports = { buildBody, normalizeNegatives, slug, clipVerdict, INSTRUMENTAL_MARKER };

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn(`fatal: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}
