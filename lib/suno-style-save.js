#!/usr/bin/env node
'use strict';
// lib/suno-style-save.js
//
// Write the style library into the account as SAVED STYLES.
//
// A saved style is `{ title, tags }`: POST /api/prompts/v2 with
// `{ tags, id, title }`. `id: null` creates, an existing id UPDATES.
//
// MEASURED 2026-11-01 (live): sending `id: null` CREATES every time.
// A run that looked the title up but sent `id: null` anyway left the
// account holding TWELVE styles with identical titles while the log
// printed "style updated" both times. The id has to reach the request
// body, and the title match has to be EXACT — two styles whose titles
// share a prefix must not collide.
//
// CLI:
//   node lib/suno-style-save.js                 # save every preset
//   node lib/suno-style-save.js midnight-solstice glass-corridor
//   node lib/suno-style-save.js --list          # show, write nothing
//   node lib/suno-style-save.js --apply         # write to the account
//   node lib/suno-style-save.js --out data/suno/style-library.json
//
// Exit: 0 ok · 1 fatal · 2 some styles failed

const fs = require('node:fs');
const path = require('node:path');

const { SunoClient } = require('./suno-web.js');
const { findExistingStyle } = require('./suno-mutator.js');
const { loadLibrary, styleText, styleTitle, libraryStyles } = require('./suno-style-library.js');

const REPO = path.resolve(__dirname, '..');

function log(msg) { process.stdout.write(`[suno-style-save] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[suno-style-save] ${msg}\n`); }

async function main() {
    const argv = process.argv.slice(2);
    const has = (n) => argv.includes(`--${n}`);
    const flag = (n, dflt) => {
        const i = argv.indexOf(`--${n}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };

    const lib = loadLibrary();
    const wanted = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out');
    const presets = wanted.length
        ? wanted.map((k) => findPreset(k)).filter(Boolean)
        : lib.presets;

    if (wanted.length && presets.length !== wanted.length) {
        const missing = wanted.filter((k) => !findPreset(k));
        warn(`no preset named: ${missing.join(', ')}`);
    }

    if (has('list')) {
        for (const p of presets) {
            log(`--- ${styleTitle(p)}  [${p.slug}]  ${styleText(p).length} chars`);
            log(styleText(p));
            log('');
        }
        return 0;
    }

    const outPath = path.resolve(REPO, flag('out', 'data/suno/style-library.json'));
    const styles = presets.map((p) => ({
        slug: p.slug,
        title: styleTitle(p),
        tags: styleText(p),
    }));

    if (!has('apply')) {
        log(`${styles.length} style(s) prepared — nothing written (add --apply)`);
        for (const s of styles) log(`  ${s.title}  (${s.tags.length} chars)`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify({ styles }, null, 2)}\n`);
        log(`plan -> ${path.relative(REPO, outPath)}`);
        return 0;
    }

    const client = await SunoClient.open({
        cookieFile: flag('cookies', undefined),
        port: Number(flag('port', 0)) || undefined,
    });

    const records = [];
    let failed = 0;
    try {
        const existing = await client.listStyles();
        for (const s of styles) {
            const prior = findExistingStyle(existing, s.title);
            try {
                const r = await client.createStyle({
                    title: s.title,
                    tags: s.tags,
                    id: prior && prior.id ? prior.id : null,
                });
                const id = (r && (r.id || r.prompt_id)) || (prior && prior.id) || null;
                log(`style ${prior ? 'updated' : 'saved'}: ${s.title}${id ? ` (${id.slice(0, 8)})` : ''}`);
                records.push({ ...s, id, ok: true, action: prior ? 'updated' : 'saved' });
            } catch (e) {
                failed++;
                warn(`style FAILED ${s.title}: ${e.message}`);
                records.push({ ...s, id: null, ok: false, error: e.message });
            }
        }
    } finally {
        await client.close();
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify({ styles: records }, null, 2)}\n`);
    log(`manifest -> ${path.relative(REPO, outPath)}`);
    log(`${records.length - failed}/${records.length} styles written`);
    return failed ? 2 : 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        warn(`fatal: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}

module.exports = { main };
