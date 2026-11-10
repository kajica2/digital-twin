#!/usr/bin/env node
'use strict';
// lib/felt-bunny.js
//
// FELT BUNNY — loader, composer, pack builder and reference doc.
//
// WHY A REGISTRY AND NOT A LIST OF PROMPTS
//
//   Two frames of one story. The character description, the DNA, the
//   anchor and the flags are constant across both; only the moment
//   changes. A hand-maintained pair of prompts would have two chances
//   to drift from the anchor and two chances to pick up a stray flag.
//   So the data lives in ONE file (`lib/felt-bunny.json`) and this
//   module turns it into the three artifacts the repo already knows how
//   to consume:
//
//     buildPack()   → a prompt pack in the house format (one bullet per
//                     frame) that lib/mj-web.js submits unchanged
//     buildFrame()  → one frame's exact composed prompt text
//     renderDoc()   → the human reference
//
// THE MEASURED RULES THIS ENCODES
//
// 1. THE CHARACTER REFERENCE RIDES AS --edit.
//
//    MEASURED 2026-11-05 (sprint 0.93): this account REFUSES --cref
//    (the identical prompt was refused with it, with and without --cw)
//    and ACCEPTS --edit. The anchor is therefore the source cell's own
//    CDN url — the frame the artist picked — carried verbatim.
//
// 2. THE IDENTITY CLAUSE IS BUILT AGAINST THE ACTUAL REFERENCE.
//
//    The source job's PROMPT asks for "an original, imaginative outfit
//    and accessories". The source RENDER has none — four bare felt
//    bunnies. So the clause denies the outfit the prompt asked for and
//    the reference does not have. Without that denial a frame can grow
//    a scarf the source never wore.
//
// 3. THE SOURCE'S OWN RATIO, AND THE ACCOUNT'S PROVEN ENGINE.
//
//    --ar 2:3 is the source job's ratio (read off its studio page);
//    --v 8.2 is this account's engine (--v 7 was MEASURED soft-banned,
//    sprint 0.61). No --stylize and no --profile: the source's panel
//    reads stylization 100 / weirdness 0, which are the defaults, and
//    the account's plain jobs of the same morning carry neither — so
//    naming them would pin an accident (sprint 0.98).
//
// 4. --ar IS LAST.
//
//    Midjourney honours the LAST occurrence of a duplicated flag, so
//    the ratio — the one flag this story must not lose — goes last.
//
// 5. NO PROMPT NAMES THE SUBJECT'S RACE OR ETHNICITY.
//
//    The repo's prompt lint (lib/prompt-lint.js) forbids it, because a
//    reference photo is authoritative and a demographic adjective
//    overrides it. Every frame here describes the SCENE.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'felt-bunny.json');

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

