#!/usr/bin/env node
'use strict';
// lib/improve-loop.js — turn recurring failures into recorded lessons.
//
//   node lib/improve-loop.js                 # run now
//   node lib/improve-loop.js --dry-run       # classify + report, write nothing
//   node lib/improve-loop.js --json          # machine-readable result
//   node lib/improve-loop.js --min 5         # occurrences needed to record
//   node lib/improve-loop.js --interval 30   # minutes between runs
//
// WHAT THIS DOES
//   Reads the twin's own failure evidence (the tail of its logs), counts
//   how often each known failure signature appears, and — for signatures
//   that recur and are not yet recorded — writes three things:
//     1. a postmortem under .kai/postmortems/
//     2. a prevention rule appended to .kai/memory.yaml
//     3. a tech-debt item appended to .kai/tech-debt/register.md
//
// WHAT THIS WILL NEVER DO
//   Edit product code. A log line is evidence, not a patch; auto-editing
//   source from a log is how a working system breaks. It records lessons;
//   a human or the agent applies them.
//
// EVERYTHING IS BOUNDED
//   Each log is TAIL-READ (a capped number of bytes from the end), the
//   number of files is capped, the number of findings is capped, and every
//   file write is atomic (temp + rename). A loop that can hang is worse
//   than no loop — that is the whole point of the timeouts it is built on.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const KAI_DIR = path.join(REPO, '.kai');
const MEMORY_FILE = path.join(KAI_DIR, 'memory.yaml');
const REGISTER_FILE = path.join(KAI_DIR, 'tech-debt', 'register.md');
const POSTMORTEM_DIR = path.join(KAI_DIR, 'postmortems');
const STATE_FILE = path.join(KAI_DIR, 'state', 'improve-loop.json');

// Defaults. Every one of these is a ceiling, not a target.
const DEFAULT_TAIL_BYTES = 64 * 1024;   // per log file
const DEFAULT_MAX_FILES = 40;           // log files read per run
const DEFAULT_MAX_FINDINGS = 10;        // findings written per run
const DEFAULT_MIN_OCCURRENCES = 3;      // a signature must recur to count
const DEFAULT_INTERVAL_MINUTES = 30;    // minimum gap between runs
const DEFAULT_MAX_EVIDENCE_LINES = 5;   // evidence lines kept per finding

/**
 * The failure signatures this repo has actually hit, and the lesson each
 * one carries. The `action` text is the prevention rule's body — it is
 * written to be READ by a future agent before it starts work.
 */
