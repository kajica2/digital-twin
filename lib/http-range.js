'use strict';
// lib/http-range.js
//
// Single-range `Range:` header parsing, split out of lib/serve.js for the same
// reason lib/xml-guard.js was split out of chart-export.js: the interesting
// logic is worth testing, and requiring serve.js to reach it starts a server.
//
// Contract:
//   parseRange(header, size) ->
//     {start, end}            a satisfiable single range (both inclusive)
//     null                    no header, or a form we deliberately ignore
//                              (multi-range, garbage) -> caller serves 200,
//                              which is always legal
//     'unsatisfiable'         syntactically valid but outside the file ->
//                              caller answers 416 with `Content-Range: bytes */size`

/**
 * @param {string|undefined} header raw Range header value
 * @param {number} size total resource size in bytes
 * @returns {{start:number,end:number}|null|'unsatisfiable'}
 */
function parseRange(header, size) {
    if (header === undefined || header === null || header === '') return null;
    const text = String(header).trim();

    // Comma = multi-range. We do not implement multipart/byteranges; returning
    // null makes the caller send the full 200, which is spec-legal.
    if (text.includes(',')) return null;

    const m = /^bytes=(\d*)-(\d*)$/.exec(text);
    if (!m) return null;

    const [, a, b] = m;
    if (a === '' && b === '') return null; // "bytes=-" is meaningless

    let start;
    let end;
    if (a === '') {                          // suffix form: last N bytes
        const n = Number(b);
        if (!Number.isInteger(n) || n <= 0) return 'unsatisfiable';
        if (size === 0) return 'unsatisfiable';
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = Number(a);
        end = b === '' ? size - 1 : Number(b);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
        if (start >= size || start > end) return 'unsatisfiable';
        end = Math.min(end, size - 1);
    }

    if (size === 0) return 'unsatisfiable';
    if (start < 0 || start > end || end >= size) return 'unsatisfiable';
    return { start, end };
}

module.exports = { parseRange };
