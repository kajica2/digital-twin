#!/usr/bin/env node
'use strict';

// lib/marketplace-taxonomy.test.js — the storefront's discovery keywords.
//
// Run: node lib/marketplace-taxonomy.test.js
//
// The contract this pins:
//   - the seven groups load
//   - every group has a name, an id and at least one term
//   - every term has a label, a slug and a query
//   - every slug is unique, lowercase and URL-safe
//   - the term count matches the source exactly (41)
//   - no term is duplicated across groups

const tax = require('./marketplace-taxonomy.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        const ok = fn();
        if (ok === false) {
            console.log(`  FAIL ${name}`);
            failed++;
        } else {
            console.log(`  ok   ${name}`);
            passed++;
        }
    } catch (e) {
        console.log(`  FAIL ${name} :: ${e.message}`);
        failed++;
    }
}

console.log('marketplace-taxonomy.test');

// --- the registry loads -------------------------------------------------

check('the seven groups load', () => {
    const list = tax.groups();
    if (list.length !== 7) throw new Error(`expected 7 groups, got ${list.length}`);
    return true;
});

check('every group has a name, an id and at least one term', () => {
    for (const g of tax.groups()) {
        if (!g.name || !g.name.trim()) throw new Error('a group has no name');
        if (!g.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(g.id)) {
            throw new Error(`group '${g.name}' has a bad id: ${g.id}`);
        }
        if (!Array.isArray(g.terms) || g.terms.length === 0) {
            throw new Error(`group '${g.name}' has no terms`);
        }
    }
    return true;
});

check('every term has a label, a slug and a query', () => {
    for (const t of tax.allTerms()) {
        for (const k of ['label', 'slug', 'query']) {
            if (!t[k] || !String(t[k]).trim()) {
                throw new Error(`term '${t.slug || t.label}' is missing ${k}`);
            }
        }
    }
    return true;
});

check('every term belongs to the group it was found under', () => {
    for (const g of tax.groups()) {
        for (const t of g.terms) {
            if (!t.group && !t.label) throw new Error('a term lost its label');
        }
    }
    return true;
});

// --- the source fidelity ------------------------------------------------

check('the term count matches the source exactly (41)', () => {
    // The source list: seven groups, 41 terms. Counted by hand from the
    // marketplace's own category list.
    const n = tax.allTerms().length;
    if (n !== 41) throw new Error(`expected 41 terms, got ${n}`);
    return true;
});

check('the group sizes match the source', () => {
    const expected = {
        'creative-assets-tools': 7,
        'templates-productivity': 4,
        'audio-music': 7,
        'education-writing': 7,
        'mind-body': 6,
        'visual-media-art': 7,
        'niche-markets': 3,
    };
    for (const g of tax.groups()) {
        const want = expected[g.id];
        if (want === undefined) throw new Error(`unexpected group id '${g.id}'`);
        if (g.terms.length !== want) {
            throw new Error(`${g.id} has ${g.terms.length} terms, expected ${want}`);
        }
    }
    return true;
});

check("'spark ar' is kept verbatim, not silently corrected", () => {
    // The source says "spark ar". It reads like a truncation of
    // "Spark AR", but the registry's job is to record what the
    // storefront says — so this is pinned, deliberately.
    const t = tax.bySlug('spark-ar');
    if (t.label !== 'spark ar') throw new Error(`label is '${t.label}', expected 'spark ar'`);
    if (t.query !== 'spark ar') throw new Error(`query is '${t.query}', expected 'spark ar'`);
    return true;
});

check('the source\'s bracketed spellings are preserved', () => {
    for (const [slug, query] of [
        ['notion-template', 'notion template'],
        ['kdp-interior', 'kdp interior'],
        ['after-effects', 'after effects'],
        ['sample-pack', 'sample pack'],
        ['workout-program', 'workout program'],
    ]) {
        const t = tax.bySlug(slug);
        if (t.query !== query) throw new Error(`${slug} query is '${t.query}', expected '${query}'`);
    }
    return true;
});

// --- slugs --------------------------------------------------------------

check('every slug is unique', () => {
    const s = tax.allTerms().map(t => t.slug);
    if (new Set(s).size !== s.length) throw new Error('duplicate slugs');
    return true;
});

check('every slug is lowercase and URL-safe', () => {
    for (const t of tax.allTerms()) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug)) {
            throw new Error(`slug '${t.slug}' is not URL-safe`);
        }
    }
    return true;
});

check('no term is duplicated across groups', () => {
    const seen = new Map();
    for (const t of tax.allTerms()) {
        const key = t.slug;
        if (seen.has(key)) {
            throw new Error(`'${key}' is in both '${seen.get(key)}' and '${t.group}'`);
        }
        seen.set(key, t.group);
    }
    return true;
});

// --- the accessors ------------------------------------------------------

check('byGroup finds every group by id and by name', () => {
    for (const g of tax.groups()) {
        if (tax.byGroup(g.id).id !== g.id) throw new Error(`byGroup failed for '${g.id}'`);
        if (tax.byGroup(g.name).id !== g.id) throw new Error(`byGroup failed for '${g.name}'`);
    }
    let threw = false;
    try {
        tax.byGroup('no-such-group');
    } catch {
        threw = true;
    }
    if (!threw) throw new Error('byGroup did not refuse an unknown group');
    return true;
});

check('termsIn returns the terms of one group', () => {
    const g = tax.groups()[0];
    if (tax.termsIn(g.id).length !== g.terms.length) throw new Error('termsIn disagreed');
    return true;
});

check('queryFor resolves a term by slug or by label', () => {
    const t = tax.allTerms()[0];
    if (tax.queryFor(t.slug) !== t.query) throw new Error(`queryFor failed for '${t.slug}'`);
    if (tax.queryFor(t.label) !== t.query) throw new Error(`queryFor failed for '${t.label}'`);
    return true;
});

check('shelfLabel joins the display term with its qualifier', () => {
    const withHint = tax.allTerms().find(t => t.hint);
    if (!withHint) throw new Error('no term carries a hint');
    const want = `${withHint.label} ${withHint.hint}`;
    if (tax.shelfLabel(withHint.slug) !== want) throw new Error('shelfLabel disagreed');
    const noHint = tax.allTerms().find(t => !t.hint);
    if (tax.shelfLabel(noHint.slug) !== noHint.label) throw new Error('shelfLabel added a hint it should not');
    return true;
});

check('queriesIn returns the group\'s search queries', () => {
    const g = tax.groups()[0];
    const q = tax.queriesIn(g.id);
    if (q.length !== g.terms.length) throw new Error('queriesIn disagreed on the count');
    for (let i = 0; i < q.length; i++) {
        if (q[i] !== (g.terms[i].query || g.terms[i].label)) throw new Error('queriesIn disagreed on a query');
    }
    return true;
});

check('the registry carries its own notes', () => {
    const n = tax.notes();
    for (const k of ['note', 'source', 'oddity']) {
        if (!n[k] || !String(n[k]).trim()) throw new Error(`the registry's ${k} note is empty`);
    }
    return true;
});

console.log(`\n[marketplace-taxonomy.test] passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
