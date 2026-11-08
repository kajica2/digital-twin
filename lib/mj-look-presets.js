#!/usr/bin/env node
'use strict';
// lib/mj-look-presets.js
//
// THE LOOK-PRESET REGISTRY — loader, composer, pack builder, doc builder.
//
// WHY THIS IS A SEPARATE THING FROM THE SCENE PRESETS
//
//   `lib/mj-scene-presets.json` holds SCENES: a physical event, a light,
//   a frame. `lib/mj-look-presets.json` holds LOOKS: the era, the stock
//   and the texture of the IMAGE. A scene says WHAT HAPPENS; a look says
//   HOW IT WAS SHOT. They are different objects and they live in
//   different files — mixing them is how a "preset" ends up naming both
//   a subject and a grade.
//
// THE THREE-PART SPLIT, AS THE LOOK PRESETS USE IT
//
//   scene : the SUBJECT — what is in the picture (here: the anchor)
//   look  : the TEXTURE — the stock, the era, the emulsion, the tape
//   cut   : motion, grade, rhythm — the renderer's job, not the prompt's
//
//   A look preset carries the LOOK and nothing else. It never names a
//   distance ("wide", "extreme close-up" — measured to be ignored) and
//   it never carries a flag (Rule 2 of the shot-registry skill: engine,
//   style and reference flags belong to the project's config).
//
// WHY EVERY PROMPT RENDERS THE SAME ANCHOR
//
//   Because the pack is a COMPARISON, not a showcase. If each preset had
//   its own subject, the sheet would show thirty different pictures and
//   you could not tell which differences came from the look. One anchor
//   subject makes every difference attributable to the look.
//
//   The anchor is also deliberately plain — a figure, a chair, a window,
//   bare walls. There is no neon sign for the neon preset to borrow and
//   no wet street for the rain look, so a look cannot be credited for
//   the subject it happened to be handed.
//
// THE COMPOSED PROMPT
//
//   <anchor subject>, <look descriptor>, <suffix> <flags>
//
//   The flags come LAST so Midjourney parses them as parameters and not
//   as prose, and `--ar` is last of all — because Midjourney honours the
//   LAST occurrence of a duplicated flag (the bug class this repo has
//   hit three times).

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'mj-look-presets.json');

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

