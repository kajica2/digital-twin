#!/usr/bin/env node
'use strict';
// lib/nema-me-u-meni.js
//
// The NEMA ME U MENI template — loader, composer, pack builder and
// reference doc.
//
// WHY A REGISTRY AND NOT A LIST OF PROMPTS
//
//   The template is TWELVE frames of one film. The DNA, the identity
//   clause, the character reference and the flags are constant across
//   all twelve, and the prose is what changes. A hand-maintained list of
//   twelve prompts would have twelve chances to drift from the DNA and
//   twelve chances to pick up a stray flag. So the data lives in ONE
//   file (`lib/nema-me-u-meni.json`) and this module turns it into the
//   three artifacts the repo already knows how to consume:
//
//     buildPack()   → a prompt pack in the house format (one bullet per
//                     frame) that lib/mj-web.js submits unchanged
//     buildFrame()  → one frame's exact composed prompt text
//     renderDoc()   → the human reference
//
// THE FOUR MEASURED RULES THIS ENCODES
//
// 1. THE CAMERA'S DISTANCE IS NOT IN THE PROMPT.
//
//    Measured 2026-10-26 → 2026-11-01 across three series: a clause
//    naming an OBJECT IN THE FRAME is obeyed ("the door frame passing
//    close across the edges of the frame" landed in all four cells of a
//    job); a clause naming a DISTANCE is not ("wide", "extreme
//    close-up", "seen from behind" did not move the camera). The
//    artist's own frame 02 therefore keeps "Extreme close-up" — it is
//    THEIR word, and the frame's own strength is the objects in the
//    foreground filling the picture. The pack adds the camera's PLACE
//    as a separate clause, which is what does land.
//
// 2. THE ARTIST'S FLAGS WIN, AND EACH ONE IS RESOLVED EXACTLY ONCE.
//
//    The repo's config default is `--ar 16:9 --style raw --s 21`. The
//    artist's own flags are `--ar 16:9 --style raw --s 75 --chaos 8`.
//    buildFullPrompt (lib/mj-submitter.js) drops the config's `--s`
//    when the prompt carries its own, so `--s 75` survives verbatim and
//    the config's 21 never appears. VERIFIED in the composed command.
//
// 3. THE CHARACTER REFERENCE IS THE ARTIST'S, AND THE PROSE DENIES WHAT
//    IT WEARS.
//
//    MEASURED 2026-11-04 on the account's own feed: the "trained
//    character reference" is `https://s.mj.run/7ZJU0zgoKBc` — a man in
//    a RED coat on snowy railway tracks, submitted by the studio-test
//    job 2c2fd76c as `--cref ... --cw 100`. No frame in this template
//    wants a red coat, so the identity clause denies it — the same
//    mechanism the house clause uses for the denim and leather jackets
//    (docs/VIDEO-FRAMING.md §Step 4). In edit mode the attachment
//    out-ranks the prose, so the prose has to lead and deny.
//
// 4. NO PROMPT NAMES THE SUBJECT'S RACE OR ETHNICITY.
//
//    The repo's prompt lint (lib/prompt-lint.js) forbids it, because a
//    reference photo is authoritative and a demographic adjective
//    overrides it. Every frame here describes the SCENE.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'nema-me-u-meni.json');

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

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

/**
 * The camera's PLACE — what the prompt adds to the artist's prose.
 *
 * A distance clause is measured to be ignored; a clause naming what is
 * IN the picture lands. So each frame's place names the objects that
 * must fill the frame and where the camera sits, never a shot size.
 */
const CAMERA_PLACE = {
    1: 'the man small in the lower third of the frame, the empty wall filling the rest, the camera static and square to the room',
    2: 'the cup and the telephone filling most of the foreground, the hand and the blurred figure behind them, the camera down at the level of the tabletop',
    3: 'the man small beyond the three doorways, the door frames passing close across the edges of the picture, the camera square on at the height of the bed',
    4: 'the lit window filling the frame, the camera on the pavement looking up at it',
    5: 'the man small and near the middle, the pedestrians stretching past him, the camera at street level',
    6: 'the reflection filling the glass, the camera square on to the shop window',
    7: 'the signal and the wet asphalt in the foreground, the man off-centre behind an out-of-focus pole, the camera low at the kerb',
    8: 'the unopened packet and the untouched glass in his fingers, the café and the passers-by soft behind him, the camera at the height of the table',
    9: 'the lamp and his hands and half his face, the rest of the room lost to black, the camera down at the level of the floor',
    10: 'the flugelhorn on the chair filling the foreground, the man small in the doorway behind it, the camera low beside the chair',
    11: 'the instrument bell almost gone into shadow, the man seen from behind, the camera low and slightly to the side',
    12: 'the man small near the edge, the rooftops and the vast gray sky filling the rest, the camera at the height of the roof',
};

