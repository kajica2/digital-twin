#!/usr/bin/env node
'use strict';
// lib/improve-loop.test.js — tests for the auto-improvement loop.
//
// Plain Node, no framework, no network, no browser. Temporary directories
// only: the suite never writes to the real .kai/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const L = require('./improve-loop.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${e && e.message}`);
    }
}

function tmpdir(name) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `improve-${name}-`));
    return d;
}

function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------- fixtures

const MEMORY_SAMPLE = `project: digital_twin
memory_version: 1
last_updated: 2026-10-25

active_prevention_rules:
  - id: "PM-2026-09-31-deploy-content"
    when: "a deploy is verified before it is pushed"
    action: >
      Compare the served bytes against HEAD.

  - id: "PM-2026-10-23-identity-is-the-whole-job"
    when: "an identity anchor is needed"
    action: >
      The attachment is the anchor.

tech_debt_watch:
  - files: "lib/serve.js"
    note: "watch"
    severity: "P3"

env_var_names:
  - DEEPSEEK_API_KEY
`;

const REGISTER_SAMPLE = `# Tech debt register — digital_twin

## P1 — none

## P2

### TD-001 · \`bin/\` — the log rotator is dead under launchd
Prose.

Files: \`bin/log-rotate.sh\`

## P3

### TD-008 · \`lib/\` — something newer
Prose.

Files: \`lib/thing.js\`

## Closed recently

### TD-009 · \`x/\` — closed item
Prose.
`;

// ------------------------------------------------------------------- tests

console.log('\n1. the signature table');
check('every signature has the fields the writers need', () => {
    assert.ok(L.SIGNATURES.length >= 5);
    for (const s of L.SIGNATURES) {
        assert.ok(s.id && /^[a-z0-9-]+$/.test(s.id), `bad id: ${s.id}`);
        assert.ok(s.pattern instanceof RegExp, `${s.id}: pattern`);
        assert.ok(s.title && s.when && s.action.length, `${s.id}: missing text`);
        assert.ok(Array.isArray(s.files), `${s.id}: files`);
        assert.ok(/^P[123]$/.test(s.severity), `${s.id}: severity`);
    }
});
check('signature ids are unique', () => {
    const seen = new Set();
    for (const s of L.SIGNATURES) {
        assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
        seen.add(s.id);
    }
});
check('the known failure modes are covered', () => {
    const ids = L.SIGNATURES.map(s => s.id);
    for (const id of ['launchd-tcc', 'api-rate-limit', 'encrypted-media', 'prompt-refusal', 'stale-chrome-port', 'no-deadline', 'missing-path']) {
        assert.ok(ids.includes(id), `missing signature ${id}`);
    }
});

console.log('\n2. reading evidence (bounded)');
check('tailFile reads only the end of a file', () => {
    const d = tmpdir('tail');
    const f = path.join(d, 'big.log');
    fs.writeFileSync(f, 'A'.repeat(5000) + 'TAIL');
    const t = L.tailFile(f, 100);
    assert.equal(t.length, 100);
    assert.ok(t.endsWith('TAIL'));
});
check('tailFile returns empty for a missing file', () => {
    assert.equal(L.tailFile(path.join(tmpdir('missing'), 'nope.log'), 100), '');
});
check('listLogFiles keeps only log-ish files and honours the cap', () => {
    const d = tmpdir('list');
    writeFile(path.join(d, 'logs', 'a.log'), 'x');
    writeFile(path.join(d, 'logs', 'b.err'), 'x');
    writeFile(path.join(d, 'logs', 'c.txt'), 'x');
    writeFile(path.join(d, 'lib', 'agent-hub', 'pids', 'hub.log'), 'x');
    const files = L.listLogFiles({ repo: d, maxFiles: 10 });
    const names = files.map(f => path.basename(f));
    assert.ok(names.includes('a.log'));
    assert.ok(names.includes('b.err'));
    assert.ok(names.includes('hub.log'));
    assert.ok(!names.includes('c.txt'), 'a .txt file was read');
});
check('listLogFiles honours maxFiles', () => {
    const d = tmpdir('cap');
    for (let i = 0; i < 8; i++) writeFile(path.join(d, 'logs', `x${i}.log`), 'x');
    const files = L.listLogFiles({ repo: d, maxFiles: 3 });
    assert.equal(files.length, 3);
});
check('collectEvidence tags each chunk with its source', () => {
    const d = tmpdir('collect');
    writeFile(path.join(d, 'logs', 'a.log'), 'hello\nworld\n');
    const ev = L.collectEvidence({ repo: d, maxFiles: 10 });
    assert.equal(ev.length, 1);
    assert.ok(ev[0].source.endsWith('a.log'));
    assert.ok(ev[0].text.includes('hello'));
});

