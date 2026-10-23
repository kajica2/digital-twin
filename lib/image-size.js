/**
 * The pixel size of an image, read from its own header.
 *
 * The only reader here used to be `sips`, and `sips` ships with
 * macOS. On any other machine it threw, the catch returned null, and
 * the callers that need a real size built a wrong-sized video without
 * saying so — the reel's vertical source was scaled against `null`.
 *
 * The dimensions are in the file. PNG, JPEG and GIF all carry them in
 * the first few bytes, so a header read is both portable and faster
 * than shelling out. `sips` is kept as the fallback for the formats
 * this does not parse (HEIC, TIFF), where macOS can still answer.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

/** How much of the file to read. A JPEG's SOF segment is near the
 *  front, but not in the first bytes. */
const HEAD_BYTES = 262144;

/** PNG: an 8-byte signature, then the IHDR chunk — width and height
 *  as two big-endian uint32 at offsets 16 and 20. */
function readPng(buf) {
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** JPEG: a chain of marker segments, the first of which that is a
 *  frame header (SOF0..SOF15, minus the ones that are not frame
 *  headers) carries the height and width. */
function readJpeg(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // Standalone markers: no length, no payload.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
        // End of image, or the start of the scan — no frame header
        // before it means this is not a decodable JPEG.
        if (marker === 0xd9 || marker === 0xda) return null;
        const len = buf.readUInt16BE(i + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

/** GIF: the logical screen descriptor — width and height as two
 *  little-endian uint16 at offsets 6 and 8. */
function readGif(buf) {
    if (buf.length < 10) return null;
    if (buf.slice(0, 3).toString('latin1') !== 'GIF') return null;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** The header bytes of a file, or null if it cannot be read. */
function readHead(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.slice(0, read);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
}

/** The size, or null if the file is not an image this can measure. */
function imageSize(file) {
    const head = readHead(file);
    if (head) {
        const size = readPng(head) || readJpeg(head) || readGif(head);
        if (size && size.width && size.height) return size;
    }
    // The formats this does not parse. macOS can still measure them.
    try {
        const out = execFileSync('sips',
            ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
        const w = Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1]);
        const h = Number((out.match(/pixelHeight:\s*(\d+)/) || [])[1]);
        return w && h ? { width: w, height: h } : null;
    } catch {
        return null;
    }
}

module.exports = { imageSize };
