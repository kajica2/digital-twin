#!/usr/bin/env node
'use strict';
// lib/suno-post-humanize-run.js
//
// Run the POST-SUBMIT humanize preset: take tracks that have already
// been submitted and rendered, and re-cover each one with its own
// style plus the humanize layer.
//
// MEASURED 2026-11-02: a plain generation is REFUSED on this account
// (the balance does not move, the clip's audio URL points at
// /api/forbidden). A cover of an existing clip renders and costs
// nothing. So the post-submit pass is a COVER — of the submitted clip
// itself, not the source underneath it.
//
// CLI:
//   node lib/suno-post-humanize-run.js --clip <id> [--clip <id> ...]
//   node lib/suno-post-humanize-run.js --workspace <wid> --latest 10
//   node lib/suno-post-humanize-run.js --clip <id> --suffix unplugged
//   node lib/suno-post-humanize-run.js --clip <id> --apply
//
// Exit: 0 ok · 1 fatal · 2 some passes failed

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { clipVerdict } = require('./suno-create.js');
const { postSubmitPlan } = require('./suno-post-humanize.js');
const { listSuffixes } = require('./suno-humanize.js');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { process.stdout.write(`[suno-post] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-post] ${msg}\n`); }

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };
    const has = (name) => argv.includes(`--${name}`);
    const all = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

    const workspace = flag('workspace', flag('wid', 'default'));
    const suffix = flag('suffix', 'raw');
    const influence = Number(flag('influence', 0.8));
    const apply = has('apply');
    const outPath = path.resolve(REPO, flag('out', 'data/suno/post-humanize.json'));

    if (!listSuffixes().includes(suffix)) {
        throw new Error(`unknown suffix "${suffix}" — try: ${listSuffixes().join(', ')}`);
    }

    const clipIds = all('clip');
    const latest = Number(flag('latest', 0)) || 0;

    if (!clipIds.length && !latest) {
        throw new Error('nothing to do — pass --clip <id> (repeatable) or --latest <n>');
    }

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    const records = [];
    let failed = 0;
    try {
        // Resolve the clips.
        const clips = [];
        for (const id of clipIds) {
            const clip = await client.getClip(id);
            if (clip) clips.push(clip);
            else warn(`no such clip: ${id}`);
        }
        // The newest clips in a workspace.
        if (latest && workspace !== 'default') {
            const r = await client.api(`/api/project/${workspace}`);
            const list = (r.json && r.json.project_clips || []).map((x) => x.clip).filter(Boolean);
            for (const clip of list.slice(0, latest)) {
                if (!clips.some((c) => c.id === clip.id)) clips.push(clip);
            }
        }
        if (!clips.length) throw new Error('no clips to humanize');

        log(`clips: ${clips.length} · suffix: ${suffix} · workspace: ${workspace}`);

        const plan = postSubmitPlan({ clips, suffix, workspace, influence });

        if (!apply) {
            log('dry run — nothing submitted (add --apply)');
            for (const p of plan) {
                log(`  ${p.title}`);
                log(`    covers ${p.clipId.slice(0, 8)} · style ${p.body.tags.length} · negatives ${p.body.negative_tags.length}`);
            }
            return 0;
        }

        const before = await client.billing();
        log(`credits: ${before.credits}`);

        for (const p of plan) {
            const body = { ...p.body };
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
                log(`submitted ${p.title} -> ${ids.length ? ids.map((i) => i.slice(0, 8)).join(', ') : '(no id)'}`);

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
                const bad = verdicts.filter((v) => !v.verdict.ok);
                if (bad.length) {
                    failed += 1;
                    warn(`  did NOT render: ${bad[0].verdict.reason}`);
                } else {
                    log(`  rendered: ${verdicts.map((v) => `${v.id.slice(0, 8)}=${v.verdict.status}`).join(' ')}`);
                }
                records.push({
                    sourceClipId: p.clipId, title: p.title, clipIds: ids,
                    verdicts, rendered: bad.length === 0,
                });
            } catch (e) {
                failed += 1;
                warn(`FAILED ${p.title}: ${e.message}`);
                records.push({ sourceClipId: p.clipId, title: p.title, rendered: false, error: e.message });
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
    log(`${records.length - failed}/${records.length} passes rendered`);
    return failed ? 2 : 0;

    function writeManifest() {
        try {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, `${JSON.stringify({ workspace, suffix, passes: records }, null, 2)}\n`);
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
