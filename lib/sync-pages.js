#!/usr/bin/env node
//
// sync-pages.js — one page, two URLs.
//
// Every page in `pages/` also exists at the repo root, so a link can
// say `how-to.html` or `pages/how-to.html` and land on the same
// thing. The root copy is the same file with the relative paths
// rewritten one level up (`../assets/x` -> `assets/x`).
//
// They used to be two hand-maintained copies of every page, and they
// drifted. Four root pages kept the `pages/` paths:
//
//   marketplace.html         36 dead image references
//   clip-interrogator.html    1 dead fetch (the samples never load)
//   temple-of-control.html    2 dead scripts + 1 dead doc link
//   how-to.html               1 dead doc link
//
// `../` at the deployment root points off the site, so those were
// 404s on the live pages — and the e2e never saw them, because the
// e2e only loads the `pages/` copies.
//
// So the root copy is now GENERATED from `pages/`, and
// `npm run pages:check` fails the build when the two disagree.
//
//   node lib/sync-pages.js            write the root copies
//   node lib/sync-pages.js --check    report stale copies, exit 1
//
// `index.html` is the exception: the root one is a hand-written
// redirect to `pages/landing.html`, and it is left exactly as it is.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(REPO, 'pages');

/** The root `index.html` is a redirect stub, not a copy. */
const SKIP = new Set(['index.html']);

/**
 * Rewrite the paths that are one level too deep for the repo root.
 *
 * Only inside a quoted value or an argument — `href="../a"`,
 * `fetch('../b')` — so a `../` that happens to appear in prose is
 * left alone.
 */
function toRootPaths(html) {
    return html.replace(/(["'(=])\.\.\//g, '$1');
}

/**
 * Repoint the links to the pages that live only in `pages/`.
 *
 * A page that has no root twin is reachable at `pages/X.html` only.
 * From inside `pages/`, `href="X.html"` already resolves there; from
 * the repo root the same link has to say `pages/X.html`, or it is a
 * dead link. The newer tools (Suno Prompts, IG Autopilot) are
 * reached from the dashboard and the landing, so this is not a
 * corner case.
 */
function toRootLinks(html, onlyInPages) {
    return html.replace(/(["'])([^"'\n]+)\1/g, (m, quote, value) =>
        onlyInPages.has(value) ? `${quote}pages/${value}${quote}` : m);
}

/** The page names that live in `pages/`. */
function pageNames() {
    if (!fs.existsSync(PAGES_DIR)) return [];
    return fs.readdirSync(PAGES_DIR)
        .filter(f => f.endsWith('.html') && !SKIP.has(f))
        .sort();
}

/**
 * The pages that have a copy at the root.
 *
 * Only the ones that already have one. The newer pages live in
 * `pages/` alone and are linked as `pages/X.html`; giving them a root
 * twin too would add URLs nobody asked for.
 */
function rootPages() {
    return pageNames().filter(page => fs.existsSync(path.join(REPO, page)));
}

/** The pages that live in `pages/` but have no copy at the root. */
function pagesOnly() {
    const inPages = new Set(pageNames());
    const atRoot = new Set(fs.existsSync(REPO)
        ? fs.readdirSync(REPO).filter(f => f.endsWith('.html')) : []);
    atRoot.add('index.html');
    return new Set([...inPages].filter(p => !atRoot.has(p)));
}

/** The root copy a `pages/` page should have, as a string. */
function expectedRoot(page) {
    const onlyInPages = pagesOnly();
    const html = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    return toRootLinks(toRootPaths(html), onlyInPages);
}

/** The pages whose root copy is missing or stale. */
function stalePages() {
    const stale = [];
    for (const page of rootPages()) {
        const target = path.join(REPO, page);
        if (!fs.existsSync(target)) { stale.push({ page, why: 'missing' }); continue; }
        if (fs.readFileSync(target, 'utf8') !== expectedRoot(page)) {
            stale.push({ page, why: 'stale' });
        }
    }
    return stale;
}

function main() {
    const check = process.argv.includes('--check');
    const stale = stalePages();
    if (!stale.length) {
        log(check ? 'every root page copy is current' : 'every root page copy is current — nothing to write');
        return 0;
    }
    if (check) {
        for (const { page, why } of stale) {
            log(`stale: ${page} (${why}) — run: npm run pages:sync`);
        }
        fail(`${stale.length} root page copy/copies out of date`);
    }
    for (const { page } of stale) {
        fs.writeFileSync(path.join(REPO, page), expectedRoot(page));
        log(`wrote ${page}`);
    }
    log(`${stale.length} root page copy/copies written`);
    return 0;
}

function log(msg) { process.stderr.write(`${msg}\n`); }
function fail(msg) { process.stderr.write(`\n${msg}\n`); process.exit(1); }

if (require.main === module) {
    try {
        process.exit(main());
    } catch (e) {
        fail(e && e.stack ? e.stack : String(e));
    }
}

module.exports = { toRootPaths, toRootLinks, pageNames, rootPages, pagesOnly, expectedRoot, stalePages };
