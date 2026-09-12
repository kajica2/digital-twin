#!/usr/bin/env node
// lib/songs-indexer.js
//
// Sprint 2 — the song indexer. Walks a configurable list of root
// directories, extracts metadata from audio files (MP3 ID3v2, WAV
// RIFF/fmt), writes a single searchable JSON catalog to
// data/songs/catalog.json.
//
// Mirrors the existing repo voice: pure-Node, no deps, idempotent.
//
// Usage:
//   node lib/songs-indexer.js                          # dry run, prints summary
//   node lib/songs-indexer.js --apply                  # writes catalog.json
//   node lib/songs-indexer.js --apply --yes            # skip prompt
//   node lib/songs-indexer.js --config <path>          # alternate config file
//   node lib/songs-indexer.js --add <file> [--add ...] # add one or more MP3/WAV
//                                                    # files to the catalog under
//                                                    # the "manual" root (override
//                                                    # label with --label <name>).
//                                                    # Repeatable.
//
// Config: lib/sources.config.json (defaults to AGENTS.md-named dirs)
//   {
//     "roots": [
//       { "path": "/Users/<you>/Documents/jazz solos", "label": "jazz-solos" },
//       { "path": "/Users/<you>/Documents/meditations", "label": "meditations" },
//       { "path": "/Users/<you>/Documents/music_to_mp4", "label": "music-to-mp4" }
//     ]
//   }
//
// Output: data/songs/catalog.json
//   {
//     "generatedAt": "2026-08-03T15:30:00.000Z",
//     "durationMs": 1234,
//     "roots": [ { "label": "...", "path": "...", "found": 12 } ],
//     "items": [
//       {
//         "id": "jazz-solos/ArtPepper_Anthropology.mp3",
//         "label": "jazz-solos",
//         "relPath": "ArtPepper_Anthropology.mp3",
//         "absPath": "/Users/.../jazz solos/ArtPepper_Anthropology.mp3",
//         "format": "mp3" | "wav",
//         "size": 1234567,
//         "mtime": "2026-08-03T15:00:00.000Z",
//         "tags": { "title": "...", "artist": "...", "album": "...",
//                   "year": "1979", "genre": "Cool", "bpm": "218",
//                   "track": "1" },
//         "durationSec": null,
//         "sampleRate": null,
//         "channels": null
//       }
//     ]
//   }
//
// Exit:
//   0  on success
//   1  on filesystem / parse error
//   2  on conflict (config invalid, roots missing, etc.)
//
// Scope (intentionally narrow — sprint 2):
//   - Walk configured roots (recursively, follow symlinks: no)
//   - Extract metadata from .mp3 (ID3v2.3 / ID3v2.4) and .wav (RIFF fmt)
//   - Skip everything else (log to stderr, don't include in catalog)
//   - Fail soft on per-file parse errors (log + skip, don't abort)
//   - Write a single JSON file the Songs panel can fetch
//
// What it does NOT do (deferred):
//   - FLAC / M4A / AAC / OGG parsing (future sprint, easy to add)
//   - Audio fingerprinting or content-based dedup
//   - Embedding or any ML
//   - Real-time filesystem watching (cron-driven rebuild is enough)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const YES = ARGV.includes('--yes');
const HELP = ARGV.includes('--help') || ARGV.includes('-h');
const KEEP_ABSPATH = ARGV.includes('--keep-abspath'); // debug-only; default strips for hygiene
const CFG_FLAG = ARGV.indexOf('--config');
const CONFIG_PATH = CFG_FLAG !== -1 && ARGV[CFG_FLAG + 1]
  ? path.resolve(ARGV[CFG_FLAG + 1])
  : path.join(ROOT, 'lib', 'sources.config.json');

