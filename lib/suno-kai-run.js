#!/usr/bin/env node
'use strict';
// lib/suno-kai-run.js
//
// Generate the KAI sound DNA — the Nordic Modern Jazz Big Band — in a
// workspace, as covers.
//
// WHY COVERS
//
// MEASURED 2026-11-02 on this account: a plain text generation is
// REFUSED (the balance does not move, the clip's audio URL points at
// /api/forbidden), while a COVER of an existing track renders and
// costs nothing.
//
// THREE FIELDS
//
// The master style (856 chars) and the exclusions (211) are 1069
// together — over the 1000-character tag limit — so they go in
// SEPARATE fields. The arrangement goes in the lyrics field, as
// section tags.
//
// CLI:
//   node lib/suno-kai-run.js --workspace <wid> --source <clipId>
//   node lib/suno-kai-run.js ... --roll 4          # rolls of each
//   node lib/suno-kai-run.js ... --with-variation   # also the house's variation
//   node lib/suno-kai-run.js ... --apply
//
// Exit: 0 ok · 1 fatal · 2 some rolls failed

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { clipVerdict } = require('./suno-create.js');
const { coverBody } = require('./suno-meter-roll.js');
const { findStyle, styleFields, variationFields } = require('./suno-kai-dna.js');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { process.stdout.write(`[suno-kai] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-kai] ${msg}\n`); }

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };
    const has = (name) => argv.includes(`--${name}`);

    const workspace = flag('workspace', flag('wid'));
    const sourceId = flag('source');
    const roll = Number(flag('roll', 1)) || 1;
    const influence = Number(flag('influence', 0.8));
    const apply = has('apply');
    const outPath = path.resolve(REPO, flag('out', 'data/suno/kai-dna.json'));

    if (!workspace) throw new Error('--workspace <wid> is required');
    if (!sourceId) throw new Error('--source <clipId> is required');

    const style = findStyle(flag('style', 'nordic-big-band'));
    if (!style) throw new Error(`no style named "${flag('style', 'nordic-big-band')}"`);

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    const records = [];
    let failed = 0;
    try {
        const source = await client.getClip(sourceId);
        if (!source) throw new Error(`the source clip ${sourceId} was not found`);
        const sourceDuration = Number((source.metadata || {}).duration) || 0;
        log(`source: ${source.title} (${sourceId.slice(0, 8)}) · ${sourceDuration}s`);
        log(`workspace: ${workspace}`);
        log(`style: ${style.name}`);

        const f = styleFields(style);
        const v = variationFields(style);

        // The plan: the master style, and optionally the house's own
        // variation of it.
        const targets = [{ name: style.name, style: f.style, negatives: f.negativeTags, lyrics: f.prompt }];
        if (has('with-variation')) {
            targets.push({ name: v.title, style: v.style, negatives: f.negativeTags, lyrics: f.prompt });
        }

        const plan = [];
        for (const t of targets) {
            for (let i = 1; i <= roll; i += 1) {
                const title = roll > 1 ? `${t.name} ${i}/${roll}` : t.name;
                plan.push({
                    name: t.name,
                    title,
                    body: coverBody({
                        style: t.style,
                        lyrics: t.lyrics,
                        negativeTags: t.negatives,
                        sourceClipId: sourceId,
                        sourceDuration,
                        title,
                        workspace,
                        influence,
                    }),
                });
            }
        }

        if (!apply) {
            log('dry run — nothing submitted (add --apply)');
            for (const r of plan) {
                log(`  ${r.title}`);
                log(`    style ${r.body.tags.length} · negatives ${r.body.negative_tags.length} · lyrics ${r.body.prompt.length}`);
            }
            return 0;
        }

        const before = await client.billing();
        log(`credits: ${before.credits}`);

        for (const r of plan) {
            const body = { ...r.body };
            try {
                const check = await client.captchaCheck();
                if (check.required) {
                    body.token = await client.captchaToken();
                    body.token_provider = check.captcha_version;
                }
                const res = await client.api('/api/generate/v2-web/', { method: 'POST', body });
                if (res.status < 200 || res.status >= 300) {
                    throw new Error(`${res.status} ${String(res.body).slice(0, 200)}`);
                }
                const ids = (res.json && res.json.clips || []).map((c) => c && c.id).filter(Boolean);
                log(`submitted ${r.title} -> ${ids.length ? ids.map((i) => i.slice(0, 8)).join(', ') : '(no id)'}`);

                const verdicts = [];
                for (const id of ids) {
                    let clip = null;
                    for (let i = 0; i < 12; i += 1) {
                        await sleep(5000);
                        try { clip = await client.getClip(id); } catch { /* keep polling */ }
                        if (clip && clip.status && !['submitted', 'pending', 'queued', 'streaming'].includes(clip.status)) break;
                    }
                    verdicts.push({ id, status: clip && clip.status, verdict: clipVerdict(clip, before.credits) });
                }
                const bad = verdicts.filter((x) => !x.verdict.ok);
                if (bad.length) {
                    failed += 1;
                    warn(`  did NOT render: ${bad[0].verdict.reason}`);
                } else {
                    log(`  rendered: ${verdicts.map((x) => `${x.id.slice(0, 8)}=${x.verdict.status}`).join(' ')}`);
                }
                records.push({
                    name: r.name, title: r.title, clipIds: ids, verdicts, rendered: bad.length === 0,
                });
            } catch (e) {
                failed += 1;
                warn(`FAILED ${r.title}: ${e.message}`);
                records.push({ name: r.name, title: r.title, rendered: false, error: e.message });
            }
        }

        const after = await client.billing();
        log(`credits: ${before.credits} -> ${after.credits}`);
    } catch (e) {
        writeManifest();
        throw e;
    } finally {
        await client.close();
    }

    writeManifest();
    log(`${records.length - failed}/${records.length} rolls rendered`);
    return failed ? 2 : 0;

    function writeManifest() {
        try {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, `${JSON.stringify({ workspace, sourceId, style: style.name, rolls: records }, null, 2)}\n`);
            log(`manifest -> ${path.relative(REPO, outPath)}`);
        } catch (e) {
            warn(`could not write the manifest: ${e.message}`);
        }
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn(`fatal: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}

module.exports = { main };
