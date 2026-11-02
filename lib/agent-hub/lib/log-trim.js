'use strict';
// lib/agent-hub/lib/log-trim.js — cap the hub's log files IN PLACE.
//
// The hub's processes write their stdout straight into pids/<name>.log
// through an O_APPEND file descriptor (`>> "$logfile"` in agent-hub.sh,
// `fs.openSync(logPath, 'a')` in hub-launch.js). That fd is bound to the
// INODE, so the usual rotation trick — rename the file and gzip it —
// would orphan the running process: it would keep appending to the
// renamed inode forever and the log would come back at zero bytes with
// an invisible writer still attached.
//
// So: never rename. Truncate the same inode and write the tail back
// into it. The writer's fd stays valid and its next append lands at the
// new end of file.
//
// Why this lives in node and not in bin/log-rotate.sh: the log-rotate
// LaunchAgent runs `/bin/bash $HOME/digital-twin/bin/log-rotate.sh` and
// dies with exit 126 ("Operation not permitted") — launchd on Sequoia
// grants filesystem access PER BINARY and /bin/bash has no grant for
// ~/Documents. That script has never run at this location, so a fix
// there would be a fix to a dead code path. node IS granted, and the
// hub's own launcher already runs every five minutes with exit 0.
//
// Trimming loses at most the few lines a writer appends in the
// microsecond between our read and our write. For a status log that is
// the right trade: the alternative is an unbounded file.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_KEEP_LINES = 2000;

/**
 * Trim one log file in place, keeping its last `keepLines` lines.
 * Returns a summary; never throws for a missing or unreadable file.
 */
function trimLogFile(file, { maxBytes = DEFAULT_MAX_BYTES, keepLines = DEFAULT_KEEP_LINES } = {}) {
    let size = 0;
    try {
        size = fs.statSync(file).size;
    } catch {
        return { file, trimmed: false, reason: 'missing', size: 0 };
    }
    if (size <= maxBytes) {
        return { file, trimmed: false, reason: 'under-cap', size };
    }

    // Read the tail. 4 bytes per line is a generous guess; if the tail
    // holds fewer than keepLines newlines we widen the window once.
    let want = Math.min(size, maxBytes * 2);
    let tail = '';
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        for (;;) {
            const buf = Buffer.alloc(want);
            const read = fs.readSync(fd, buf, 0, want, size - want);
            tail = buf.subarray(0, read).toString('utf8') + tail;
            const lines = tail.split('\n');
            if (lines.length > keepLines + 1 || want >= size) break;
            want = Math.min(size, want * 4);
        }
    } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        return { file, trimmed: false, reason: `unreadable: ${e.message}`, size };
    }

    // A trailing newline makes split() yield a final empty element; it is
    // not a line, and counting it would drop a real one.
    const lines = tail.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const kept = lines.slice(Math.max(0, lines.length - keepLines)).join('\n');
    const payload = kept.endsWith('\n') ? kept : `${kept}\n`;

    try {
        // Same inode: truncate to zero, then write the tail back at 0.
        const wfd = fs.openSync(file, 'r+');
        fs.ftruncateSync(wfd, 0);
        fs.writeSync(wfd, payload, 0, payload.length, 0);
        fs.closeSync(wfd);
    } catch (e) {
        return { file, trimmed: false, reason: `unwritable: ${e.message}`, size };
    }

    const after = fs.statSync(file).size;
    return { file, trimmed: true, reason: 'trimmed', size, after, keptLines: payload.split('\n').length - 1 };
}

/**
 * Trim every *.log in a directory. Returns one summary per file.
 */
function trimLogDir(dir, opts = {}) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names.sort()) {
        if (!name.endsWith('.log')) continue;
        out.push(trimLogFile(path.join(dir, name), opts));
    }
    return out;
}

module.exports = { trimLogFile, trimLogDir, DEFAULT_MAX_BYTES, DEFAULT_KEEP_LINES };
