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

// ---------- The rule ----------
//
// The rule itself lives in lib/prompt-lint-core.js — ONE implementation,
// shared with the browser console (pages/mj-console.html).
//
// It used to live here, inline. That was fine until the console needed
// the same rule: the console is exactly where a stray "a Black man"
// would be typed by hand, one keystroke away from a pack the CI linter
// then fails on. A second copy in the browser could drift from this one,
// so the console loads the shared file instead.
//
// Re-exported here because this module's public API has always included
// findViolations / RACE_TERMS / PERSON_NOUNS, and several callers
// (mj-scene-presets.test.js, mj-look-presets.test.js,
// nema-me-u-meni.test.js, prompt-lint.test.js) import them from here.
const { findViolations, RACE_TERMS, PERSON_NOUNS } = require('./prompt-lint-core.js');

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
