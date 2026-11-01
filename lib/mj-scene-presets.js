#!/usr/bin/env node
'use strict';
// lib/mj-scene-presets.js
//
// Midjourney SCENE PRESET registry — the loader, the pack builder, the
// cut planner and the reference doc.
//
// WHY A REGISTRY AND NOT A LIST OF PROMPTS
//
// A preset is only useful if it can be re-used, compared and rendered. The
// registry keeps the data in one place (`lib/mj-scene-presets.json`) and
// this module turns it into the three artifacts the repo already knows how
// to consume:
//
//   buildPack()  → a prompt pack in the house format (one bullet per
//                   preset, `--ar` on every bullet) that the MJ watcher
//                   or `lib/mj-web.js` submits unchanged.
//   buildCutPlan()→ the argv that turns the rendered stills into a clip
//                   with `bin/images-to-mp4.mjs`, using the RENDERER's own
//                   vocabulary (lib/render/plan.mjs).
//   renderDoc()  → the human reference.
//
// THE THREE RULES THIS ENCODES
//
// 1. THE CAMERA'S DISTANCE IS NOT IN THE PROMPT.
//
//    Measured 2026-10-26 → 2026-11-01 across three series: a clause
//    naming an OBJECT IN THE FRAME is obeyed ("the door frame passing
//    close across the edges of the frame" landed in all four cells of a
//    job); a clause naming a DISTANCE is not ("wide", "extreme close-up",
//    "seen from behind" did not move the camera, because in edit mode the
//    reference photo's framing wins the distance). So every preset's
//    `frame` clause names what is IN the picture, and the distance is the
//    CUT's business.
//
// 2. NO PRESET CARRIES A FLAG.
//
//    `--v 7` was MEASURED soft-banned on this account (2026-10-26): a job
//    id came back, the job was never queued, the CDN 404'd every size
//    forever. The engine lives in lib/mj-config.json. The style
//    (`--style raw --s 21`) is the house recipe and lives in the config
//    too — and buildFullPrompt drops the config's `--s` when the PROMPT
//    names a style, so a preset naming one would silently reset stylize
//    to Midjourney's default of 100. Reference flags (`--cref`, `--oref`)
//    are REFUSED on this account outright. So the registry carries prose
//    only, and the flags are composed once, from the config.
//
// 3. THE SUBJECT'S IDENTITY IS LEFT TO THE REFERENCE PHOTO.
//
//    The repo's prompt lint (`lib/prompt-lint.js`, docs/PROMPT-LINT.md)
//    forbids naming the subject's race or ethnicity, because the reference
//    photo is authoritative and a demographic adjective overrides it.
//    Every preset describes the SCENE.
//
// Pure Node, no deps, no network.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'mj-scene-presets.json');

// The groups, in the order the doc and the pack present them.
const GROUPS = ['music-video', 'electronic-pop', 'story-video', 'vertical'];

const GROUP_LABELS = {
    'music-video': 'Music-video scene presets',
    'electronic-pop': 'Electronic and pop scene presets',
    'story-video': 'Story-video scene presets',
    'vertical': 'Vertical presets (Reels, TikTok, Shorts)',
};

// The house tail every preset's frame clause carries. It is part of the
// look — the film grain, the muted palette, and the negation that keeps
// lettering out of a frame the layout will put type into anyway.
const HOUSE_TAIL = 'fine natural film grain, muted palette, no text';

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

/**
 * Load and validate the registry.
 * @param {string} [repoRoot]
 * @returns {object} the parsed registry
 */