const SIGNATURES = [
    {
        id: 'launchd-tcc',
        pattern: /Operation not permitted/i,
        severity: 'P2',
        files: ['bin/', '~/Library/LaunchAgents/'],
        title: 'a launchd LaunchAgent cannot exec into ~/Documents',
        when: 'a launchd LaunchAgent fails with exit 126 or "Operation not permitted"',
        action: [
            'launchd grants filesystem access PER BINARY. /bin/bash is not',
            'granted ~/Documents, so a shell LaunchAgent cannot read the repo;',
            'node IS granted it. Put a shim in ~/Library/LaunchAgents/ that',
            'resolves node and execs the script directly — never /bin/bash into',
            '~/Documents, never /tmp (wiped on reboot).',
        ],
    },
    {
        id: 'api-rate-limit',
        pattern: /\b429\b|Too many requests/i,
        severity: 'P3',
        files: ['lib/suno-web.js', 'lib/mj-web.js'],
        title: 'an API rate limit answered instead of the data',
        when: 'an API read returns 429 or "Too many requests"',
        action: [
            'Space the probes out and REUSE one browser session — each fresh',
            'session costs a fresh authenticated read. Prefer the singular',
            'route over a batch route (GET /api/clip/{id} over',
            'get_songs_by_ids), and treat a 429 as "wait", never as "empty".',
        ],
    },
    {
        id: 'encrypted-media',
        pattern: /Unable to decode audio data|moov atom not found/i,
        severity: 'P3',
        files: ['lib/suno-fetch.js'],
        title: 'a media URL returned an encrypted object, not a media file',
        when: 'a downloaded media object will not decode (ffprobe or decodeAudioData fails)',
        action: [
            'The bytes are ENCRYPTED at rest (AES256). No header, query string',
            'or compression setting unwraps them — curl and the browser get the',
            'same ciphertext. Plaintext reaches the page through the app\'s own',
            'MediaSource appendBuffer; capture there, not from the URL.',
        ],
    },
    {
        id: 'prompt-refusal',
        pattern: /banned_prompt_detected|softban/i,
        severity: 'P3',
        files: ['lib/mj-web.js', 'lib/mj-revise.js'],
        title: 'a generation was refused or silently soft-banned',
        when: 'a generation is refused, soft-banned, or accepted but never queued',
        action: [
            'A refusal is not a fact about the PROMPT until the submission',
            'mechanism is proven — run a KNOWN-GOOD control through the same',
            'path first. A job id that comes back but never reaches the feed',
            'is a soft-ban: it will never render, and re-submitting only',
            'costs another generation.',
        ],
    },
    {
        id: 'stale-chrome-port',
        pattern: /Chrome failed to bind on port/i,
        severity: 'P3',
        files: ['lib/mj-submitter.js', 'lib/suno-web.js'],
        title: 'a Chrome debug port was already taken',
        when: 'a browser launch fails to bind its debug port',
        action: [
            'Two causes, and they look identical from the outside: (1) a',
            'stale Chrome holds the port AND the profile lock — always use a',
            'FRESH port AND a fresh --user-data-dir; (2) the bind DEADLINE',
            'was too tight for the machine. MEASURED 2026-11-02: the same',
            'binary on the same port with a fresh profile bound in ~1s by',
            'hand while the automated launch failed its 8s deadline under',
            'load. Before blaming Chrome, launch it by hand on the same port',
            'and profile; if it binds, the deadline was the defect.',
        ],
    },
    {
        id: 'no-deadline',
        pattern: /timed out after \d+ms|browser did not answer/i,
        severity: 'P2',
        files: ['lib/mj-submitter.js', 'lib/suno-web.js'],
        title: 'a call had no deadline and had to be interrupted',
        when: 'a protocol or network call is left to wait forever',
        action: [
            'Give every hangable call a deadline: the CDP request layer and',
            'the in-page fetch layer each need their own, and the in-page one',
            'must be SHORTER so the abort surfaces as a named AbortError',
            'rather than a generic timeout.',
        ],
    },
    {
        id: 'missing-path',
        pattern: /ENOENT|no such file or directory/i,
        severity: 'P3',
        files: ['lib/daily-pipeline.js', 'lib/daily-content.js'],
        title: 'a path did not exist',
        when: 'an operation names a path that is not there',
        action: [
            'Resolve every path from the REPO ROOT (path.resolve(__dirname,',
            '"..")), never from process.cwd() — a launchd job\'s cwd is "/", so',
            'a cwd-relative path becomes "/daily" and fails with ENOENT on the',
            'filesystem root.',
            'Check the path before the operation, and report the missing path',
            'by name. A missing input that is silently skipped becomes a',
            'different result than the one that was asked for.',
        ],
    },
];

/** Read the last `maxBytes` of a file. Bounded by construction. */
function tailFile(file, maxBytes = DEFAULT_TAIL_BYTES) {
    let fd;
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - maxBytes);
        const len = size - start;
        if (len <= 0) return '';
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, start);
        return buf.slice(0, read).toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
}

/**
 * The log files worth reading. Bounded: at most `maxFiles`, newest first,
 * and only `*.log` / `*.err` inside the given directories.
 */
function listLogFiles({ repo = REPO, maxFiles = DEFAULT_MAX_FILES } = {}) {
    const dirs = [
        path.join(repo, 'logs'),
        path.join(repo, 'lib', 'agent-hub', 'pids'),
    ];
    const found = [];
    for (const dir of dirs) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isFile()) continue;
            if (!/\.(log|err|out)$/.test(e.name)) continue;
            const full = path.join(dir, e.name);
            let mtime = 0;
            try { mtime = fs.statSync(full).mtimeMs; } catch {}
            found.push({ file: full, mtime });
        }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, maxFiles).map(f => f.file);
}

/**
 * Collect the evidence: the tail of each log, tagged with its source.
 */
function collectEvidence({ repo = REPO, maxFiles = DEFAULT_MAX_FILES, tailBytes = DEFAULT_TAIL_BYTES } = {}) {
    const out = [];
    for (const file of listLogFiles({ repo, maxFiles })) {
        const text = tailFile(file, tailBytes);
        if (!text) continue;
        out.push({ source: path.relative(repo, file), text });
    }
    return out;
}

/**
 * Classify the evidence into findings: one per signature, with the count
 * and a few example lines. Pure — no filesystem, no clock.
 */
