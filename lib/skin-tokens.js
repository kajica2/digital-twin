#!/usr/bin/env node
// lib/skin-tokens.js — the skin validator.
//
// A skin is a CSS file that defines every token in lib/skin-contract.js.
// The contract says WHAT must exist; this file says whether a given
// skin actually does it, so a broken skin fails at build/check time
// instead of rendering an unstyled page.
//
// Two shapes of failure are distinguished:
//   * an ERROR means the skin violates the contract and must not ship.
//   * a WARNING means the skin is legal but probably not what its
//     author intended (a themed token that never changes with the
//     theme is the classic one).
//
// Pure Node: no dependencies, no side effects on import. Usable as a
// library (validateSkin / parseSkin) and as a CLI:
//
//   node lib/skin-tokens.js assets/skins/house.css
//   node lib/skin-tokens.js --json assets/skins/*.css

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const contract = require('./skin-contract.js');

const GROUPS = contract.GROUPS;
const LOCAL = contract.LOCAL;
const themed = contract.themed;
const staticTokens = contract.staticTokens;
const all = contract.all;
const groupOf = contract.groupOf;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Skip a quoted string starting at `i`; returns the index after it. */
function skipString(css, i) {
    const quote = css[i];
    let j = i + 1;
    while (j < css.length) {
        if (css[j] === '\\') { j += 2; continue; }
        if (css[j] === quote) return j + 1;
        j++;
    }
    return css.length;
}

/** Skip a parenthesised run starting at `i`; returns the index after it. */
function skipParen(css, i) {
    let depth = 0;
    let j = i;
    while (j < css.length) {
        const c = css[j];
        if (c === '"' || c === "'") { j = skipString(css, j); continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return j + 1; }
        j++;
    }
    return css.length;
}

