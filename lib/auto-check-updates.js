'use strict';
// lib/auto-check-updates.js — is the repo behind, and is the deployed
// site answering?
//
// This started as the Node port of bin/auto-check-updates.sh (now
// removed — the shell implementation and this file's node port were never
// two live paths), and it exists for the same reason lib/log-rotate.js
// exists:
//
//   The auto-check LaunchAgent ran `/bin/bash
//   $HOME/digital-twin/bin/auto-check-updates.sh` and died with exit
//   126 ("Operation not permitted") on every run. launchd on Sequoia
//   grants filesystem access PER BINARY and /bin/bash has no grant for
//   ~/Documents. 283 runs, 283 failures, and a 131 KB stderr file that
//   nobody read.
//
// node IS granted, so the job moved to node.
//
// The OUTPUT TEXT is preserved exactly — the format is what a reader
// (and any log-grepping habit) depends on.
//
// One bug from the shell version is fixed here rather than ported: the
// shell looped over candidate paths in a variable it had once called
// `PATH`, shadowing the shell's own PATH so `curl` was never found and
// every probe returned 000 — the deployed site always looked down. In
// node there is no shell PATH to shadow, and the candidate list is a
// constant.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_DEPLOYED_URL = 'https://digitaltwin-ebon.vercel.app';
const PROBE_PATHS = ['landing.html', 'pages/landing.html', 'index.html'];
const PROBE_TIMEOUT_MS = 15000;

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Run git in `cwd` and return trimmed stdout, or '' on any failure.
 */
function git(args, cwd = REPO) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

/**
 * The repo's position relative to origin/main.
 * Returns { local, remote, behind } — behind is null when unknown.
 */
function repoState(cwd = REPO, fetch = true) {
    if (fetch) git(['fetch', 'origin', '--quiet'], cwd);
    const local = git(['rev-parse', 'HEAD'], cwd);
    const remote = git(['rev-parse', 'origin/main'], cwd);
    let behind = null;
    if (local && remote) {
        const count = git(['rev-list', '--count', 'HEAD..origin/main'], cwd);
        behind = /^\d+$/.test(count) ? Number(count) : null;
    }
    const short = (h) => (h ? h.slice(0, 7) : '?');
    return { local: local ? short(local) : '?', remote: remote ? short(remote) : '?', behind };
}

/**
 * Probe the deployed site. Returns one of:
 *   { ok: true,  path: 'landing.html' }              a page answered 200
 *   { ok: false, rootOk: true }                      only the root answered
 *   { ok: false, rootOk: false }                     nothing answered
 */
async function probeDeploy(baseUrl = DEFAULT_DEPLOYED_URL, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const one = async (rel) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${rel}`, { signal: ctrl.signal, redirect: 'follow' });
            return res.status;
        } catch {
            return 0;
        } finally {
            clearTimeout(timer);
        }
    };

    for (const rel of PROBE_PATHS) {
        const status = await one(rel);
        if (status === 200) return { ok: true, path: rel };
    }
    const rootStatus = await one('');
    return { ok: false, rootOk: rootStatus === 200 };
}

/**
 * Build the report lines. Pure, so the format is testable.
 */
function reportLines({ state, deploy, when = new Date(), baseUrl = DEFAULT_DEPLOYED_URL }) {
    const lines = [];
    lines.push(`[update-check] ${stamp(when)}`);
    lines.push('---');

    if (state.local === state.remote) {
        lines.push(`✓ Repo up to date (commit ${state.local})`);
    } else {
        const n = state.behind === null ? '?' : state.behind;
        lines.push(`⚠ Repo behind: ${n} commit(s) behind origin/main`);
        lines.push(`  Local:  ${state.local}`);
        lines.push(`  Remote: ${state.remote}`);
    }

    if (deploy.ok) {
        lines.push(`✓ Deployed site responding (${deploy.path} → 200 OK)`);
    } else if (deploy.rootOk) {
        lines.push('⚠ Deployed root OK, but pages may need rebuild');
    } else {
        lines.push(`⚠ Deployed site not responding (tried: ${PROBE_PATHS.join(', ')})`);
    }

    lines.push('---');
    lines.push('[update-check] Done');
    return lines;
}

async function main(argv = process.argv.slice(2), deps = {}) {
    const {
        cwd = REPO,
        baseUrl = process.env.DEPLOYED_URL || DEFAULT_DEPLOYED_URL,
        stateFn = repoState,
        probeFn = probeDeploy,
        out = (s) => process.stdout.write(`${s}\n`),
    } = deps;

    const state = stateFn(cwd);
    const deploy = await probeFn(baseUrl);
    for (const line of reportLines({ state, deploy, baseUrl })) out(line);
    return 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code || 0)).catch((e) => {
        process.stderr.write(`[update-check] fatal: ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    });
}

module.exports = { main, reportLines, repoState, probeDeploy, git, stamp, REPO, DEFAULT_DEPLOYED_URL, PROBE_PATHS };