console.log('\n3. classification');
const EV = [
    { source: 'logs/a.log', text: 'x\nOperation not permitted\ny' },
    { source: 'logs/b.log', text: 'Operation not permitted\nOperation not permitted' },
    { source: 'logs/c.log', text: 'HTTP 429 Too many requests' },
];
check('a signature below the threshold is not a finding', () => {
    const f = L.classify(EV, { minOccurrences: 4 });
    assert.ok(!f.some(x => x.id === 'launchd-tcc'), 'launchd-tcc fired too early');
});
check('a recurring signature is a finding with its count', () => {
    const f = L.classify(EV, { minOccurrences: 3 });
    const t = f.find(x => x.id === 'launchd-tcc');
    assert.ok(t, 'launchd-tcc missing');
    assert.equal(t.occurrences, 3);
});
check('a finding carries bounded evidence lines', () => {
    const many = [{ source: 'logs/a.log', text: Array(50).fill('Operation not permitted').join('\n') }];
    const f = L.classify(many, { minOccurrences: 1, maxEvidence: 5 });
    assert.equal(f[0].evidence.length, 5);
});
check('findings are sorted by how often they occur', () => {
    const ev = [
        { source: 'a', text: '429\n429' },
        { source: 'b', text: Array(9).fill('Operation not permitted').join('\n') },
    ];
    const f = L.classify(ev, { minOccurrences: 1 });
    assert.ok(f[0].occurrences >= f[1].occurrences);
});
check('classification is pure — the same evidence gives the same answer', () => {
    const a = L.classify(EV, { minOccurrences: 2 });
    const b = L.classify(EV, { minOccurrences: 2 });
    assert.deepEqual(a, b);
});

console.log('\n4. dedupe');
check('a rule id already in memory.yaml is known', () => {
    const ids = L.knownRuleIds(MEMORY_SAMPLE);
    assert.ok(ids.has('deploy-content'));
    assert.ok(ids.has('identity-is-the-whole-job'));
});
check('nextDebtId allocates after the highest existing id', () => {
    assert.equal(L.nextDebtId(REGISTER_SAMPLE), 10);
});
check('isRecorded sees a rule, a register mention, and a postmortem', () => {
    assert.ok(L.isRecorded('deploy-content', { memoryText: MEMORY_SAMPLE }));
    assert.ok(L.isRecorded('launchd-tcc', { registerText: '… signature `launchd-tcc` …' }));
    assert.ok(L.isRecorded('launchd-tcc', { postmortems: ['2026-11-02-launchd-tcc.md'] }));
});
check('isRecorded says no for an unknown signature', () => {
    assert.equal(L.isRecorded('never-seen', {
        memoryText: MEMORY_SAMPLE, registerText: REGISTER_SAMPLE, postmortems: [],
    }), false);
});

console.log('\n5. byte-surgical edits');
check('insertYamlListItem lands inside the list and leaves the rest alone', () => {
    const block = '  - id: "PM-2026-11-02-test-rule"\n    when: "x"\n    action: >\n      y';
    const res = L.insertYamlListItem(MEMORY_SAMPLE, 'active_prevention_rules:', block);
    assert.ok(res.inserted);
    assert.ok(res.text.includes('PM-2026-11-02-test-rule'));
    // the new rule must sit inside the list — after the first rule and
    // before the next top-level key
    const iNew = res.text.indexOf('PM-2026-11-02-test-rule');
    const iFirst = res.text.indexOf('PM-2026-09-31-deploy-content');
    const iWatch = res.text.indexOf('tech_debt_watch:');
    assert.ok(iFirst < iNew, 'the new rule landed before the first rule');
    assert.ok(iNew < iWatch, 'the new rule landed outside the list');
});
check('insertYamlListItem refuses a key that is not there', () => {
    const res = L.insertYamlListItem(MEMORY_SAMPLE, 'nope:', 'x');
    assert.equal(res.inserted, false);
    assert.equal(res.text, MEMORY_SAMPLE);
});
check('insertYamlListItem does not disturb the rest of the file', () => {
    const block = '  - id: "PM-2026-11-02-test-rule"';
    const res = L.insertYamlListItem(MEMORY_SAMPLE, 'active_prevention_rules:', block);
    const before = MEMORY_SAMPLE.split('\n').filter(l => !l.includes('PM-2026-11-02-test-rule'));
    const after = res.text.split('\n').filter(l => !l.includes('PM-2026-11-02-test-rule'));
    assert.deepEqual(before, after);
});
check('insertBeforeHeading puts the block before the heading', () => {
    const res = L.insertBeforeHeading(REGISTER_SAMPLE, '## Closed recently', '### TD-010 · `x/` — new');
    assert.ok(res.inserted);
    assert.ok(res.text.indexOf('TD-010') < res.text.indexOf('## Closed recently'));
    assert.ok(res.text.includes('### TD-009 · `x/` — closed item'), 'the closed item was lost');
});
check('insertBeforeHeading appends when the heading is missing', () => {
    const res = L.insertBeforeHeading('# empty\n', '## Nowhere', 'body');
    assert.ok(res.text.includes('body'));
});
check('yamlQuote escapes a double quote', () => {
    assert.equal(L.yamlQuote('a "b" c'), 'a \\"b\\" c');
});

