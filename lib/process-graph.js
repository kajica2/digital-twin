#!/usr/bin/env node
'use strict';
/**
 * lib/process-graph.js — allowlisted process packages for the twin.
 *
 * A process graph is a named pipeline of shell commands (nodes) with
 * directed edges between them. The catalog lives at
 * data/twin/process-graphs.json and is the only source of truth: the
 * CLI, the API, and the <process-graph> page all read it.
 *
 *   node lib/process-graph.js --list
 *   node lib/process-graph.js --show lyrics-to-frames
 *   node lib/process-graph.js --dry-run lyrics-to-frames
 *   node lib/process-graph.js --apply index-songs
 *
 * Dry-run prints the plan and exits without spawning anything.
 * Apply runs each required node in topological order (optional nodes
 * are skipped unless --with-optional is passed).
 *
 * Pure CommonJS. No network. The catalog path is overridable via
 * PROCESS_GRAPH_CATALOG for tests.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_CATALOG = path.join(REPO, 'data', 'twin', 'process-graphs.json');

function catalogPath() {
  return process.env.PROCESS_GRAPH_CATALOG
    ? path.resolve(process.env.PROCESS_GRAPH_CATALOG)
    : DEFAULT_CATALOG;
}

function loadCatalog(filePath) {
  const p = filePath || catalogPath();
  if (!fs.existsSync(p)) {
    throw Object.assign(new Error(`process-graphs catalog not found: ${p}`), { code: 'ENOENT' });
  }
  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error(`process-graphs catalog is not valid JSON: ${p}`), { cause: err });
  }
  if (!data || !Array.isArray(data.packages)) {
    throw new Error('process-graphs catalog must have a packages array');
  }
  return data;
}

function listPackages(catalog) {
  return (catalog.packages || []).map((pkg) => ({
    id: pkg.id,
    title: pkg.title,
    summary: pkg.summary || '',
    browserOk: !!pkg.browserOk,
    nodes: (pkg.nodes || []).length,
    edges: (pkg.edges || []).length,
  }));
}

function getPackage(catalog, id) {
  if (!id) return null;
  return (catalog.packages || []).find((pkg) => pkg.id === id) || null;
}

function nodeMap(pkg) {
  const map = new Map();
  for (const node of pkg.nodes || []) {
    if (!node || !node.id) continue;
    map.set(node.id, node);
  }
  return map;
}

/**
 * Kahn topological order over required (or all) nodes.
 * Optional nodes are included only when withOptional is true.
 * Isolated nodes with no edges still appear, in catalog order.
 */
function planOrder(pkg, { withOptional = false } = {}) {
  const nodes = (pkg.nodes || []).filter((n) => withOptional || !n.optional);
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));

  for (const edge of pkg.edges || []) {
    if (!Array.isArray(edge) || edge.length < 2) continue;
    const [from, to] = edge;
    if (!idSet.has(from) || !idSet.has(to)) continue;
    adj.get(from).push(to);
    indeg.set(to, (indeg.get(to) || 0) + 1);
  }

  const queue = ids.filter((id) => (indeg.get(id) || 0) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== ids.length) {
    // Cycle — fall back to catalog order so the plan is still printable.
    return ids;
  }
  return order;
}

function buildPlan(pkg, opts = {}) {
  const withOptional = !!opts.withOptional;
  const order = planOrder(pkg, { withOptional });
  const map = nodeMap(pkg);
  return order.map((id, i) => {
    const node = map.get(id);
    return {
      step: i + 1,
      id: node.id,
      label: node.label || node.id,
      cmd: node.cmd,
      optional: !!node.optional,
      note: node.note || null,
    };
  });
}

function formatPlan(pkg, plan) {
  const lines = [];
  lines.push(`# ${pkg.title} (${pkg.id})`);
  if (pkg.summary) lines.push(pkg.summary);
  lines.push(`browserOk=${!!pkg.browserOk}  steps=${plan.length}`);
  lines.push('');
  for (const step of plan) {
    const opt = step.optional ? ' [optional]' : '';
    lines.push(`${step.step}. ${step.label}${opt}`);
    lines.push(`   $ ${step.cmd}`);
    if (step.note) lines.push(`   # ${step.note}`);
  }
  return lines.join('\n');
}