function load() {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

/** The frames, in story order. */
function frames(reg) {
    const r = reg || load();
    return (r.frames || []).slice().sort((a, b) => a.n - b.n);
}

/** One frame by its number (1-based) or its slug. */
function frame(n, reg) {
    const list = frames(reg);
    if (typeof n === 'number') return list.find(f => f.n === n) || null;
    return list.find(f => f.slug === n) || null;
}

function bySlug(slug, reg) {
    return frame(slug, reg);
}

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

/** The DNA clause — the palette and texture, appended to every frame. */
function dnaClause(reg) {
    const r = reg || load();
    return r.dnaProse;
}

/**
 * The character clause — the constant, carried verbatim on every frame.
 *
 * Lifted from the source job's own prompt, so the two frames are the
 * same rabbit rather than two similar ones. Written once and repeated,
 * so the story reads as one film rather than two pictures
 * (docs/VIDEO-FRAMING.md §Step 4).
 */
function characterClause(reg) {
    const r = reg || load();
    return r.character;
}

/**
 * The identity clause — the constant, carried verbatim on every frame.
 *
 * Written once and repeated, so the two frames read as one film rather
 * than two pictures (docs/VIDEO-FRAMING.md §Step 4).
 */
function identityClause(reg) {
    const r = reg || load();
    return r.identity;
}

/**
 * Compose ONE frame's exact prompt text.
 *
 * The order is fixed and it is the order the house packs use:
 *
 *   opening · detail · character · camera · light · DNA · identity ·
 *   suffix · flags
 *
 * The OPENING comes first and it is DIFFERENT per frame. The character
 * clause is shared by both frames, so a fixed clause order would open
 * every prompt with the same words — and a shared prefix collapses the
 * acceptance matcher's excerpt, which is how N prompts get attributed to
 * a few task ids (measured 2026-09-24 → 2026-11-05).
 *
 * The camera clause comes BEFORE the style words (docs/VIDEO-FRAMING.md
 * §4), and the flags come last so Midjourney parses them as parameters
 * and not as prose.
 */
function buildFrame(n, opts = {}) {
    const reg = opts.reg || load();
    const f = typeof n === 'number' ? frame(n, reg) : bySlug(n, reg);
    if (!f) throw new Error(`no such frame: ${n}`);

    const parts = [
        f.opening,
        f.detail,
        characterClause(reg),
        f.camera,
        f.light,
        dnaClause(reg),
        identityClause(reg),
        reg.suffix,
    ].filter(Boolean);

    let text = parts.join(', ');

    // The artist's own flags, resolved once. The anchor rides FIRST and
    // the ratio LAST: Midjourney resolves a doubled flag by taking the
    // last one, and --ar is the flag this story must not lose.
    text += ` ${reg.flags}`;
    return text;
}

/** Every frame's composed prompt. */
function buildPrompts(opts = {}) {
    const reg = opts.reg || load();
    return frames(reg).map(f => buildFrame(f.n, { ...opts, reg }));
}

/**
 * Build the house prompt pack: one top-level bullet per frame, in the
 * format lib/mj-web.js and the MJ watcher already parse.
 */
function buildPack(opts = {}) {
    const reg = opts.reg || load();
    const list = frames(reg);
    const lines = [];
    lines.push(`# ${reg.title} — ${list.length} frames (${reg.source.sourceFlags.match(/--ar\s+\S+/)[0].split(/\s+/)[1]})`);
    lines.push('');
    lines.push(`> ${reg.subtitle}`);
    lines.push('>');
    lines.push(`> Concept: ${reg.concept}`);
    lines.push('>');
    lines.push(`> Source: the artist's own frame — job ${reg.source.jobId} index ${reg.source.index} (cell ${reg.source.cell}).`);
    lines.push('> That frame is the CHARACTER ANCHOR: it is carried as `--edit`, because this');
    lines.push('> account refuses `--cref` (measured 2026-11-05).');
    lines.push('>');
    lines.push(`> Visual DNA (appended to every frame): ${reg.dnaProse}`);
    lines.push('>');
    lines.push(`> Identity clause: ${reg.identity}`);
    lines.push('>');
    lines.push(`> Flags: \`${reg.flags}\``);
    lines.push('');
    for (const f of list) {
        lines.push(`## ${String(f.n).padStart(2, '0')} — ${f.title}`);
        lines.push('');
        lines.push(`> ${f.change}`);
        lines.push('');
        lines.push(`- ${buildFrame(f.n, { ...opts, reg })}`);
        lines.push('');
    }
    return lines.join('\n');
}

/** The human reference. */
function renderDoc(opts = {}) {
    const reg = opts.reg || load();
    const list = frames(reg);
    const L = [];
    L.push(`# ${reg.title} — the ${list.length}-frame story`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The source');
    L.push('');
    L.push(`**Job.** \`${reg.source.jobId}\` index ${reg.source.index} (cell \`${reg.source.cell}\`)`);
    L.push('');
    L.push(`**Anchor.** \`${reg.source.cellUrl}\``);
    L.push('');
    L.push(`**The source job's own prompt.** ${reg.source.sourcePrompt}`);
    L.push('');
    L.push(`**The source job's own flags.** \`${reg.source.sourceFlags}\` — ${reg.source.measuredDims}`);
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The composition');
    L.push('');
    L.push(`**Concept.** ${reg.concept}`);
    L.push('');
    L.push(`**Visual DNA.** ${reg.dnaProse}`);
    L.push('');
    L.push(`**Identity clause.** ${reg.identity}`);
    L.push('');
    L.push(`**Flags.** \`${reg.flags}\``);
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The frames');
    L.push('');
    for (const f of list) {
        L.push(`### ${String(f.n).padStart(2, '0')} — ${f.title}`);
        L.push('');
        L.push(`*The change:* ${f.change}`);
        L.push('');
        L.push(f.opening);
        L.push('');
        L.push(f.detail);
        L.push('');
        L.push(`*Camera:* ${f.camera}`);
        L.push('');
        L.push(`*Light:* ${f.light}`);
        L.push('');
        if (f.cell) {
            L.push(`*Picked cell:* \`${f.cell}\` — the 4-up grid is four different`);
            L.push('takes. Measurement screens (median luma, nothing blown); the eye');
            L.push('decides on content.');
            if (f.cellNote) {
                L.push('');
                L.push(`*Why this one:* ${f.cellNote}.`);
            }
            L.push('');
        }
        L.push('```');
        L.push(buildFrame(f.n, { ...opts, reg }));
        L.push('```');
        L.push('');
    }
    L.push('---');
    L.push('');
    L.push('## Rendering it');
    L.push('');
    L.push('The pack carries its own complete suffix, so it composes with NO');
    L.push('defaults — the config\'s master suffix would otherwise append the');
    L.push('master\'s prose and the master\'s `--edit` anchor to it:');
    L.push('');
    L.push('```bash');
    L.push("node lib/mj-web.js --prompt-file assets/mural-prompts/felt-bunny.md \\");
    L.push("    --all-prompts --defaults '' --output mj-output/felt-bunny");
    L.push('```');
    L.push('');
    L.push('`--defaults \'\'` is empty on purpose. The config\'s master suffix ends');
    L.push('with `--edit https://s.mj.run/3Hv2HR2n3Zs` — the artist\'s own identity');
    L.push('anchor — and Midjourney honours the LAST of a duplicated flag, so');
    L.push('without the override the master\'s anchor would replace this story\'s.');
    L.push('');
    L.push('Both frames come back as `v8-2_edit_diffusion` jobs (the anchor rides');
    L.push('as `--edit`), at 2:3, four cells each.');
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The release');
    L.push('');
    L.push('`assets/releases/felt-bunny/` holds the two frames as JPG (native');
    L.push('896x1344), the contact sheet, and the manifest. The MP4 is');
    L.push('gitignored, so the cut is built on demand:');
    L.push('');
    L.push('```bash');
    L.push('node bin/images-to-mp4.mjs assets/releases/felt-bunny/frames/01.jpg \\');
    L.push('    assets/releases/felt-bunny/frames/02.jpg \\');
    L.push('    --out assets/releases/felt-bunny/felt-bunny-cut.mp4 \\');
    L.push('    --mode cut --size 896x1344 --each 3');
    L.push('```');
    L.push('');
    L.push('Two shots, three seconds each, hard cut between them: the bunny');
    L.push('stands alone, and then the boat is in its paws.');
    return L.join('\n');
}

module.exports = {
    REPO,
    REGISTRY_PATH,
    load,
    frames,
    frame,
    bySlug,
    buildFrame,
    buildPrompts,
    buildPack,
    renderDoc,
    dnaClause,
    identityClause,
    characterClause,
};

if (require.main === module) {
    const cmd = process.argv[2] || 'pack';
    const reg = load();
    if (cmd === 'pack') {
        process.stdout.write(buildPack({ reg }) + '\n');
    } else if (cmd === 'doc') {
        process.stdout.write(renderDoc({ reg }) + '\n');
    } else if (cmd === 'list') {
        for (const f of frames(reg)) {
            process.stdout.write(`${String(f.n).padStart(2, '0')}  ${f.slug}  ${f.title}\n`);
        }
    } else if (cmd === 'frame') {
        const n = Number(process.argv[3]);
        if (!Number.isInteger(n)) { process.stderr.write('usage: frame <n>\n'); process.exit(2); }
        process.stdout.write(buildFrame(n, { reg }) + '\n');
    } else {
        process.stderr.write('usage: pack | doc | list | frame <n>\n');
        process.exit(2);
    }
}
