#!/usr/bin/env node
// lib/mj-console-store.js
//
// The saved-prompt library behind the Midjourney console.
//
// WHAT THIS IS.
//
// A flat, ordered list of prompts the artist has saved, each with a
// title, the prompt text, its aspect ratio, and the tags that make it
// findable again. It is the "access them" half of the console: the
// composer makes a prompt, this keeps it, and the library lists them.
//
// WHERE IT LIVES.
//
// `data/mj/prompts.json` — inside the repo, next to the other MJ
// catalogs. Two consequences, both deliberate:
//
//   * It is LOCAL. The twin is local-first; a prompt library is the
//     artist's working material, not a public artifact.
//   * It is NOT tracked. The repo's rule for generated state is that the
//     source is tracked and the output is not (same as `data/songs/`,
//     `data/scene-presets/`, `data/look-presets/`). A personal prompt
//     library is private working material, so `.gitignore` keeps it out
//     of the repo entirely.
//
// THE STORE IS THE SOURCE OF TRUTH, NOT THE PAGE.
//
// The browser could have kept the library in localStorage — one line of
// JavaScript, no server. It does not, for one reason: localStorage is
// per-browser, and this twin has a real filesystem with a real watcher
// behind it. A prompt saved in the console has to be reachable from the
// CLI (`node lib/mj-console-store.js --list`), from the watcher, and
// from any browser on the machine — otherwise "save a prompt" and "use
// the prompt" are two different libraries.
//
// So: the console POSTs to the API, the API writes THIS file, and every
// consumer reads the same file.
//
// THE TWO GATES A PROMPT PASSES THROUGH BEFORE IT IS STORED.
//
//   1. The IDENTITY LINT (lib/prompt-lint-core.js). A prompt must not
//      name the subject's race or ethnicity — these prompts are written
//      so a reference photo can be attached, and a demographic adjective
//      overrides the photo. The same rule the repo's linter enforces on
//      every pack, applied at the moment of typing.
//
//   2. The FLAG COMPOSER (lib/mj-flags.js). The stored prompt keeps its
//      text and ratio SEPARATE, and the composed command is derived —
//      never stored. That way the library cannot drift from what the
//      submitter would send: the console composes on read using the
//      same function the submitter uses.
//
// Usage:
//   node lib/mj-console-store.js --list
//   node lib/mj-console-store.js --add "title" --prompt "text" [--ar 16:9] [--tags a,b]
//   node lib/mj-console-store.js --remove <id>
//
// Exit: 0 ok · 2 bad input · 3 store error

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildFullPrompt, splitAr } = require('./mj-flags.js');
const { findViolations } = require('./prompt-lint-core.js');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_STORE = path.join(REPO, 'data', 'mj', 'prompts.json');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));
const DEFAULT_ARGS = (CONFIG.mj && CONFIG.mj.defaultArgs) || '';

const MAX_PROMPTS = 500;
const MAX_TITLE = 120;
const MAX_TEXT = 4000;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class StoreError extends Error {
    constructor(message, statusCode = 400, details = null) {
        super(message);
        this.name = 'StoreError';
        this.statusCode = statusCode;
        this.details = details;
    }
}

// ---------------------------------------------------------------------------
// Id + slug
// ---------------------------------------------------------------------------

function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'prompt';
}

/**
 * A short, sortable, collision-resistant id.
 *
 * Time-prefixed so the library's natural order is also its creation
 * order (lexicographic sort == chronological), plus random bytes so two
 * saves in the same millisecond cannot collide.
 */