/**
 * The DNA clause as it is appended to the prose.
 *
 * The DNA is PALETTE and TEXTURE — the look that makes the twelve
 * frames one film. It goes in the prose (the style box), because the
 * artist dictated flags with no `--profile`, and the house moodboard
 * codes would have been a grade nobody asked for.
 */
function dnaClause(reg) {
    const r = reg || load();
    return r.dnaProse;
}

/**
 * The identity clause — the constant, carried verbatim on every frame.
 *
 * Written once and repeated, so the set reads as one film rather than
 * twelve pictures (docs/VIDEO-FRAMING.md §Step 4). It denies what the
 * CHARACTER REFERENCE wears, because in edit mode the attachment
 * out-ranks the prose.
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
 * The flags come LAST so Midjourney parses them as parameters and not
 * as prose — the same rule the house packs follow, and the same reason
 * the composed command must be verified rather than assumed.
 */
function buildFrame(n, opts = {}) {
    const reg = opts.reg || load();
    const f = typeof n === 'number' ? frame(n, reg) : bySlug(n, reg);
    if (!f) throw new Error(`no such frame: ${n}`);

    const parts = [
        f.prose,
        CAMERA_PLACE[f.n],
        dnaClause(reg),
        identityClause(reg),
        reg.suffix,
    ].filter(Boolean);

    let text = parts.join(', ');

    // The character reference comes BEFORE the flags. The order matters:
    // the flags go last so Midjourney parses them as parameters, and
    // `--ar` last of all — the house rule the repo's own composer follows
    // (buildFullPrompt emits `--ar` last because Midjourney honours the
    // LAST occurrence of a duplicated flag).
    //
    // WHICH FLAG carries it is MEASURED, not assumed: this account's
    // composer refuses `--cref` (the identical prompt was refused with
    // it — with and without `--cw` — and accepted without it), and
    // accepts `--edit`. So the reference rides as `--edit` here.
    if (opts.ref !== false) {
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
    lines.push(`> Source: the artist's master template — "${reg.concept}"`);
    lines.push('>');
    lines.push(`> ${reg.figure}`);
    lines.push('>');
    lines.push(`> Visual DNA (appended to every frame): ${reg.visualDna}`);
    lines.push('>');
    lines.push(`> Character reference: the artist's trained reference, carried verbatim as ${reg.characterRefFlag}.`);
    lines.push(`> Flags: \`${reg.flags}\` — the artist's own, resolved once each.`);
    lines.push('');
    lines.push(`> Act structure: ${reg.acts.map(a => a.title).join(' · ')}`);
    lines.push('');
    for (const f of list) {
        lines.push(`## ${String(f.n).padStart(2, '0')} — ${f.title}`);
        lines.push('');
        lines.push(`> "${f.quote}"`);
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
    L.push(`# ${reg.title} — the master prompt template`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push(`**Concept.** ${reg.concept}`);
    L.push('');
    L.push(`**Figure.** ${reg.figure}`);
    L.push('');
    L.push(`**Visual DNA.** ${reg.visualDna}`);
    L.push('');
    L.push(`**Flags.** \`${reg.flags}\``);
    L.push('');
    L.push(`**Character reference.** \`${reg.characterRef}\` (as \`${reg.characterRefFlag}\`)`);
    L.push('');
    L.push(`**Identity clause.** ${reg.identity}`);
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The frames');
    L.push('');
    for (const f of list) {
        L.push(`### ${String(f.n).padStart(2, '0')} — ${f.title}`);
        L.push('');
        L.push(`> "${f.quote}"`);
        L.push('');
        L.push(f.prose);
        L.push('');
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
    CAMERA_PLACE,
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
