#!/usr/bin/env node
'use strict';

// lib/marketplace-taxonomy.js — the storefront's discovery keywords.
//
// WHAT THIS IS
// The canonical list of the categories the marketplace sells into, and
// the keyword a shopper would type to find them. Seven groups, 41 terms.
//
// WHAT THIS IS NOT
// - Not the Midjourney collection registry (lib/daily-collections.json),
//   which names what gets RENDERED.
// - Not the published catalogue (assets/marketplace/daily/index.json),
//   which names what has been published.
//
// A term carries three things, and the difference matters:
//   label   how the category is written to a shopper — the source's own
//           spelling and capitalisation
//   slug    the URL-safe handle — the programmatic address
//   query   the search keyword to type
//   hint    the word the source used AFTER the bracketed term ("3D models"
//           for blender) — the qualifier, kept so the shelf label can be
//           assembled without losing the source's phrasing
//
// THE ODDITY IS KEPT, NOT CORRECTED
// "spark ar" reads like a truncation of "Spark AR", but the source says
// "spark ar" and this registry's job is to record what the storefront
// says. See the JSON's _oddity-spark-ar note.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, 'marketplace-taxonomy.json');

let _registry = null;

/** The parsed registry. */
function registry() {
    if (_registry) return _registry;
    _registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return _registry;
}

/** Every group, in storefront order. */
function groups() {
    return registry().groups.slice();
}

/** The group names, in storefront order. */
function groupNames() {
    return registry().groups.map(g => g.name);
}

/** One group by its id (kebab-case) or its display name. */
function byGroup(idOrName) {
    const key = String(idOrName || '').toLowerCase();
    const g = registry().groups.find(x =>
        x.id === key || x.name.toLowerCase() === key);
    if (!g) throw new Error(`no taxonomy group '${idOrName}'`);
    return g;
}

/** The terms in one group. */
function termsIn(groupIdOrName) {
    return byGroup(groupIdOrName).terms.slice();
}

/** Every term, across every group. */
function allTerms() {
    const out = [];
    for (const g of registry().groups) {
        for (const t of g.terms) out.push({ ...t, group: g.id, groupName: g.name });
    }
    return out;
}

/** One term by its slug, anywhere in the taxonomy. */
function bySlug(slug) {
    const t = allTerms().find(x => x.slug === slug);
    if (!t) throw new Error(`no taxonomy term with slug '${slug}'`);
    return t;
}

/**
 * The search query for a term — what a shopper types.
 * Falls back to the label when the term carries no explicit query.
 */
function queryFor(slugOrLabel) {
    const key = String(slugOrLabel || '').toLowerCase();
    const t = allTerms().find(x => x.slug === key || x.label.toLowerCase() === key);
    if (!t) throw new Error(`no taxonomy term '${slugOrLabel}'`);
    return t.query || t.label;
}

/**
 * The shelf label for a term — the display term plus its qualifier,
 * e.g. "blender" + "3D models" -> "blender 3D models".
 */
function shelfLabel(slugOrLabel) {
    const key = String(slugOrLabel || '').toLowerCase();
    const t = allTerms().find(x => x.slug === key || x.label.toLowerCase() === key);
    if (!t) throw new Error(`no taxonomy term '${slugOrLabel}'`);
    return t.hint ? `${t.label} ${t.hint}` : t.label;
}

/** The terms of one group, as their search queries. */
function queriesIn(groupIdOrName) {
    return termsIn(groupIdOrName).map(t => t.query || t.label);
}

/** The registry's own notes. */
function notes() {
    const r = registry();
    return {
        note: r._note,
        source: r._source,
        oddity: r['_oddity-spark-ar'],
        schema: r.schema,
    };
}

module.exports = {
    registry,
    groups,
    groupNames,
    byGroup,
    termsIn,
    allTerms,
    bySlug,
    queryFor,
    shelfLabel,
    queriesIn,
    notes,
};

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--groups') {
        for (const g of groups()) {
            console.log(`${g.name}  (${g.terms.length})`);
            for (const t of g.terms) {
                console.log(`   ${t.label.padEnd(26)} -> ${t.slug.padEnd(26)} ${t.query}`);
            }
        }
    } else if (arg === '--one' && process.argv[3]) {
        console.log(JSON.stringify(bySlug(process.argv[3]), null, 2));
    } else {
        console.log('usage: marketplace-taxonomy.js --groups | --one <slug>');
    }
}