/** Index of the `}` matching the `{` at `openIdx`. */
function matchBrace(css, openIdx) {
    let depth = 0;
    let i = openIdx;
    while (i < css.length) {
        const c = css[i];
        if (c === '"' || c === "'") { i = skipString(css, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
        i++;
    }
    return css.length;
}

/** Remove comments, keeping string contents intact. */
function stripComments(css) {
    let out = '';
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end === -1 ? css.length : end + 2;
            out += ' ';
            continue;
        }
        if (c === '"' || c === "'") {
            const j = skipString(css, i);
            out += css.slice(i, j);
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * The skin's name comes from the `/*! skin: <name>` header. It must be
 * the first thing in the file so a reader (and the validator) can find
 * it without parsing the whole stylesheet.
 */
function extractHeaderName(css) {
    const m = /\/\*!\s*skin:\s*([A-Za-z0-9_-]+)/.exec(css);
    return m ? m[1] : null;
}

/**
 * True when the header is the first thing in the file. A skin whose
 * header is buried under a licence block is still readable, but the
 * format says the header comes first, so it is worth saying so.
 */
function headerIsFirst(css) {
    // A byte-order mark and leading whitespace are not content.
    const start = String(css).replace(/^﻿/, '').replace(/^\s+/, '');
    return /^\/\*!\s*skin:/.test(start);
}

/** Split a rule body into custom-property declarations. */
function parseDeclarations(body) {
    const decls = [];
    let buf = '';
    let i = 0;

    const flush = () => {
        const chunk = buf.trim();
        buf = '';
        if (!chunk) return;
        const idx = chunk.indexOf(':');
        if (idx === -1) {
            // A custom property with no value at all is a typo, not a
            // custom property; keep it so the validator can complain.
            if (chunk.startsWith('--')) {
                decls.push({ name: chunk, value: null, malformed: true });
            }
            return;
        }
        const name = chunk.slice(0, idx).trim();
        if (!name.startsWith('--')) return;
        decls.push({ name, value: chunk.slice(idx + 1).trim(), malformed: false });
    };

    while (i < body.length) {
        const c = body[i];
        if (c === '"' || c === "'") { const j = skipString(body, i); buf += body.slice(i, j); i = j; continue; }
        if (c === '(') { const j = skipParen(body, i); buf += body.slice(i, j); i = j; continue; }
        if (c === ';') { flush(); i++; continue; }
        buf += c;
        i++;
    }
    flush();
    return decls;
}

/** The class names in a selector part, e.g. ['dark'] for 'html.dark'. */
function classTokens(part) {
    const out = [];
    const re = /\.(-?[_a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(part)) !== null) out.push(m[1]);
    return out;
}

/**
 * Which scope a rule belongs to.
 *
 * `base` is `:root` (and only `:root`); `dark` is the theme override.
 * A rule that is neither is ignored — a skin is not allowed to invent
 * extra scopes, but a stray rule should not crash the validator.
 */
function classify(selector) {
    const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
    let base = false;
    let dark = false;
    for (const part of parts) {
        if (/:root\s*\[\s*data-theme\s*=\s*["']dark["']\s*\]/i.test(part)) { dark = true; continue; }
        if (/:root\s*\[\s*data-theme\s*=\s*dark\s*\]/i.test(part)) { dark = true; continue; }
        // `.dark` is the class form. Matching the class token exactly
        // keeps `.dark-mode` and `.darkness` out of the dark scope.
        if (classTokens(part).some((c) => c.toLowerCase() === 'dark')) { dark = true; continue; }
        if (/:root\b/i.test(part)) base = true;
    }
    if (dark) return 'dark';
    if (base) return 'base';
    return null;
}

/**
 * Top-level rules of a stylesheet.
 *
 * At-rule blocks (@media, @supports) are not scopes, so a token
 * defined only inside one of them does not count towards scope
 * coverage — but the declaration still exists in the file, so it can
 * still satisfy a `var(--x)` reference. Those declarations come back
 * in `nested`.
 */
function parseRules(css) {
    const rules = [];
    const nested = [];
    let buf = '';
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '"' || c === "'") { const j = skipString(css, i); buf += css.slice(i, j); i = j; continue; }
        if (c === '{') {
            const prelude = buf.trim();
            buf = '';
            const end = matchBrace(css, i);
            const body = css.slice(i + 1, end);
            i = end + 1;
            if (prelude.startsWith('@')) {
                // Declarations inside @media / @supports are not scoped,
                // but they still exist, so a var() may point at one.
                const inner = parseRules(body);
                for (const rule of inner.rules) nested.push(...rule.declarations);
                nested.push(...inner.nested);
                continue;
            }
            rules.push({ selector: prelude, declarations: parseDeclarations(body) });
            continue;
        }
        if (c === '}' || c === ';') { buf = ''; i++; continue; }
        buf += c;
        i++;
    }
    return { rules, nested };
}

/** Strip the `--` prefix so keys match the contract's vocabulary. */
function bare(name) {
    return name.startsWith('--') ? name.slice(2) : name;
}

/**
 * Parse a skin stylesheet.
 *
 * @param {string} cssText
 * @returns {{name: string|null,
 *            scopes: {base: Object<string,string>, dark: Object<string,string>},
 *            defined: string[]}}
 *   `name` is null when the `/*! skin:` header is missing. Scope maps
 *   are keyed by bare token name (no `--` prefix).
 */
function parseSkin(cssText) {
    const src = cssText == null ? '' : String(cssText);
    const name = extractHeaderName(src);
    const scopes = { base: {}, dark: {} };
    const defined = new Set();
    const parsed = parseRules(stripComments(src));

    for (const rule of parsed.rules) {
        const scope = classify(rule.selector);
        for (const decl of rule.declarations) {
            const token = bare(decl.name);
            defined.add(token);
            if (!scope) continue;
            // A later declaration of the same token wins, matching CSS.
            scopes[scope][token] = decl.malformed ? null : decl.value;
        }
    }

    // Declarations inside @media / @supports are not scoped, but they
    // still exist, so a var() may legitimately point at one.
    for (const decl of parsed.nested) defined.add(bare(decl.name));

    return { name, scopes, defined: Array.from(defined) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^)]*))?\)/g;

/**
 * Collect the custom properties a value refers to that are not defined
 * anywhere in the file.
 *
 * A `var()` with a literal fallback still resolves to a real colour,
 * so it is only a warning; a bare `var()` to an undefined property
 * invalidates the declaration and is an error.
 */
function undefinedReferences(value, definedSet) {
    const missing = [];
    if (!value) return missing;
    VAR_RE.lastIndex = 0;
    let m;
    while ((m = VAR_RE.exec(value)) !== null) {
        const prop = bare(m[1]);
        if (definedSet.has(prop)) continue;
        const fallback = (m[2] || '').trim();
        missing.push({ prop, hasFallback: fallback !== '' });
    }
    return missing;
}

/**
 * Validate a skin against the contract.
 *
 * @param {string} cssText
 * @param {{expectedName?: string, allow?: string[]}} [opts]
 * @returns {{ok: boolean, errors: Array, warnings: Array, counts: Object}}
 */
function validateSkin(cssText, opts) {
    const options = opts || {};
    const allowed = new Set(options.allow || []);
    const errors = [];
    const warnings = [];

    const parsed = parseSkin(cssText);
    const base = parsed.scopes.base;
    const dark = parsed.scopes.dark;

    if (!parsed.name) {
        errors.push({ code: 'missing-header', message: 'missing "/*! skin: <name>" header' });
    } else {
        if (!headerIsFirst(cssText)) {
            errors.push({ code: 'header-not-first', message: 'the "/*! skin: <name>" header must be the first thing in the file' });
        }
        if (options.expectedName && parsed.name !== options.expectedName) {
            errors.push({
                code: 'name-mismatch',
                message: `skin name "${parsed.name}" does not match expected "${options.expectedName}"`,
            });
        }
    }

    for (const token of themed) {
        if (!(token in base)) {
            errors.push({ code: 'missing-base', token, message: `themed token --${token} is missing from the base scope` });
        }
        if (!(token in dark)) {
            errors.push({ code: 'missing-dark', token, message: `themed token --${token} is missing from the dark scope` });
        }
    }

    for (const token of staticTokens) {
        if (!(token in base)) {
            errors.push({ code: 'missing-static', token, message: `static token --${token} is missing from the base scope` });
        }
    }

    const definedSet = new Set(parsed.defined);
    for (const token of parsed.defined) {
        if (LOCAL.includes(token)) {
            errors.push({ code: 'local-token', token, message: `--${token} is a page-local palette and must not be defined by a skin` });
        } else if (!all.includes(token) && !allowed.has(token)) {
            errors.push({ code: 'unknown-token', token, message: `--${token} is not part of the skin contract` });
        }
    }

    for (const scope of ['base', 'dark']) {
        const map = scope === 'base' ? base : dark;
        for (const [token, value] of Object.entries(map)) {
            if (value === null) {
                errors.push({ code: 'malformed-value', token, scope, message: `--${token} has no value` });
                continue;
            }
            if (value === '') {
                errors.push({ code: 'empty-value', token, scope, message: `--${token} has an empty value` });
                continue;
            }
            for (const ref of undefinedReferences(value, definedSet)) {
                const message = `--${token} references --${ref.prop}, which is not defined in this file`;
                if (ref.hasFallback) {
                    // The fallback keeps the declaration valid, so this is
                    // a smell rather than a break.
                    warnings.push({ code: 'undefined-var-fallback', token, scope, message });
                } else {
                    errors.push({ code: 'undefined-var', token, scope, message });
                }
            }
        }
    }

    for (const token of staticTokens) {
        if (token in dark) {
            warnings.push({ code: 'static-in-dark', token, message: `static token --${token} is redefined in the dark scope` });
        }
    }

    // --warning is a synonym of --warn: the same colour under a second
    // name, so the two must not drift apart.
    for (const scope of ['base', 'dark']) {
        const map = scope === 'base' ? base : dark;
        if (typeof map.warn === 'string' && typeof map.warning === 'string' && map.warn.trim() !== map.warning.trim()) {
            warnings.push({
                code: 'synonym-drift',
                token: 'warning',
                scope,
                message: `--warning and --warn differ in the ${scope} scope, but --warning is a synonym of --warn`,
            });
        }
    }

    for (const token of themed) {
        const light = base[token];
        const night = dark[token];
        if (typeof light === 'string' && typeof night === 'string' && light.trim() === night.trim()) {
            warnings.push({ code: 'unchanged-in-dark', token, message: `themed token --${token} has the same value in light and dark` });
        }
    }

    const groups = {};
    for (const [group, tokens] of Object.entries(GROUPS)) {
        groups[group] = {
            themed: tokens.length,
            base: tokens.filter((t) => t in base).length,
            dark: tokens.filter((t) => t in dark).length,
        };
    }

    const counts = {
        contract: all.length,
        themed: themed.length,
        static: staticTokens.length,
        base: Object.keys(base).length,
        dark: Object.keys(dark).length,
        defined: parsed.defined.length,
        groups,
    };

    return { ok: errors.length === 0, errors, warnings, counts, name: parsed.name };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
    return [
        'usage: node lib/skin-tokens.js [--json] <file.css> [more.css ...]',
        '',
        'Validates each skin stylesheet against lib/skin-contract.js.',
        'Exits 0 when every file is valid, 1 otherwise.',
    ].join('\n');
}

function report(result, file) {
    // A skin missing half its tokens would otherwise print hundreds of
    // near-identical lines. The count at the bottom stays truthful; the
    // list is just a sample.
    const MAX_LISTED = 12;
    const lines = [];
    lines.push(`skin: ${result.name || '(no name)'}  file: ${file}`);
    lines.push(`  tokens: base ${result.counts.base}  dark ${result.counts.dark}  (contract: ${result.counts.contract})`);
    for (const [group, c] of Object.entries(result.counts.groups)) {
        const mark = c.base === c.themed && c.dark === c.themed ? 'ok' : 'INCOMPLETE';
        lines.push(`  ${group}: base ${c.base}/${c.themed}  dark ${c.dark}/${c.themed}  ${mark}`);
    }
    const shown = result.errors.slice(0, MAX_LISTED);
    for (const e of shown) lines.push(`  ERROR  ${e.message}`);
    if (result.errors.length > shown.length) {
        lines.push(`  ERROR  … and ${result.errors.length - shown.length} more`);
    }
    const shownWarnings = result.warnings.slice(0, MAX_LISTED);
    for (const w of shownWarnings) lines.push(`  warn   ${w.message}`);
    if (result.warnings.length > shownWarnings.length) {
        lines.push(`  warn   … and ${result.warnings.length - shownWarnings.length} more`);
    }
    lines.push(`  => ${result.ok ? 'VALID' : 'INVALID'} (${result.errors.length} errors, ${result.warnings.length} warnings)`);
    return lines.join('\n');
}

function runCli(argv) {
    const args = argv.filter((a) => a !== '--json');
    const json = argv.includes('--json');

    if (args.length === 0) {
        process.stdout.write(usage() + '\n');
        return 1;
    }

    const files = [];
    let allOk = true;

    for (const file of args) {
        let css;
        try {
            css = fs.readFileSync(file, 'utf8');
        } catch (err) {
            files.push({ file, ok: false, error: err.message });
            allOk = false;
            continue;
        }
        const expectedName = path.basename(file).replace(/\.css$/i, '');
        const result = validateSkin(css, { expectedName });
        if (!result.ok) allOk = false;
        files.push({ file, ...result });
    }

    if (json) {
        process.stdout.write(JSON.stringify({ ok: allOk, files }, null, 2) + '\n');
    } else {
        const blocks = files.map((f) => {
            if (f.error) return `skin: (unreadable)  file: ${f.file}\n  ERROR  ${f.error}\n  => INVALID (1 errors, 0 warnings)`;
            return report(f, f.file);
        });
        process.stdout.write(blocks.join('\n\n') + '\n');
    }

    return allOk ? 0 : 1;
}

module.exports = {
    parseSkin,
    parseRules,
    validateSkin,
    classify,
    extractHeaderName,
    headerIsFirst,
    usage,
};

if (require.main === module) {
    process.exit(runCli(process.argv.slice(2)));
}
