#!/usr/bin/env node
// lib/auto-check-updates.test.js — the pure half of
// lib/auto-check-updates.js.
//
// No launchd, no network, no git. The report FORMAT and the probe
// DECISIONS are pure functions and are tested here; the git and HTTP
// calls are injected.
//
// The defect this file exists for
// -------------------------------
// The shell version probed the deployed site in a loop variable it had
// once named `PATH`. That shadowed the shell's own PATH, so `curl` was
// never found, every probe returned 000, and the site always looked
// down — the job reported "Deployed site not responding" for months.
//
// The port has no shell, so it cannot repeat that. What it CAN get
// wrong is the opposite: reporting the site as healthy when the page
// it found was not the one it was asked for, or reporting a stale
// status. The assertions below pin the report format exactly, because
// the format is what a reader (and a log grep) depends on.

'use strict';

const assert = require('node:assert');

const { reportLines, probeDeploy, PROBE_PATHS, DEFAULT_DEPLOYED_URL } = require('./auto-check-updates.js');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
        failures.push({ name, err });
        process.stdout.write(`FAIL ${name}\n`);
    }
}

// Async checks are collected and run in the tail IIFE, so the summary
// line is printed after every check has reported.
const asyncChecks = [];
function checkAsync(name, fn) {
    asyncChecks.push({ name, fn });
}

const WHEN = new Date(2026, 10, 2, 15, 4, 5);

// ---------------------------------------------------------------------------
// 1. the report format is preserved exactly
// ---------------------------------------------------------------------------

check('the report is stamped, ruled, and closed', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'abc1234', behind: 0 },
        deploy: { ok: true, path: 'landing.html' },
        when: WHEN,
    });
    assert.strictEqual(lines[0], '[update-check] 2026-11-02 15:04:05');
    assert.strictEqual(lines[1], '---');
    assert.strictEqual(lines[lines.length - 2], '---');
    assert.strictEqual(lines[lines.length - 1], '[update-check] Done');
});

check('an up-to-date repo reads as up to date', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'abc1234', behind: 0 },
        deploy: { ok: true, path: 'landing.html' },
        when: WHEN,
    });
    assert.strictEqual(lines[2], '✓ Repo up to date (commit abc1234)');
});

check('a repo behind origin says how far behind', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'def5678', behind: 3 },
        deploy: { ok: true, path: 'landing.html' },
        when: WHEN,
    });
    assert.strictEqual(lines[2], '⚠ Repo behind: 3 commit(s) behind origin/main');
    assert.strictEqual(lines[3], '  Local:  abc1234');
    assert.strictEqual(lines[4], '  Remote: def5678');
});

check('an unknown behind-count is reported as ?', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'def5678', behind: null },
        deploy: { ok: true, path: 'landing.html' },
        when: WHEN,
    });
    assert.strictEqual(lines[2], '⚠ Repo behind: ? commit(s) behind origin/main');
});

check('a responding deploy names the path that answered', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'abc1234', behind: 0 },
        deploy: { ok: true, path: 'pages/landing.html' },
        when: WHEN,
    });
    assert.ok(lines.includes('✓ Deployed site responding (pages/landing.html → 200 OK)'), lines.join(' | '));
});

check('a root-only response is a warning, not a pass', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'abc1234', behind: 0 },
        deploy: { ok: false, rootOk: true },
        when: WHEN,
    });
    assert.ok(lines.includes('⚠ Deployed root OK, but pages may need rebuild'), lines.join(' | '));
});

check('a dead deploy lists every path that was tried', () => {
    const lines = reportLines({
        state: { local: 'abc1234', remote: 'abc1234', behind: 0 },
        deploy: { ok: false, rootOk: false },
        when: WHEN,
    });
    assert.ok(
        lines.includes('⚠ Deployed site not responding (tried: landing.html, pages/landing.html, index.html)'),
        lines.join(' | '),
    );
});

// ---------------------------------------------------------------------------
// 2. the probe decisions
// ---------------------------------------------------------------------------

checkAsync('the probe takes the first path that answers 200', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
        asked.push(url);
        return { status: url.includes('pages/landing.html') ? 200 : 404 };
    };
    const res = await probeDeploy('https://example.test', { fetchImpl });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.path, 'pages/landing.html');
    assert.ok(asked.length <= 2, `asked ${asked.length} paths`);
});

checkAsync('a site that answers only at the root is rootOk, not ok', async () => {
    const fetchImpl = async (url) => ({ status: url.endsWith('/') ? 200 : 404 });
    const res = await probeDeploy('https://example.test', { fetchImpl });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rootOk, true);
});

checkAsync('a site that answers nothing is neither', async () => {
    const fetchImpl = async () => ({ status: 0 });
    const res = await probeDeploy('https://example.test', { fetchImpl });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rootOk, false);
});

checkAsync('a throwing fetch is a dead site, not a crash', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const res = await probeDeploy('https://example.test', { fetchImpl });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.rootOk, false);
});

checkAsync('the probe tries exactly the documented paths', async () => {
    const asked = [];
    const fetchImpl = async (url) => { asked.push(url); return { status: 404 }; };
    await probeDeploy('https://example.test', { fetchImpl });
    for (const rel of PROBE_PATHS) {
        assert.ok(asked.some((u) => u.includes(rel)), `${rel} was never tried`);
    }
});

checkAsync('a trailing slash on the base url does not double up', async () => {
    const asked = [];
    const fetchImpl = async (url) => { asked.push(url); return { status: 404 }; };
    await probeDeploy('https://example.test/', { fetchImpl });
    assert.ok(!asked.some((u) => u.includes('example.test//')), asked.join(' | '));
});

// ---------------------------------------------------------------------------
// 3. the constants
// ---------------------------------------------------------------------------

check('the deploy target is the Vercel host CI verifies', () => {
    assert.strictEqual(DEFAULT_DEPLOYED_URL, 'https://digitaltwin-ebon.vercel.app');
});

// ---------------------------------------------------------------------------
(async () => {
    for (const { name, fn } of asyncChecks) {
        try {
            await fn();
            passed += 1;
            process.stdout.write(`ok   ${name}\n`);
        } catch (err) {
            failures.push({ name, err });
            process.stdout.write(`FAIL ${name}\n`);
        }
    }
    console.log(`\n[auto-check-updates.test] passed: ${passed}, failed: ${failures.length}`);
    if (failures.length) {
        for (const f of failures) process.stdout.write(`\n${f.name}\n${f.err.stack}\n`);
        process.exit(1);
    }
})();
