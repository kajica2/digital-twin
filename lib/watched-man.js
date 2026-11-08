#!/usr/bin/env node
'use strict';
// lib/watched-man.js
//
// THE WATCHED MAN — loader, composer, pack builder and reference doc.
//
// WHY A REGISTRY AND NOT A LIST OF PROMPTS
//
//   The storyboard is TWELVE frames of one film. The DNA, the identity
//   clause, the STYLE REFERENCE and the flags are constant across all
//   twelve, and the prose is what changes. A hand-maintained list of
//   twelve prompts would have twelve chances to drift from the DNA and
//   twelve chances to pick up a stray flag. So the data lives in ONE
//   file (`lib/watched-man.json`) and this module turns it into the
//   three artifacts the repo already knows how to consume:
//
//     buildPack()   → a prompt pack in the house format (one bullet per
//                     frame) that lib/mj-web.js submits unchanged
//     buildFrame()  → one frame's exact composed prompt text
//     renderDoc()   → the human reference
//
// THE FOUR MEASURED RULES THIS ENCODES
//
// 1. THE STYLE REFERENCE IS THE ARTIST'S OWN, RECOVERED FROM THE FEED.
//
//    The artist pointed at job c6403638 and asked for its look to be
//    set as the style prompt. Measured 2026-11-06:
//
//      * there is NO server route that creates a style reference —
//        thirteen candidate paths 404'd while the control route
//        answered 400, so the probe itself worked;
//      * every --sref this account uses is an `s.mj.run/<code>` link;
//      * job c6403638's own `full_command` already carries
//        `--sref https://s.mj.run/cATLXOMsR-o --profile ub2pnlv --v 8.2`;
//      * the studio's per-image action bar renders that same
//        reference as a thumbnail whose `alt` IS the URL.
//
//    So the look the artist pointed at IS that style reference, and it
//    travels as `--sref`.
//
// 2. THE CAMERA'S ORIENTATION IS NOT IN THE PROMPT.
//
//    Measured 2026-11-05 on a twelve-camera grid: nine of twelve
//    cameras landed, and the three that missed — the high angle, the
//    top-down flat lay and the dutch tilt — all failed the SAME way,
//    coming back LEVEL. A clause naming the camera's ORIENTATION is
//    ignored the way a DISTANCE clause is. So each frame's camera
//    clause names the camera's PLACE and the objects that must be in
//    the picture.
//
// 3. THE ARTIST'S FLAGS WIN, AND EACH ONE IS RESOLVED EXACTLY ONCE.
//
//    The repo's config default is `--ar 16:9 --style raw --s 21`. A
//    prompt carrying `--raw` owns the style slot, so buildFullPrompt
//    (lib/mj-flags.js) drops the config's `--style` AND its coupled
//    `--s`. The `--profile` on the source job rides on only six of two
//    hundred feed jobs, so it is a deliberate grade on that one job,
//    not the account's default — pinning a default would pin an
//    accident. It is left out.
//
// 4. NO PROMPT NAMES THE SUBJECT'S RACE OR ETHNICITY.
//
//    The repo's prompt lint (lib/prompt-lint.js) forbids it, because a
//    reference photo is authoritative and a demographic adjective
//    overrides it. Every frame here describes the SCENE.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'watched-man.json');

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

function load() {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

/** The frames, in order. */
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

/** The acts, in order. */
function acts(reg) {
    const r = reg || load();
    return (r.acts || []).slice();
}

/** The frames of one act. */
function actFrames(actId, reg) {
    const r = reg || load();
    const a = acts(r).find(x => x.id === actId);
    if (!a) return [];
    return a.frames.map(n => frame(n, r)).filter(Boolean);
}

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

/**
 * The DNA clause as it is appended to the prose.
 *
 * The DNA is PALETTE and TEXTURE — the look that makes the twelve
 * frames one film. It goes in the prose (the style box), because the
 * style reference is a separate flag and the house moodboard codes
 * would be a grade nobody asked for.
 */
function dnaClause(reg) {
    const r = reg || load();
    return r.dnaProse;
}

/**
 * The identity clause — the constant, carried verbatim on every frame.
 *
 * Written once and repeated, so the set reads as one film rather than
 * twelve pictures (docs/VIDEO-FRAMING.md §Step 4).
 */
function identityClause(reg) {
    const r = reg || load();
    return r.identity;
}

/**
 * Compose ONE frame's exact prompt text.
 *
 * The order is fixed and it is the order the artist used:
 *
 *   prose · camera place · DNA · identity · suffix · style ref · flags
 *
 * The flags come LAST so Midjourney parses them as parameters and not
 * as prose — and `--ar` last of all, the house rule the repo's own
 * composer follows (buildFullPrompt emits `--ar` last because MJ
 * honours the LAST occurrence of a duplicated flag).
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

    // The STYLE REFERENCE, before the flags.
    //
    // It is a flag, not prose, so it goes with the other flags — but
    // the flags still come last, and `--ar` still last of all.
    //
    // `opts.ref === false` drops it, which is what the plain-render
    // path needs: this set renders plain (no `--edit` attachment),
    // because in edit mode the attachment decides the distance and
    // every distance clause is disobeyed (docs/VIDEO-FRAMING.md §4).
    if (opts.ref !== false && reg.styleReference) {
        const flag = reg.styleReferenceFlag || '--sref';
        text += ` ${flag} ${reg.styleReference}`;
    }

    // The artist's own flags, resolved once each.
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
    lines.push(`# ${reg.title} — ${list.length} frames (16:9)`);
    lines.push('');
    lines.push(`> ${reg.subtitle}`);
    lines.push('>');
    lines.push(`> Source: the artist's own storyboard — "${reg.concept}"`);
    lines.push('>');
    lines.push(`> ${reg.figure}`);
    lines.push('>');
    lines.push(`> Visual DNA (appended to every frame): ${reg.visualDna}`);
    lines.push('>');
    lines.push(`> Style reference: \`${reg.styleReference}\` — the artist's own, recovered from the account's feed, carried as \`${reg.styleReferenceFlag}\`.`);
    lines.push(`> Flags: \`${reg.flags}\` — the artist's own, resolved once each.`);
    lines.push('');
    lines.push(`> Act structure: ${acts(reg).map(a => a.title).join(' · ')}`);
    lines.push('');
    for (const f of list) {
        lines.push(`## ${String(f.n).padStart(2, '0')} — ${f.title}`);
        lines.push('');
        lines.push(`> ${f.beat}`);
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
    L.push(`# ${reg.title} — the twelve-frame storyboard`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push('**Concept.** ' + reg.concept);
    L.push('');
    L.push('**Figure.** ' + reg.figure);
    L.push('');
    L.push('**Visual DNA.** ' + reg.visualDna);
    L.push('');
    L.push('**Style reference.** `' + reg.styleReference + '` (as `' + reg.styleReferenceFlag + '`)');
    L.push('');
    L.push('**Flags.** `' + reg.flags + '`');
    L.push('');
    L.push('**Identity clause.** ' + reg.identity);
    L.push('');
    L.push('---');
    L.push('');
    for (const a of acts(reg)) {
        L.push('## ' + a.title);
        L.push('');
        for (const f of actFrames(a.id, reg)) {
            L.push('### ' + String(f.n).padStart(2, '0') + ' — ' + f.title);
            L.push('');
            L.push('> ' + f.beat);
            L.push('');
            L.push(f.prose);
            L.push('');
            L.push('```');
            L.push(buildFrame(f.n, { ...opts, reg }));
            L.push('```');
            L.push('');
        }
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
    acts,
    actFrames,
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