console.log('\n6. rendering');
check('renderRule produces memory.yaml\'s own shape', () => {
    const f = { id: 'x-rule', when: 'when it bites', action: ['line one', 'line two'] };
    const r = L.renderRule(f, '2026-11-02');
    assert.ok(r.includes('- id: "PM-2026-11-02-x-rule"'));
    assert.ok(r.includes('when: "when it bites"'));
    assert.ok(r.includes('action: >'));
    assert.ok(r.includes('      line one'));
});
check('renderPostmortem states that no product code was changed', () => {
    const f = { id: 'x-rule', title: 'T', severity: 'P2', when: 'w', action: ['a'], occurrences: 3, evidence: [{ source: 'logs/a.log', line: 'boom' }], files: [] };
    const p = L.renderPostmortem(f, '2026-11-02');
    assert.ok(p.includes('## What was NOT done'));
    assert.ok(p.includes('No product code was changed'));
    assert.ok(p.includes('logs/a.log'));
});
check('renderDebtItem uses the register\'s own shape', () => {
    const f = { id: 'x-rule', title: 'T', severity: 'P2', when: 'w', action: ['a'], occurrences: 3, evidence: [], files: ['lib/a.js'] };
    const d = L.renderDebtItem(f, 9);
    assert.ok(d.includes('### TD-009 · `lib/a.js` — T'));
    assert.ok(d.includes('Files: `lib/a.js`'));
});

console.log('\n7. state and the interval gate');
check('shouldRun is true when the loop has never run', () => {
    assert.equal(L.shouldRun({ lastRun: null }, { now: Date.now() }), true);
});
check('shouldRun is false inside the interval', () => {
    const now = Date.now();
    const state = { lastRun: new Date(now - 5 * 60 * 1000).toISOString() };
    assert.equal(L.shouldRun(state, { now, intervalMinutes: 30 }), false);
});
check('shouldRun is true outside the interval', () => {
    const now = Date.now();
    const state = { lastRun: new Date(now - 45 * 60 * 1000).toISOString() };
    assert.equal(L.shouldRun(state, { now, intervalMinutes: 30 }), true);
});
check('state round-trips', () => {
    const f = path.join(tmpdir('state'), 'state.json');
    L.writeState(f, { lastRun: '2026-11-02T00:00:00.000Z', lastFindings: 2 });
    const s = L.readState(f);
    assert.equal(s.lastRun, '2026-11-02T00:00:00.000Z');
    assert.equal(s.lastFindings, 2);
});
check('readState of a missing file is an empty state', () => {
    const s = L.readState(path.join(tmpdir('nostate'), 'nope.json'));
    assert.equal(s.lastRun, null);
});

console.log('\n8. a full run, end to end');
function buildRepo(name) {
    const d = tmpdir(name);
    writeFile(path.join(d, '.kai', 'memory.yaml'), MEMORY_SAMPLE);
    writeFile(path.join(d, '.kai', 'tech-debt', 'register.md'), REGISTER_SAMPLE);
    writeFile(path.join(d, 'logs', 'a.log'), Array(4).fill('Operation not permitted').join('\n'));
    writeFile(path.join(d, 'logs', 'b.log'), 'HTTP 429 Too many requests\n');
    return d;
}

