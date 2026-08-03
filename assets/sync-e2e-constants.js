#!/usr/bin/env node
// assets/sync-e2e-constants.js
//
// Auto-updater for the digital_twin e2e constants. Sibling to
// landing.spec.mjs, same pure-Node, no-deps style.
//
// The e2e hardcodes 5 counts (feature cards, demo panes, architecture
// levels, domain twins, flow nodes). They are the sprint-0 contract.
// When the landing page changes — sprint 1 adds a 5th architecture
// level, sprint 2 swaps a 6-feature variant for 7 — those numbers
// need to update. Hunting through the test to find every line is
// error-prone. This script reads the live page, counts the actual
// elements, and patches the assertions in lockstep.
//
// Usage:
//   node assets/sync-e2e-constants.js          # dry run, prints diff
//   node assets/sync-e2e-constants.js --apply  # writes the changes
//   node assets/sync-e2e-constants.js --apply --yes  # skip the prompt
//
// Exit:
//   0  on success (or no-op when already consistent)
//   1  on filesystem error
//   2  on conflict (variants disagree, or page shape changed)
//
// Scope (matches the 5 assertions in landing.spec.mjs):
//   - feature-card count      (per variant, from VARIANTS.features[].length)
//   - demo-pane count         (static, from class="demo-pane" in HTML)
//   - level count             (static, from class="level" in HTML)
//   - twin-card count         (static, from class="twin-card" in HTML)
//   - flow-node count         (static, from class="flow-node " in HTML)
//
// What it does NOT touch:
//   - consoleErrors count (that's 0 by design — not a contract number)
//   - any other assertion in the file

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const YES = ARGV.includes('--yes');

const PAGE = path.join(ROOT, 'pages', 'landing.html');
const TEST = path.join(ROOT, 'e2e', 'landing.spec.mjs');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// --- 1. Count features per variant from the VARIANTS data block ---
// The landing uses a literal `const VARIANTS = { '1': {...}, ... }`
// shape; we count `title:` occurrences inside each `features: [ ... ]`
// array. title appears exactly once per feature entry, so this is
// the canonical "how many features in this variant" measurement.
function countFeaturesPerVariant(html) {
  const m = html.match(/const\s+VARIANTS\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) throw new Error('Could not find `const VARIANTS = { ... };` block in landing.html');
  const block = m[1];

  const counts = {};
  const variantRe = /'([123])'\s*:\s*\{[\s\S]*?features:\s*\[([\s\S]*?)\]/g;
  let vm;
  while ((vm = variantRe.exec(block)) !== null) {
    const v = vm[1];
    const body = vm[2];
    const titleMatches = body.match(/title:/g) || [];
    counts[v] = titleMatches.length;
  }
  return counts;
}

// --- 2. Static counts from the rendered HTML (these are the same in
// every variant — they're not inside any variant block).
function countStatic(html, cls) {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`class="(?:[^"]*\\s)?${escaped}(?:\\s[^"]*)?"`, 'g');
  return (html.match(re) || []).length;
}

// --- Read both files ---
const html = read(PAGE);
const test = read(TEST);

// --- Compute the live counts ---
const featureCounts = countFeaturesPerVariant(html);
const featureCountValues = Object.values(featureCounts);
if (featureCountValues.length === 0) {
  console.error('FAIL: no variant features found in pages/landing.html');
  process.exit(2);
}
const allVariantsAgree = featureCountValues.every(c => c === featureCountValues[0]);
const featureCount = featureCountValues[0];

const demoPaneCount = countStatic(html, 'demo-pane');
const levelCount = countStatic(html, 'level');
const twinCardCount = countStatic(html, 'twin-card');
const flowNodeCount = countStatic(html, 'flow-node');

const live = {
  'feature cards (per variant)': featureCount,
  'demo panes': demoPaneCount,
  'architecture levels': levelCount,
  'domain twin cards': twinCardCount,
  'flow nodes': flowNodeCount,
};

// --- Read current values from the test file ---
function currentFromTest(test, varName) {
  const re = new RegExp(`assert\\(${varName}\\s*===\\s*(\\d+)`);
  const m = test.match(re);
  return m ? parseInt(m[1], 10) : null;
}

