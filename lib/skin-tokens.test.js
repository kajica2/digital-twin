#!/usr/bin/env node
// lib/skin-tokens.test.js — tests for the skin validator and for the
// runtime's pure resolution function.
//
// Plain `.js` file invoked via `node`, no test framework:
//
//   node lib/skin-tokens.test.js
//
// Coverage:
//   1.  parse: a valid skin parses to the expected scope maps
//   2.  header: the name is extracted; a missing header is an error
//   3.  coverage: a themed token missing from base / from dark
//   4.  coverage: a static token missing from base
//   5.  scope: a LOCAL token is rejected
//   6.  scope: an unknown token is rejected
//   7.  values: a var() to an undefined custom property is an error
//   8.  values: a themed token identical in light and dark warns
//   9.  runtime: URL param beats stored value; stored value is used
//       when there is no param; the default is used when there is
//       neither; an unknown param falls back to the default
//  10.  CLI: no arguments prints usage and exits 1

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const contract = require('./skin-contract.js');
const { themed, staticTokens, LOCAL, all } = contract;
const tokens = require('./skin-tokens.js');
const DTSkin = require('./skin.js');

const { parseSkin, validateSkin } = tokens;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
    if (cond) {
        passed++;
        process.stdout.write(`  ✓ ${name}\n`);
    } else {
        failed++;
        failures.push(name);
        process.stdout.write(`  ✗ ${name}\n`);
    }
}

function checkEqual(name, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
        process.stdout.write(`  ✓ ${name}\n`);
    } else {
        failed++;
        failures.push(`${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
        process.stdout.write(`  ✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(actual)}\n`);
    }
}

/**
 * Build a skin file from the contract so the fixtures cannot drift out
 * of date when the contract grows.
 *
 * @param {{name?: string, skipBase?: string[], skipDark?: string[],
 *          extraBase?: string, extraDark?: string, omitHeader?: boolean,
 *          sameInDark?: string[], darkSelector?: string}} opts
 */
function makeSkin(opts) {
    const o = opts || {};
    const name = o.name || 'fixture';
    const darkSelector = o.darkSelector || ':root[data-theme="dark"]';

    const base = themed.concat(staticTokens)
        .filter((t) => !(o.skipBase || []).includes(t))
        .map((t) => `  --${t}: ${valueFor(t, 'light')};`)
        .join('\n');
    const dark = themed
        .filter((t) => !(o.skipDark || []).includes(t))
        .map((t) => `  --${t}: ${valueFor(t, (o.sameInDark || []).includes(t) ? 'light' : 'dark')};`)
        .join('\n');

    const header = o.omitHeader ? '' : `/*! skin: ${name}\n *  title: Fixture\n */\n`;
    const extraBase = o.extraBase ? `\n${o.extraBase}\n` : '';
    const extraDark = o.extraDark ? `\n${o.extraDark}\n` : '';

    return `${header}
:root {
${base}${extraBase}
}

${darkSelector} {
${dark}${extraDark}
}
`;
}

/** A distinct, plausible colour per token so no two scopes collide. */
function valueFor(token, theme) {
    // --warning is a synonym of --warn, so it must share its value.
    const source = token === 'warning' ? 'warn' : token;
    if (theme === 'light') return `#${hex(source, 1)}`;
    return `#${hex(source, 2)}`;
}

function hex(token, salt) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    h = (h + salt * 2654435761) >>> 0;
    return (h % 0xffffff).toString(16).padStart(6, '0');
}

function hasCode(result, code) {
    return result.errors.some((e) => e.code === code);
}

function warnCode(result, code) {
    return result.warnings.some((w) => w.code === code);
}

process.stdout.write('\n[skin-tokens.test]\n\n');