function classify(evidence, { minOccurrences = DEFAULT_MIN_OCCURRENCES, maxEvidence = DEFAULT_MAX_EVIDENCE_LINES } = {}) {
    const findings = [];
    for (const sig of SIGNATURES) {
        let occurrences = 0;
        const lines = [];
        for (const src of evidence) {
            for (const raw of src.text.split('\n')) {
                if (!sig.pattern.test(raw)) continue;
                occurrences += 1;
                if (lines.length < maxEvidence) {
                    lines.push({ source: src.source, line: raw.trim().slice(0, 240) });
                }
            }
        }
        if (occurrences < minOccurrences) continue;
        findings.push({
            id: sig.id,
            title: sig.title,
            severity: sig.severity,
            files: sig.files,
            when: sig.when,
            action: sig.action,
            occurrences,
            evidence: lines,
        });
    }
    findings.sort((a, b) => b.occurrences - a.occurrences);
    return findings;
}

/** The prevention-rule ids already in memory.yaml. */
function knownRuleIds(memoryText) {
    const out = new Set();
    const re = /id:\s*"PM-\d{4}-\d{2}-\d{2}-([a-z0-9-]+)"/g;
    let m;
    while ((m = re.exec(memoryText)) !== null) out.add(m[1]);
    return out;
}

/** The tech-debt ids already in the register. */
function knownDebtIds(registerText) {
    const out = new Set();
    const re = /TD-(\d+)/g;
    let m;
    while ((m = re.exec(registerText)) !== null) out.add(parseInt(m[1], 10));
    return out;
}

/** The next free TD number. */
function nextDebtId(registerText) {
    const ids = knownDebtIds(registerText);
    let max = 0;
    for (const n of ids) if (n > max) max = n;
    return max + 1;
}

/**
 * Is this signature already recorded anywhere? Three places, because a
 * lesson recorded in only one of them is still a lesson someone will
 * trip over again.
 */
function isRecorded(id, { memoryText = '', registerText = '', postmortems = [] } = {}) {
    if (knownRuleIds(memoryText).has(id)) return true;
    if (registerText.includes(id)) return true;
    return postmortems.some(p => p.includes(`-${id}`));
}

/**
 * Insert a block into a YAML list, immediately after the list's key.
 * Byte-surgical: the rest of the file is returned untouched.
 */
function insertYamlListItem(yamlText, listKey, block) {
    const lines = yamlText.split('\n');
    const keyIndex = lines.findIndex(l => l.trim() === listKey);
    if (keyIndex === -1) return { text: yamlText, inserted: false, reason: `no "${listKey}" key` };
    let end = keyIndex + 1;
    while (end < lines.length) {
        const l = lines[end];
        if (l.trim() === '') { end += 1; continue; }
        if (!/^\s/.test(l)) break;
        end += 1;
    }
    // Walk back over trailing blank lines so the block lands flush with
    // the last item of the list.
    let insertAt = end;
    while (insertAt > keyIndex + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    return { text: [...before, ...block.split('\n'), ...after].join('\n'), inserted: true };
}

/**
 * Insert a section into a Markdown document, just before a heading.
 * Byte-surgical: the rest of the file is returned untouched.
 */
function insertBeforeHeading(mdText, heading, block) {
    const lines = mdText.split('\n');
    const index = lines.findIndex(l => l.trim() === heading);
    if (index === -1) {
        const text = mdText.replace(/\n*$/, '\n') + '\n' + block.replace(/\n*$/, '\n');
        return { text, inserted: true, at: 'end' };
    }
    let insertAt = index;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    return { text: [...before, ...block.split('\n'), ...after].join('\n'), inserted: true, at: heading };
}

/** Escape a string for a double-quoted YAML scalar. */
function yamlQuote(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The prevention-rule block for a finding, in memory.yaml's own shape. */
function renderRule(finding, date) {
    const body = finding.action.map(l => `      ${l}`).join('\n');
    return [
        `  - id: "PM-${date}-${finding.id}"`,
        `    when: "${yamlQuote(finding.when)}"`,
        `    action: >`,
        body,
    ].join('\n');
}

/** The postmortem body for a finding. */
function renderPostmortem(finding, date) {
    const lines = [
        `# ${finding.title}`,
        '',
        `- **Signature:** \`${finding.id}\``,
        `- **Observed:** ${finding.occurrences} occurrence(s) in the twin's logs`,
        `- **Date:** ${date}`,
        `- **Severity:** ${finding.severity}`,
        '',
        '## What happened',
        '',
        `The failure signature \`${finding.id}\` recurred ${finding.occurrences} time(s) across the`,
        "twin's own logs. This record exists so the lesson is applied before",
        'the next occurrence, not rediscovered after it.',
        '',
        '## Evidence',
        '',
    ];
    for (const e of finding.evidence) {
        lines.push(`- \`${e.source}\` — ${e.line}`);
    }
    lines.push('');
    lines.push('## Lesson');
    lines.push('');
    lines.push(`**When:** ${finding.when}`);
    lines.push('');
    for (const l of finding.action) lines.push(l);
    lines.push('');
    lines.push('## What was NOT done');
    lines.push('');
    lines.push('No product code was changed by this loop. The lesson is recorded;');
    lines.push('applying it is a separate, deliberate act.');
    lines.push('');
    return lines.join('\n');
}

/** The tech-debt item for a finding, in the register's own shape. */
function renderDebtItem(finding, tdId) {
    const files = finding.files.length ? finding.files.map(f => `\`${f}\``).join(', ') : '_(none recorded)_';
    // The register pads its ids to three digits (TD-001 … TD-008).
    const id = String(tdId).padStart(3, '0');
    const lines = [
        `### TD-${id} · ${files} — ${finding.title}`,
        `Observed ${finding.occurrences} time(s) in the twin's logs (signature \`${finding.id}\`).`,
        `Raised automatically by \`lib/improve-loop.js\`; the prevention rule is`,
        `\`PM-${new Date().toISOString().slice(0, 10)}-${finding.id}\` in \`.kai/memory.yaml\`.`,
        '',
        `**When it bites:** ${finding.when}`,
        '',
    ];
    for (const l of finding.action) lines.push(l);
    lines.push('');
    lines.push(`Files: ${files}`);
    lines.push('');
    return lines.join('\n');
}

/** Write a file atomically: temp + rename, so a reader never sees half a file. */
function writeAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

/** The loop's own state: when it last ran, and what it found. */
function readState(file = STATE_FILE) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { lastRun: null, lastFindings: 0 };
    }
}

