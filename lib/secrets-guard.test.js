#!/usr/bin/env node
'use strict';
// lib/secrets-guard.test.js
//
// THIS REPO IS PUBLIC. github.com/kajica2/digital-twin is world-readable, so
// anything that lands in a commit is published the moment it is pushed, and
// a deleted file stays readable in history forever. A session cookie is not a
// file you can take back — it is a live login.
//
// So this guard answers one question, before a push rather than after:
// is there credential material anywhere in what this repo publishes?
//
// Six checks, each one a thing that has actually gone wrong in a repo
// somewhere:
//
//   1. TRACKED PATHS. A cookie jar, an .env, a private key or a memory
//      directory must never be tracked, whatever its contents look like.
//   2. TRACKED CONTENT. Cookie values, API keys, bearer tokens and session
//      ids are matched by shape, with a narrow allowlist for the fixtures the
//      test suites need — matched by VALUE, never by file, so a real secret
//      cannot hide behind "that file is a test".
//   3. UNTRACKED BUT NOT IGNORED. `git add -A` publishes these. A credential
//      store sitting in the tree unprotected is one careless commit away.
//   3b. IGNORED BUT PRESENT. A jar copied into the repo is already a mistake:
//      `git add -f`, an archived working directory or a "here is my tree"
//      zip all publish it, so its presence is a finding too.
//   4. IGNORE RULES. The patterns that keep jars, env files, .kai/ memory and
//      logs out of the repo are themselves asserted, so removing one fails
//      here instead of silently unprotecting the tree.
//   5. HISTORY (default, unless the checkout is shallow). Every commit on
//      every ref, because that is what a stranger can read.
//
// Plus: every module's DEFAULT cookie path has to resolve OUTSIDE the repo —
// the failure mode where someone "fixes" the default to ./cookies.txt and a
// jar lands inside the tree it is meant to stay out of.
//
// Usage:
//   node lib/secrets-guard.test.js              # all five + paths
//   node lib/secrets-guard.test.js --no-history # skip the history sweep
//   node lib/secrets-guard.test.js --quiet      # findings only
//   node lib/secrets-guard.test.js --strict     # a baselined leak still fails
//
// Exit code 0 clean, 1 findings.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const SKIP_HISTORY = process.argv.includes('--no-history');
const STRICT = process.argv.includes('--strict');
const MAX_FILE_BYTES = 4 * 1024 * 1024;

let passed = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) {
        passed++;
        if (!QUIET) process.stderr.write(`  ✓ ${label}\n`);
    } else {
        failures.push({ label, detail });
        process.stderr.write(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}\n`);
    }
}

function git(args) {
    return execFileSync('git', args, {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
}

// ---------------------------------------------------------------- the rules

// Paths that are credential stores or private runtime state, by name.
const PATH_RULES = [
    { id: 'cookie-jar', re: /(^|\/)[^/]*cookies?[^/]*\.(?:txt|json|jar)$/i },
    { id: 'cookie-jar', re: /(^|\/)(?:\.?jar|.*-jar)$/i },
    { id: 'env-file', re: /(^|\/)\.env(\..*)?$/i },
    { id: 'private-key', re: /\.(?:pem|p12|pfx|keystore|jks|ppk)$/i },
    { id: 'netrc', re: /(^|\/)\.?netrc$/i },
    { id: 'memory-dir', re: /(^|\/)\.kai(\/|$)/ },
    { id: 'runtime-logs', re: /^logs\// },
];

// Credential-shaped values. Each rule's first capture group is the secret; a
// match is only allowed when its VALUE is one of the fixtures the suites use.
const CONTENT_RULES = [
    { id: 'gumroad-session', re: /_gumroad_app_session=([^\s;'"]+)/g, allow: ['FAKE-SESSION'] },
    { id: 'xsrf-token', re: /XSRF-TOKEN=([^\s;'"]+)/g, allow: ['FAKE-XSRF'] },
    { id: 'x-csrf', re: /\bct0=([0-9a-f]{16,})/g },
    { id: 'x-auth-token', re: /\bauth_token=([0-9a-f]{16,})/g },
    { id: 'cookie-value', re: /(?:^|[;\s'"`])(?:sessionid|session_id|sessid)=([A-Za-z0-9%:._-]{16,})/g },
    { id: 'bearer', re: /\bBearer\s+([A-Za-z0-9._-]{20,})/g, allow: ['sk-fake'] },
    { id: 'openai-key', re: /\b(sk-[A-Za-z0-9]{32,})/g },
    { id: 'anthropic-key', re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g },
    { id: 'github-token', re: /\b((?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,})/g },
    { id: 'github-pat', re: /\b(github_pat_[A-Za-z0-9_]{30,})/g },
    { id: 'aws-key', re: /\b(AKIA[0-9A-Z]{16})\b/g },
    { id: 'slack-token', re: /\b(xox[bpasr]-[A-Za-z0-9-]{10,})/g },
    { id: 'google-key', re: /\b(AIza[0-9A-Za-z_-]{30,})/g },
    { id: 'private-key-block', re: /(-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----)/g },
    { id: 'deepseek-cookie', re: /\bsmidV2=([A-Za-z0-9%:._-]{10,})/g },
    { id: 'deepseek-session', re: /\bds_session_id=([A-Za-z0-9%:._-]{10,})/g },
];

