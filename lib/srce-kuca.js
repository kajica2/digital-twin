#!/usr/bin/env node
'use strict';
// lib/srce-kuca.js
//
// The SRCE KUCA shots — loader, composer, pack builder and reference doc.
//
// WHY A REGISTRY AND NOT A LIST OF PROMPTS
//
//   Twelve shots of one film. The DNA, the identity clause and the flags
//   are constant across all twelve; only the moment changes. A
//   hand-maintained list of twelve prompts would have twelve chances to
//   drift from the DNA and to pick up a stray flag. So the data lives in
//   ONE file (`lib/srce-kuca.json`) and this module generates the pack,
//   the doc and the test inputs from it.
//
// THE MEASURED RULES THIS ENCODES
//
// 1. RENDER PLAIN WHEN THE CAMERA IS THE POINT.
//
//    docs/VIDEO-FRAMING.md §4: in EDIT mode (an --edit attachment) the
//    reference photograph decides the distance and the height, and every
//    distance clause is disobeyed. In PLAIN mode the camera clause is
//    obeyed — the wide, the high angle, the dutch tilt, the macro, the
//    profile, the top-down, the long lens and the whip pan all landed.
//    These shots are a CAMERA set, so they render plain.
//
// 2. THE ARTIST'S FLAGS WIN, AND EACH ONE IS RESOLVED EXACTLY ONCE.
//
//    The repo's config default is `--ar 16:9 --style raw --s 21`. The
//    artist's own flags are `--chaos 5 --ar 16:9 --raw --stylize 755 --hd`
//    plus FIVE separate `--profile` lines. buildFullPrompt (the repo's own
//    composer) drops the config's --style/--s/--ar when the prompt
//    carries its own, so the config never competes with the artist.
//
//    The five --profile lines are FIVE separate flags, not one --profile
//    with five codes. MEASURED 2026-11-04 on the live studio page: that
//    is the spelling the UI's own recent-parameters row produces, and
//    the account's job commands agree.
//
// 3. THE CAMERA CLAUSE GOES BEFORE THE STYLE WORDS.
//
//    docs/VIDEO-FRAMING.md §4: so the camera reads as the instruction
//    and the style as the grade on top of it.
//
// 4. NO PROMPT NAMES THE SUBJECT'S RACE OR ETHNICITY.
//
//    The repo's prompt lint (lib/prompt-lint.js) forbids it, because a
//    reference photo is authoritative and a demographic adjective
//    overrides it. Every shot here describes the SCENE.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'srce-kuca.json');

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

function load() {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function frames(reg) {
    const r = reg || load();
    return (r.frames || []).slice().sort((a, b) => a.n - b.n);
}

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

/** The DNA clause — the palette and texture, appended to every shot. */
function dnaClause(reg) {
    const r = reg || load();
    return r.dnaProse;
}

/** The identity clause — constant, verbatim, on every shot. */
function identityClause(reg) {
    const r = reg || load();
    return r.identity;
}

/**
 * Compose ONE shot's exact prompt text.
 *
 * The order is the measured one:
 *
 *   prose · camera · DNA · identity · suffix · flags
 *
 * The camera clause comes BEFORE the style words (docs/VIDEO-FRAMING.md
 * §4), and the flags come last so Midjourney parses them as parameters.
 */
function buildFrame(n, opts = {}) {
    const reg = opts.reg || load();
    const f = typeof n === 'number' ? frame(n, reg) : bySlug(n, reg);
    if (!f) throw new Error(`no such frame: ${n}`);

    const parts = [
        f.prose,
        f.camera,
        dnaClause(reg),
        identityClause(reg),
        reg.suffix,
    ].filter(Boolean);

    let text = parts.join(', ');

    // The artist's own flags, resolved once. A prompt carrying --raw
    // owns the style slot, so the config's --style and its coupled --s
    // are dropped by buildFullPrompt — the artist wins.
    text += ` ${reg.flags}`;
    return text;
}

/** Every shot's composed prompt. */
function buildPrompts(opts = {}) {
    const reg = opts.reg || load();
    return frames(reg).map(f => buildFrame(f.n, { ...opts, reg }));
}

/**
 * Build the house prompt pack: one top-level bullet per shot, in the
 * format lib/mj-web.js and the MJ watcher already parse.
 */
function buildPack(opts = {}) {
    const reg = opts.reg || load();
    const list = frames(reg);
    const lines = [];
    lines.push(`# ${reg.title} — ${list.length} shots (16:9)`);
    lines.push('');
    lines.push(`> ${reg.subtitle}`);
    lines.push('>');
    lines.push(`> Source: ${reg.artist} — the song's own lyric.`);
    lines.push('>');
    lines.push(`> Concept: ${reg.concept}`);
    lines.push('>');
    lines.push(`> Visual DNA (appended to every shot): ${reg.visualDna}`);
    lines.push('>');
    lines.push(`> Camera: a camera set. Rendered PLAIN — no --edit attachment, because`);
    lines.push('> in edit mode the reference decides the distance and the camera clause');
    lines.push('> is disobeyed (docs/VIDEO-FRAMING.md §4).');
    lines.push('>');
    lines.push(`> Flags: \`${reg.flags}\``);
    lines.push('');
    lines.push(`> Act structure: ${reg.acts.map(a => a.title).join(' · ')}`);
    lines.push('');
    for (const f of list) {
        lines.push(`## ${String(f.n).padStart(2, '0')} — ${f.title}`);
        lines.push('');
        lines.push(`> "${f.lyric}"`);
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
    L.push(`# ${reg.title} — the ${reg.frames.length} shots`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push(`**Song.** ${reg.artist}`);
    L.push('');
    L.push(`**Concept.** ${reg.concept}`);
    L.push('');
    L.push(`**Visual DNA.** ${reg.visualDna}`);
    L.push('');
    L.push(`**Flags.** \`${reg.flags}\``);
    L.push('');
    L.push(`**Identity clause.** ${reg.identity}`);
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The shots');
    L.push('');
    for (const f of list) {
        L.push(`### ${String(f.n).padStart(2, '0')} — ${f.title}`);
        L.push('');
        L.push(`> "${f.lyric}"`);
        L.push('');
        L.push(f.prose);
        L.push('');
        L.push(`*Camera:* ${f.camera}`);
        L.push('');
        if (f.cell) {
            L.push(`*Picked cell:* \`${f.cell}\` — the 4-up grid is four different`);
            L.push('takes. Measurement screens (median luma, nothing blown); the eye');
            L.push('decides on content.');
            L.push('');
        }
        L.push('```');
        L.push(buildFrame(f.n, { ...opts, reg }));
        L.push('```');
        L.push('');
    }
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