function loadRegistry(repoRoot = REPO) {
    const file = path.join(repoRoot, 'lib', 'mj-scene-presets.json');
    const raw = fs.readFileSync(file, 'utf8');
    const registry = JSON.parse(raw);
    if (!registry || !Array.isArray(registry.presets) || !registry.presets.length) {
        throw new Error('mj-scene-presets: the registry has no presets');
    }
    const slugs = new Set();
    for (const p of registry.presets) {
        for (const key of ['slug', 'name', 'group', 'bestFor', 'ar', 'prose', 'frame']) {
            if (!p[key]) {
                throw new Error(`mj-scene-presets: preset "${p.slug || '?'}" is missing "${key}"`);
            }
        }
        if (!p.cut || !p.cut.motion) {
            throw new Error(`mj-scene-presets: preset "${p.slug}" has no cut recipe`);
        }
        if (slugs.has(p.slug)) {
            throw new Error(`mj-scene-presets: duplicate slug "${p.slug}"`);
        }
        slugs.add(p.slug);
    }
    return registry;
}

/**
 * The presets of one group (and optionally one aspect ratio), or all of them.
 *
 * The aspect filter is not cosmetic: the renderer takes ONE `--size` for a
 * whole cut, so a cut can only be built from presets that share an aspect
 * ratio. Mixing a 1:1 plate into a 16:9 cut means the renderer scales or
 * crops it, and the frame stops being the frame the prompt asked for.
 *
 * @param {object} registry
 * @param {string} [group]
 * @param {string} [ar]
 */
function selectPresets(registry, group, ar, slugs) {
    let picked = registry.presets.slice();
    if (group) {
        picked = picked.filter((p) => p.group === group);
        if (!picked.length) {
            throw new Error(`mj-scene-presets: no presets in group "${group}" ` +
                `(${GROUPS.join(', ')})`);
        }
    }
    if (ar) {
        picked = picked.filter((p) => p.ar === ar);
        if (!picked.length) {
            throw new Error(`mj-scene-presets: no presets with --ar ${ar}`);
        }
    }
    if (slugs && slugs.length) {
        const want = new Set(slugs);
        picked = picked.filter((p) => want.has(p.slug));
        if (!picked.length) {
            throw new Error(`mj-scene-presets: no presets with the slug(s) ${slugs.join(', ')}`);
        }
    }
    return picked;
}

// ---------------------------------------------------------------------
// Composing one prompt
// ---------------------------------------------------------------------

/**
 * Compose the prompt for one preset.
 *
 * The order is: the SCENE, then the FRAME, then any caller-supplied
 * constant clause (the wardrobe / identity clause that makes a set read
 * as one film), then the house tail, then `--ar` LAST.
 *
 * `--ar` is last because Midjourney resolves a doubled flag by taking the
 * last one, and the repo's own `buildFullPrompt` emits it there too. A
 * preset therefore never carries a flag, and exactly one `--ar` reaches
 * the composer.
 *
 * @param {object} preset
 * @param {object} [opts]
 * @param {string} [opts.ar]        override the preset's aspect ratio
 * @param {string} [opts.extraTail] a constant clause to append (the wardrobe)
 * @param {string} [opts.subject]   the subject's description, prepended
 * @returns {string} the composed prompt
 */
function composePrompt(preset, opts = {}) {
    const parts = [];
    if (opts.subject) parts.push(String(opts.subject).trim());
    // The scene and the frame are two clauses, so they are joined with a
    // comma — Midjourney reads the comma as a beat, and without it the
    // two clauses run together into one sentence ("...on the gear stick
    // the camera low beside the front wheel...").
    parts.push(`${String(preset.prose).trim()}, ${String(preset.frame).trim()}`);
    if (opts.extraTail) parts.push(String(opts.extraTail).trim());
    // The house tail is the LAST thing before the flag, so a caller's
    // `extraTail` sits with the scene and the texture closes the frame.
    if (!parts[parts.length - 1].includes(HOUSE_TAIL)) {
        parts.push(HOUSE_TAIL);
    }
    const ar = opts.ar || preset.ar;
    return `${parts.join(' ').replace(/\s{2,}/g, ' ').trim()} --ar ${ar}`;
}

// ---------------------------------------------------------------------
// The prompt pack
// ---------------------------------------------------------------------