function writeState(file = STATE_FILE, state = {}) {
    writeAtomic(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Should the loop run now? The gap is a floor, not a schedule — a manual
 * run with --force always runs.
 */
function shouldRun(state, { now = Date.now(), intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}) {
    if (!state || !state.lastRun) return true;
    const last = Date.parse(state.lastRun);
    if (!Number.isFinite(last)) return true;
    return now - last >= intervalMinutes * 60 * 1000;
}

/**
 * One run: collect, classify, dedupe, write. `dryRun` writes nothing at
 * all — not even the state file.
 */
function run({
    repo = REPO,
    dryRun = false,
    minOccurrences = DEFAULT_MIN_OCCURRENCES,
    maxFiles = DEFAULT_MAX_FILES,
    tailBytes = DEFAULT_TAIL_BYTES,
    maxFindings = DEFAULT_MAX_FINDINGS,
    now = new Date(),
} = {}) {
    const date = now.toISOString().slice(0, 10);
    const evidence = collectEvidence({ repo, maxFiles, tailBytes });
    const findings = classify(evidence, { minOccurrences });

    const memoryFile = path.join(repo, '.kai', 'memory.yaml');
    const registerFile = path.join(repo, '.kai', 'tech-debt', 'register.md');
    const postmortemDir = path.join(repo, '.kai', 'postmortems');

    let memoryText = '';
    let registerText = '';
    let postmortems = [];
    try { memoryText = fs.readFileSync(memoryFile, 'utf8'); } catch {}
    try { registerText = fs.readFileSync(registerFile, 'utf8'); } catch {}
    try { postmortems = fs.readdirSync(postmortemDir); } catch {}

    const recorded = [];
    const fresh = [];
    for (const f of findings) {
        if (isRecorded(f.id, { memoryText, registerText, postmortems })) recorded.push(f.id);
        else fresh.push(f);
    }

    const written = [];
    for (const f of fresh.slice(0, maxFindings)) {
        if (dryRun) { written.push({ id: f.id, postmortem: null, rule: null, debt: null, dryRun: true }); continue; }

        const pmFile = path.join(postmortemDir, `${date}-${f.id}.md`);
        writeAtomic(pmFile, renderPostmortem(f, date));
        postmortems = postmortems.concat([path.basename(pmFile)]);

        const ruleBlock = renderRule(f, date);
        const ruleRes = insertYamlListItem(memoryText, 'active_prevention_rules:', ruleBlock);
        if (ruleRes.inserted) {
            writeAtomic(memoryFile, ruleRes.text);
            memoryText = ruleRes.text;
        }

        const tdId = nextDebtId(registerText);
        const debtBlock = renderDebtItem(f, tdId);
        const debtRes = insertBeforeHeading(registerText, '## Closed recently', debtBlock);
        if (debtRes.inserted) {
            writeAtomic(registerFile, debtRes.text);
            registerText = debtRes.text;
        }

        written.push({ id: f.id, postmortem: pmFile, rule: ruleRes.inserted, debt: debtRes.inserted, tdId });
    }

    const result = {
        date,
        dryRun,
        evidenceFiles: evidence.length,
        findings: findings.map(f => ({ id: f.id, occurrences: f.occurrences, known: recorded.includes(f.id) })),
        recorded,
        written,
        skipped: Math.max(0, fresh.length - Math.min(fresh.length, maxFindings)),
    };

    if (!dryRun) {
        writeState(path.join(repo, '.kai', 'state', 'improve-loop.json'), {
            lastRun: now.toISOString(),
            lastFindings: findings.length,
            written: written.map(w => w.id),
        });
    }
    return result;
}

function usage() {
    return [
        'usage: node lib/improve-loop.js [--dry-run] [--json] [--min N] [--interval MIN] [--force]',
        '',
        '  --dry-run        classify and report; write nothing',
        '  --json           machine-readable result on stdout',
        '  --min N          occurrences needed to record a signature (default 3)',
        '  --interval MIN   minutes between runs (default 30); --force ignores it',
        '  --force          run even if the interval has not elapsed',
    ].join('\n');
}

function main(argv) {
    const opts = { dryRun: false, json: false, min: DEFAULT_MIN_OCCURRENCES, interval: DEFAULT_INTERVAL_MINUTES, force: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--json') opts.json = true;
        else if (arg === '--force') opts.force = true;
        // A value flag consumes the next argv entry — it must be consumed
        // here, in the same pass, or the value is read as an unknown flag.
        else if (arg === '--min') { opts.min = parseInt(argv[i + 1], 10); i++; }
        else if (arg === '--interval') { opts.interval = parseInt(argv[i + 1], 10); i++; }
        else if (arg === '--help' || arg === '-h') { process.stdout.write(usage() + '\n'); return 0; }
        else if (/^--min=/.test(arg)) opts.min = parseInt(arg.slice(6), 10);
        else if (/^--interval=/.test(arg)) opts.interval = parseInt(arg.slice(11), 10);
        else { process.stderr.write(`unknown flag: ${arg}\n${usage()}\n`); return 2; }
    }
    if (!Number.isFinite(opts.min) || opts.min < 1) { process.stderr.write('--min must be a positive integer\n'); return 2; }
    if (!Number.isFinite(opts.interval) || opts.interval < 0) { process.stderr.write('--interval must be a non-negative number\n'); return 2; }

    const state = readState(STATE_FILE);
    if (!opts.force && !opts.dryRun && !shouldRun(state, { intervalMinutes: opts.interval })) {
        const msg = { skipped: 'interval', lastRun: state.lastRun, intervalMinutes: opts.interval };
        if (opts.json) process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
        else process.stdout.write(`improve-loop: last ran ${state.lastRun} — within the ${opts.interval}m interval, nothing to do\n`);
        return 0;
    }

    const result = run({ dryRun: opts.dryRun, minOccurrences: opts.min });
    if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
        process.stdout.write(`improve-loop: ${result.evidenceFiles} log(s) read, ${result.findings.length} signature(s) seen\n`);
        for (const f of result.findings) {
            process.stdout.write(`  ${f.known ? 'known' : 'NEW  '}  ${f.id} — ${f.occurrences} occurrence(s)\n`);
        }
        for (const w of result.written) {
            const verb = opts.dryRun ? 'would write' : 'wrote';
            process.stdout.write(`  ${verb} ${w.id}: postmortem + prevention rule + tech-debt item\n`);
        }
        if (!result.written.length) process.stdout.write('  nothing new to record\n');
    }
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    SIGNATURES,
    REPO,
    KAI_DIR,
    MEMORY_FILE,
    REGISTER_FILE,
    POSTMORTEM_DIR,
    STATE_FILE,
    DEFAULT_TAIL_BYTES,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_FINDINGS,
    DEFAULT_MIN_OCCURRENCES,
    DEFAULT_INTERVAL_MINUTES,
    tailFile,
    listLogFiles,
    collectEvidence,
    classify,
    knownRuleIds,
    knownDebtIds,
    nextDebtId,
    isRecorded,
    insertYamlListItem,
    insertBeforeHeading,
    yamlQuote,
    renderRule,
    renderPostmortem,
    renderDebtItem,
    writeAtomic,
    readState,
    writeState,
    shouldRun,
    run,
    main,
    usage,
};