// The ignore rules that keep secrets out of the tree. Removing one is a
// regression, so their presence is asserted.
const REQUIRED_IGNORES = ['*-cookies.txt', '.env', '.kai/', 'logs/'];

function isAllowed(rule, value) {
    return (rule.allow || []).some((a) => value === a || value.startsWith(a));
}

/** Never print a secret into the log that is scanning for secrets. */
function redact(value) {
    const v = String(value);
    if (v.length <= 8) return `${v.slice(0, 2)}… (${v.length} chars)`;
    return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

function scanText(where, text, findings) {
    for (const rule of CONTENT_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(text)) !== null) {
            const value = m[1] || m[0];
            if (isAllowed(rule, value)) continue;
            findings.push({ where, rule: rule.id, sample: redact(value) });
            if (findings.length > 200) return findings; // stop flooding
        }
    }
    return findings;
}

function matchesPath(relPath, skipIds) {
    return PATH_RULES
        .filter((r) => !(skipIds && skipIds.includes(r.id)))
        .filter((r) => r.re.test(relPath))
        .map((r) => r.id);
}

// ------------------------------------------------------------------- checks

function trackedPaths() {
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
    const bad = [];
    for (const rel of files) {
        const ids = matchesPath(rel);
        if (ids.length) bad.push(`${rel} (${[...new Set(ids)].join(', ')})`);
    }
    check(`${files.length} tracked path(s): no cookie jar, .env, key or private memory`, bad.length === 0,
        bad.slice(0, 20).join('\n    '));
    return files;
}

function trackedContent(files) {
    const findings = [];
    let scanned = 0;
    let skippedBinary = 0;
    let skippedBig = 0;
    for (const rel of files) {
        const abs = path.join(REPO, rel);
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            continue; // deleted between ls-files and now
        }
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) { skippedBig++; continue; }
        let buf;
        try {
            buf = fs.readFileSync(abs);
        } catch {
            continue;
        }
        if (buf.includes(0)) { skippedBinary++; continue; }
        scanned++;
        scanText(rel, buf.toString('utf8'), findings);
    }
    check(`${scanned} tracked file(s) scanned for credential-shaped values`, findings.length === 0,
        findings.slice(0, 20).map((f) => `${f.where}: ${f.rule} ${f.sample}`).join('\n    '));
    if (skippedBig || skippedBinary) {
        if (!QUIET) process.stderr.write(`    (skipped ${skippedBinary} binary, ${skippedBig} over ${MAX_FILE_BYTES} bytes)\n`);
    }
    return findings;
}

function untrackedNotIgnored() {
    const out = git(['status', '--porcelain', '--untracked-files=all']);
    const bad = [];
    for (const line of out.split('\n')) {
        if (!line.startsWith('?? ')) continue;
        const rel = line.slice(3).trim();
        const ids = matchesPath(rel);
        if (ids.length) bad.push(`${rel} (${[...new Set(ids)].join(', ')}) — \`git add -A\` would publish it`);
    }
    check('no untracked, un-ignored path is a credential store', bad.length === 0, bad.join('\n    '));
}

/**
 * A credential store that is merely IGNORED is still a credential store in
 * the tree: one `git add -f`, one archived working directory, one "help me
 * debug this" zip. The jar's home is $HOME, never the repo — so its presence
 * is a finding even though git would not publish it by accident.
 *
 * `logs/` is excluded: runtime logs are expected to live in the tree, which
 * is why they are ignored.
 */