/**
 * Build the prompt pack for a set of presets.
 *
 * The pack follows the house format documented at
 * assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md: one top-level bullet
 * per prompt, `--ar` on every bullet, frontmatter and blockquotes for the
 * reader (the watcher ignores both).
 *
 * The 5–10 soft cap does NOT apply here — that cap keeps a SONG's prompt
 * set varied, and a registry sweep is intentionally exhaustive (the same
 * exception assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md already makes
 * for the style-preset packs). The pack says so in its own header, so a
 * reader does not think it broke the rule.
 *
 * @param {object} registry
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.group]
 * @param {string} [opts.subject]
 * @param {string} [opts.extraTail]
 * @param {string} [opts.ar]       override the aspect for every preset
 * @param {string} [opts.arFilter] keep only the presets with this aspect
 * @param {string[]} [opts.slugs] keep only these presets (by slug)
 * @returns {{markdown: string, prompts: Array<object>}}
 */
function buildPack(registry, opts = {}) {
    const presets = selectPresets(registry, opts.group, opts.arFilter, opts.slugs);
    const title = opts.title || 'Scene Presets';
    const lines = [];
    lines.push('---');
    lines.push(`title: ${title}`);
    lines.push('format: prompt-pack');
    lines.push(`presets: ${presets.length}`);
    lines.push('generated-by: lib/mj-scene-presets.js');
    lines.push('---');
    lines.push('');
    lines.push(`# ${title} — ${presets.length} prompts (16:9)`);
    lines.push('');
    lines.push(`> Generated from \`lib/mj-scene-presets.json\` — the scene-preset registry.`);
    lines.push('>');
    lines.push('> The 5–10 lyric-pack cap does not apply here: a registry sweep is');
    lines.push('> intentionally exhaustive, one prompt per preset. The pack carries no');
    lines.push('> engine, style or reference flag — the config owns those.');
    lines.push('');
    lines.push('> The camera\'s DISTANCE is not in any of these prompts. A clause naming');
    lines.push('> an object in the frame lands; a clause naming a distance does not');
    lines.push('> (measured 2026-10-26 → 2026-11-01). The distance is the cut\'s job —');
    lines.push('> see `node lib/mj-scene-presets.js --cut-plan`.');
    lines.push('');

    const prompts = [];
    for (const p of presets) {
        const composed = composePrompt(p, {
            subject: opts.subject,
            extraTail: opts.extraTail,
            ar: opts.ar,
        });
        prompts.push({ slug: p.slug, name: p.name, text: composed, ar: opts.ar || p.ar });
        lines.push(`- ${composed}`);
    }
    lines.push('');
    return { markdown: lines.join('\n'), prompts };
}

// ---------------------------------------------------------------------
// The cut plan
// ---------------------------------------------------------------------

/**
 * Build the argv that turns the rendered stills into a clip.
 *
 * The motions and looks come from the PRESET, and they are the renderer's
 * own vocabulary — so the plan can be handed straight to
 * `bin/images-to-mp4.mjs`, which validates both.
 *
 * `--grade` carries the look applied ONCE to the joined cut. A per-shot
 * vignette stacks once per shot across a twelve-shot cut; a graded one is
 * one. That is why the grade is a separate field in the registry.
 *
 * @param {object} registry
 * @param {object} [opts]
 * @param {string} [opts.group]     only this group's presets
 * @param {string} [opts.ar]        only this aspect ratio's presets
 * @param {string[]} [opts.slugs]    only these presets (by slug)
 * @param {string} [opts.size]      the output size (default 16:9)
 * @param {string} [opts.mode]      the cut mode (default cut)
 * @param {string} [opts.input]     the input directory of stills
 * @param {string} [opts.out]       the output file
 * @param {string} [opts.grade]     override the grade
 * @returns {object} the plan
 */
