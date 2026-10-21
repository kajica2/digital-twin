#!/usr/bin/env node
'use strict';
// lib/musicxml-to-pdf.js
//
// Sprint 0.24 — MusicXML → PDF, and nothing else.
//
// The chart pipeline (lib/chart-export.js) does a lot: splits parts,
// builds muted variants, writes a manifest, exports MIDI and MP3s.
// Sometimes you just want one PDF out of one score. This is that.
//
// Handles both score containers, because MuseScore reads both:
//   .musicxml / .xml   plain-text MusicXML
//   .mxl              compressed MusicXML (a ZIP; how MuseScore and
//                      most engravers ship scores)
//
// Usage:
//   node lib/musicxml-to-pdf.js score.musicxml
//   node lib/musicxml-to-pdf.js score.mxl --out ./pdf
//   node lib/musicxml-to-pdf.js ./scores --out ./pdf --jobs 4
//   node lib/musicxml-to-pdf.js ./scores --out ./pdf --skip-existing
//
// Options:
//   --out <dir>        output directory (default: ./pdf-out)
//   --jobs <n>         parallel renders (default 1 — see note below)
//   --timeout <sec>    per-file render timeout (default 300)
//   --skip-existing    skip when the target PDF exists and is newer
//                      than its source
//   --flat             write all PDFs directly into --out (default)
//   --keep-tree        mirror each input's directory structure under --out
//   --dry-run          report what would be rendered, render nothing
//   --quiet            only print problems and the summary
//   --help, -h
//
// On parallelism: mscore is a full Qt application (~200 MB resident)
// that also writes shared state under
// ~/Library/Application Support/MuseScore. Serial is the safe default.
// --jobs works and is materially faster on a big corpus, but it is
// opt-in because concurrent instances contend on that shared state.
//
// Exit codes:
//   0  every render succeeded (or was skipped)
//   1  at least one render failed
//   2  bad usage / no inputs / mscore missing
//
// Pure Node, no deps beyond a `mscore` binary on PATH.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { musicXmlIsWellFormed } = require('./xml-guard.js');

// ---------- args ----------
const ARGV = process.argv.slice(2);
function flagValue(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const HELP         = ARGV.includes('--help') || ARGV.includes('-h');
const OUT_DIR      = path.resolve(flagValue('--out', path.join(process.cwd(), 'pdf-out')));
const JOBS         = Math.max(1, parseInt(flagValue('--jobs', '1'), 10) || 1);
const TIMEOUT_MS   = Math.max(5, parseInt(flagValue('--timeout', '300'), 10) || 300) * 1000;
const SKIP_EXISTING= ARGV.includes('--skip-existing');
const KEEP_TREE    = ARGV.includes('--keep-tree');
const DRY_RUN      = ARGV.includes('--dry-run');
const QUIET        = ARGV.includes('--quiet');

const INPUTS = ARGV.filter(a => !a.startsWith('--'))
    .filter(a => {
        // drop values consumed by flags
        const i = ARGV.indexOf(a);
        return !(i > 0 && ['--out', '--jobs', '--timeout'].includes(ARGV[i - 1]));
    });

const SCORE_EXTS = new Set(['.musicxml', '.xml', '.mxl']);
const COMPRESSED = new Set(['.mxl']);

function log(msg) { if (!QUIET) process.stdout.write(msg + '\n'); }
function warn(msg) { process.stderr.write(msg + '\n'); }

function usage() {
    process.stdout.write(`MusicXML → PDF (one job: a PDF per score)

Usage:
  node lib/musicxml-to-pdf.js <input...> [options]

Inputs may be files, directories (walked recursively), or a mix.
Recognised score formats: .musicxml  .xml  .mxl (compressed MusicXML)

Options:
  --out <dir>        output directory (default: ./pdf-out)
  --jobs <n>         parallel renders (default 1; see the header note)
  --timeout <sec>    per-file render timeout (default 300)
  --skip-existing    skip targets already newer than their source
  --keep-tree        mirror input directory structure under --out
  --flat             write all PDFs directly into --out (default)
  --dry-run          list what would be rendered, render nothing
  --quiet            print only problems and the summary
  --help, -h         this message

Requires mscore (MuseScore 4) on PATH:  brew install --cask musescore
`);
}

// ---------- discovery ----------
function walk(dir, acc) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { warn(`[pdf] cannot read ${dir}: ${e.message}`); return acc; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (SCORE_EXTS.has(path.extname(e.name).toLowerCase())) acc.push(p);
    }
    return acc;
}

function collectInputs(inputs) {
    const out = [];
    for (const raw of inputs) {
        const p = path.resolve(raw);
        if (!fs.existsSync(p)) { warn(`[pdf] no such path: ${raw}`); continue; }
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (SCORE_EXTS.has(path.extname(p).toLowerCase())) out.push(p);
        else warn(`[pdf] skipping unsupported file: ${raw}`);
    }
    return [...new Set(out)].sort();
}

// ---------- target naming ----------
//
// The output name is the source basename with a .pdf extension, so
// `0001_t3.mxl` → `0001_t3.pdf`. With --flat (the default) two sources
// of the same basename in different directories would collide; the
// first one rendered wins and the second is reported as a collision
// rather than silently overwriting.
function targetFor(src, roots) {
    const base = path.basename(src).replace(/\.[^.]+$/, '.pdf');
    if (!KEEP_TREE) return path.join(OUT_DIR, base);
    // Find the input root this file came from so the relative path is
    // stable and readable.
    let rel = path.basename(src);
    for (const root of roots) {
        const rp = path.resolve(root);
        if (src.startsWith(rp + path.sep)) {
            rel = path.relative(rp, src);
            break;
        }
    }
    return path.join(OUT_DIR, rel).replace(/\.[^.]+$/, '.pdf');
}

