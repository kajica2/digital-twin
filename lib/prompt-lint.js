#!/usr/bin/env node
'use strict';
// lib/prompt-lint.js
//
// Prompt lint — do not specify the subject's race or ethnicity.
//
// Why this exists (the user's rule, 2026-10-22):
//   Prompts are written so that a **reference photo** can be attached
//   and the model gives back what the photo shows. A prompt that names
//   the subject's race overrides the photo: the model renders a Black
//   man because the prompt said so, whatever the reference actually
//   contains.
//
//   So: describe the SCENE — light, lens, medium, mood, era, wardrobe,
//   gesture, setting. Leave the person's identity to the reference.
//
// What it flags:
//   A demographic descriptor directly modifying a person noun
//   ("a black man", "an Asian woman", "African-American saxophonist").
//
// What it deliberately does NOT flag:
//   * "black and white" — a photographic treatment, not a person.
//   * "a woman in black" / "a black coat" — clothing, not a person.
//   * "white wine", "the Black Sea", "black metal" — not people.
//   * a nationality word not attached to a person noun
//     ("Mexican cuisine", "Asian fusion", "Indian summer").
//   * skin as a *rendering* property of an object ("a black piano").
//
// It checks the prompts **as the submitter would send them**: the
// parsing comes from `lib/mj-submitter.js`'s `extractPrompts`, so the
// lint and the watcher can never disagree about what a pack contains.
// Frontmatter, blockquotes and code fences are ignored, exactly as the
// watcher ignores them.
//
// Usage:
//   node lib/prompt-lint.js                 # scan the repo's prompt sources
//   node lib/prompt-lint.js <file> [...]    # scan specific files
//
// Exit: 0 clean · 1 violations found · 2 bad input

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const { extractPrompts } = require('./mj-submitter.js');

// ---------- The term lists ----------
//
// RACE_TERMS are the adjectives that carry a demographic claim. They
// are only a finding when they modify a PERSON noun — "black and
// white" and "a black coat" must not trip the lint.
//
// Multi-word terms are matched with a flexible separator so
// "African-American", "african american" and "African American" all
// hit, and so the two-word form wins over a bare "african".
const RACE_TERMS = [
    'african american', 'african-american', 'native american', 'native-american',
    'first nations', 'first-nations', 'mixed race', 'mixed-race',
    'mixed ethnicity', 'east asian', 'east-asian', 'south asian', 'south-asian',
    'middle eastern', 'middle-eastern', 'african descent', 'asian descent',
    'arab descent', 'black', 'white', 'african', 'asian', 'arab', 'arabic',
    'hispanic', 'latino', 'latina', 'latinx', 'cuban', 'puerto rican',
    'dominican', 'mexican', 'colombian', 'peruvian', 'argentine', 'venezuelan',
    'indian', 'pakistani', 'bangladeshi', 'sri lankan', 'nepali',
    'chinese', 'taiwanese', 'japanese', 'korean', 'vietnamese', 'filipino',
    'indonesian', 'thai', 'cambodian', 'burmese',
    'nigerian', 'ethiopian', 'somali', 'kenyan', 'ghanaian', 'sudanese',
    'south african', 'zimbabwean', 'zambian',
    'moroccan', 'algerian', 'tunisian', 'egyptian', 'libyan',
    'turkish', 'iranian', 'iraqi', 'syrian', 'lebanese', 'levantine', 'greek',
    'caucasian', 'european', 'slavic', 'balkan', 'nordic', 'scandinavian',
    'mediterranean', 'roma', 'romani',
    'indigenous', 'aboriginal', 'aborigine', 'inuit', 'sami',
    'biracial', 'mixed-race',
];

// PERSON_NOUNS are the nouns that make a demographic adjective a
// claim about a person rather than about a colour, a garment or a
// scene.
const PERSON_NOUNS = [
    'man', 'men', 'woman', 'women', 'person', 'people', 'boy', 'boys',
    'girl', 'girls', 'kid', 'kids', 'child', 'children', 'adult', 'adults',
    'musician', 'musicians', 'artist', 'artists',
    'saxophonist', 'saxophonists', 'trumpeter', 'trumpeters',
    'player', 'players', 'drummer', 'drummers', 'singer', 'singers',
    'model', 'models', 'guy', 'guys', 'lady', 'ladies',
    'elder', 'elders', 'elderly', 'worker', 'workers',
    'pedestrian', 'pedestrians', 'passerby', 'passersby',
    'crowd', 'crowds', 'audience', 'teen', 'teens', 'teenager', 'teenagers',
    'student', 'students', 'performer', 'performers', 'dancer', 'dancers',
];

// "a person of colour" — a demographic claim with a different shape.
const OF_COLOR_RE = /\b(?:people|persons?|men|women|someone|somebody|human|humans)\s+of\s+colou?r\b/gi;

// "of African descent" — the noun follows the descriptor.
const DESCENT_RE = /\bof\s+(?:african|asian|arab|european|latino|latina|hispanic|middle\s+eastern)\s+descent\b/gi;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A descriptor may be two words joined by a space or a hyphen.
function termToPattern(term) {
    const parts = term.split(/[\s-]+/);
    return parts.map(escapeRe).join('[\\s-]+');
}

const RACE_ALT = RACE_TERMS.map(termToPattern).join('|');
const NOUN_ALT = PERSON_NOUNS.map(escapeRe).join('|');

