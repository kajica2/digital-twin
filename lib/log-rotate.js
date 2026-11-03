'use strict';
// lib/log-rotate.js — daily rotation for the repo's logs.
//
// This started as the Node port of bin/log-rotate.sh (now removed — the
// shell implementation and this file's node port were never two live
// paths), and it differs from the shell version in ONE way that matters:
//
//   The shell version RENAMED the live log (`mv "$f" "${name}.log.1"`)
//   before gzipping it. Every writer in this repo holds an O_APPEND
//   file descriptor bound to the INODE, so a rename orphans the writer:
//   it keeps appending to the renamed inode forever, the fresh
//   `<name>.log` comes back empty, and the process that owns the fd
//   looks like it is writing to nothing.
//
//   So: gzip the CONTENT into `<name>.log.1.gz`, then TRUNCATE the
//   original in place. The inode survives, every writer's fd stays
//   valid, and the next append lands at offset 0 of the same file.
//
// Why Node at all: this started as a shell script, and the shell
// LaunchAgent that ran it died with exit 126 ("Operation not
// permitted") — launchd on Sequoia grants filesystem access PER BINARY,
// and /bin/bash has no grant for ~/Documents. node IS granted, so the
// implementation moved here and the shell version was deleted rather
// than left as a second, never-running path.
//
// Rotation window: 7 daily generations, gzipped. `.1.gz` is the most
// recent; older ones count up to `.7.gz`; anything past that is purged.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '..');
const LOG_DIR = path.join(REPO, 'logs');
const KEEP = 7;
const PURGE_MAX = 60;

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Rotate one log file. Never throws for a missing or unreadable file —
 * a rotation job that dies halfway is worse than one that skips a file.
 *
 * Returns { file, rotated, reason, size, kept }.
 */
function rotateOne(file, { keep = KEEP, purgeMax = PURGE_MAX } = {}) {
    let stat = null;
    try {
        stat = fs.statSync(file);
    } catch {
        return { file, rotated: false, reason: 'missing', size: 0 };
    }
    if (!stat.isFile()) {
        return { file, rotated: false, reason: 'not-a-file', size: stat.size };
    }

    const base = file.replace(/\.log$/, '');
    const rot = (n) => `${base}.log.${n}.gz`;

    // Bump the old generations up FIRST, highest index first so we
    // never clobber a rotation we have not moved yet.
    for (let i = keep; i >= 2; i--) {
        const prev = rot(i - 1);
        if (!fs.existsSync(prev)) continue;
        try {
            fs.renameSync(prev, rot(i));
        } catch {
            // A rotation we cannot move is a rotation we cannot keep;
            // leave it and carry on.
        }
    }

    let size = stat.size;
    let rotated = false;
    if (size > 0) {
        try {
            const content = fs.readFileSync(file);
            fs.writeFileSync(rot(1), zlib.gzipSync(content, { level: 9 }));
            // Truncate IN PLACE — same inode, same open writers.
            const fd = fs.openSync(file, 'r+');
            try {
                fs.ftruncateSync(fd, 0);
            } finally {
                fs.closeSync(fd);
            }
            rotated = true;
        } catch (e) {
            return { file, rotated: false, reason: `unwritable: ${e.message}`, size };
        }
    }

    // Purge anything past the window.
    let purged = 0;
    for (let n = keep + 1; n <= purgeMax; n++) {
        const p = rot(n);
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                purged++;
            }
        } catch {
            /* leave it */
        }
    }

    return { file, rotated, reason: rotated ? 'rotated' : 'empty', size, kept: rot(1), purged };
}

/**
 * Rotate every *.log in a directory. Returns one summary per file.
 */
function rotateDir(dir, opts = {}) {
    let names = [];
    try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort();
    } catch {
        return [];
    }
    return names.map((n) => rotateOne(path.join(dir, n), opts));
}

/**
 * The completion line the shell version appended to logs/log-rotate.log.
 */
function appendDoneLine(logDir = LOG_DIR, when = new Date()) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'log-rotate.log'), `[log-rotate] done at ${stamp(when)}\n`);
    } catch {
        /* the summary is a courtesy, not a contract */
    }
}

function main(argv = process.argv.slice(2), deps = {}) {
    const { logDir = LOG_DIR, keep = KEEP, out = (s) => process.stdout.write(`${s}\n`) } = deps;
    fs.mkdirSync(logDir, { recursive: true });

    const summaries = argv.length
        ? argv.map((f) => rotateOne(path.resolve(f), { keep }))
        : rotateDir(logDir, { keep });

    for (const s of summaries) {
        if (s.reason === 'missing') continue;
        out(s.rotated
            ? `[log-rotate] rotated ${path.basename(s.file)} (${s.size} B -> ${path.basename(s.kept)})`
            : `[log-rotate] skipped ${path.basename(s.file)} (${s.reason})`);
    }
    appendDoneLine(logDir);
    out(`[log-rotate] done at ${stamp()}`);
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (e) {
        process.stderr.write(`[log-rotate] fatal: ${e && e.message ? e.message : e}\n`);
        process.exit(1);
    }
}

module.exports = { rotateOne, rotateDir, appendDoneLine, stamp, main, REPO, LOG_DIR, KEEP };