const current = {
  'feature cards (per variant)': currentFromTest(test, 'fc'),
  'demo panes': currentFromTest(test, 'paneCount'),
  'architecture levels': currentFromTest(test, 'lv'),
  'domain twin cards': currentFromTest(test, 'dt'),
  'flow nodes': currentFromTest(test, 'flow'),
};

// --- Conflict checks ---
const conflicts = [];
if (!allVariantsAgree) {
  conflicts.push(`variants disagree on feature count: ${JSON.stringify(featureCounts)}`);
}
for (const [k, v] of Object.entries(live)) {
  if (v === 0) conflicts.push(`${k} = 0 in landing.html — page shape changed?`);
}
for (const [k, v] of Object.entries(current)) {
  if (v === null) conflicts.push(`could not find assertion in test for ${k}`);
}

// --- Plan edits ---
// Pattern: assert(VAR === N, `MESSAGE WITH N`). We rewrite both Ns.
const edits = [];

function makeEdit(varName, currentN, newN) {
  const re = new RegExp(`assert\\(${varName}\\s*===\\s*\\d+,\\s*\`([^\`]*?)\`\\);`);
  const m = test.match(re);
  if (!m) return null;
  const oldMsg = m[1];
  const oldNStr = String(currentN);
  const newMsg = oldMsg.split(oldNStr).join(String(newN));
  const oldLine = `assert(${varName} === ${currentN}, \`${oldMsg}\`);`;
  const newLine = `assert(${varName} === ${newN}, \`${newMsg}\`);`;
  return { varName, oldLine, newLine, oldN: currentN, newN };
}

const editMap = [
  { key: 'feature cards (per variant)', varName: 'fc' },
  { key: 'demo panes', varName: 'paneCount' },
  { key: 'architecture levels', varName: 'lv' },
  { key: 'domain twin cards', varName: 'dt' },
  { key: 'flow nodes', varName: 'flow' },
];

for (const { key, varName } of editMap) {
  const cur = current[key];
  const liveVal = live[key];
  if (cur === null) continue;
  if (cur === liveVal) continue;
  const edit = makeEdit(varName, cur, liveVal);
  if (edit) edits.push(edit);
}

// --- Report ---
console.log(`Live page counts (from pages/landing.html):`);
for (const [k, v] of Object.entries(live)) {
  const cur = current[k];
  const suffix = cur !== null ? `  (test says ${cur})` : '';
  console.log(`  ${k.padEnd(30)} ${v}${suffix}`);
}
console.log('');
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
console.log('');

if (conflicts.length > 0) {
  console.log(`${conflicts.length} conflict(s) — refusing to run safely:`);
  for (const c of conflicts) console.log(`  ! ${c}`);
  console.log('');
  console.log('Fix the underlying drift first, then re-run.');
  process.exit(2);
}

if (edits.length === 0) {
  console.log('No edits needed. Test is consistent with the page.');
  process.exit(0);
}

console.log(`${edits.length} edit(s) planned in e2e/landing.spec.mjs:`);
for (const e of edits) {
  console.log(`  ${e.varName}: ${e.oldN} → ${e.newN}`);
  console.log(`    - ${e.oldLine}`);
  console.log(`    + ${e.newLine}`);
}
console.log('');

function applyEdits() {
  if (!YES) {
    console.log('Apply? [y/N]');
    process.stdout.write('> ');
    const buf = fs.readFileSync(0, 'utf8');
    if (buf.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }
  let updated = test;
  for (const e of edits) {
    if (!updated.includes(e.oldLine)) {
      console.error(`  ! ${e.varName}: pattern vanished between read and write. Aborting.`);
      process.exit(1);
    }
    updated = updated.replace(e.oldLine, e.newLine);
  }
  fs.writeFileSync(TEST, updated, 'utf8');
  console.log(`Wrote ${edits.length} edit(s). Run \`cd e2e && node landing.spec.mjs\` to verify.`);
  process.exit(0);
}

if (APPLY) {
  applyEdits();
} else {
  console.log('Re-run with --apply to write these edits. --yes skips the prompt.');
  process.exit(0);
}