function shellSplit(cmd) {
  // Minimal argv split for npm/node commands with quoted segments.
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function runStep(step, { cwd = REPO, dryRun = false, dryRunFlag = null } = {}) {
  let cmd = step.cmd;
  if (dryRun && dryRunFlag && !cmd.includes(dryRunFlag)) {
    cmd = `${cmd} ${dryRunFlag}`;
  }
  if (dryRun && !dryRunFlag) {
    return { id: step.id, status: 'skipped', reason: 'dry-run (no flag)', cmd };
  }
  const argv = shellSplit(cmd);
  if (!argv.length) {
    return { id: step.id, status: 'error', reason: 'empty command', cmd };
  }
  // Refuse placeholders — an apply that still has <slug> would do the wrong thing.
  if (/<[^>]+>/.test(cmd)) {
    return {
      id: step.id,
      status: 'error',
      reason: 'command still has placeholders — fill them before --apply',
      cmd,
    };
  }
  const bin = argv[0];
  const args = argv.slice(1);
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
  return {
    id: step.id,
    status: result.status === 0 ? 'ok' : 'error',
    code: result.status,
    cmd,
    stdout: (result.stdout || '').slice(0, 4000),
    stderr: (result.stderr || '').slice(0, 4000),
  };
}

function applyPackage(pkg, opts = {}) {
  const plan = buildPlan(pkg, opts);
  const results = [];
  for (const step of plan) {
    if (step.optional && !opts.withOptional) {
      results.push({ id: step.id, status: 'skipped', reason: 'optional' });
      continue;
    }
    const r = runStep(step, {
      cwd: opts.cwd || REPO,
      dryRun: !!opts.dryRun,
      dryRunFlag: opts.dryRun ? (pkg.dryRunFlag || null) : null,
    });
    results.push(r);
    if (r.status === 'error' && !opts.continueOnError) break;
  }
  return results;
}

function usage() {
  return [
    'Usage: node lib/process-graph.js --list',
    '       node lib/process-graph.js --show <id>',
    '       node lib/process-graph.js --dry-run <id>',
    '       node lib/process-graph.js --apply <id> [--with-optional]',
    '',
    'Catalog: data/twin/process-graphs.json',
    'Override with PROCESS_GRAPH_CATALOG=/path/to/catalog.json',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { list: false, show: null, dryRun: null, apply: null, withOptional: false, json: false, help: false };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--show') args.show = argv[++i] || null;
    else if (a === '--dry-run') args.dryRun = argv[++i] || null;
    else if (a === '--apply') args.apply = argv[++i] || null;
    else if (a === '--with-optional') args.withOptional = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else unknown.push(a);
  }
  return { args, unknown };
}

function main(argv = process.argv.slice(2)) {
  const { args, unknown } = parseArgs(argv);
  if (args.help || (!args.list && !args.show && !args.dryRun && !args.apply)) {
    process.stdout.write(usage() + '\n');
    return unknown.length ? 2 : 0;
  }
  if (unknown.length) {
    process.stderr.write(`unknown flag(s): ${unknown.join(' ')}\n${usage()}\n`);
    return 2;
  }

  let catalog;
  try {
    catalog = loadCatalog();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  if (args.list) {
    const rows = listPackages(catalog);
    if (args.json) {
      process.stdout.write(JSON.stringify({ packages: rows }, null, 2) + '\n');
    } else {
      for (const row of rows) {
        const ok = row.browserOk ? 'browser' : 'local';
        process.stdout.write(`${row.id.padEnd(20)} ${ok.padEnd(8)} ${row.nodes}n  ${row.title}\n`);
      }
    }
    return 0;
  }

  const id = args.show || args.dryRun || args.apply;
  const pkg = getPackage(catalog, id);
  if (!pkg) {
    process.stderr.write(`unknown package: ${id}\n`);
    process.stderr.write(`known: ${listPackages(catalog).map((p) => p.id).join(', ')}\n`);
    return 2;
  }

  if (args.show) {
    const plan = buildPlan(pkg, { withOptional: true });
    if (args.json) {
      process.stdout.write(JSON.stringify({ package: pkg, plan }, null, 2) + '\n');
    } else {
      process.stdout.write(formatPlan(pkg, plan) + '\n');
    }
    return 0;
  }

  if (args.dryRun) {
    const plan = buildPlan(pkg, { withOptional: args.withOptional });
    if (args.json) {
      process.stdout.write(JSON.stringify({ id: pkg.id, dryRun: true, plan }, null, 2) + '\n');
    } else {
      process.stdout.write(formatPlan(pkg, plan) + '\n');
      process.stdout.write('\n(dry-run — nothing executed)\n');
    }
    return 0;
  }

  // --apply
  if (pkg.browserOk === false && process.env.PROCESS_GRAPH_FORCE !== '1') {
    // Still allow apply from the CLI; the API is what gates browserOk.
  }
  const results = applyPackage(pkg, {
    withOptional: args.withOptional,
    dryRun: false,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify({ id: pkg.id, results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      const mark = r.status === 'ok' ? 'ok' : r.status === 'skipped' ? 'skip' : 'FAIL';
      process.stdout.write(`[${mark}] ${r.id}${r.reason ? ' — ' + r.reason : ''}\n`);
      if (r.cmd) process.stdout.write(`      $ ${r.cmd}\n`);
      if (r.stderr) process.stdout.write(r.stderr.split('\n').slice(0, 8).map((l) => `      ${l}`).join('\n') + '\n');
    }
  }
  return results.some((r) => r.status === 'error') ? 1 : 0;
}

module.exports = {
  REPO,
  catalogPath,
  loadCatalog,
  listPackages,
  getPackage,
  planOrder,
  buildPlan,
  formatPlan,
  shellSplit,
  runStep,
  applyPackage,
  parseArgs,
  main,
};

if (require.main === module) {
  process.exit(main());
}