// 1. A valid skin parses to the expected scope maps.
process.stdout.write('1. a valid skin parses\n');
{
    const css = makeSkin({ name: 'house' });
    const parsed = parseSkin(css);
    checkEqual('name comes from the header', parsed.name, 'house');
    checkEqual('base scope holds every themed token', Object.keys(parsed.scopes.base).length, themed.length + staticTokens.length);
    checkEqual('dark scope holds every themed token', Object.keys(parsed.scopes.dark).length, themed.length);
    check('base has --bg', 'bg' in parsed.scopes.base);
    check('dark has --bg', 'bg' in parsed.scopes.dark);
    check('base has the static token --font-display', 'font-display' in parsed.scopes.base);
    check('dark does not carry static tokens', !('font-display' in parsed.scopes.dark));

    const result = validateSkin(css, { expectedName: 'house' });
    check('a contract-complete skin is valid', result.ok);
    checkEqual('a contract-complete skin has no errors', result.errors, []);
    checkEqual('a contract-complete skin has no warnings', result.warnings, []);
}

// 2. The header.
process.stdout.write('\n2. the header\n');
{
    const named = validateSkin(makeSkin({ name: 'studio' }), { expectedName: 'studio' });
    check('the header name satisfies expectedName', named.ok);

    const mismatched = validateSkin(makeSkin({ name: 'studio' }), { expectedName: 'house' });
    check('a name mismatch is an error', hasCode(mismatched, 'name-mismatch'));

    const noHeader = validateSkin(makeSkin({ omitHeader: true }));
    check('a missing header is an error', hasCode(noHeader, 'missing-header'));
    check('a missing header makes the skin invalid', !noHeader.ok);
    checkEqual('parseSkin reports no name without a header', parseSkin(makeSkin({ omitHeader: true })).name, null);

    // The format says the header comes first.
    const buried = validateSkin('/* a licence block */\n' + makeSkin({ name: 'house' }));
    check('a header that is not first is an error', hasCode(buried, 'header-not-first'));
    check('a buried header makes the skin invalid', !buried.ok);
}

// 3. Missing themed tokens.
process.stdout.write('\n3. themed token coverage\n');
{
    const noBase = validateSkin(makeSkin({ skipBase: ['bg'] }));
    check('a themed token missing from base is an error', hasCode(noBase, 'missing-base'));
    check('the missing token is named', noBase.errors.some((e) => e.code === 'missing-base' && e.token === 'bg'));
    check('a missing base token makes the skin invalid', !noBase.ok);

    const noDark = validateSkin(makeSkin({ skipDark: ['primary'] }));
    check('a themed token missing from dark is an error', hasCode(noDark, 'missing-dark'));
    check('the missing token is named', noDark.errors.some((e) => e.code === 'missing-dark' && e.token === 'primary'));
    check('a missing dark token makes the skin invalid', !noDark.ok);

    // The new `series` group is themed, so it is covered by the same rule.
    const noSeries = validateSkin(makeSkin({ skipDark: ['c1'] }));
    check('a missing series token in dark is an error', hasCode(noSeries, 'missing-dark'));
}

// 4. Missing static tokens.
process.stdout.write('\n4. static token coverage\n');
{
    const result = validateSkin(makeSkin({ skipBase: ['font-body'] }));
    check('a static token missing from base is an error', hasCode(result, 'missing-static'));
    check('the missing static token is named', result.errors.some((e) => e.code === 'missing-static' && e.token === 'font-body'));
    check('a missing static token makes the skin invalid', !result.ok);
}

// 5. LOCAL tokens.
process.stdout.write('\n5. local tokens are not skinnable\n');
{
    const result = validateSkin(makeSkin({ extraBase: `  --${LOCAL[0]}: #123456;` }));
    check('a LOCAL token is an error', hasCode(result, 'local-token'));
    check('the local token is named', result.errors.some((e) => e.code === 'local-token' && e.token === LOCAL[0]));
    check('a LOCAL token makes the skin invalid', !result.ok);
}

// 6. Unknown tokens.
process.stdout.write('\n6. unknown tokens\n');
{
    const result = validateSkin(makeSkin({ extraBase: '  --not-in-the-contract: #123456;' }));
    check('an unknown token is an error', hasCode(result, 'unknown-token'));
    check('the unknown token is named', result.errors.some((e) => e.code === 'unknown-token' && e.token === 'not-in-the-contract'));
    check('an unknown token makes the skin invalid', !result.ok);

    const allowed = validateSkin(makeSkin({ extraBase: '  --not-in-the-contract: #123456;' }), { allow: ['not-in-the-contract'] });
    check('an explicitly allowed token is accepted', !hasCode(allowed, 'unknown-token'));
}