function buildCutPlan(registry, opts = {}) {
    const presets = selectPresets(registry, opts.group, opts.ar, opts.slugs);
    const motions = presets.map((p) => p.cut.motion);
    const fx = presets.map((p) => p.cut.fx || 'none');
    const grade = opts.grade
        || presets.map((p) => p.cut.grade).find(Boolean)
        || 'none';
    const mode = opts.mode
        || presets.map((p) => p.cut.mode).find(Boolean)
        || 'cut';
    const size = opts.size || '16:9';
    const each = opts.each || presets.map((p) => p.cut.each).find(Boolean) || 3;

    const argv = [
        'node', 'bin/images-to-mp4.mjs',
        opts.input || 'mj-output/scene-presets',
        '--mode', mode,
        '--size', size,
        '--each', String(each),
        '--motions', motions.join(','),
        '--fx', fx.join(','),
    ];
    if (grade && grade !== 'none') argv.push('--grade', grade);
    if (opts.out) argv.push('--out', opts.out);
    if (opts.loop) argv.push('--loop');
    if (opts.audio) argv.push('--audio', opts.audio);

    return {
        presets: presets.map((p) => p.slug),
        motions,
        fx,
        grade,
        mode,
        size,
        each,
        argv,
        command: argv.join(' '),
    };
}

// ---------------------------------------------------------------------
// The reference doc
// ---------------------------------------------------------------------

/**
 * Render the human reference for the registry.
 * @param {object} registry
 * @returns {string} markdown
 */
