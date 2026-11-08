#!/usr/bin/env node
'use strict';
// tools/augment-look-registry.js
//
// ADD THE FIELDS THE CUT TOOLING NEEDS: the native ratio and the cut
// recipe per look.
//
// WHY: the registry's first form carried only `descriptor` / `family` /
// `tags` — enough to compose a prompt, not enough to PLAN A CUT. The
// repo's renderer takes one `--size` for a whole cut, and a look's
// NATIVE ratio is part of what the medium IS: an anamorphic 35mm look
// is 21:9, a broadcast tape is 4:3, an instant photo is 1:1.
//
// So the ratio and the cut recipe are added here, per look, from the
// medium's own description.
//
// THE CUT RECIPE is the renderer's vocabulary, not prose: `motion`,
// `fx`, `grade`, `mode` and `each`. Those names must exist in the
// renderer, so they are asserted against the renderer's own table by
// `lib/mj-look-presets.test.js`.
//
// Usage: node tools/augment-look-registry.js
// Exit: 0 augmented · 2 bad input

const fs = require('node:fs');
const path = require('node:path');

const REG = path.resolve(__dirname, '../lib/mj-look-presets.json');
if (!fs.existsSync(REG)) { process.stderr.write('no registry\n'); process.exit(2); }

// The native ratio per look — the frame shape is part of the medium.
const NATIVE_AR = {
    'analog-noir-1970s': '21:9',
    'vhs-glitch-noir-1980s': '4:3',
    'bw-16mm-grunge-1990s': '16:9',
    'french-new-wave-1960s': '16:9',
    'italian-giallo-1970s': '16:9',
    'neon-noir-1980s': '21:9',
    'dogme-95': '16:9',
    'digital-lofi-2000s': '4:3',
    'british-kitchen-sink-1960s': '16:9',
    'american-new-hollywood-1970s': '21:9',
    'soviet-post-punk-1980s': '16:9',
    'super-8-memory': '16:9',
    'betacam-newsraw': '4:3',
    'minidv-y2k': '4:3',
    'cctv-surveillance': '4:3',
    'thermal-infrared': '16:9',
    'bleach-bypass-war': '16:9',
    'cross-process-crush': '16:9',
    'expired-polaroid': '1:1',
    'technicolor-melodrama': '16:9',
    'film-noir-1940s': '16:9',
    'german-expressionist': '16:9',
    'brutalist-concrete': '16:9',
    'desert-mirage': '21:9',
    'rain-soaked-city': '21:9',
    'warehouse-rave': '16:9',
    'rooftop-dawn': '21:9',
    'club-toilet-realism': '16:9',
    'pastoral-overcast': '16:9',
    'tape-loop-feedback': '4:3',
};