// `--add <path>` is repeatable. Each arg after a `--add` token until the
// next flag (or end of argv) is treated as a file path.
const MANUAL_LABEL_DEFAULT = 'manual';
function collectAdds() {
  const adds = [];
  for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === '--add') {
      for (let j = i + 1; j < ARGV.length; j++) {
        if (ARGV[j].startsWith('--')) break;
        adds.push(ARGV[j]);
      }
    }
  }
  return adds;
}
const MANUAL_FILES = collectAdds();
const LABEL_FLAG = ARGV.indexOf('--label');
const MANUAL_LABEL = LABEL_FLAG !== -1 && ARGV[LABEL_FLAG + 1] && !ARGV[LABEL_FLAG + 1].startsWith('--')
  ? ARGV[LABEL_FLAG + 1]
  : MANUAL_LABEL_DEFAULT;

const OUT_PATH = path.join(ROOT, 'data', 'songs', 'catalog.json');

const SUPPORTED_EXTS = new Set(['.mp3', '.wav', '.aif', '.aiff']);

// --- helpers -------------------------------------------------------------

function log(msg) { process.stderr.write(`[indexer] ${msg}\n`); }

function readId3v2Text(buf, offset, size, encoding) {
  // encoding: 0 = ISO-8859-1, 1 = UTF-16 (with BOM), 2 = UTF-16BE, 3 = UTF-8
  if (encoding === 3) return buf.toString('utf8', offset + 1, offset + size);
  if (encoding === 0) return buf.toString('latin1', offset + 1, offset + size);
  // 1 or 2: UTF-16
  let start = offset + (encoding === 1 ? 3 : 1); // skip BOM for encoding 1
  let end = offset + size;
  // strip trailing null bytes
  while (end > start && buf[end - 1] === 0) end--;
  if (end <= start) return '';
  // detect BOM if present
  if (buf[start] === 0xFF && buf[start + 1] === 0xFE) start += 2;
  else if (buf[start] === 0xFE && buf[start + 1] === 0xFF) start += 2;
  return buf.toString('utf16le', start, end);
}

function parseId3v2(buf) {
  // buf starts with "ID3" (already checked by caller). Header:
  //   "ID3" (3) + ver (2) + flags (1) + size (4, syncsafe)
  const verMajor = buf[3];
  if (verMajor !== 3 && verMajor !== 4) return {};
  const flags = buf[5];
  const tagSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];

  let offset = 10;
  if (flags & 0x40) {
    // Extended header present — skip it. Size is also syncsafe.
    if (offset + 4 > buf.length) return {};
    const extSize = (buf[offset] << 21) | (buf[offset + 1] << 14)
                  | (buf[offset + 2] << 7) | buf[offset + 3];
    offset += 4 + extSize;
  }

  const end = Math.min(offset + tagSize, buf.length);
  const tags = {};

  while (offset + 10 <= end) {
    const frameId = buf.toString('ascii', offset, offset + 4);
    if (frameId[0] === '\0') break; // padding
    let frameSize;
    if (verMajor === 4) {
      frameSize = (buf[offset + 4] << 21) | (buf[offset + 5] << 14)
                | (buf[offset + 6] << 7) | buf[offset + 7];
    } else {
      frameSize = (buf[offset + 4] << 24) | (buf[offset + 5] << 16)
                | (buf[offset + 6] << 8) | buf[offset + 7];
    }
    const frameStart = offset + 10;
    const frameEnd = frameStart + frameSize;
    if (frameEnd > end || frameSize <= 0) break;

    const enc = buf[frameStart];
    const text = readId3v2Text(buf, frameStart, frameSize, enc).trim();
    if (text) {
      switch (frameId) {
        case 'TIT2': tags.title = text; break;
        case 'TPE1': case 'TPE2': tags.artist = text; break;
        case 'TALB': tags.album = text; break;
        case 'TYER': case 'TDRC': tags.year = text; break;
        case 'TCON': tags.genre = text; break;
        case 'TBPM': tags.bpm = text; break;
        case 'TRCK': tags.track = text; break;
        case 'TKEY': tags.key = text; break;
        default: break; // ignore other frames for now
      }
    }
    offset = frameEnd;
  }

  return tags;
}