// 7. Values referencing undefined custom properties.
process.stdout.write('\n7. values\n');
{
    const bad = validateSkin(makeSkin({ extraBase: '  --primary-soft: color-mix(in srgb, var(--nope) 8%, transparent);' }));
    check('a var() to an undefined custom property is an error', hasCode(bad, 'undefined-var'));
    check('the undefined property is named', bad.errors.some((e) => e.code === 'undefined-var' && /--nope/.test(e.message)));
    check('an undefined var makes the skin invalid', !bad.ok);

    const good = validateSkin(makeSkin({ extraBase: '  --primary-soft: color-mix(in srgb, var(--primary) 8%, transparent);' }));
    check('a var() to a defined custom property is fine', !hasCode(good, 'undefined-var'));

    const fallback = validateSkin(makeSkin({ extraBase: '  --primary-soft: var(--nope, #abcdef);' }));
    check('a var() with a fallback warns instead of failing', warnCode(fallback, 'undefined-var-fallback'));
    check('a var() with a fallback is still valid', fallback.ok);

    const empty = validateSkin(makeSkin({ extraBase: '  --primary-soft:;' }));
    check('an empty value is an error', hasCode(empty, 'empty-value'));

    const malformed = validateSkin(makeSkin({ extraBase: '  --primary-soft' }));
    check('a declaration with no value is an error', hasCode(malformed, 'malformed-value'));
}

// 8. A themed token that never changes between the two scopes.
process.stdout.write('\n8. themed tokens that do not change\n');
{
    const result = validateSkin(makeSkin({ sameInDark: ['accent'] }));
    check('an unchanged themed token warns', warnCode(result, 'unchanged-in-dark'));
    check('the unchanged token is named', result.warnings.some((w) => w.code === 'unchanged-in-dark' && w.token === 'accent'));
    check('an unchanged themed token is still valid', result.ok);

    const redefined = validateSkin(makeSkin({ extraDark: '  --font-body: serif;' }));
    check('a static token redefined in dark warns', warnCode(redefined, 'static-in-dark'));
    check('a static token redefined in dark is still valid', redefined.ok);

    // --warning is a synonym of --warn, so the two must not drift.
    const drifted = validateSkin(makeSkin({ extraBase: '  --warning: #ff0000;' }));
    check('a drifting synonym warns', warnCode(drifted, 'synonym-drift'));
    check('a drifting synonym is still valid', drifted.ok);
}

// 8b. Parsing edge cases.
process.stdout.write('\n8b. parsing edge cases\n');
{
    // The class form of the dark scope.
    const classDark = parseSkin(makeSkin({ darkSelector: '.dark' }));
    check('a .dark selector is the dark scope', Object.keys(classDark.scopes.dark).length === themed.length);
    check('a .dark selector leaves the base scope alone', Object.keys(classDark.scopes.base).length === themed.length + staticTokens.length);

    // A class that merely starts with "dark" is not the dark scope.
    const notDark = parseSkin(makeSkin({ darkSelector: '.dark-mode' }));
    check('.dark-mode is not the dark scope', Object.keys(notDark.scopes.dark).length === 0);

    // Single quotes and an unquoted value both count.
    const singleQuoted = parseSkin(makeSkin({ darkSelector: ":root[data-theme='dark']" }));
    check('a single-quoted dark selector is the dark scope', Object.keys(singleQuoted.scopes.dark).length === themed.length);

    // Declarations inside @media do not count towards scope coverage,
    // but they exist in the file, so a var() may point at one.
    const mediaCss = makeSkin({ extraBase: '  --primary-soft: var(--in-media);' })
        + '\n@media (min-width: 40em) {\n  :root {\n    --in-media: #abcdef;\n  }\n}\n';
    const media = validateSkin(mediaCss);
    check('a var() to a @media-defined property is satisfied', !hasCode(media, 'undefined-var'));
    check('a token only defined in @media is not a contract token', hasCode(media, 'unknown-token'));
    check('a @media declaration does not count as scoped', !('in-media' in parseSkin(mediaCss).scopes.base));

    // A contract token redefined inside @media is fine — it is still a
    // contract token, it just is not scoped.
    const contractMedia = validateSkin(makeSkin({}) + '\n@media (min-width: 40em) {\n  :root {\n    --bg: #abcdef;\n  }\n}\n');
    check('a contract token in @media is not unknown', !hasCode(contractMedia, 'unknown-token'));
    check('a contract token in @media is not an error', contractMedia.ok);

    // Comments are ignored, including inside a scope.
    const commented = validateSkin(makeSkin({}) + '\n/* --not-a-token: #fff; */\n');
    check('a token inside a comment is ignored', !hasCode(commented, 'unknown-token'));

    // A declaration with no value at all.
    const malformed = parseSkin(':root {\n  --bg: #fff;\n  --surface\n}\n');
    check('a declaration with no value parses as null', malformed.scopes.base.surface === null);
}