// The descriptor must directly modify the person noun: one or two
// intervening words ("a young Black man") still count, but a clause
// in between does not.
const PERSON_RE = new RegExp(
    `\\b(${RACE_ALT})\\s+(?:\\w+\\s+){0,2}?(${NOUN_ALT})\\b`,
    'gi'
);

const LINE_RE = new RegExp(
    `\\b(${RACE_ALT})\\s+(?:\\w+\\s+){0,2}?(${NOUN_ALT})\\b`,
    'gi'
);

// ---------- Detection ----------

// findViolations(promptText) -> [{ term, noun, match }]
function findViolations(promptText) {
    const out = [];
    if (typeof promptText !== 'string' || !promptText) return out;

    const seen = new Set();
    for (const re of [PERSON_RE, OF_COLOR_RE, DESCENT_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(promptText)) !== null) {
            const match = m[0].replace(/\s+/g, ' ').trim();

            // "black and white" is a photographic TREATMENT, never a
            // claim about a person: "a framed black-and-white portrait",
            // "a black-and-white photo of a man". Neither word in the
            // compound may act as a descriptor.
            if (/^black[\s-]+and[\s-]+white\b/i.test(match)) continue;
            if (/^white\b/i.test(match)) {
                const before = promptText.slice(Math.max(0, m.index - 24), m.index);
                if (/black[\s-]+and[\s-]+$/i.test(before)) continue;
            }

            const key = match.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                term: (m[1] || match).toLowerCase(),
                noun: m[2] ? m[2].toLowerCase() : null,
                match,
            });
            if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
        }
    }
    return out;
}

// ---------- Scanning ----------

// A file is only a "prompt pack" if it has top-level bullets. Prose
// documents (the format spec, READMEs) are not packs and are skipped
// rather than parsed as one.
function looksLikePack(content) {
    return /^- /m.test(content);
}

function findLine(content, needle) {
    const lines = content.split('\n');
    const target = needle.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(target)) return i + 1;
    }
    return null;
}

// scanFile(filePath) -> { file, prompts, violations, skipped }
function scanFile(filePath) {
    const abs = path.resolve(filePath);
    const content = fs.readFileSync(abs, 'utf8');

    if (!looksLikePack(content)) {
        return { file: abs, prompts: 0, violations: [], skipped: 'not a prompt pack (no top-level bullets)' };
    }

    // The submitter's own parser — one source of truth for what a
    // pack actually contains.
    const prompts = extractPrompts(abs);
    const violations = [];
    prompts.forEach((p, i) => {
        for (const v of findViolations(p.text)) {
            violations.push({
                index: i,
                prompt: p.text,
                line: findLine(content, v.match),
                ...v,
            });
        }
    });
    return { file: abs, prompts: prompts.length, violations, skipped: null };
}

// scanPaths(paths) -> { files: [...], violations: [...] }
function scanPaths(paths) {
    const results = [];
    for (const p of paths) results.push(scanFile(p));
    const violations = [];
    for (const r of results) {
        for (const v of r.violations) violations.push({ file: r.file, ...v });
    }
    return { files: results, violations };
}

// ---------- Default targets ----------

const DEFAULT_DIRS = [
    { dir: path.join(REPO, 'assets', 'mural-prompts'), ext: '.md' },
    { dir: path.join(REPO, 'prompts-inbox'), ext: '.md' },
];

// `processed/` holds packs the watcher has already shipped; they are
// history, not something about to be submitted.
const SKIP_DIRS = new Set(['processed', 'node_modules']);

function walk(dir, ext, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return; // directory absent — nothing to lint there
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(full, ext, out);
            continue;
        }
        if (!e.isFile()) continue;
        if (!e.name.endsWith(ext)) continue;
        out.push(full);
    }
}

function defaultTargets() {
    const out = [];
    for (const { dir, ext } of DEFAULT_DIRS) walk(dir, ext, out);
    return out.sort();
}

// ---------- CLI ----------

function main(argv) {
    const args = argv.slice(2);
    let targets;
    if (args.length > 0) {
        targets = args;
        for (const t of targets) {
            if (!fs.existsSync(t)) {
                process.stderr.write(`prompt-lint: no such file: ${t}\n`);
                return 2;
            }
        }
    } else {
        targets = defaultTargets();
        if (targets.length === 0) {
            process.stderr.write('prompt-lint: no prompt files found to scan\n');
            return 0;
        }
    }

    const { files, violations } = scanPaths(targets);
    const packed = files.filter(f => !f.skipped);

    for (const v of violations) {
        const where = v.line ? `${path.relative(REPO, v.file)}:${v.line}` : path.relative(REPO, v.file);
        process.stderr.write(
            `prompt-lint: ${where}: prompt ${v.index + 1} specifies the subject's race/ethnicity — "${v.match}"\n`
        );
    }

    const promptCount = packed.reduce((n, f) => n + f.prompts, 0);
    if (violations.length === 0) {
        process.stderr.write(
            `prompt-lint: ${packed.length} pack(s), ${promptCount} prompt(s), 0 violation(s)\n`
        );
        return 0;
    }
    process.stderr.write(
        `prompt-lint: ${violations.length} violation(s) across ${packed.length} pack(s).\n` +
        `  Describe the scene, not the subject's identity — leave the person to the reference photo.\n`
    );
    return 1;
}

if (require.main === module) {
    process.exit(main(process.argv));
}

module.exports = {
    findViolations,
    scanFile,
    scanPaths,
    defaultTargets,
    looksLikePack,
    RACE_TERMS,
    PERSON_NOUNS,
};
