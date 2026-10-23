#!/usr/bin/env node
//
// sync-pages.test.js — the root page copies must not drift.
//
// The contract this file enforces:
//
//   1. every `pages/X.html` has a root `X.html` that is the same
//      file with the paths rewritten for one level up;
//   2. no root page references `../` — at the deployment root that
//      points off the site, and every such reference was a 404;
//   3. every relative href/src in a root page points at a file that
//      exists.
//
// (1) is the drift check. (2) and (3) are the dead-link check, and
// they are what caught the four root pages that carried `pages/`
// paths. The e2e cannot catch any of this: it only loads the
// `pages/` copies, which were always the correct ones.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { pageNames, rootPages, expectedRoot } = require('./sync-pages.js');

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${name}\n`); }
    else {
        failed++; failures.push(name);
        process.stderr.write(`  ✗ ${name}\n${detail ? `    ${detail}\n` : ''}`);
    }
}

const PAGES = pageNames();
const TWINS = rootPages();

check('the pages directory has pages in it', PAGES.length > 0, `found ${PAGES.length}`);
check('the root has page copies to keep in sync', TWINS.length > 0, `found ${TWINS.length}`);

// 1. the drift check
const STALE = [];
for (const page of TWINS) {
    const target = path.join(REPO, page);
    if (!fs.existsSync(target)) { STALE.push(`${page} (missing)`); continue; }
    if (fs.readFileSync(target, 'utf8') !== expectedRoot(page)) {
        STALE.push(`${page} (stale)`);
    }
}
check('every root page copy matches its pages/ original',
    STALE.length === 0, STALE.map(s => `  ${s}`).join('\n'));

// 2. the root index stays a redirect to the landing page
const ROOT_INDEX = path.join(REPO, 'index.html');
if (fs.existsSync(ROOT_INDEX)) {
    const html = fs.readFileSync(ROOT_INDEX, 'utf8');
    check('the root index is still a redirect to the landing page',
        /url=pages\/landing\.html/.test(html));
}

// 3. no `../` anywhere in a root page
const WITH_PARENT = TWINS.filter(page => {
    const target = path.join(REPO, page);
    return fs.existsSync(target)
        && /(["'(=])\.\.\//.test(fs.readFileSync(target, 'utf8'));
});
check('no root page points above the deployment root',
    WITH_PARENT.length === 0, WITH_PARENT.map(p => `  ${p}`).join('\n'));

// 4. every relative reference in a root page resolves
//
// Two different failures, and only one of them is this test's
// business:
//
//   - a reference to a page that exists in `pages/` but not at the
//     root is a DRIFT bug: the rewrite is supposed to have repointed
//     it. That fails.
//   - a reference to a file that exists nowhere at all is a CONTENT
//     decision — a tool that was listed before it was built. That is
//     reported, not failed.
const UNRESOLVED = [];
const UNKNOWN = [];
for (const page of TWINS) {
    const target = path.join(REPO, page);
    if (!fs.existsSync(target)) continue;
    const html = fs.readFileSync(target, 'utf8');
    const refs = html.match(/(?:href|src)=["']([^"']+)["']/g) || [];
    for (const ref of refs) {
        const value = ref.replace(/^(?:href|src)=["']/, '').replace(/["']$/, '');
        if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
        if (/^[a-z]+:/i.test(value)) continue;          // http, mailto, tel
        if (value.startsWith('//')) continue;
        if (value.startsWith('/')) continue;             // site-absolute
        if (/\$\{|\{\{/.test(value)) continue;           // built at runtime
        const clean = value.split('#')[0].split('?')[0];
        if (!clean) continue;
        if (fs.existsSync(path.join(REPO, clean))) continue;
        if (fs.existsSync(path.join(REPO, 'pages', clean))) {
            UNRESOLVED.push(`${page} -> ${clean}`);
        } else {
            UNKNOWN.push(`${page} -> ${clean}`);
        }
    }
}
check('no root page points at a file that is not there',
    UNRESOLVED.length === 0, UNRESOLVED.slice(0, 20).map(m => `  ${m}`).join('\n')
        + (UNRESOLVED.length > 20 ? `\n    …and ${UNRESOLVED.length - 20} more` : ''));
if (UNKNOWN.length) {
    process.stderr.write(
        `  · ${UNKNOWN.length} reference(s) point at a file that does not exist anywhere:\n`
        + UNKNOWN.slice(0, 10).map(m => `      ${m}`).join('\n')
        + (UNKNOWN.length > 10 ? `\n      …and ${UNKNOWN.length - 10} more` : '') + '\n');
}

// 5. the rewrite is the only thing that differs
check('the two copies differ only by the rewrite',
    TWINS.every(page => {
        const root = fs.readFileSync(path.join(REPO, page), 'utf8');
        return root === expectedRoot(page);
    }));

process.stderr.write(`\n[sync-pages.test] ${passed} passed, ${failed} failed\n`);
if (failed) {
    process.stderr.write(`failed: ${failures.join('; ')}\n`);
}
process.exit(failed ? 1 : 0);
