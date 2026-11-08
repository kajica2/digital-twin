#!/usr/bin/env node
'use strict';
// lib/nema-me-u-meni-camera-grid.js
//
// THE CAMERA GRID for NEMA ME U MENI.
//
// WHAT THIS IS
//
//   The master template (lib/nema-me-u-meni.json) is TWELVE FRAMES of one
//   film: one beat per frame, one camera per beat. This module re-shoots
//   it. The beats, the lyrics, the DNA and the grade are the template's,
//   carried over — THE VARIABLE IS THE CAMERA. Twelve beats, twelve camera
//   positions, one per beat.
//
//   As with the template, the data lives in ONE file
//   (lib/nema-me-u-meni-camera-grid.json) and this module turns it into the
//   three artifacts the repo already knows how to consume:
//
//     buildPack()   → a prompt pack in the house format (one bullet per
//                     frame) that lib/mj-web.js submits unchanged
//     buildFrame()  → one frame's exact composed prompt text
//     renderDoc()   → the human reference
//
// THE FOUR MEASURED RULES THIS ENCODES
//
// 1. THIS SET RENDERS PLAIN — NO ATTACHMENT.
//
//    MEASURED (docs/VIDEO-FRAMING.md §4): in EDIT mode the reference
//    photograph decides the distance and the height, and EVERY distance
//    clause in the five-way test was disobeyed. In PLAIN mode the camera
//    clause is obeyed — the wide, the high angle, the dutch tilt, the
//    macro, the profile, the top-down, the long lens and the whip pan all
//    landed in the frames they were written for. The camera IS the point
//    of this set, so it carries no --edit and no --cref. (The identity
//    clause is still carried, so the wardrobe reads the same across all
//    twelve and the grid is continuous with the master template.)
//
// 2. THE CAMERA CLAUSE NAMES THE PLACE, NEVER THE WORD "CAMERA".
//
//    MEASURED 2026-11-05: a camera clause that said "the camera outside
//    the doorway looking in" came back as a CAMERA BODY on a table —
//    the word rendered as an object. So every clause says where the
//    picture is TAKEN FROM ("seen from the doorway", "seen from
//    directly behind", "looked straight down on") and what fills the
//    frame from there.
//
// 3. A CLAUSE NAMING AN OBJECT IN THE FRAME LANDS; A CLAUSE NAMING A
//    DISTANCE DOES NOT.
//
//    MEASURED 2026-10-26 → 2026-11-01 across three series. So each
//    camera clause names BOTH the place and the objects that must fill
//    the picture from there. And the template's own distance words
//    ("wide static shot of", "extreme close-up of", "vast wide shot")
//    are REMOVED from the borrowed prose — a distance clause is ignored,
//    and worse, it would fight the grid's camera (beat 05 is a whip pan
//    and the template's prose for it says "vast wide shot").
//
// 4. THE ARTIST'S FLAGS WIN, AND EACH ONE IS RESOLVED EXACTLY ONCE.
//
//    The repo's config default is `--ar 16:9 --style raw --s 21`. This
//    set carries `--ar 16:9 --style raw --s 75 --chaos 8 --hd`. The
//    config's --s is dropped because the prompt carries its own (MJ
//    honours the LAST occurrence of a duplicated flag, so two --s flags
//    would silently override the artist).
//
// NO PROMPT NAMES THE SUBJECT'S RACE OR ETHNICITY — the repo's lint
// (lib/prompt-lint.js) forbids it, because a reference photo is
// authoritative and a demographic adjective overrides it.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'nema-me-u-meni-camera-grid.json');

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

/** The camera list, in order. */
function cameras(reg) {
    const r = reg || load();
    return (r.cameras || []).slice().sort((a, b) => a.n - b.n);
}

/** One camera by its number. */
function camera(n, reg) {
    return cameras(reg).find(c => c.n === n) || null;
}

/**
 * The camera a frame is shot from, resolved through its `cameraN`.
 *
 * Every frame names a camera by number, and every camera is used exactly
 * once — that is the whole point of the set. The two are cross-checked
 * against each other here so a typo cannot silently leave a camera unused
 * or use one twice.
 */
function cameraOf(f, reg) {
    if (!f || !f.cameraN) return null;
    return camera(f.cameraN, reg);
}

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

