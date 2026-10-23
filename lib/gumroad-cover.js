#!/usr/bin/env node
'use strict';
// lib/gumroad-cover.js
//
// Gumroad's thumbnail validator (app/models/thumbnail.rb) is strict:
//
//     elsif original_width != original_height  -> "Please upload a square thumbnail."
//     elsif original_width < 600 ...            -> "Could not process your thumbnail"
//
// Most of the twin's artwork is NOT square: the plates are 832×464, the
// daily frames 1280×716, the reel posters 1080×1920. Only the cover-study
// JPGs (832×832) pass as-is.
//
// So a cover has to be prepared: centre-crop to a square, then scale it to
// 800×800 (comfortably over the 600px floor). The crop keeps the middle of
// the frame, which for these plates is the subject.
//
// TWO DEPENDENCIES, BOTH ON THE MACHINE ALREADY
//
//   * ffmpeg — the repo already shells out to it (lib/reel-watcher.js,
//     lib/daily-reels.js). It does the crop and the resize.
//   * a pure-node image header reader (below) — so the crop rectangle can be
//     computed exactly instead of guessed with ffmpeg filter expressions.
//
// The generated covers are written under `data/gumroad/covers/`, which is
// gitignored: they are derived artifacts, not source.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'gumroad', 'covers');
const TARGET = 800;

/**
 * Read an image's pixel dimensions from its header.
 *
 * Handles JPEG (SOF0/1/2 markers), PNG (IHDR) and WebP (VP8/VP8L/VP8X).
 * Returns {width, height} or null when the format is not recognised.
 */
function imageSize(filePath) {
    let buf;
    try { buf = fs.readFileSync(filePath); } catch { return null; }
    if (buf.length < 24) return null;

    // PNG: 8-byte signature, then an IHDR chunk with the dimensions.
    if (buf.readUInt32BE(0) === 0x89504e47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // WebP: "RIFF"...."WEBP"
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8 ') {
            return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === 'VP8L') {
            const bits = buf.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') {
            const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
            const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
            return { width: w + 1, height: h + 1 };
        }
        return null;
    }

    // JPEG: walk the segment chain to the start-of-frame marker.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off < buf.length - 9) {
            if (buf[off] !== 0xff) { off++; continue; }
            const marker = buf[off + 1];
            // SOF0..SOF15, minus the DHT/JPG/DAC markers that share the range.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
            }
            const len = buf.readUInt16BE(off + 2);
            if (len < 2) return null;
            off += 2 + len;
        }
    }
    return null;
}

function ffmpegAvailable() {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        return true;
    } catch { return false; }
}

/**
 * The crop rectangle that turns a W×H image into the largest centred square.
 */
function squareCrop(width, height) {
    const side = Math.min(width, height);
    return { width: side, height: side, x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2) };
}

/**
 * A square, >=600px JPEG for `filePath`, ready to be uploaded as a cover.
 *
 * Returns:
 *   { path, generated }  — path to the file to upload; `generated` is false
 *                          when the source was already usable.
 *   null                 — when no square cover could be produced.
 */
function squareCover(filePath) {
    const abs = path.resolve(REPO, filePath);
    if (!fs.existsSync(abs)) return null;
    const size = imageSize(abs);
    if (!size) return null;

    // Already square and big enough: use it as-is.
    if (size.width === size.height && size.width >= 600) {
        return { path: abs, generated: false };
    }
    if (!ffmpegAvailable()) return null;

    const crop = squareCrop(size.width, size.height);
    const key = crypto.createHash('sha1')
        .update(`${abs}:${size.width}x${size.height}:${TARGET}`)
        .digest('hex')
        .slice(0, 16);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${path.basename(abs, path.extname(abs))}-${key}.jpg`);

    // Re-encode only when the cached artifact is missing.
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
        try {
            execFileSync('ffmpeg', [
                '-y', '-v', 'error', '-i', abs,
                '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${TARGET}:${TARGET}`,
                '-q:v', '3', out,
            ], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) {
            return null;
        }
    }
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return null;
    return { path: out, generated: true };
}

module.exports = { imageSize, squareCrop, squareCover, ffmpegAvailable, OUT_DIR, TARGET };

if (require.main === module) {
    for (const f of process.argv.slice(2)) {
        const r = squareCover(f);
        if (!r) { console.log(`${f}: no square cover`); continue; }
        const s = imageSize(r.path);
        console.log(`${f} -> ${r.path} (${s.width}x${s.height}${r.generated ? '' : ' — source reused'})`);
    }
}