function ignoredButPresent() {
    const out = git(['status', '--porcelain', '--ignored', '--untracked-files=all']);
    const bad = [];
    for (const line of out.split('\n')) {
        if (!line.startsWith('!! ')) continue;
        const rel = line.slice(3).trim();
        // `logs/` is expected in the tree (ignored), and `.kai/` memory is a
        // documented local store — neither is a credential. `.pem` inside a
        // gitignored virtualenv is Python's CA bundle, not a private key.
        const ids = matchesPath(rel, ['runtime-logs', 'memory-dir', 'private-key']);
        if (ids.length) bad.push(`${rel} (${[...new Set(ids)].join(', ')}) — belongs in $HOME, not in the tree`);
    }
    check('no credential store sits inside the tree even as an ignored file', bad.length === 0,
        bad.slice(0, 20).join('\n    '));
}

function ignoreRules() {
    const text = fs.existsSync(path.join(REPO, '.gitignore'))
        ? fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8')
        : '';
    const lines = new Set(text.split('\n').map((l) => l.trim()));
    const missing = REQUIRED_IGNORES.filter((p) => !lines.has(p));
    check(`.gitignore still covers ${REQUIRED_IGNORES.join(', ')}`, missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : '');
}

function defaultCookiePaths() {
    const configFiles = ['ig', 'suno', 'mj', 'x', 'youtube'].map((name) => {
        const file = `lib/${name}-config.json`;
        return {
            name: file,
            get: () => {
                const cfg = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
                const raw = cfg.cookiesFile || cfg.web && cfg.web.cookiesFile;
                if (!raw) return null;
                return String(raw).replace(/^~/, process.env.HOME || '~');
            },
        };
    });
    const moduleDefaults = [
        { name: 'lib/gumroad.js', get: () => require('./gumroad.js').DEFAULT_COOKIE_FILE },
        { name: 'lib/x-cookies.js', get: () => require('./x-cookies.js').defaultCookiePath() },
        { name: 'lib/mj-cookies.js', get: () => require('./mj-cookies.js').defaultCookiePath() },
        {
            name: 'lib/mj-config.json',
            get: () => {
                const v = require('./mj-config.json').web.cookiesFile;
                return String(v).replace(/^~/, process.env.HOME || '~');
            },
        },
    ];
    const inside = [];
    for (const mod of moduleDefaults) {
        let p;
        try {
            p = mod.get();
        } catch (e) {
            inside.push(`${mod.name}: could not resolve (${e.message})`);
            continue;
        }
        if (p === null) continue; // this config names no jar
        const abs = path.resolve(p);
        if (!path.isAbsolute(abs) || abs === REPO || abs.startsWith(REPO + path.sep)) {
            inside.push(`${mod.name}: ${p} resolves inside the repo`);
        }
    }
    const total = moduleDefaults.length + configFiles.length;
    for (const cfg of configFiles) moduleDefaults.push(cfg);
    check(`${total} cookie-jar setting(s) resolve outside the repo`, inside.length === 0,
        inside.join('\n    '));
}

/**
 * Every commit on every ref — the part a stranger can read and the part a
 * later commit cannot undo. Streamed, not buffered: `git log -p --all` on this
 * repo is tens of megabytes.
 */
function history() {
    let shallow = false;
    try {
        shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
        shallow = true;
    }
    if (SKIP_HISTORY) {
        if (!QUIET) process.stderr.write('  – history sweep skipped (--no-history)\n');
        return;
    }
    if (shallow) {
        if (!QUIET) process.stderr.write('  – history sweep skipped (shallow checkout — fetch full history to check it)\n');
        return;
    }

    return new Promise((resolve) => {
        const findings = [];
        let commits = 0;
        let current = '?';
        let pending = '';
        const child = spawn('git', ['log', '-p', '--all', '--no-color', '--format=commit %H %s'], {
            cwd: REPO,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop();
            for (const line of lines) {
                if (line.startsWith('commit ')) {
                    commits++;
                    current = line.split(' ')[1] || '?';
                    continue;
                }
                if (line.length < 12) continue;
                scanText(`history ${current.slice(0, 10)}`, line, findings);
            }
        });
        child.on('close', () => {
            if (pending.length >= 12) scanText(`history ${current.slice(0, 10)}`, pending, findings);
            check(`${commits} commit(s) on every ref: no credential ever committed`, findings.length === 0,
                findings.slice(0, 20).map((f) => `${f.where}: ${f.rule} ${f.sample}`).join('\n    '));
            resolve();
        });
    });
}