// 9. The runtime's pure resolution function.
process.stdout.write('\n9. DTSkin.resolve\n');
{
    const paramWins = DTSkin.resolve({ param: 'studio', stored: 'house', defaultName: 'house', available: ['house', 'studio'] });
    checkEqual('the URL param wins over the stored value', paramWins, { name: 'studio', source: 'param' });

    const storedUsed = DTSkin.resolve({ stored: 'studio', defaultName: 'house', available: ['house', 'studio'] });
    checkEqual('the stored value is used when there is no param', storedUsed, { name: 'studio', source: 'stored' });

    const defaultUsed = DTSkin.resolve({ defaultName: 'house', available: ['house', 'studio'] });
    checkEqual('the default is used when there is neither', defaultUsed, { name: 'house', source: 'default' });

    const unknownParam = DTSkin.resolve({ param: 'nope', stored: 'studio', defaultName: 'house', available: ['house', 'studio'] });
    checkEqual('an unknown param falls back to the default', unknownParam, { name: 'house', source: 'fallback' });

    const unknownStored = DTSkin.resolve({ stored: 'nope', defaultName: 'house', available: ['house', 'studio'] });
    checkEqual('an unknown stored value falls back to the default', unknownStored, { name: 'house', source: 'fallback' });

    // Without a known list any name is accepted; the stylesheet error
    // event is the real fallback in that case.
    const noList = DTSkin.resolve({ param: 'whatever', defaultName: 'house' });
    checkEqual('without an available list any name is accepted', noList, { name: 'whatever', source: 'param' });

    const unsafe = DTSkin.resolve({ param: '../../etc/passwd', defaultName: 'house' });
    checkEqual('an unsafe name is rejected', unsafe, { name: 'house', source: 'default' });

    checkEqual('the skin name is read from the href', DTSkin.skinFromHref('../assets/skins/house.css'), 'house');
    checkEqual('the sibling href keeps the directory', DTSkin.hrefForSkin('../assets/skins/house.css', 'studio'), '../assets/skins/studio.css');
    checkEqual('the skin param is read from the query', DTSkin.paramFromSearch('?a=1&skin=studio&b=2'), 'studio');
    checkEqual('no skin param reads as null', DTSkin.paramFromSearch('?a=1'), null);
}

// 10. The CLI.
process.stdout.write('\n10. the CLI\n');
{
    const script = path.join(__dirname, 'skin-tokens.js');
    let out = '';
    let code = 0;
    try {
        out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    } catch (err) {
        out = err.stdout || '';
        code = err.status;
    }
    check('the CLI exits 1 with no arguments', code === 1);
    check('the CLI prints usage', /usage:/.test(out));
}

process.stdout.write(`\n[skin-tokens.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    process.stdout.write('failures:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(failed === 0 ? 0 : 1);
