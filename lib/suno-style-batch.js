#!/usr/bin/env node
'use strict';
// lib/suno-style-batch.js
//
// Builds Suno **style variants** from the user's saved style batch and
// the reference-lock protocols in pages/suno-prompts.html.
//
// The composition rule is the one the user's own batch already uses
// (reverse-engineered from the style titled "Kai record"):
//
//     tags = <protocol's Copy Prompt directive> + <the song's style descriptor>
//
// capped at the server's 1000-character tag limit, with the DESCRIPTOR
// always preserved — the directive gives way. See lib/suno-styles.js.
//
// The create/upsert endpoint is POST /api/prompts/v2 with
// { tags, id, title } — `id: null` creates, `id: <existing>` updates.
// That makes this script idempotent: re-running it updates the same 10
// styles rather than piling up duplicates.
//
// CLI:
//   node lib/suno-style-batch.js --song <clip_id> [--apply] [--dry-run]
//                                 [--song-title "KO TO TAMO VERA"]
//                                 [--out data/suno/style-variants.json]
//
// Exit: 0 ok · 1 fatal · 2 some variants failed

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { loadPresets, buildVariants, LIMITS } = require('./suno-styles.js');

const REPO = path.resolve(__dirname, '..');

function log(msg) { process.stdout.write(`[suno-batch] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-batch] ${msg}\n`); }

/** "KO TO TAMO VERA _  IDEMO _ ..." -> "KO TO TAMO VERA" */
function shortTitle(raw) {
    const t = String(raw || '').trim();
    const cut = t.split(/\s[_|]\s|\s\|\s/)[0].trim();
    return cut || t.slice(0, LIMITS.title);
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
    };
    const has = name => argv.includes(`--${name}`);

    const songId = flag('song');
    if (!songId) throw new Error('--song <clip_id> is required');
    const apply = has('apply');
    const outPath = path.resolve(REPO, flag('out', 'data/suno/style-variants.json'));

    const presets = loadPresets(REPO);
    log(`${presets.length} protocols loaded from pages/suno-prompts.html`);

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    const manifest = {
        generatedAt: new Date().toISOString(),
        song: { clipId: songId, title: null, descriptor: null, settings: null },
        rules: {
            tagsLimit: LIMITS.tags,
            titleLimit: LIMITS.title,
            composition: 'protocol Copy Prompt + song style descriptor, descriptor preserved, total <= 1000',
        },
        variants: [],
    };

    try {
        const clip = await client.getClip(songId);
        if (!clip) throw new Error(`clip not found: ${songId}`);
        const md = clip.metadata || {};
        const descriptor = String(md.tags || '').trim();
        if (!descriptor) throw new Error(`clip ${songId} has no style tags to use as a descriptor`);

        const title = flag('song-title', null) || shortTitle(clip.title);
        manifest.song.title = title;
        manifest.song.descriptor = descriptor;
        manifest.song.settings = {
            model: clip.major_model_version || (md.model_badges && md.model_badges.songcard
                ? md.model_badges.songcard.display_name
                : null),
            task: md.task || null,
            type: md.type || null,
            prompt: md.prompt || null,
            duration: md.duration ?? null,
            is_max_mode: md.is_max_mode ?? null,
            control_sliders: md.control_sliders || null,
            cover_clip_id: md.cover_clip_id || null,
        };
        log(`song "${title}" (${songId})`);
        log(`descriptor: ${descriptor.length} chars`);

        const variants = buildVariants({ presets, descriptor, songTitle: title });
        const existing = await client.listStyles();
        const byTitle = new Map(existing.map(s => [String(s.title || ''), s]));

        for (const v of variants) {
            const prior = byTitle.get(v.title);
            const record = {
                preset: v.preset,
                target: v.target,
                influence: v.influence,
                influenceValue: v.influenceValue,
                title: v.title,
                tags: v.tags,
                tagsLength: v.tagsLength,
                titleLength: v.titleLength,
                styleId: null,
                action: 'create',
                ok: false,
            };
            if (prior) {
                record.styleId = prior.id;
                record.action = 'update';
            }
            if (!apply) {
                record.ok = null;
                record.preview = true;
                manifest.variants.push(record);
                log(`${record.action.padEnd(6)} ${v.title}  [${v.tagsLength} chars, influence ${v.influenceValue}]`);
                continue;
            }
            try {
                const r = await client.createStyle({ title: v.title, tags: v.tags });
                record.styleId = (r && (r.id || r.prompt_id)) || prior?.id || null;
                record.ok = true;
                log(`${record.action.padEnd(6)} ${v.title} -> ${record.styleId}`);
            } catch (e) {
                record.ok = false;
                record.error = e.message;
                warn(`FAILED  ${v.title}: ${e.message}`);
            }
            manifest.variants.push(record);
        }

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`manifest -> ${path.relative(REPO, outPath)}`);

        if (apply) {
            const ok = manifest.variants.filter(v => v.ok).length;
            log(`${ok}/${manifest.variants.length} styles written`);
            if (ok < manifest.variants.length) process.exit(2);
        } else {
            log('dry run — pass --apply to write');
        }
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().catch(e => { warn(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { shortTitle };