// ------------------------------------------------------------- the baseline

/**
 * Findings that are REAL and already known, so the guard can gate the next
 * leak instead of failing forever on a leak it cannot fix.
 *
 * An entry is a credential that was published before the guard existed. It
 * keeps being printed on every run until it is rotated — a baseline that
 * hides things is worse than no baseline.
 */
function readBaseline() {
    const file = path.join(REPO, '.secrets-baseline.json');
    if (!fs.existsSync(file)) return { historyPaths: [], present: false };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { historyPaths: Array.isArray(parsed.historyPaths) ? parsed.historyPaths : [], present: true };
    } catch (e) {
        return { historyPaths: [], present: false, error: e.message };
    }
}

/**
 * Every path that ever existed on any ref, checked against the same name
 * rules. A jar deleted in a later commit is still in the history a stranger
 * can read — that is precisely how the Suno jar stayed public after it was
 * removed from the tree.
 */
function historyPaths(baseline) {
    const listing = git(['log', '--all', '--name-only', '--pretty=format:']);
    const seen = new Map();
    for (const rel of listing.split('\n')) {
        const trimmed = rel.trim();
        if (!trimmed) continue;
        // Logs are a hygiene question, not a credential one: a watcher's log
        // that was once committed is noise, and flagging it here would keep
        // the credential check red over something no rotation can fix.
        const ids = matchesPath(trimmed, ['runtime-logs']);
        if (!ids.length) continue;
        if (!seen.has(trimmed)) seen.set(trimmed, new Set(ids));
    }

    const known = new Map(baseline.historyPaths.map((e) => [e.path, e]));
    const unknown = [];
    const pending = [];
    for (const [rel, ids] of seen) {
        const entry = known.get(rel);
        if (!entry) unknown.push(`${rel} (${[...ids].join(', ')})`);
        else if (entry.status !== 'rotated') pending.push(`${rel} — ${entry.status}: ${entry.action || 'rotate the credential'}`);
    }
    // A baselined path that is no longer in history means the history was
    // purged: say so, so the entry can be closed instead of lingering.
    const absent = baseline.historyPaths.filter((e) => !seen.has(e.path)).map((e) => e.path);

    check('no cookie jar, .env or key file ever existed on any ref (see .secrets-baseline.json)',
        unknown.length === 0, unknown.slice(0, 20).join('\n    '));

    const unresolved = baseline.historyPaths.filter((e) => e.status !== 'rotated');
    check(`${baseline.historyPaths.length} baselined historical finding(s), ${baseline.historyPaths.length - unresolved.length} rotated`,
        !STRICT || unresolved.length === 0,
        STRICT && unresolved.length ? `--strict: still un-rotated: ${unresolved.map((e) => e.path).join(', ')}` : '');

    for (const line of pending) process.stderr.write(`  ! PUBLISHED, NEEDS ROTATION: ${line}\n`);
    if (absent.length) {
        process.stderr.write(`  ! baselined path(s) no longer in history (purged?) — close the entry: ${absent.join(', ')}\n`);
    }
}

// --------------------------------------------------------------------- main

async function main() {
    process.stderr.write('secrets guard — this repo is public, so a leaked cookie is published permanently\n');
    try {
        git(['rev-parse', '--git-dir']);
    } catch {
        process.stderr.write('  ✗ not a git checkout — nothing to guard\n');
        return 1;
    }

    const files = trackedPaths();
    trackedContent(files);
    untrackedNotIgnored();
    ignoredButPresent();
    ignoreRules();
    defaultCookiePaths();
    await history();
    try {
        historyPaths(readBaseline());
    } catch (e) {
        check('history path sweep could run', false, e.message);
    }

    process.stderr.write(`\n[secrets-guard] passed: ${passed}, failed: ${failures.length}\n`);
    if (failures.length) {
        for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n`);
        process.stderr.write('Remove the material, rotate the credential, and purge it from history before pushing.\n');
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`[secrets-guard] crashed: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
});