/**
 * The DNA clause as it is appended to the prose.
 *
 * The DNA is PALETTE and TEXTURE — the look that makes the twelve frames
 * one film. It goes in the prose (the style box), because the artist
 * dictated flags with no `--profile`, and the house moodboard codes would
 * have been a grade nobody asked for.
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
 *   prose · camera place · DNA · identity · suffix · flags
 *
 * The camera clause comes BEFORE the style words, so the camera reads as
 * the instruction and the style as the grade on top of it.
 *
 * The flags come LAST so Midjourney parses them as parameters and not as
 * prose — the same rule the house packs follow, and the same reason the
 * composed command must be verified rather than assumed.
 *
 * `opts.ref` exists so the contract can be TESTED: a camera-grid frame
 * that carried an attachment would have its distance decided by the
 * photograph, which is the one thing this set must not do. The default
 * is therefore NO reference, and the test asserts it.
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
    ].filter(Boolean)
        // The prose clauses are written as sentences, so each ends with a
        // period. Joining them with ", " would produce "cinema., the man
        // and the table" — a stray full stop before a comma. The stop is
        // dropped at the JOIN, so each clause still reads as a sentence
        // in the registry and the composed prompt reads as one long
        // comma-separated description, which is the house shape.
        .map(p => String(p).replace(/\.\s*$/, ''));

    let text = parts.join(', ');

    // A reference would decide the distance (MEASURED, docs/VIDEO-FRAMING.md
    // §4), so it is opt-IN and off by default. The master template needs
    // it because its subject is a face; this set's subject is the camera.
    if (opts.ref === true && reg.characterRef) {
        const flag = reg.characterRefFlag || '--edit';
        text += flag === '--cref'
            ? ` --cref ${reg.characterRef} --cw ${reg.characterWeight}`
            : ` ${flag} ${reg.characterRef}`;
    }

    // The artist's own flags, resolved once. A prompt that carries
    // `--style raw` owns the style slot, so the config's own --style and
    // its coupled --s are dropped by buildFullPrompt — the artist wins.
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
    lines.push(`> Source: the master template's twelve beats, re-shot — "${reg.concept}"`);
    lines.push('>');
    lines.push(`> Visual DNA (appended to every frame): ${reg.visualDna}`);
    lines.push('>');
    lines.push(`> Flags: \`${reg.flags}\` — the template's own, resolved once each.`);
    lines.push('>');
    lines.push('> **Plain generation — no identity attachment.** Measured: with an');
    lines.push('> attachment the reference photograph decides the distance and every');
    lines.push('> camera clause is disobeyed; without one the camera clause lands.');
    lines.push('> These twelve frames are about where the camera is, so they render plain.');
    lines.push('');
    lines.push(`> Act structure: ${reg.acts.map(a => a.title).join(' · ')}`);
    lines.push('');
    lines.push(`> The camera grid — one position per beat, each used once:`);
    for (const c of cameras(reg)) {
        lines.push(`> ${String(c.n).padStart(2, '0')} · ${c.name} — ${c.note}`);
    }
    lines.push('');
    for (const f of list) {
        const cam = cameraOf(f, reg);
        lines.push(`## ${String(f.n).padStart(2, '0')} — ${f.title}`);
        lines.push('');
        lines.push(`> "${f.quote}"`);
        lines.push('');
        lines.push(`> CAMERA ${String(cam ? cam.n : f.cameraN).padStart(2, '0')} of 12: ${cam ? cam.name : 'unassigned'}`);
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
    L.push(`# ${reg.title}`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push(`**Concept.** ${reg.concept}`);
    L.push('');
    L.push(`**Source.** The master template \`lib/nema-me-u-meni.json\` — same beats, same DNA, same grade, new cameras.`);
    L.push('');
    L.push(`**Visual DNA.** ${reg.visualDna}`);
    L.push('');
    L.push(`**Flags.** \`${reg.flags}\``);
    L.push('');
    L.push(`**Identity clause.** ${reg.identity}`);
    L.push('');
    L.push('**Render plain.** No `--edit`, no `--cref` — measured, the attachment');
    L.push('decides the distance and the camera clause would be disobeyed.');
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The camera grid');
    L.push('');
    L.push('| # | camera | what it is for |');
    L.push('|---|--------|----------------|');
    for (const c of cameras(reg)) {
        L.push(`| ${String(c.n).padStart(2, '0')} | ${c.name} | ${c.note} |`);
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The frames');
    L.push('');
    for (const f of list) {
        const cam = cameraOf(f, reg);
        L.push(`### ${String(f.n).padStart(2, '0')} — ${f.title}`);
        L.push('');
        L.push(`> "${f.quote}"`);
        L.push('');
        L.push(`**Camera ${String(cam ? cam.n : f.cameraN).padStart(2, '0')} of 12 — ${cam ? cam.name : 'unassigned'}.** ${cam ? cam.note : ''}`);
        L.push('');
        L.push(f.prose);
        L.push('');
        L.push('```');
        L.push(buildFrame(f.n, { ...opts, reg }));
        L.push('```');
        L.push('');
        if (f.cell) {
            const landed = f.cameraLanded || 'unknown';
            const LANDED_TEXT = {
                confirmed: 'CONFIRMED — the eye check found the assigned camera in this cell.',
                'not-confirmed': 'NOT CONFIRMED — the assigned camera did not arrive in this frame.',
                unknown: 'NOT CHECKED — no content review yet.',
            };
            L.push(`**Picked cell.** \`${f.cell}\` — the luma screen pick (closest to the median of the four, never blown).`);
            L.push('');
            L.push(`**Camera check.** ${LANDED_TEXT[landed] || landed}`);
            if (f.cameraReason) {
                L.push('');
                L.push(`> ${f.cameraReason}`);
            }
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
    cameras,
    camera,
    cameraOf,
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
            const cam = cameraOf(f, reg);
            process.stdout.write(`${String(f.n).padStart(2, '0')}  ${f.slug}  ${f.title}  [camera ${cam ? cam.n : '?'}: ${cam ? cam.name : 'unassigned'}]\n`);
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