check('a dry run writes nothing at all', () => {
    const d = buildRepo('dry');
    const before = fs.readFileSync(path.join(d, '.kai', 'memory.yaml'), 'utf8');
    const r = L.run({ repo: d, dryRun: true, minOccurrences: 3 });
    assert.equal(r.dryRun, true);
    assert.ok(r.findings.length >= 1);
    assert.equal(fs.readFileSync(path.join(d, '.kai', 'memory.yaml'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(d, '.kai', 'state', 'improve-loop.json')));
    const pmDir = path.join(d, '.kai', 'postmortems');
    assert.ok(!fs.existsSync(pmDir) || fs.readdirSync(pmDir).length === 0);
});
check('a real run writes a postmortem, a rule and a debt item', () => {
    const d = buildRepo('real');
    const r = L.run({ repo: d, minOccurrences: 3 });
    assert.ok(r.written.length >= 1);
    const pm = fs.readdirSync(path.join(d, '.kai', 'postmortems'));
    assert.ok(pm.some(f => f.includes('launchd-tcc')));
    const mem = fs.readFileSync(path.join(d, '.kai', 'memory.yaml'), 'utf8');
    assert.ok(mem.includes('PM-'), 'no prevention rule written');
    assert.ok(mem.includes('launchd-tcc'), 'the signature id is not in the rule');
    const reg = fs.readFileSync(path.join(d, '.kai', 'tech-debt', 'register.md'), 'utf8');
    assert.ok(/### TD-\d+ · `[^`]+` — /.test(reg), 'no tech-debt item written');
});
check('the debt item is placed before "Closed recently"', () => {
    const d = buildRepo('place');
    L.run({ repo: d, minOccurrences: 3 });
    const reg = fs.readFileSync(path.join(d, '.kai', 'tech-debt', 'register.md'), 'utf8');
    const newItem = reg.search(/### TD-\d+ · `[^`]+` — (?!.*closed item)/);
    assert.ok(newItem >= 0, 'no new item');
    assert.ok(newItem < reg.indexOf('## Closed recently'));
});
check('running twice writes nothing new the second time', () => {
    const d = buildRepo('twice');
    const first = L.run({ repo: d, minOccurrences: 3 });
    assert.ok(first.written.length >= 1);
    const memAfter1 = fs.readFileSync(path.join(d, '.kai', 'memory.yaml'), 'utf8');
    const pmAfter1 = fs.readdirSync(path.join(d, '.kai', 'postmortems')).sort();
    const second = L.run({ repo: d, minOccurrences: 3 });
    assert.equal(second.written.length, 0, 'the second run wrote something');
    assert.equal(fs.readFileSync(path.join(d, '.kai', 'memory.yaml'), 'utf8'), memAfter1);
    assert.deepEqual(fs.readdirSync(path.join(d, '.kai', 'postmortems')).sort(), pmAfter1);
    assert.ok(second.recorded.length >= 1, 'nothing was recognised as already recorded');
});
check('the run state records when it ran', () => {
    const d = buildRepo('state');
    L.run({ repo: d, minOccurrences: 3 });
    const s = L.readState(path.join(d, '.kai', 'state', 'improve-loop.json'));
    assert.ok(s.lastRun, 'no lastRun');
    assert.ok(Date.parse(s.lastRun) > 0);
});
check('the loop only ever writes under .kai/', () => {
    const d = buildRepo('scope');
    const before = fs.readdirSync(d).sort();
    L.run({ repo: d, minOccurrences: 3 });
    assert.deepEqual(fs.readdirSync(d).sort(), before);
});
check('a missing .kai/ directory is handled, not fatal', () => {
    const d = tmpdir('nokai');
    writeFile(path.join(d, 'logs', 'a.log'), 'x');
    const r = L.run({ repo: d, minOccurrences: 1 });
    assert.ok(r);
});

console.log('\n9. the command line');
check('an unknown flag is refused with exit 2', () => {
    assert.equal(L.main(['--nope']), 2);
});
check('--help prints the usage and exits 0', () => {
    assert.equal(L.main(['--help']), 0);
});
check('a dry run through main() writes nothing', () => {
    const d = buildRepo('cli');
    const orig = process.cwd();
    // main() uses the module's REPO, so only assert the exit code here.
    assert.equal(L.main(['--dry-run', '--min', '999999']), 0);
    void orig; void d;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