function newId(now = Date.now()) {
    const rand = require('node:crypto').randomBytes(4).toString('hex');
    return `p_${now.toString(36)}_${rand}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeTags(tags) {
    let list = tags;
    if (typeof tags === 'string') list = tags.split(',');
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const t = String(raw == null ? '' : raw).trim().toLowerCase();
        if (!t) continue;
        if (t.length > MAX_TAG_LEN) continue;
        if (out.includes(t)) continue;
        out.push(t);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/**
 * Validate + normalize an incoming prompt.
 *
 * Returns the normalized record. Throws StoreError with a 4xx status on
 * a client mistake — a bad request is not a server fault, and the API
 * layer maps that status straight through.
 */
function normalizeEntry(input, { now = Date.now() } = {}) {
    if (!input || typeof input !== 'object') {
        throw new StoreError('prompt must be an object');
    }

    const title = String(input.title == null ? '' : input.title).trim();
    if (!title) throw new StoreError('title is required');
    if (title.length > MAX_TITLE) {
        throw new StoreError(`title is too long (${title.length} chars, max ${MAX_TITLE})`);
    }

    // The prompt's OWN `--ar` wins over the `ar` field, and the field wins
    // over nothing — same precedence the submitter uses. The stored record
    // keeps the ratio SEPARATE from the text, so the library and a pack
    // file carry a ratio the same way.
    const rawText = String(input.prompt == null ? '' : input.prompt).trim();
    if (!rawText) throw new StoreError('prompt text is required');

    const split = splitAr(rawText);
    const ar = (split.ar || (input.ar ? String(input.ar).trim() : '') || null);

    if (ar && !/^\d{1,2}:\d{1,2}$/.test(ar)) {
        throw new StoreError(`invalid aspect ratio "${ar}" (expected e.g. 16:9)`);
    }

    // The text stored is the text WITHOUT the `--ar` — the ratio lives in
    // its own field. (The composer re-appends it, last.)
    const text = split.text;
    if (!text) throw new StoreError('prompt text is required');
    if (text.length > MAX_TEXT) {
        throw new StoreError(`prompt text is too long (${text.length} chars, max ${MAX_TEXT})`);
    }

    // THE IDENTITY LINT. Same rule, same implementation as the repo's
    // linter — enforced at the moment of typing, so a violating prompt
    // never reaches the library in the first place.
    const violations = findViolations(text);
    if (violations.length) {
        throw new StoreError(
            `the prompt specifies the subject's race/ethnicity ("${violations[0].match}") — ` +
            'describe the scene, not the identity; leave the person to the reference photo',
            422,
            { violations }
        );
    }

    const nowIso = new Date(now).toISOString();

    return {
        id: String(input.id || newId(now)).trim() || newId(now),
        title,
        prompt: text,
        ar: ar || null,
        tags: normalizeTags(input.tags),
        notes: String(input.notes == null ? '' : input.notes).trim().slice(0, 1000),
        createdAt: nowIso,
        updatedAt: nowIso,
    };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Create a store bound to a file.
 *
 * The file is optional: a store with no file yet reads as an empty
 * library and writes on the first save. That is the state a fresh
 * checkout is in, and the console must not need a seed file to work.
 */