// The cut recipe per look — the RENDERER'S vocabulary, chosen to match
// the medium's own character.
//
// THE NAMES ARE THE RENDERER'S OWN. lib/render/plan.mjs exports:
//   KEN_BURNS_MODES = none, zoom-in, zoom-out, pan-left
//   FX               = grain, grain-heavy, vignette, chroma, vhs, smear,
//                      flicker, warm, cold, blur, sharpen, contrast
//   TRANSITIONS      = none, crossfade
//
// An invented effect name is a CRASH AT RENDER TIME, not a warning — so
// these are read off the renderer's own table, and
// lib/mj-look-presets.test.js asserts every name against it.
const CUTS = {
    'analog-noir-1970s': { motion: 'zoom-in', fx: 'grain+vignette', grade: 'warm+vignette', transition: 'crossfade', each: 3 },
    'vhs-glitch-noir-1980s': { motion: 'zoom-in', fx: 'vhs+chroma', grade: 'vhs+flicker', transition: 'crossfade', each: 3 },
    'bw-16mm-grunge-1990s': { motion: 'zoom-in', fx: 'grain-heavy+contrast', grade: 'contrast+grain', transition: 'none', each: 3 },
    'french-new-wave-1960s': { motion: 'zoom-out', fx: 'grain', grade: 'contrast', transition: 'none', each: 2 },
    'italian-giallo-1970s': { motion: 'zoom-in', fx: 'chroma+grain', grade: 'contrast+warm', transition: 'crossfade', each: 3 },
    'neon-noir-1980s': { motion: 'zoom-in', fx: 'chroma+grain', grade: 'cold+contrast', transition: 'crossfade', each: 3 },
    'dogme-95': { motion: 'zoom-out', fx: 'grain', grade: 'none', transition: 'none', each: 4 },
    'digital-lofi-2000s': { motion: 'zoom-in', fx: 'smear+grain', grade: 'none', transition: 'none', each: 2 },
    'british-kitchen-sink-1960s': { motion: 'zoom-out', fx: 'grain', grade: 'contrast', transition: 'none', each: 4 },
    'american-new-hollywood-1970s': { motion: 'zoom-in', fx: 'grain+vignette', grade: 'warm', transition: 'crossfade', each: 4 },
    'soviet-post-punk-1980s': { motion: 'none', fx: 'grain-heavy', grade: 'cold', transition: 'none', each: 5 },
    'super-8-memory': { motion: 'zoom-in', fx: 'grain-heavy+vignette', grade: 'warm+flicker', transition: 'crossfade', each: 4 },
    'betacam-newsraw': { motion: 'zoom-in', fx: 'chroma+grain', grade: 'contrast', transition: 'none', each: 3 },
    'minidv-y2k': { motion: 'zoom-in', fx: 'sharpen+grain', grade: 'none', transition: 'none', each: 2 },
    'cctv-surveillance': { motion: 'none', fx: 'grain-heavy+vignette', grade: 'contrast', transition: 'none', each: 5 },
    'thermal-infrared': { motion: 'none', fx: 'grain-heavy', grade: 'contrast', transition: 'none', each: 5 },
    'bleach-bypass-war': { motion: 'zoom-in', fx: 'grain-heavy+contrast', grade: 'contrast', transition: 'crossfade', each: 3 },
    'cross-process-crush': { motion: 'zoom-in', fx: 'chroma+flicker', grade: 'contrast', transition: 'crossfade', each: 3 },
    'expired-polaroid': { motion: 'none', fx: 'grain-heavy+vignette', grade: 'warm', transition: 'none', each: 4 },
    'technicolor-melodrama': { motion: 'zoom-in', fx: 'vignette+grain', grade: 'warm+contrast', transition: 'crossfade', each: 4 },
    'film-noir-1940s': { motion: 'zoom-in', fx: 'grain+vignette', grade: 'contrast', transition: 'crossfade', each: 3 },
    'german-expressionist': { motion: 'zoom-in', fx: 'grain-heavy+contrast', grade: 'contrast', transition: 'none', each: 3 },
    'brutalist-concrete': { motion: 'none', fx: 'grain', grade: 'cold', transition: 'none', each: 5 },
    'desert-mirage': { motion: 'pan-left', fx: 'blur+grain', grade: 'warm', transition: 'crossfade', each: 5 },
    'rain-soaked-city': { motion: 'pan-left', fx: 'chroma+grain', grade: 'cold', transition: 'crossfade', each: 4 },
    'warehouse-rave': { motion: 'zoom-in', fx: 'flicker+chroma', grade: 'contrast', transition: 'none', each: 2 },
    'rooftop-dawn': { motion: 'zoom-out', fx: 'grain+vignette', grade: 'warm', transition: 'crossfade', each: 5 },
    'club-toilet-realism': { motion: 'zoom-in', fx: 'flicker+grain', grade: 'cold', transition: 'none', each: 2 },
    'pastoral-overcast': { motion: 'pan-left', fx: 'grain', grade: 'none', transition: 'crossfade', each: 5 },
    'tape-loop-feedback': { motion: 'zoom-in', fx: 'vhs+flicker', grade: 'vhs', transition: 'crossfade', each: 3 },
};

// The cut recipe per look — the RENDERER'S vocabulary, chosen to match
// the medium's own character.
//
// THE NAMES ARE THE RENDERER'S OWN. lib/render/plan.mjs exports:
//   KEN_BURNS_MODES = none, zoom-in, zoom-out, pan-left
//   FX               = grain, grain-heavy, vignette, chroma, vhs, smear,
//                      flicker, warm, cold, blur, sharpen, contrast
//   TRANSITIONS      = none, crossfade
//
// An invented effect name is a CRASH AT RENDER TIME, not a warning — so
// these are read off the renderer's own table, and
// lib/mj-look-presets.test.js asserts every name against it.

// The stock-free projection: the TEXTURE of the look without the stock
// noun. The stock is the most evocative word in a look and the most
// likely to summon a film-strip graphic, so it is kept as data and can
// be dropped.
//
// The stock is the first clause of the artist's descriptor, up to the
// first comma.
function stockOf(descriptor) {
    const first = String(descriptor || '').split(',')[0].trim();
    return first;
}

const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
let changed = 0;
for (const p of reg.presets) {
    if (!NATIVE_AR[p.slug]) {
        process.stderr.write(`no native ratio for ${p.slug}\n`);
        process.exit(2);
    }
    if (!CUTS[p.slug]) {
        process.stderr.write(`no cut recipe for ${p.slug}\n`);
        process.exit(2);
    }
    if (p.ar !== NATIVE_AR[p.slug] || !p.cut || p.stock !== stockOf(p.descriptor)) {
        p.ar = NATIVE_AR[p.slug];
        p.cut = CUTS[p.slug];
        p.stock = stockOf(p.descriptor);
        // The colour consequence of the stock, for the scene-safe
        // projection: the palette and texture WITHOUT the stock noun.
        const rest = String(p.descriptor || '').split(',').slice(1).map(s => s.trim()).filter(Boolean);
        p.styleScene = rest.join(', ');
        p.style = [p.stock, ...rest].join(', ');
        changed++;
    }
}

// The registry's default ratio is now "the pack's override", and the
// per-look ratio is the native one.
reg._note_ratios = 'Each look carries its NATIVE ratio — the frame shape is part of what the medium IS. A cut is ONE ratio (the renderer takes one --size for a whole cut), so a plan spanning several ratios is REFUSED rather than silently scaled. The pack\'s --ar overrides the ratio for a look plate; the cut plan\'s --ar-filter selects which looks may share a cut.';

fs.writeFileSync(REG, JSON.stringify(reg, null, 4) + '\n');
process.stdout.write(`[augment-look-registry] ${changed} preset(s) augmented\n`);