function load() {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

/** The presets, in registry order. */
function presets(reg) {
    const r = reg || load();
    return (r.presets || []).slice().sort((a, b) => a.n - b.n);
}

/** One preset by its number (1-based) or its slug. */
function preset(n, reg) {
    const list = presets(reg);
    if (typeof n === 'number') return list.find(p => p.n === n) || null;
    return list.find(p => p.slug === n) || null;
}

function bySlug(slug, reg) {
    return preset(slug, reg);
}

/** The distinct families, in first-appearance order. */
function families(reg) {
    const out = [];
    for (const p of presets(reg)) {
        if (!out.includes(p.family)) out.push(p.family);
    }
    return out;
}

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

/**
 * Compose ONE preset's exact prompt text.
 *
 * The order is fixed:
 *
 *   anchor clauses (rotated) · look descriptor · suffix · flags
 *
 * THE ANCHOR IS SHARED, SO THE OPENING IS ROTATED. Every prompt renders
 * the same scene, so a fixed order would open all thirty with the same
 * words — and a shared prefix collapses the acceptance matcher's
 * excerpt, which is how N prompts get attributed to a few task ids
 * (measured 2026-09-24 → 2026-11-05, and again 2026-11-05 on the
 * SWR asset packs).
 *
 * So the anchor's clauses are rotated by the preset's number: each
 * prompt starts with a different element of the same scene. The subject
 * is identical; only the ORDER of the words moves.
 */
function buildPrompt(n, opts = {}) {
    const reg = opts.reg || load();
    const p = typeof n === 'number' ? preset(n, reg) : bySlug(n, reg);
    if (!p) throw new Error(`no such preset: ${n}`);

    const subject = opts.subject || anchorText(p.n, reg);
    const parts = [subject, p.descriptor, reg.suffix].filter(Boolean);
    let text = parts.join(', ');

    // The flags come last, and `--ar` last of all.
    text += ` ${reg.flags}`;
    return text;
}

/**
 * The subject text for ONE preset: its own opening phrase, then any
 * anchor clause the opening did NOT already cover.
 *
 * THE SUBJECT IS SHARED BY ALL THIRTY, SO THE OPENING MUST NOT BE.
 * A fixed clause order was tried first and produced only FOUR distinct
 * openings (the anchor has four clauses) — not enough for thirty
 * prompts, and a shared prefix is what collapses the acceptance
 * matcher's excerpt into one string, which is how N prompts get
 * attributed to a few task ids (measured 2026-09-24 → 2026-11-05).
 *
 * So each preset carries its own short opening — the same scene seen
 * from a different angle — and the anchor clauses follow it ONLY IF the
 * opening left them out.
 *
 * MEASURED 2026-11-05: THE DUPLICATION WAS THE BUG. The first version
 * appended the remaining anchor clauses blindly, so most prompts
 * carried "a wooden chair in the middle of the floor" TWICE — once
 * inside the opening and once as the appended clause. In the first
 * eight submissions, every prompt that carried the duplicate was
 * refused (5 of 8: presets 1, 2, 4, 6, 7) and every prompt that did
 * not was accepted (2 of 8: presets 3, 5). One of the five
 * (preset 7) rendered anyway, so the duplicate is a RISK rather than
 * the sole cause — but the correlation is perfect and the fix is
 * obvious: never say the same thing twice.
 */
function anchorText(n, reg) {
    const r = reg || load();
    const openings = r.openings || [];
    const clauses = r.anchorClauses || [];
    if (!openings.length) {
        // No openings: rotate the clauses as a fallback.
        if (!clauses.length) return r.anchor || '';
        const k = clauses.length;
        const start = (n - 1) % k;
        return clauses.slice(start).concat(clauses.slice(0, start)).join(', ');
    }
    const opening = openings[(n - 1) % openings.length];
    if (!clauses.length) return opening;

    // The opening already carries part of the scene. A clause is
    // appended ONLY IF the opening does not already name what that
    // clause is about.
    //
    // The check is on the clause's own subject words, and it is
    // PER-CLAUSE — the first version extracted every clause's nouns
    // with one shared index and compared them against the opening's
    // text, which compared the WRONG clause's words and let ten
    // prompts still carry a duplicated noun.
    const lower = opening.toLowerCase();
    const extra = clauses.filter((c) => {
        // The content words of this clause: the ones that would be
        // said twice if the clause were appended.
        const words = (c.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
            .filter(w => !['that', 'with', 'from', 'into', 'this', 'they', 'them', 'then', 'than', 'when', 'what', 'only', 'also', 'just', 'over', 'some'].includes(w));
        if (!words.length) return false;
        // If the opening already says ANY of the clause's content
        // words, the clause would repeat something.
        return !words.some(w => lower.includes(w));
    });
    return [opening, ...extra].join(', ');
}

/** Every preset's composed prompt. */
function buildPrompts(opts = {}) {
    const reg = opts.reg || load();
    return presets(reg).map(p => buildPrompt(p.n, { ...opts, reg }));
}

/**
 * Build the house prompt pack: one top-level bullet per preset.
 *
 * The OPENING of each bullet is a distinct short phrase, because the
 * subject is shared and a shared prefix collapses the acceptance
 * matcher's excerpt. Each opening names a different element of the
 * anchor — the man, the window, the chair, the dust, the wall — so the
 * prompts stay comparable (the same scene) while their openings stay
 * distinct.
 */
function buildPack(opts = {}) {
    const reg = opts.reg || load();
    const list = presets(reg);
    const lines = [];
    lines.push(`# ${reg.title} — ${list.length} looks (${reg.ar})`);
    lines.push('');
    lines.push(`> ${reg.subtitle}`);
    lines.push('>');
    lines.push(`> Anchor subject (identical in every prompt, so the sheet compares the looks):`);
    lines.push(`> ${reg.anchor}`);
    lines.push('>');
    lines.push(`> Flags: \`${reg.flags}\` — the house default, resolved once each.`);
    lines.push('>');
    lines.push('> **A registry sweep is intentionally exhaustive** — the 5–10 soft cap');
    lines.push('> that keeps a song\'s prompt set varied does not apply here.');
    lines.push('');
    for (const p of list) {
        lines.push(`## ${String(p.n).padStart(2, '0')} — ${p.name}`);
        lines.push('');
        lines.push(`> ${p.family}`);
        lines.push('');
        lines.push(`- ${buildPrompt(p.n, { ...opts, reg })}`);
        lines.push('');
    }
    return lines.join('\n');
}

/** The human reference. */
function renderDoc(opts = {}) {
    const reg = opts.reg || load();
    const list = presets(reg);
    const L = [];
    L.push(`# ${reg.title}`);
    L.push('');
    L.push(`> ${reg.subtitle}`);
    L.push('');
    L.push(`**Anchor subject.** ${reg.anchor}`);
    L.push('');
    L.push('**Why one subject.** Every look renders the same scene, so any');
    L.push('difference between two cells is the look\'s doing. The subject is');
    L.push('deliberately plain — no neon sign for the neon preset to borrow,');
    L.push('no wet street for the rain look — so a look cannot be credited for');
    L.push('the scene it happened to be handed.');
    L.push('');
    L.push('Each prompt opens with its own short phrase for the same scene,');
    L.push('because a shared prefix collapses the acceptance matcher\'s excerpt');
    L.push('and N prompts get attributed to a few task ids.');
    L.push('');
    L.push(`**Flags.** \`${reg.flags}\``);
    L.push('');
    L.push('**Suffix.** ' + reg.suffix);
    L.push('');
    L.push('**The rendered set.** All thirty were rendered from the same anchor subject, so');
    L.push('any difference between two frames is the LOOK\'s doing. The comparison sheet is');
    L.push('`mj-output/mj-look-presets-sheet/look-sheet-30up.png` — one chosen cell per look,');
    L.push('captioned with the look\'s name, its group, the cell and its measured luma.');
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The looks');
    L.push('');
    L.push('| # | look | family |');
    L.push('|---|------|--------|');
    for (const p of list) {
        L.push(`| ${String(p.n).padStart(2, '0')} | ${p.name} | ${p.family} |`);
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('## The prompts');
    L.push('');
    for (const p of list) {
        L.push(`### ${String(p.n).padStart(2, '0')} — ${p.name}`);
        L.push('');
        L.push(`*${p.family}*`);
        L.push('');
        L.push(p.descriptor);
        L.push('');
        L.push('```');
        L.push(buildPrompt(p.n, { ...opts, reg }));
        L.push('```');
        L.push('');
        if (p.cell) {
            const luma = typeof p.cellLuma === 'number' ? ` · luma ${p.cellLuma.toFixed(1)}` : '';
            L.push(`**Picked cell.** \`${p.cell}\`${luma}`);
            L.push('');
            if (p.allCellsBlown) {
                L.push('> **Every cell is blown.** The measurement screen found no cell under the');
                L.push('> 90-luma ceiling, so the sheet shows the LEAST-blown one. For this look');
                L.push('> an overexposed frame IS the look — the medium is meant to be hot.');
                L.push('');
            }
        }
    }
    return L.join('\n');
}

module.exports = {
    REPO,
    REGISTRY_PATH,
    load,
    presets,
    preset,
    bySlug,
    families,
    anchorText,
    buildPrompt,
    buildPrompts,
    buildPack,
    renderDoc,
};

if (require.main === module) {
    // A CLI THAT CRASHES WHEN ITS OUTPUT IS PIPED is a CLI nobody can
    // use with `| head`. MEASURED 2026-11-06: `--list | head -3`
    // raised an unhandled EPIPE and printed a stack trace.
    //
    // EPIPE is the normal end of a pipe, not an error worth a stack.
    process.stdout.on('error', (e) => {
        if (e && e.code === 'EPIPE') process.exit(0);
        throw e;
    });

    // The CLI accepts BOTH shapes, because the repo's sibling tools use
    // the flag form (`--list`, `--pack`) and a positional form is
    // easier to type. `npm run look-presets:pack` passes the flag.
    const argv = process.argv.slice(2);
    const has = (name) => argv.includes(`--${name}`);
    const flags = argv.filter(a => a.startsWith('--') && !a.includes('='));
    const positional = argv.filter(a => !a.startsWith('--'));
    const cmd = flags[0] ? flags[0].replace(/^--/, '') : (positional[0] || 'pack');
    const reg = load();

    // `--show` takes a SLUG or a NUMBER. The slug is the registry's own
    // handle; the number is the registry's order (and what the sheet is
    // captioned with). Both work because the artist thinks in names and
    // the sheet thinks in numbers.
    const pickBy = (token) => {
        if (token === undefined) return null;
        const byNum = presets(reg).find(p => String(p.n) === String(token));
        if (byNum) return byNum;
        // `bySlug(slug, reg)` — the slug comes FIRST.
        return bySlug(token, reg) || null;
    };

    if (cmd === 'pack') {
        // The pack goes to a BUILD DIRECTORY by default, never the
        // watcher's inbox — a pack in the inbox is rendered on sight,
        // which is thirty generations for a file nobody asked to render.
        // `--inbox` is the explicit opt-in.
        if (has('inbox')) {
            const dir = path.join(REPO, 'prompts-inbox');
            fs.mkdirSync(dir, { recursive: true });
            const out = path.join(dir, 'mj-look-presets.md');
            fs.writeFileSync(out, buildPack({ reg }) + '\n');
            process.stdout.write(`${out}\n`);
        } else {
            process.stdout.write(buildPack({ reg }) + '\n');
        }
    } else if (cmd === 'doc') {
        process.stdout.write(renderDoc({ reg }) + '\n');
    } else if (cmd === 'list') {
        for (const p of presets(reg)) {
            process.stdout.write(`${String(p.n).padStart(2, '0')}  ${p.slug}  ${p.name}\n`);
        }
    } else if (cmd === 'show' || cmd === 'prompt') {
        const p = pickBy(positional[0]);
        if (!p) {
            process.stderr.write(`no such look: ${positional[0] || '(nothing given)'}\n`);
            process.stderr.write('usage: --show <slug|n> [--no-stock] [--verbatim]\n');
            process.exit(2);
        }
        // THE TWO PROJECTIONS OF A STOCK.
        //
        // MEASURED 2026-11-05: a prose naming a film stock came back
        // with a black film-strip border and stock lettering down one
        // edge, on four of seven shots. The stock is the most evocative
        // word in a look and the most likely to summon a film-strip
        // graphic — so it is kept as data and projected two ways:
        //
        //   --verbatim  the artist's own descriptor, unchanged
        //   --no-stock  the colour consequence WITHOUT the stock noun
        //               (safe to paste into a scene)
        //
        // The default is the stock-free projection, because that is the
        // one safe to paste anywhere.
        if (has('verbatim')) {
            process.stdout.write(`${p.descriptor}\n`);
        } else if (has('no-stock')) {
            process.stdout.write(`${p.styleScene || p.descriptor}\n`);
        } else {
            process.stdout.write(buildPrompt(p.n, { reg }) + '\n');
        }
    } else if (cmd === 'cut-plan') {
        // A CUT IS ONE ASPECT RATIO. The renderer takes one --size for a
        // whole cut, and the looks carry their NATIVE ratios (21:9 for
        // the anamorphic ones, 4:3 for the video ones, 1:1 for the
        // instant one) — because the frame shape is part of what the
        // medium IS.
        //
        // So a plan spanning several ratios is REFUSED rather than
        // silently scaled. A usage error is a usage error: one line,
        // exit 2 — never a stack trace.
        //
        // ONE FLAG, ONE MEANING: `--ar-filter` selects which looks may
        // share a cut; the pack's own `--ar` overrides a look's ratio
        // for a look plate. They never collide.
        const arFilter = (argv.find(a => a.startsWith('--ar-filter=')) || '').split('=')[1]
            || positional[0] || null;
        const chosen = arFilter
            ? presets(reg).filter(p => p.ar === arFilter)
            : presets(reg);
        if (!chosen.length) {
            const ratios = [...new Set(presets(reg).map(p => p.ar))].sort();
            process.stderr.write(`no look has the ratio ${arFilter} (the registry carries: ${ratios.join(', ')})\n`);
            process.exit(2);
        }
        if (!arFilter) {
            const ratios = [...new Set(chosen.map(p => p.ar))].sort();
            if (ratios.length > 1) {
                process.stderr.write(`a cut is ONE aspect ratio, and these looks carry ${ratios.length}: ${ratios.join(', ')}\n`);
                process.stderr.write('pick one: --ar-filter 16:9 (or 4:3, 21:9, 1:1)\n');
                process.exit(2);
            }
        }
        const plan = {
            ratio: chosen[0].ar,
            looks: chosen.map(p => ({
                n: p.n, slug: p.slug, name: p.name, ar: p.ar,
                cut: p.cut,
            })),
        };
        process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    } else {
        process.stderr.write('usage: --pack [--inbox] | --doc | --list | --show <slug|n> [--no-stock|--verbatim] | --cut-plan [--ar-filter 16:9]\n');
        process.exit(2);
    }
}