function createStore(filePath = DEFAULT_STORE) {
    const abs = path.resolve(filePath);

    function readRaw() {
        let raw;
        try {
            raw = fs.readFileSync(abs, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return { schema: 1, prompts: [] };
            throw new StoreError(`could not read the prompt library: ${err.message}`, 500);
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new StoreError(`the prompt library is not valid JSON: ${err.message}`, 500);
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new StoreError('the prompt library is not an object', 500);
        }
        if (!Array.isArray(parsed.prompts)) parsed.prompts = [];
        return parsed;
    }

    /**
     * Write atomically: a temp file in the same directory, then a
     * rename. A half-written library is worse than no library — it would
     * be unparseable and the console would show an error instead of the
     * prompts.
     */
    function writeRaw(data) {
        const dir = path.dirname(abs);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            throw new StoreError(`could not create the library directory: ${err.message}`, 500);
        }
        const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.tmp`);
        const body = JSON.stringify(data, null, 2) + '\n';
        try {
            fs.writeFileSync(tmp, body, 'utf8');
            fs.renameSync(tmp, abs);
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch { /* best effort */ }
            throw new StoreError(`could not write the prompt library: ${err.message}`, 500);
        }
    }

    /**
     * The library, with each prompt's COMPOSED command attached.
     *
     * The composed command is derived on read using the shared composer —
     * the same function the submitter runs — so what the console shows
     * is what a submission would send. It is never stored: a stored
     * composed command would go stale the moment the config's defaults
     * changed.
     */
    function list({ defaults = DEFAULT_ARGS } = {}) {
        const data = readRaw();
        const prompts = data.prompts.map((p) => {
            const composed = buildFullPrompt(p.prompt || '', p.ar || null, defaults);
            return { ...p, composed };
        });
        return {
            schema: data.schema || 1,
            prompts,
            totals: {
                prompts: prompts.length,
                withRatio: prompts.filter((p) => p.ar).length,
                tags: new Set(prompts.flatMap((p) => p.tags || [])).size,
            },
        };
    }

    /** Add one prompt. Returns the stored record. */
    function add(input, { now = Date.now(), defaults = DEFAULT_ARGS } = {}) {
        const entry = normalizeEntry(input, { now });
        const data = readRaw();

        // An explicit id means "update this one" — otherwise ids are
        // always fresh.
        if (input && input.id) {
            const idx = data.prompts.findIndex((p) => p.id === input.id);
            if (idx !== -1) {
                const updated = { ...entry, id: data.prompts[idx].id, createdAt: data.prompts[idx].createdAt };
                data.prompts[idx] = updated;
                writeRaw(data);
                return { ...updated, composed: buildFullPrompt(updated.prompt, updated.ar, defaults) };
            }
        }

        if (data.prompts.length >= MAX_PROMPTS) {
            throw new StoreError(`the library holds ${MAX_PROMPTS} prompts — remove one first`, 409);
        }
        data.prompts.push(entry);
        writeRaw(data);
        return { ...entry, composed: buildFullPrompt(entry.prompt, entry.ar, defaults) };
    }

    /** Remove one prompt by id. Returns true when it existed. */
    function remove(id) {
        const data = readRaw();
        const before = data.prompts.length;
        data.prompts = data.prompts.filter((p) => p.id !== id);
        if (data.prompts.length === before) return false;
        writeRaw(data);
        return true;
    }

    /** One prompt by id, or null. */
    function get(id, { defaults = DEFAULT_ARGS } = {}) {
        const { prompts } = list({ defaults });
        return prompts.find((p) => p.id === id) || null;
    }

    /**
     * Render the library as a MJ prompt PACK (the format the watcher
     * parses): one top-level bullet per prompt, `--ar` appended.
     *
     * This is the bridge from "the console" to "the pipeline": the pack
     * it writes is exactly the file `lib/mj-watcher.js` watches for.
     */
    function toPack({ title = 'Saved prompts', ids = null, defaults = DEFAULT_ARGS } = {}) {
        const { prompts } = list({ defaults });
        const chosen = ids ? prompts.filter((p) => ids.includes(p.id)) : prompts;
        const lines = [];
        lines.push(`# ${title} — ${chosen.length} prompt${chosen.length === 1 ? '' : 's'}`);
        lines.push('');
        lines.push(`> Saved in the Midjourney console. ${chosen.length} prompt(s).`);
        lines.push('');
        for (const p of chosen) {
            const ar = p.ar ? ` --ar ${p.ar}` : '';
            lines.push(`- ${p.prompt}${ar}`);
        }
        lines.push('');
        return lines.join('\n');
    }

    return { path: abs, list, add, remove, get, toPack, readRaw, writeRaw };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
    const args = argv.slice(2);
    const arg = (name) => {
        const i = args.indexOf(name);
        return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
    };
    const has = (name) => args.includes(name);

    if (has('--help') || (!has('--list') && !has('--add') && !has('--remove') && !has('--pack'))) {
        process.stdout.write(
            'usage:\n' +
            '  node lib/mj-console-store.js --list\n' +
            '  node lib/mj-console-store.js --add "<title>" --prompt "<text>" [--ar 16:9] [--tags a,b]\n' +
            '  node lib/mj-console-store.js --remove <id>\n' +
            '  node lib/mj-console-store.js --pack [--title "Name"]\n'
        );
        return has('--help') ? 0 : 2;
    }

    const store = createStore();

    try {
        if (has('--list')) {
            const { prompts, totals } = store.list();
            for (const p of prompts) {
                const ratio = (p.ar || '—').padStart(6);
                process.stdout.write(`${p.id}  ${ratio}  ${p.title}\n`);
                process.stdout.write(`         ${p.composed}\n`);
            }
            process.stdout.write(`\n${totals.prompts} prompt(s) · ${totals.withRatio} with a ratio · ${totals.tags} tag(s)\n`);
            return 0;
        }

        if (has('--pack')) {
            process.stdout.write(store.toPack({ title: arg('--title') || 'Saved prompts' }));
            return 0;
        }

        if (has('--remove')) {
            const id = arg('--remove');
            if (!id) {
                process.stderr.write('mj-console-store: --remove needs an id\n');
                return 2;
            }
            if (!store.remove(id)) {
                process.stderr.write(`mj-console-store: no prompt with id ${id}\n`);
                return 2;
            }
            process.stdout.write(`removed ${id}\n`);
            return 0;
        }

        if (has('--add')) {
            const title = arg('--add');
            const prompt = arg('--prompt');
            if (!title || !prompt) {
                process.stderr.write('mj-console-store: --add needs a title and --prompt\n');
                return 2;
            }
            const saved = store.add({
                title,
                prompt,
                ar: arg('--ar'),
                tags: arg('--tags'),
                notes: arg('--notes'),
            });
            process.stdout.write(`saved ${saved.id}\n${saved.composed}\n`);
            return 0;
        }
    } catch (err) {
        const status = err && err.statusCode ? err.statusCode : 3;
        process.stderr.write(`mj-console-store: ${err.message}\n`);
        // Exit codes are 0/2/3 (see the header). process.exit() masks the
        // code to its low byte, so a raw 422 would surface as 166 — map
        // every client error onto 2 and keep 3 for a store fault.
        if (status >= 500) return 3;
        return status === 400 || status === 409 || status === 422 ? 2 : 3;
    }

    return 0;
}

if (require.main === module) {
    process.exit(main(process.argv));
}

module.exports = {
    createStore,
    normalizeEntry,
    normalizeTags,
    newId,
    slugify,
    StoreError,
    DEFAULT_STORE,
    DEFAULT_ARGS,
    MAX_PROMPTS,
};
