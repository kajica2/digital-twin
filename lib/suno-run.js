#!/usr/bin/env node
'use strict';
// lib/suno-run.js
//
// RUNS the Suno style variants.
//
// For each variant in the manifest, this generates one song that covers
// the same source audio the reference song covers, using that variant's
// style tags and its own Audio Influence value.
//
// The payload shape was derived from the studio API itself
// (POST /api/generate/v2-web/), not guessed: the endpoint validates
// against a pydantic model and returns the schema in its 422 body, so
// the field names and the accepted `task` literals are ground truth.
//
// The settings copied from the reference song are the ones that actually
// shape the result:
//   * task            cover
//   * cover_clip_id   the uploaded source clip
//   * mv              chirp-hawk  (v6)
//   * prompt          [Instrumental]
//   * make_instrumental true
//   * duration        198.4 (max mode)
//   * metadata.control_sliders.audio_weight  <- the protocol's influence
//
// CLI:
//   node lib/suno-run.js --song <cover_clip_id> [--limit N] [--apply]
//                        [--source <upload_clip_id>] [--out <manifest>]
//
// Exit: 0 ok · 1 fatal · 2 some runs failed

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SunoClient } = require('./suno-web.js');
const { loadPresets, buildVariants } = require('./suno-styles.js');

const REPO = path.resolve(__dirname, '..');

function log(msg) { process.stdout.write(`[suno-run] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-run] ${msg}\n`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Build the generation body for one variant.
 *
 * @param {object} o
 * @param {object} o.variant      a variant from buildVariants()
 * @param {string} o.sourceClipId the uploaded clip to cover
 * @param {number} o.duration     max-mode duration, from the reference song
 * @param {number} o.sourceEnd    source length in seconds
 */
function buildBody({ variant, sourceClipId, duration, sourceEnd }) {
    return {
        prompt: '[Instrumental]',
        task: 'cover',
        cover_clip_id: sourceClipId,
        cover_start_s: 0,
        cover_end_s: sourceEnd,
        mv: 'chirp-hawk',
        title: variant.title,
        tags: variant.tags,
        negative_tags: '',
        make_instrumental: true,
        duration: Math.round(duration),
        generation_type: 'TEXT',
        override_fields: ['prompt', 'tags'],
        project_id: 'default',
        transaction_uuid: crypto.randomUUID(),
        metadata: {
            web_client_pathname: '/create',
            create_surface: 'home',
            create_mode: 'custom',
            is_max_mode: true,
            control_sliders: {
                audio_weight: variant.influenceValue,
                weirdness_constraint: 0,
                aug_creativity: 1,
            },
        },
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };
    const has = name => argv.includes(`--${name}`);

    const songId = flag('song');
    if (!songId) throw new Error('--song <cover_clip_id> is required (the reference song)');
    const apply = has('apply');
    const limit = Number(flag('limit', 0)) || 0;
    const pace = Number(flag('pace', 6000)) || 0;
    const outPath = path.resolve(REPO, flag('out', 'data/suno/style-variants.json'));

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    try {
        const song = await client.getClip(songId);
        if (!song) throw new Error(`reference song not found: ${songId}`);
        const md = song.metadata || {};
        const sourceClipId = flag('source') || md.cover_clip_id || md.edited_clip_id;
        if (!sourceClipId) throw new Error('no source clip to cover (no cover_clip_id on the song)');

        const source = await client.getClip(sourceClipId);
        const sourceEnd = source && source.metadata && source.metadata.duration
            ? source.metadata.duration
            : 0;
        const duration = md.duration || 198.4;
        const descriptor = String(md.tags || '').trim();

        log(`reference song: ${song.title}`);
        log(`source clip:    ${sourceClipId} (${sourceEnd}s)`);
        log(`settings:       task=${md.task} mv=${md.model_name || 'chirp-hawk'} max=${md.is_max_mode} duration=${duration}`);
        log(`descriptor:     ${descriptor.length} chars`);

        const presets = loadPresets(REPO);
        const variants = buildVariants({
            presets,
            descriptor,
            songTitle: song.title.split(/\s[_|]\s/)[0].trim() || song.title,
        });
        const selected = limit ? variants.slice(0, limit) : variants;

        const manifest = fs.existsSync(outPath)
            ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
            : { variants: [] };
        manifest.generatedAt = new Date().toISOString();
        manifest.runs = manifest.runs || [];
        const runEntries = [];
        const alreadyDone = new Set(
            (manifest.runs || []).filter(r => r.ok).map(r => r.title)
        );

        for (const v of selected) {
            if (alreadyDone.has(v.title)) {
                log(`skip ${v.title} (already submitted)`);
                continue;
            }
            const body = buildBody({
                variant: v,
                sourceClipId,
                duration,
                sourceEnd,
            });
            const entry = {
                title: v.title,
                preset: v.preset,
                influence: v.influence,
                influenceValue: v.influenceValue,
                sourceClipId,
                duration,
                submittedAt: new Date().toISOString(),
                ok: false,
            };
            if (!apply) {
                entry.preview = true;
                runEntries.push(entry);
                log(`would run ${v.title}  [influence ${v.influenceValue}]`);
                continue;
            }
            const before = (await client.billing()).credits;
            let r;
            let attempts = 0;
            const maxAttempts = 4;
            while (attempts < maxAttempts) {
                attempts++;
                // The studio API gates generation behind a captcha. Once
                // the server says one is required, every request without a
                // fresh token comes back 422 token_validation_failed.
                const check = await client.captchaCheck();
                if (check.required) {
                    const token = await client.captchaToken();
                    body.token = token;
                    body.token_provider = check.captcha_version;
                }
                try {
                    r = await client.api('/api/generate/v2-web/', { method: 'POST', body });
                } catch (e) {
                    r = { status: 0, body: e.message };
                }
                if (r.status >= 200 && r.status < 300) break;
                const retryable = r.status === 429 ||
                    /token_validation_failed|Too many requests|verify your request/i.test(String(r.body));
                if (!retryable || attempts >= maxAttempts) break;
                const backoff = 4000 * attempts;
                warn(`  retry ${attempts}/${maxAttempts - 1} in ${backoff}ms (${r.status})`);
                await sleep(backoff);
            }
            if (r.status < 200 || r.status >= 300) {
                entry.error = `${r.status} ${String(r.body).slice(0, 300)}`;
                warn(`FAILED ${v.title}: ${entry.error}`);
                runEntries.push(entry);
                continue;
            }
            const clipId = r.json && r.json.clips && r.json.clips[0] && r.json.clips[0].id;
            entry.generationId = r.json && r.json.id;
            entry.clipId = clipId || null;
            entry.ok = true;
            const after = (await client.billing()).credits;
            entry.creditsBefore = before;
            entry.creditsAfter = after;
            entry.creditsSpent = before - after;
            log(`submitted ${v.title} -> clip ${clipId}  (credits ${before} -> ${after})`);
            runEntries.push(entry);
            if (pace) await sleep(pace);
        }

        // Keep history: this pass replaces the entry for any title it
        // touched and leaves the rest alone.
        const touched = new Set(runEntries.map(r => r.title));
        manifest.runs = [
            ...(manifest.runs || []).filter(r => !r.preview && !touched.has(r.title)),
            ...runEntries,
        ];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`manifest -> ${path.relative(REPO, outPath)}`);

        if (apply) {
            const ok = runEntries.filter(r => r.ok).length;
            log(`${ok}/${runEntries.length} runs submitted`);
            if (ok < runEntries.length) process.exit(2);
        } else {
            log('dry run — pass --apply to submit');
        }
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().catch(e => { warn(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { buildBody };
