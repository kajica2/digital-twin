#!/usr/bin/env node
'use strict';
/**
 * lib/process-graph.test.js — offline suite for the process-graph catalog.
 * No network, no browser, no real spawn for apply (placeholder refusal).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadCatalog,
  listPackages,
  getPackage,
  planOrder,
  buildPlan,
  formatPlan,
  shellSplit,
  applyPackage,
  parseArgs,
  main,
} = require('./process-graph.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const FIXTURE = {
  version: 1,
  packages: [
    {
      id: 'demo',
      title: 'Demo pipeline',
      summary: 'A tiny graph for tests.',
      browserOk: true,
      dryRunFlag: '--help',
      nodes: [
        { id: 'a', label: 'First', cmd: 'echo a', optional: false },
        { id: 'b', label: 'Second', cmd: 'echo b', optional: false },
        { id: 'c', label: 'Optional third', cmd: 'echo c', optional: true },
      ],
      edges: [['a', 'b'], ['b', 'c']],
    },
    {
      id: 'lyrics-to-frames',
      title: 'Lyrics → frames',
      browserOk: true,
      nodes: [
        { id: 'pack', label: 'Pack', cmd: 'node lib/mj-prompt-generator.js --idea "<x>" --out out.md' },
        { id: 'frames', label: 'Frames', cmd: 'npm run mj:frames -- --pack mj-output/x' },
      ],
      edges: [['pack', 'frames']],
    },
    {
      id: 'next-in-order',
      title: 'Next in order',
      browserOk: false,
      nodes: [{ id: 'direct', label: 'Direct', cmd: 'npm run story:direct -- --versions 1' }],
      edges: [],
    },
    {
      id: 'evolution',
      title: 'Evolution',
      browserOk: false,
      nodes: [{ id: 'direct', label: 'Direct', cmd: 'npm run story:direct -- --versions 3' }],
      edges: [],
    },
    {
      id: 'mutation',
      title: 'Mutation',
      browserOk: false,
      nodes: [
        {
          id: 'dry',
          label: 'Dry',
          cmd: 'npm run mj:revise -- --source <job-id> --prompt-file <pack.md> --dry-run',
          optional: false,
        },
        {
          id: 'apply',
          label: 'Apply',
          cmd: 'npm run mj:revise -- --source <job-id> --prompt-file <pack.md>',
          optional: false,
        },
      ],
      edges: [['dry', 'apply']],
    },
  ],
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-graph-'));
const catalogFile = path.join(tmpDir, 'process-graphs.json');
fs.writeFileSync(catalogFile, JSON.stringify(FIXTURE, null, 2));
process.env.PROCESS_GRAPH_CATALOG = catalogFile;

// ---- load / list / get ----
{
  const catalog = loadCatalog();
  check('loads the fixture catalog', catalog.packages.length === 5);
  const rows = listPackages(catalog);
  check('lists five packages', rows.length === 5);
  check('list carries browserOk', rows.find((r) => r.id === 'demo').browserOk === true);
  check('getPackage finds demo', !!getPackage(catalog, 'demo'));
  check('getPackage misses unknown', getPackage(catalog, 'nope') === null);
}

// ---- the four MJ flows are seeded ----
{
  const catalog = loadCatalog();
  const ids = listPackages(catalog).map((p) => p.id);
  check('catalog has lyrics-to-frames', ids.includes('lyrics-to-frames'));
  check('catalog has next-in-order', ids.includes('next-in-order'));
  check('catalog has evolution', ids.includes('evolution'));
  check('catalog has mutation', ids.includes('mutation'));
}

// ---- plan order ----
{
  const catalog = loadCatalog();
  const demo = getPackage(catalog, 'demo');
  const required = planOrder(demo, { withOptional: false });
  check('required plan is a then b', required.join(',') === 'a,b');
  const all = planOrder(demo, { withOptional: true });
  check('full plan is a then b then c', all.join(',') === 'a,b,c');
  const plan = buildPlan(demo, { withOptional: false });
  check('buildPlan steps are numbered', plan[0].step === 1 && plan[1].step === 2);
  check('buildPlan skips optional by default', plan.length === 2);
  const text = formatPlan(demo, buildPlan(demo, { withOptional: true }));
  check('formatPlan names the package', text.includes('Demo pipeline') && text.includes('demo'));
  check('formatPlan shows the optional marker', text.includes('[optional]'));
}

// ---- shellSplit ----
{
  check('shellSplit plain', shellSplit('npm run index-songs').join('|') === 'npm|run|index-songs');
  check(
    'shellSplit keeps quoted segments',
    shellSplit('node x.js --idea "hello world" --out out.md').join('|') ===
      'node|x.js|--idea|hello world|--out|out.md'
  );
}

// ---- apply refuses placeholders (no spawn) ----
{
  const catalog = loadCatalog();
  const mut = getPackage(catalog, 'mutation');
  const results = applyPackage(mut, { withOptional: false });
  // First required node still has <job-id> / <pack.md>, so apply must
  // refuse before any child process starts — and never reach 'apply'.
  check('apply stops on the first placeholder', results.length === 1);
  check(
    'apply refuses placeholder commands',
    results[0] &&
      results[0].id === 'dry' &&
      results[0].status === 'error' &&
      /placeholder/i.test(results[0].reason || ''),
    results[0] && results[0].reason
  );
}

// ---- parseArgs / main ----
{
  const { args, unknown } = parseArgs(['--list', '--json']);
  check('parseArgs --list', args.list === true && args.json === true);
  check('parseArgs no unknown', unknown.length === 0);
  const bad = parseArgs(['--wat']);
  check('parseArgs collects unknown', bad.unknown.includes('--wat'));
}

{
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  const code = main(['--list']);
  process.stdout.write = orig;
  check('main --list exits 0', code === 0);
  check('main --list prints lyrics-to-frames', out.includes('lyrics-to-frames'));
  check('main --list prints evolution', out.includes('evolution'));
}

{
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  const code = main(['--dry-run', 'demo']);
  process.stdout.write = orig;
  check('main --dry-run exits 0', code === 0);
  check('main --dry-run prints the plan', out.includes('First') && out.includes('echo a'));
  check('main --dry-run says nothing executed', /dry-run/i.test(out));
}

{
  let err = '';
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  const code = main(['--show', 'does-not-exist']);
  process.stderr.write = orig;
  check('main --show unknown exits 2', code === 2);
  check('main --show unknown names the id', /does-not-exist/.test(err));
}

{
  const code = main(['--help']);
  check('main --help exits 0', code === 0);
}

{
  // Real shipped catalog still loads and has the four MJ flows.
  delete process.env.PROCESS_GRAPH_CATALOG;
  const shipped = loadCatalog();
  const ids = listPackages(shipped).map((p) => p.id);
  check('shipped catalog has lyrics-to-frames', ids.includes('lyrics-to-frames'));
  check('shipped catalog has next-in-order', ids.includes('next-in-order'));
  check('shipped catalog has evolution', ids.includes('evolution'));
  check('shipped catalog has mutation', ids.includes('mutation'));
  check('shipped catalog has chart-export', ids.includes('chart-export'));
  check('shipped catalog has index-songs', ids.includes('index-songs'));
  const lyrics = getPackage(shipped, 'lyrics-to-frames');
  check('lyrics-to-frames has ≥3 nodes', lyrics.nodes.length >= 3);
  check('lyrics-to-frames is browserOk', lyrics.browserOk === true);
  const evo = getPackage(shipped, 'evolution');
  check('evolution mentions versions 3', /versions 3|--versions 3/.test(JSON.stringify(evo)));
  const next = getPackage(shipped, 'next-in-order');
  check('next-in-order mentions versions 1', /versions 1|--versions 1/.test(JSON.stringify(next)));
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