// ---------- render ----------
//
// mscore's exit code is NOT the success signal: on macOS its Qt
// shutdown routinely exits 134 (SIGABRT) or non-zero *after* writing a
// complete file. The file is the source of truth. That quirk is long
// established in this repo — see lib/chart-export.js runMscore().
//
// This uses async `spawn`, not `spawnSync`: spawnSync blocks the event
// loop, which would make the --jobs pool silently serial (measured:
// no difference between --jobs 1 and --jobs 4 before this changed).
function renderOne(src, dst) {
    return new Promise((resolve) => {
        const ext = path.extname(src).toLowerCase();

        // Plain-text scores: reject malformed XML before mscore hangs on
        // it. .mxl is a ZIP, so the tag scan does not apply; those rely
        // on the timeout instead.
        if (!COMPRESSED.has(ext)) {
            const wf = musicXmlIsWellFormed(src);
            if (!wf.ok) {
                resolve({ ok: false, reason: `malformed XML — ${wf.reason}` });
                return;
            }
        }

        fs.mkdirSync(path.dirname(dst), { recursive: true });
        // A stale file at the target would defeat the "did mscore write
        // it" check, so clear it first.
        try { fs.unlinkSync(dst); } catch {}

        const t0 = Date.now();
        const child = spawn('mscore', ['-f', src, '-o', dst], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch {}
        }, TIMEOUT_MS);

        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ ok: false, reason: `could not spawn mscore: ${e.message}` });
        });
        child.on('close', () => {
            clearTimeout(timer);
            if (timedOut) {
                resolve({ ok: false, reason: `mscore timed out after ${TIMEOUT_MS / 1000}s` });
                return;
            }
            if (!fs.existsSync(dst)) {
                const tail = stderr.split('\n').filter(Boolean).slice(-2).join(' | ');
                resolve({ ok: false, reason: `mscore wrote no output${tail ? ` :: ${tail}` : ''}` });
                return;
            }
            const size = fs.statSync(dst).size;
            if (size === 0) {
                resolve({ ok: false, reason: 'mscore wrote an empty PDF' });
                return;
            }
            resolve({ ok: true, bytes: size, sec: (Date.now() - t0) / 1000 });
        });
    });
}

// ---------- main ----------
async function main() {
    if (HELP) { usage(); process.exit(0); }
    if (INPUTS.length === 0) {
        warn('[pdf] no inputs given');
        usage();
        process.exit(2);
    }
    const probe = spawnSync('/bin/sh', ['-c', 'command -v mscore'], { encoding: 'utf8' });
    if (!probe.stdout.trim()) {
        warn('[pdf] mscore not found on PATH. Install with:  brew install --cask musescore');
        process.exit(2);
    }

    const files = collectInputs(INPUTS);
    if (files.length === 0) {
        warn('[pdf] no score files found (.musicxml / .xml / .mxl)');
        process.exit(2);
    }

    const roots = INPUTS;
    const jobs = [];
    const seenTargets = new Map();
    for (const src of files) {
        const dst = targetFor(src, roots);
        if (seenTargets.has(dst)) {
            jobs.push({ src, dst, skip: `target collision with ${seenTargets.get(dst)}` });
            continue;
        }
        seenTargets.set(dst, src);
        if (SKIP_EXISTING && fs.existsSync(dst)
            && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
            jobs.push({ src, dst, skip: 'target already newer' });
            continue;
        }
        jobs.push({ src, dst });
    }

    const todo = jobs.filter(j => !j.skip);
    log(`[pdf] ${files.length} score(s) found · ${todo.length} to render · ${jobs.length - todo.length} skipped`);
    log(`[pdf] output: ${OUT_DIR}${KEEP_TREE ? ' (keeping directory structure)' : ''}`);
    if (DRY_RUN) {
        for (const j of jobs) {
            log(`[pdf]   ${j.skip ? 'skip' : 'would render'}  ${path.relative(process.cwd(), j.src)}`
                + `${j.skip ? `  (${j.skip})` : ''}`);
        }
        log('[pdf] dry run — nothing rendered');
        process.exit(0);
    }
    if (todo.length === 0) {
        log('[pdf] nothing to do');
        process.exit(0);
    }

    let done = 0, failed = 0, bytes = 0;
    const failures = [];
    const t0 = Date.now();

    // Serial by default. --jobs>1 runs a bounded pool; mscore is a full
    // Qt app, so this is opt-in (see header note on shared state).
    let cursor = 0;
    async function worker() {
        while (true) {
            const my = cursor++;
            if (my >= todo.length) return;
            const { src, dst } = todo[my];
            const res = await renderOne(src, dst);
            done += 1;
            if (res.ok) {
                bytes += res.bytes;
                log(`[pdf] (${done}/${todo.length}) ok  ${path.basename(dst)}  ${res.bytes} B  ${res.sec.toFixed(1)}s`);
            } else {
                failed += 1;
                failures.push({ src, dst, reason: res.reason });
                warn(`[pdf] (${done}/${todo.length}) FAIL ${path.basename(src)} — ${res.reason}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, worker));

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    log('');
    log(`[pdf] rendered ${todo.length - failed}/${todo.length} in ${sec}s · ${(bytes / 1048576).toFixed(1)} MB`);
    if (failures.length) {
        log(`[pdf] ${failures.length} failure(s):`);
        for (const f of failures) log(`[pdf]   ${path.basename(f.src)} — ${f.reason}`);
    }
    process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
    main().catch(e => { warn(`[pdf] fatal: ${e.message}`); process.exit(1); });
}

module.exports = { collectInputs, targetFor, renderOne, SCORE_EXTS };