function readId3v1(buf) {
  // ID3v1 is the last 128 bytes if they start with "TAG".
  if (buf.length < 128) return {};
  const start = buf.length - 128;
  if (buf.toString('ascii', start, start + 3) !== 'TAG') return {};
  const tags = {};
  const title = buf.toString('latin1', start + 3, start + 33).replace(/\0+$/, '').trim();
  const artist = buf.toString('latin1', start + 33, start + 63).replace(/\0+$/, '').trim();
  const album = buf.toString('latin1', start + 63, start + 93).replace(/\0+$/, '').trim();
  const year = buf.toString('latin1', start + 93, start + 97).replace(/\0+$/, '').trim();
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (year) tags.year = year;
  return tags;
}

function parseMp3(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    // Read first 64KB (enough for typical ID3v2 tags + start of audio).
    // ID3v2 is at the start. If file is small, read what we have.
    const headSize = Math.min(65536, stat.size);
    const head = Buffer.alloc(headSize);
    fs.readSync(fd, head, 0, headSize, 0);

    let tags = {};
    if (head.length >= 10 && head.toString('ascii', 0, 3) === 'ID3') {
      try { tags = parseId3v2(head); } catch (e) { /* swallow */ }
    }
    // ID3v1 at end (last 128 bytes) — read separately so small files still work.
    if (stat.size >= 128) {
      const tail = Buffer.alloc(128);
      fs.readSync(fd, tail, 0, 128, stat.size - 128);
      const v1 = readId3v1(tail);
      // ID3v2 wins; only fill missing.
      for (const [k, v] of Object.entries(v1)) if (!tags[k]) tags[k] = v;
    }
    return { tags, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function parseWav(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    // RIFF header is 12 bytes; fmt chunk is at least 16 bytes after that.
    // Total we need: 12 (RIFF) + 8 (fmt header) + 16 (PCM fmt) = 36.
    // Read 64 to be safe and to grab a LIST-INFO chunk if present.
    const headSize = Math.min(4096, stat.size);
    const head = Buffer.alloc(headSize);
    fs.readSync(fd, head, 0, headSize, 0);

    if (head.length < 36) return { tags: {}, size: stat.size };
    if (head.toString('ascii', 0, 4) !== 'RIFF') return { tags: {}, size: stat.size };
    if (head.toString('ascii', 8, 12) !== 'WAVE') return { tags: {}, size: stat.size };

    // Walk chunks looking for "fmt " and "LIST" (INFO).
    let offset = 12;
    let sampleRate = null;
    let channels = null;
    let byteRate = null;
    const tags = {};

    while (offset + 8 <= headSize) {
      const chunkId = head.toString('ascii', offset, offset + 4);
      const chunkSize = head.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkStart + chunkSize > headSize) break;

      if (chunkId === 'fmt ') {
        channels = head.readUInt16LE(chunkStart + 2);
        sampleRate = head.readUInt32LE(chunkStart + 4);
        byteRate = head.readUInt32LE(chunkStart + 8);
      } else if (chunkId === 'LIST') {
        // LIST/INFO: "INFO" followed by sub-chunks like INAM, IART, ICRD
        const listType = head.toString('ascii', chunkStart, chunkStart + 4);
        if (listType === 'INFO') {
          let p = chunkStart + 4;
          const end = chunkStart + chunkSize;
          while (p + 8 <= end) {
            const subId = head.toString('ascii', p, p + 4);
            const subSize = head.readUInt32LE(p + 4);
            const subStart = p + 8;
            if (subStart + subSize > end) break;
            const txt = head.toString('utf8', subStart, subStart + subSize).replace(/\0+$/, '').trim();
            if (txt) {
              switch (subId) {
                case 'INAM': tags.title = txt; break;
                case 'IART': tags.artist = txt; break;
                case 'IPRD': tags.album = txt; break;
                case 'ICRD': tags.year = txt; break;
                case 'IGNR': tags.genre = txt; break;
                case 'IBPM': tags.bpm = txt; break;
                case 'ITRK': tags.track = txt; break;
                default: break;
              }
            }
            p = subStart + subSize + (subSize % 2); // pad to even
          }
        }
      }
      offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    let durationSec = null;
    if (byteRate && byteRate > 0) {
      // data chunk size = total - 44 (header) approximately; subtract ID3/chunks
      // better: search for "data" chunk header, but we only have headSize bytes.
      // For the common case (PCM data at the end), this is a reasonable estimate.
      const dataBytes = Math.max(0, stat.size - 44);
      durationSec = Math.round((dataBytes / byteRate) * 100) / 100;
    }

    return {
      tags,
      size: stat.size,
      durationSec,
      sampleRate,
      channels,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// --- AIFF (.aif / .aiff) ---------------------------------------------------
//
// Audio IFF. Container: "FORM" + size(4B BE) + "AIFF" + chunks.
// Chunks: COMM (channels, frames, bitDepth, sampleRate as 80-bit
// IEEE 754 extended precision) + SSND (offset, blockSize, samples).
// All multi-byte values are BIG-ENDIAN — different from RIFF/WAV.
// We extract the same metadata as WAV: tags (ID3-from-NAME chunk
// or fallback to filename), sampleRate, channels, durationSec.
//
// Tag extraction: AIFF stores metadata in "NAME" / "AUTH" / "ANNO"
// / "ID3 " chunks rather than WAV's LIST/INFO. The "ID3 " chunk
// (rare in AIFF but spec-legal) carries a full ID3v2 chunk inside.
// For common cases, NAME gives us the title.
function parseAiff(absPath) {
    const fd = fs.openSync(absPath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        // FORM header (12 bytes) + COMM (18 bytes) + we may want
        // NAME/AUTH/ANNO chunks (each 4 ID + 4 size + payload).
        const headSize = Math.min(8192, stat.size);
        const head = Buffer.alloc(headSize);
        fs.readSync(fd, head, 0, headSize, 0);

        if (head.length < 26) return { tags: {}, size: stat.size };
        if (head.toString('ascii', 0, 4) !== 'FORM') return { tags: {}, size: stat.size };
        if (head.toString('ascii', 8, 12) !== 'AIFF') return { tags: {}, size: stat.size };

        // Walk chunks (all sizes are big-endian 32-bit).
        let offset = 12;
        let sampleRate = null;
        let channels = null;
        let frames = null;
        let bitDepth = null;
        const tags = {};

        while (offset + 8 <= headSize) {
            const chunkId = head.toString('ascii', offset, offset + 4);
            const chunkSize = head.readUInt32BE(offset + 4);
            const chunkStart = offset + 8;
            if (chunkStart + chunkSize > headSize) break;

            if (chunkId === 'COMM') {
                if (chunkSize >= 18) {
                    channels  = head.readUInt16BE(chunkStart);
                    frames    = head.readUInt32BE(chunkStart + 2);
                    bitDepth  = head.readUInt16BE(chunkStart + 6);
                    // 80-bit IEEE 754 extended precision, big-endian.
                    // Layout: 1 sign bit + 15 exponent bits (biased by 16383)
                    // + 64 mantissa bits. The MSB of the mantissa is the
                    // implicit integer bit (the "J bit" — set in
                    // normalized numbers). The mantissa's full value is
                    // mant_int / 2^63 — so 0xAC440000_00000000 =1.345825.
                    // No "1 +" needed; that's the bug we fixed.
                    const expHi = head.readUInt16BE(chunkStart + 8);
                    const sign = (expHi & 0x8000) ? -1 : 1;
                    const exp  = (expHi & 0x7FFF) - 16383;
                    const mantHi = head.readUInt32BE(chunkStart + 10);
                    const mantLo = head.readUInt16BE(chunkStart + 14);
                    const mantInt = mantHi * 0x100000000 + mantLo;
                    sampleRate = sign * (mantInt / Math.pow(2, 63)) * Math.pow(2, exp);
                    sampleRate = Math.round(sampleRate);
                }
            } else if (chunkId === 'NAME') {
                tags.title = head.toString('utf8', chunkStart, chunkStart + chunkSize).replace(/\0+$/, '').trim();
            } else if (chunkId === 'AUTH') {
                tags.artist = head.toString('utf8', chunkStart, chunkStart + chunkSize).replace(/\0+$/, '').trim();
            } else if (chunkId === 'ANNO') {
                // ANNO is free-form notes; we put it in the comment field if any
                const anno = head.toString('utf8', chunkStart, chunkStart + chunkSize).replace(/\0+$/, '').trim();
                if (anno) tags.comment = anno;
            } else if (chunkId === 'ID3 ') {
                // ID3 chunk inside AIFF carries ID3v2 — same parser as MP3.
                const id3 = parseId3v2(head.slice(chunkStart, chunkStart + chunkSize));
                for (const [k, v] of Object.entries(id3 || {})) {
                    if (!tags[k] && v) tags[k] = v;
                }
            }
            offset = chunkStart + chunkSize + (chunkSize % 2); // pad to even
        }

        let durationSec = null;
        if (frames !== null && sampleRate && sampleRate > 0) {
            durationSec = Math.round((frames / sampleRate) * 100) / 100;
        }

        return {
            tags,
            size: stat.size,
            durationSec,
            sampleRate,
            channels,
        };
    } finally {
        fs.closeSync(fd);
    }
}

// --- walk + parse --------------------------------------------------------

function* walk(rootPath) {
  let entries;
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (e) {
    log(`skip: cannot readdir ${rootPath}: ${e.code || e.message}`);
    return;
  }
  for (const entry of entries) {
    // Skip hidden + node_modules + .git anywhere
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) yield full;
    }
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    process.stderr.write(`FAIL: config not found at ${CONFIG_PATH}\n`);
    process.stderr.write(`Create it with: { "roots": [{ "path": "...", "label": "..." }] }\n`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    process.stderr.write(`FAIL: config is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
  if (!cfg.roots || !Array.isArray(cfg.roots) || cfg.roots.length === 0) {
    process.stderr.write(`FAIL: config.roots must be a non-empty array\n`);
    process.exit(2);
  }
  return cfg;
}

function indexRoot(root, items) {
  // root: { path, label }
  const abs = root.path.replace(/^~/, process.env.HOME || '');
  let found = 0;
  if (!fs.existsSync(abs)) {
    log(`root missing: ${abs}`);
    return { label: root.label, path: abs, found: 0, missing: true };
  }
  for (const filePath of walk(abs)) {
    const item = buildItem(filePath, abs, root.label);
    if (item) {
      items.push(item);
      found++;
    }
  }
  return { label: root.label, path: abs, found, missing: false };
}

function buildItem(filePath, rootAbs, label) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    log(`unsupported ext: ${filePath}`);
    return null;
  }
  const rel = path.relative(rootAbs, filePath);
  let parsed;
  try {
    if (ext === '.mp3')              parsed = parseMp3(filePath);
    else if (ext === '.wav')         parsed = parseWav(filePath);
    else if (ext === '.aif' ||
             ext === '.aiff')        parsed = parseAiff(filePath);
    else                            parsed = parseWav(filePath); // fallback for future formats
  } catch (e) {
    log(`parse failed: ${filePath}: ${e.code || e.message}`);
    return null;
  }
  const stat = fs.statSync(filePath);
  return {
    id: `${label}/${rel}`,
    label,
    relPath: rel,
    absPath: filePath,
    format: ext.slice(1),
    size: parsed.size,
    mtime: stat.mtime.toISOString(),
    tags: parsed.tags,
    durationSec: parsed.durationSec || null,
    sampleRate: parsed.sampleRate || null,
    channels: parsed.channels || null,
  };
}

function indexManual(files, label, items) {
  // files: array of absolute file paths the user passed via --add.
  // Each gets bucketed under a synthetic root whose path equals the
  // common parent of the files (or `~` if they live in different places).
  // Items are deduplicated by absPath against anything already in `items`.
  let found = 0;
  let skippedDup = 0;
  let skippedMissing = 0;
  const seenAbs = new Set(items.map(i => i.absPath).filter(Boolean));

  for (const raw of files) {
    const abs = raw.replace(/^~/, process.env.HOME || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      log(`manual missing: ${abs}`);
      skippedMissing++;
      continue;
    }
    if (seenAbs.has(abs)) {
      // refresh metadata in place: drop old, re-add fresh
      const idx = items.findIndex(i => i.absPath === abs);
      if (idx !== -1) items.splice(idx, 1);
    }
    const item = buildItem(abs, path.dirname(abs), label);
    if (item) {
      items.push(item);
      found++;
      seenAbs.add(abs);
    }
  }

  return { label, found, skippedDup, skippedMissing };
}

function index() {
  const t0 = Date.now();
  const cfg = loadConfig();
  const items = [];
  const rootSummary = [];

  for (const root of cfg.roots) {
    rootSummary.push(indexRoot(root, items));
  }

  let manualSummary = null;
  if (MANUAL_FILES.length > 0) {
    manualSummary = indexManual(MANUAL_FILES, MANUAL_LABEL, items);
    rootSummary.push({
      label: manualSummary.label,
      path: '<manual>',
      found: manualSummary.found,
      missing: false,
    });
  }

  items.sort((a, b) => {
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    return a.relPath.localeCompare(b.relPath);
  });

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    roots: rootSummary,
    items,
  };
}

// --- main ----------------------------------------------------------------

function main() {
  if (HELP) {
    process.stderr.write(`Usage: node lib/songs-indexer.js [options] [--add <file>...]

Options:
  --apply               Write catalog to data/songs/catalog.json (default: dry-run)
  --yes                 Skip the y/N confirmation prompt
  --config <path>       Override lib/sources.config.json
  --add <file>          Add individual file(s) under a synthetic "manual" root
                        (repeatable; can be combined with --apply)
  --keep-abspath        Keep absolute filesystem paths in the output
                        catalog. Default strips them for hygiene
                        (catalog deploys to GitHub Pages).
  --help, -h            Show this message

Without --apply, prints a dry-run summary and exits.
`);
    process.exit(0);
  }
  const catalog = index();

  process.stderr.write('\n');
  process.stderr.write(`[indexer] scanned ${catalog.roots.length} root(s):\n`);
  for (const r of catalog.roots) {
    const tag = r.missing ? 'missing' : 'ok';
    process.stderr.write(`[indexer]   [${tag}] ${r.path}  →  ${r.found} file(s) (${r.label})\n`);
  }
  if (MANUAL_FILES.length > 0) {
    const kept = catalog.items.filter(i => i.label === MANUAL_LABEL).length;
    process.stderr.write(`[indexer] manual --add: ${MANUAL_FILES.length} arg(s) → ${kept} catalog entries under "${MANUAL_LABEL}"\n`);
  }
  process.stderr.write(`[indexer] total: ${catalog.items.length} catalog entries\n`);
  process.stderr.write(`[indexer] took ${catalog.durationMs}ms\n`);
  process.stderr.write('\n');

  if (!APPLY) {
    process.stderr.write(`[indexer] DRY RUN — pass --apply to write ${OUT_PATH}\n`);
    process.exit(0);
  }

  if (!YES) {
    process.stderr.write(`Write ${catalog.items.length} entries to ${OUT_PATH}? [y/N]\n`);
    process.stderr.write('> ');
    const buf = fs.readFileSync(0, 'utf8');
    if (buf.trim().toLowerCase() !== 'y') {
      process.stderr.write('Aborted.\n');
      process.exit(0);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Strip absolute paths from the shipped catalog. The Twin OS panel
  // renders from relPath + label + tags; absPath is debug-only and
  // would leak the local filesystem when the catalog is deployed to
  // GitHub Pages. Pass --keep-abspath to retain it for local use.
  if (!KEEP_ABSPATH) {
    for (const root of catalog.roots) {
      delete root.path; // strip too — same hygiene reason
      root.pathHint = root.label; // placeholder for the UI
    }
    for (const item of catalog.items) {
      delete item.absPath;
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  process.stderr.write(`[indexer] wrote ${OUT_PATH}${KEEP_ABSPATH ? ' (with absPath)' : ' (paths redacted)'}\n`);
  process.exit(0);
}

main();