function renderDoc(registry) {
    const lines = [];
    lines.push('# MJ scene presets — reference');
    lines.push('');
    lines.push(`${registry.presets.length} reusable scene presets for music videos and short`);
    lines.push('visual stories. Each one is a **scene** (what is in the frame), a **frame**');
    lines.push('(where the camera stands and what it names), and a **cut** (how the renderer');
    lines.push('turns the still into video).');
    lines.push('');
    lines.push('The registry is canonical: `lib/mj-scene-presets.json`. This doc and the');
    lines.push('packs are generated from it — edit the registry, regenerate, do not hand-');
    lines.push('edit a prompt here.');
    lines.push('');
    lines.push('## The three rules');
    lines.push('');
    lines.push('**1. The camera\'s distance is not in the prompt.** Measured across three');
    lines.push('series (2026-10-26 → 2026-11-01): a clause naming an *object in the frame*');
    lines.push('is obeyed — "the door frame passing close across the edges of the frame"');
    lines.push('landed in all four cells of a job — while a clause naming a *distance* is');
    lines.push('not. "Wide", "extreme close-up", "seen from behind" did not move the camera:');
    lines.push('in edit mode the reference photo\'s framing wins the distance. So every');
    lines.push('preset names what is IN the picture, and the distance is the cut\'s job.');
    lines.push('');
    lines.push('**2. No preset carries a flag.** `--v 7` was MEASURED soft-banned on this');
    lines.push('account (2026-10-26): a job id came back, the job was never queued, the CDN');
    lines.push('404\'d every size forever. `--v 8.2` is the account\'s proven engine and lives');
    lines.push('in `lib/mj-config.json`. The house style (`--style raw --s 21`) lives there');
    lines.push('too — and `buildFullPrompt` drops the config\'s `--s` when the PROMPT names');
    lines.push('a style, so a preset naming one would silently reset stylize to 100.');
    lines.push('Reference flags (`--cref`, `--oref`) are refused on this account outright.');
    lines.push('');
    lines.push('**3. The subject\'s identity is left to the reference photo.** A prompt must');
    lines.push('not name the subject\'s race or ethnicity (`lib/prompt-lint.js`), because the');
    lines.push('reference is authoritative and a demographic adjective overrides it.');
    lines.push('');
    lines.push('## Using them');
    lines.push('');
    lines.push('```bash');
    lines.push('# the whole registry as a prompt pack');
    lines.push('node lib/mj-scene-presets.js --pack');
    lines.push('');
    lines.push('# one group (the pack lands in prompts-inbox/, the watcher renders it)');
    lines.push('node lib/mj-scene-presets.js --pack --group vertical');
    lines.push('');
    lines.push('# compose one preset without rendering anything');
    lines.push('node lib/mj-scene-presets.js --show neon-night-drive');
    lines.push('');
    lines.push('# the cut recipe for the rendered stills');
    lines.push('node lib/mj-scene-presets.js --cut-plan --group vertical');
    lines.push('```');
    lines.push('');
    lines.push('### Keeping a set consistent');
    lines.push('');
    lines.push('A set is one look, not twelve pictures. Two things make it so, and they are');
    lines.push('the same two things `docs/VIDEO-FRAMING.md` found:');
    lines.push('');
    lines.push('- **A constant clause, written once and repeated verbatim** in every prompt —');
    lines.push('  the wardrobe, the texture, the negation. In edit mode the attachment');
    lines.push('  out-ranks the prose, so the prose has to lead and deny.');
    lines.push('- **One key light per frame**, named the same way every time.');
    lines.push('');
    lines.push('The `--subject` and `--extra-tail` options carry both:');
    lines.push('');
    lines.push('```bash');
    lines.push('node lib/mj-scene-presets.js --pack \\');
    lines.push('  --subject "a man in a dark coat over a black roll-neck" \\');
    lines.push('  --extra-tail "no denim jacket and no leather jacket and no necklace"');
    lines.push('```');
    lines.push('');

    for (const group of GROUPS) {
        const inGroup = registry.presets.filter((p) => p.group === group);
        if (!inGroup.length) continue;
        lines.push(`## ${GROUP_LABELS[group] || group} (\`${group}\`)`);
        lines.push('');
        lines.push(`${inGroup.length} presets.`);
        lines.push('');
        for (const p of inGroup) {
            lines.push(`### ${p.name}`);
            lines.push('');
            lines.push(`**\`${p.slug}\`** · \`--ar ${p.ar}\``);
            lines.push('');
            lines.push(`*Best for:* ${p.bestFor}`);
            lines.push('');
            lines.push('```text');
            lines.push(composePrompt(p));
            lines.push('```');
            lines.push('');
            lines.push(`*Cut:* ${p.cut.mode}, ${p.cut.motion}, per-shot \`${p.cut.fx}\`, `
                + `whole-cut grade \`${p.cut.grade}\`, ${p.cut.each}s per shot.`);
            lines.push('');
        }
    }

    lines.push('## The cut vocabulary');
    lines.push('');
    lines.push('The cut recipes use the renderer\'s own names, so a plan can be handed');
    lines.push('straight to `bin/images-to-mp4.mjs`:');
    lines.push('');
    lines.push('| | names |');
    lines.push('|---|---|');
    lines.push('| motion | `none`, `zoom-in`, `zoom-out`, `pan-left` |');
    lines.push('| look (`--fx`, per shot) | `grain`, `grain-heavy`, `vignette`, `chroma`, `vhs`, `smear`, `flicker`, `warm`, `cold`, `blur`, `sharpen`, `contrast` |');
    lines.push('| grade (`--grade`, once) | the same names |');
    lines.push('| mode | `cut`, `crossfade`, `kenburns` |');
    lines.push('');
    lines.push('A shot stacks looks with `+` (`grain+chroma`). `--grade` is applied ONCE to');
    lines.push('the joined cut: a per-shot vignette stacks once per shot, a graded one is one.');
    lines.push('');
    lines.push('### A cut is one aspect ratio');
    lines.push('');
    lines.push('The renderer takes ONE `--size` for a whole cut, so a cut can only be built');
    lines.push('from presets that share an aspect ratio — mixing a 1:1 plate into a 16:9');
    lines.push('cut means the renderer scales or crops it, and the frame stops being the');
    lines.push('frame the prompt asked for. `--ar-filter` selects the subset:');
    lines.push('');
    lines.push('```bash');
    lines.push('node lib/mj-scene-presets.js --pack --ar-filter 16:9');
    lines.push('node lib/mj-scene-presets.js --cut-plan --ar-filter 16:9');
    lines.push('```');
    lines.push('');
    lines.push('## A verified run');
    lines.push('');
    lines.push('MEASURED 2026-11-01, on this account, with the live web backend:');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push('| prompts rendered | 4 (3 accepted, 1 soft-banned) |');
    lines.push('| job types | `v8-2_diffusion`, matched by `feed-command` |');
    lines.push('| image size | 1141×640 (16:9), 12 cells written |');
    lines.push('| the cut | 1920×1080, 30 fps, 9.0 s, h264 / yuv420p / bt709 / tv |');
    lines.push('');
    lines.push('The grade and the looks were measured in the ENCODE, not assumed — a still');
    lines.push('and the frame cut from it differ measurably:');
    lines.push('');
    lines.push('| shot | look | measured |');
    lines.push('|---|---|---|');
    lines.push('| 1 | `chroma+grain` | U +0.75 with V −0.01 — the RGB split moved one axis |');
    lines.push('| 2 | `grain` | luma −9.1 against the still |');
    lines.push('| 3 | `warm+grain` | U +2.20 — the warm push, and only the warm shot moved |');
    lines.push('');
    lines.push('| shot | vignette grade | edges vs centre |');
    lines.push('|---|---|---|');
    lines.push('| 1 | `vignette` | 28.22 vs 54.08 |');
    lines.push('| 2 | `vignette` | 22.16 vs 88.90 |');
    lines.push('| 3 | `vignette` | 29.90 vs 45.57 |');
    lines.push('');
    lines.push('### The softban');
    lines.push('');
    lines.push('One of the four prompts was soft-banned: the composer accepted it, the job');
    lines.push('was never queued, and no image exists. The tool reports it and moves on,');
    lines.push('so the other three still shipped.');
    lines.push('');
    lines.push('What soft-bans is NOT: an expired engine. `--v 8.2` is this account\'s');
    lines.push('proven engine and the accepted jobs came back `v8-2_diffusion`. The');
    lines.push('refused prompt was the church interior — a scene of a RELIGIOUS building');
    lines.push('full of coloured bulbs. That is a content trigger, not a parameter one,');
    lines.push('and the house response is to re-word the scene, not to change the flags.');
    lines.push('');
    lines.push('### Choosing one cell per frame');
    lines.push('');
    lines.push('Midjourney returns four cells per prompt and they are four different takes,');
    lines.push('not four renditions. The choice is a real decision, and the rule used here');
    lines.push('is measurable rather than aesthetic: take the cell whose exposure is');
    lines.push('closest to the MEDIAN of the four, and never a blown one (>90 luma).');
    lines.push('');
    lines.push('That picked `0_1`, `0_1`, `0_0` for the three prompts above. The third');
    lines.push('prompt\'s cells ran 65.8 / 93.3 / 100.0 / 98.7 — three of them nearly');
    lines.push('clipped, and the rule took the only one with headroom.');
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

const HELP = `MJ scene presets — the registry, the pack, the cut plan.

Usage:
  node lib/mj-scene-presets.js [options]

Options:
  --pack                 write the prompt pack (default: prompts-inbox/scene-presets.md)
  --out <path>           where --pack writes (default data/scene-presets/scene-presets.md)
  --inbox                write the pack to prompts-inbox/ instead, where the
                         MJ watcher will render it (spends generations)
  --group <name>         only one group: ${GROUPS.join(' | ')}
  --subject <text>       a constant subject clause prepended to every prompt
  --extra-tail <text>    a constant clause appended to every prompt
  --ar <ratio>           override the aspect ratio for every prompt
  --ar-filter <ratio>    keep only the presets with this aspect ratio
                         (a cut is ONE size, so a cut needs one aspect)
  --slug <slug>           keep only this preset (repeatable, comma-separated)
  --show <slug>          print one preset's composed prompt
  --list                 list the presets
  --cut-plan             print the renderer's argv for the presets
  --input <dir>          the stills directory for the cut plan
  --size <size>          the cut's output size (default 16:9)
  --mode <mode>          cut | crossfade | kenburns
  --doc                  write the reference doc
  --help                 show this help`;

function main(argv = process.argv.slice(2)) {
    const has = (f) => argv.includes(f);
    const val = (f, d = null) => {
        const i = argv.indexOf(f);
        return (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : d;
    };
    // --slug is repeatable and also accepts a comma-separated list.
    const slugList = () => {
        const out = [];
        for (let i = 0; i < argv.length; i += 1) {
            if (argv[i] !== '--slug' || !argv[i + 1]) continue;
            for (const s of String(argv[i + 1]).split(',')) {
                const t = s.trim();
                if (t) out.push(t);
            }
        }
        return out;
    };
    if (has('--help') || has('-h')) {
        process.stdout.write(HELP + '\n');
        return 0;
    }

    const registry = loadRegistry(REPO);
    const group = val('--group');

    if (has('--list')) {
        for (const p of registry.presets) {
            const mark = group && p.group !== group ? ' ' : '*';
            process.stdout.write(`${mark} ${p.slug.padEnd(26)} ${p.ar.padEnd(6)} ${p.group.padEnd(14)} ${p.name}\n`);
        }
        return 0;
    }

    if (has('--show')) {
        const slug = val('--show');
        const p = registry.presets.find((x) => x.slug === slug);
        if (!p) {
            process.stderr.write(`mj-scene-presets: no preset "${slug}"\n`);
            return 2;
        }
        process.stdout.write(composePrompt(p, {
            subject: val('--subject'),
            extraTail: val('--extra-tail'),
            ar: val('--ar'),
        }) + '\n');
        return 0;
    }

    if (has('--cut-plan')) {
        const plan = buildCutPlan(registry, {
            group,
            ar: val('--ar-filter'),
            slugs: slugList(),
            size: val('--size'),
            mode: val('--mode'),
            input: val('--input'),
            out: val('--out'),
        });
        process.stdout.write(plan.command + '\n');
        return 0;
    }

    if (has('--doc')) {
        const out = val('--out', path.join(REPO, 'docs', 'MJ-SCENE-PRESETS.md'));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, renderDoc(registry));
        process.stdout.write(`[mj-scene-presets] wrote ${path.relative(REPO, out)}\n`);
        return 0;
    }

    // Default: the pack.
    //
    // NOT prompts-inbox/ by default: that directory is the MJ watcher's
    // drop zone, and a pack that lands there is rendered on sight — 23
    // generations for a file nobody asked to render. `--inbox` is the
    // explicit opt-in, and `--out` always wins.
    const defaultOut = has('--inbox')
        ? path.join(REPO, 'prompts-inbox', 'scene-presets.md')
        : path.join(REPO, 'data', 'scene-presets', 'scene-presets.md');
    const out = val('--out', defaultOut);
    const pack = buildPack(registry, {
        title: 'Scene Presets',
        group,
        subject: val('--subject'),
        extraTail: val('--extra-tail'),
        ar: val('--ar'),
        arFilter: val('--ar-filter'),
        slugs: slugList(),
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pack.markdown);
    process.stdout.write(`[mj-scene-presets] wrote ${pack.prompts.length} prompt(s) to `
        + `${path.relative(REPO, out)}\n`);
    return 0;
}

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}

module.exports = {
    GROUPS,
    GROUP_LABELS,
    HOUSE_TAIL,
    loadRegistry,
    selectPresets,
    composePrompt,
    buildPack,
    buildCutPlan,
    renderDoc,
    main,
};
