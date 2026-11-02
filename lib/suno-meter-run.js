#!/usr/bin/env node
'use strict';
// lib/suno-meter-run.js
//
// Submit the uncommon-meter rolls as covers, into a workspace.
//
// MEASURED 2026-11-02 on this account:
//
//   * A plain text generation is REFUSED — the submit answers with a
//     clip id, the balance does not move, and the clip's audio URL
//     points at /api/forbidden.
//   * A COVER renders, and costs nothing.
//
// So these are covers. The captcha is per-request, so every roll takes
// a fresh token.
//
// CLI:
//   node lib/suno-meter-run.js --workspace <wid> --source <clipId>
//   node lib/suno-meter-run.js --workspace <wid> --source <clipId> --only seven-bells
//   node lib/suno-meter-run.js --workspace <wid> --source <clipId> --roll 2
//   node lib/suno-meter-run.js ... --apply            # submit
//   node lib/suno-meter-run.js ... --out data/suno/meter-rolls.json
//
// Exit: 0 ok · 1 fatal · 2 some rolls failed

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { clipVerdict } = require('./suno-create.js');
const { loadPrompts, findPrompt, rollPlan } = require('./suno-meter-roll.js');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { process.stdout.write(`[suno-meter] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-meter] ${msg}\n`); }

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };
    const has = (name) => argv.includes(`--${name}`);

    const workspace = flag('workspace', flag('wid'));
    const sourceId = flag('source');
    const only = flag('only');
    const roll = Number(flag('roll', 4)) || 4;
    const influence = Number(flag('influence', 0.7));
    const apply = has('apply');
    const outPath = path.resolve(REPO, flag('out', 'data/suno/meter-rolls.json'));

    if (!workspace) throw new Error('--workspace <wid> is required');
    if (!sourceId) throw new Error('--source <clipId> is required');

    const prompts = only ? [findPrompt(only)].filter(Boolean) : loadPrompts();
    if (!prompts.length) throw new Error(`no prompt named "${only}"`);

    // The source's own settings — its length decides the cover's span.
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
        log(`prompts: ${prompts.length} x ${roll} rolls = ${prompts.length * roll}`);

        const plan = rollPlan({
            prompts, sourceClipId: sourceId, sourceDuration, workspace, roll, influence,
        });

        if (!apply) {
            log('dry run — nothing submitted (add --apply)');
            for (const r of plan) {
                log(`  ${r.title}  · style ${r.body.tags.length} chars · lyrics ${r.body.prompt.length} chars`);
            }
            return 0;
        }

        const before = await client.billing();
        log(`credits: ${before.credits}`);

        for (const r of plan) {
            const body = { ...r.body };
            try {
                // The captcha is per-request.
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

                // A submitted clip is not a made track — but a clip that
                // is not ON THE SERVER YET is not a failure either.
                //
                // MEASURED 2026-11-02: right after the submit,
                // `get_songs_by_ids` does not know the clip yet, and the
                // verdict reported "the clip is not on the server yet"
                // as a FAILED generation while it was in flight.
                //
                // So: a missing clip means KEEP WAITING; a clip with a
                // status means the verdict applies.
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
                    slug: r.slug, name: r.name, meter: r.meter, roll: r.roll,
                    title: r.title, clipIds: ids, verdicts,
                    rendered: bad.length === 0,
                });
            } catch (e) {
                failed += 1;
                warn(`FAILED ${r.title}: ${e.message}`);
                records.push({ slug: r.slug, name: r.name, title: r.title, rendered: false, error: e.message });
            }
        }

        const after = await client.billing();
        log(`credits: ${before.credits} -> ${after.credits}`);
    } catch (e) {
        // MEASURED 2026-11-02: a fatal error mid-run (a 401 on the
        // billing call) killed the process with NO manifest, so every
        // record of what HAD happened was lost. Write it first, then
        // re-throw.
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
            fs.writeFileSync(outPath, `${JSON.stringify({ workspace, sourceId, rolls: records }, null, 2)}\n`);
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
