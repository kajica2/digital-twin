#!/usr/bin/env node
//
// daily-reels.js — turn a published daily plate into a vertical reel.
//
// The daily run publishes plates; a plate on a page is not distribution.
// This is the hand-off: the same day's plate becomes a 1080x1920
// vertical video, drops into reel-inbox/, and the running reel-watcher
// picks it up, transcodes it and writes the POST sheet.
//
// Two things are built per plate:
//
//   <base>.mp4  the vertical source (1080x1920, H.264 + AAC). It is
//               built VERTICAL on purpose: the watcher letterboxes
//               rather than crops, so a 16:9 source would sit in a
//               black band. Instead the still is centred over a
//               blurred, darkened extension of itself and drifts right.
//
//   <base>.mp3  a silent audio track whose ID3 carries the plate's
//               caption (title / artist / album / genre). The watcher
//               reads the sibling audio's tags and writes the caption
//               into the POST sheet -- this is where the reel's words
//               come from. Instagram reels are posted silent; the
//               music is added in the app.
//
// Usage:
//   node lib/daily-reels.js --date 2026-10-22            # queue that day
//   node lib/daily-reels.js --date 2026-10-22 --dry-run
//   node lib/daily-reels.js --latest                     # the newest day
//
// The reel-inbox is the hand-off point: the watcher (a launchd service)
// takes it from there. Nothing here touches Midjourney -- a reel is
// built from an ALREADY published plate, so it costs no quota.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const COLLECTIONS_DIR = path.join(REPO, 'assets', 'marketplace', 'daily');
const DEFAULT_INBOX = path.join(REPO, 'reel-inbox');

const WIDTH = 1080;
const HEIGHT = 1920;
const SECONDS = 6;
const FPS = 30;

function log(msg) { process.stdout.write(`[daily-reels] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[daily-reels] ${msg}\n`); }
function fail(msg, code = 1) {
    process.stderr.write(`[daily-reels] ${msg}\n`);
    process.exit(code);
}

/**
 * The caption the reel's POST sheet will carry, and the ID3 fields it
 * comes from. The watcher's own format is
 * "<title> — <artist> (<album>) [<genre>]" — this is the same shape,
 * written here so the reel is described before the watcher sees it.
 */
function captionFields({ caption, artist, album, genre }) {
    const title = String(caption || '').trim();
    return {
        title,
        artist: String(artist || 'Digital Twin').trim(),
        album: String(album || 'Daily Frames').trim(),
        genre: String(genre || '').trim(),
    };
}

/** The reel's basename: the collection id plus the caption's own slug. */
function reelBaseName(collectionId, caption) {
    // Dashes, not underscores: this is a file name a person reads in
    // the inbox. (mj-submitter's slugify exists for directory names.)
    const slug = String(caption || '')
        .toLowerCase()
        .replace(/[·•—–]/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug ? `${collectionId}-${slug}` : `${collectionId}-frame`;
}

/**
 * The visible band: the still scaled to width 1400, cropped to the
 * 1080-wide window that pans right across it. The crop height keeps
 * the plate's own aspect ratio (a 16:9 plate gives a 604px band).
 */
function bandHeight(plateWidth, plateHeight) {
    if (!plateWidth || !plateHeight) return Math.round(HEIGHT * 0.3125);
    const h = Math.round((WIDTH * plateHeight) / plateWidth);
    return Math.max(200, Math.min(h, HEIGHT));
}

function ffmpeg(args) {
    execFileSync('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * The vertical source: a sharp band over a blurred, darkened extension
 * of the same still, drifting slowly right.
 */
function buildVerticalSource(plateFile, outFile, seconds = SECONDS, plateWidth = null, plateHeight = null) {
    const band = bandHeight(plateWidth, plateHeight);
    const pan = `(in_w-out_w)*t/${seconds}`;
    const filter = [
        `[0:v]scale=1400:-2,crop=${WIDTH}:${band}:x='${pan}':y=0,setsar=1[fg]`,
        `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},` +
        `gblur=sigma=28,eq=brightness=-0.10:saturation=0.85,setsar=1[bg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1`,
    ].join(';');
    ffmpeg([
        '-loop', '1', '-i', plateFile,
        '-i', outFile.replace(/\.mp4$/, '.mp3'),
        '-filter_complex', filter,
        '-t', String(seconds), '-r', String(FPS),
        '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', '6M',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-movflags', '+faststart',
        outFile,
    ]);
    return outFile;
}

/** The silent, tagged audio track the caption is read from. */
function buildTaggedAudio(outFile, fields, seconds = SECONDS) {
    ffmpeg([
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', String(seconds),
        '-metadata', `title=${fields.title}`,
        '-metadata', `artist=${fields.artist}`,
        '-metadata', `album=${fields.album}`,
        '-metadata', `genre=${fields.genre}`,
        outFile,
    ]);
    return outFile;
}

/** The image size, read with sips (macOS) — the plate's own dimensions. */
function imageSize(file) {
    try {
        const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
        const w = Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1]);
        const h = Number((out.match(/pixelHeight:\s*(\d+)/) || [])[1]);
        return w && h ? { width: w, height: h } : null;
    } catch {
        return null;
    }
}

/**
 * Queue one plate's reel: build the source and the tagged audio into a
 * staging directory, then move both into the inbox under the same
 * basename. The watcher matches the sibling audio by basename, so the
 * two files must agree exactly.
 */
function queuePlate({ plateFile, caption, collectionId, album, genre, artist, inboxDir, stagingDir, dryRun = false }) {
    const base = reelBaseName(collectionId, caption);
    const fields = captionFields({ caption, artist, album, genre });
    const size = imageSize(plateFile);
    const mp4 = path.join(stagingDir, `${base}.mp4`);
    const mp3 = path.join(stagingDir, `${base}.mp3`);
    if (!dryRun) {
        buildTaggedAudio(mp3, fields);
        buildVerticalSource(plateFile, mp4, SECONDS, size && size.width, size && size.height);
    }
    const targets = [mp4, mp3].map(f => path.join(inboxDir, path.basename(f)));
    if (!dryRun) {
        fs.mkdirSync(inboxDir, { recursive: true });
        for (let i = 0; i < 2; i++) fs.renameSync([mp4, mp3][i], targets[i]);
    }
    return { base, caption: fields.title, targets, size };
}

/** Every published day, newest first. */
function listDays(dir = COLLECTIONS_DIR) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.existsSync(path.join(dir, n, 'plates.json')))
        .sort()
        .reverse();
}

/** One day's plates, from its plates.json. */
function readDay(date, dir = COLLECTIONS_DIR) {
    const file = path.join(dir, date, 'plates.json');
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Queue every plate of a published day. Returns what was queued.
 */
function queueDay(date, { inboxDir = DEFAULT_INBOX, dryRun = false, dir = COLLECTIONS_DIR } = {}) {
    const day = readDay(date, dir);
    if (!day) return null;
    const stagingDir = path.join(REPO, 'daily-content', date, 'reels');
    fs.mkdirSync(stagingDir, { recursive: true });
    const queued = [];
    for (const plate of day.plates || []) {
        const plateFile = path.join(dir, date, plate.file);
        if (!fs.existsSync(plateFile)) { warn(`${date}: ${plate.file} is missing — skipped`); continue; }
        const result = queuePlate({
            plateFile,
            caption: plate.caption,
            collectionId: day.pack || day.id || 'daily',
            album: day.title,
            genre: day.badge,
            inboxDir,
            stagingDir,
            dryRun,
        });
        queued.push(result);
        log(`queued ${result.base} — "${result.caption}"${dryRun ? ' (dry run)' : ''}`);
    }
    return { date, day, queued };
}

function argVal(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const inboxDir = path.resolve(REPO, argVal('--inbox', DEFAULT_INBOX));
    const days = listDays();
    if (!days.length) fail('no published day to queue');
    const date = argVal('--date') || (process.argv.includes('--latest') ? days[0] : days[0]);
    const result = queueDay(date, { inboxDir, dryRun });
    if (!result) fail(`no published bundle for ${date}`);
    log(`${date}: ${result.queued.length} reel(s) ${dryRun ? 'planned' : 'queued'} -> ${inboxDir}`);
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (e) {
        fail(e && e.stack ? e.stack : String(e));
    }
}

module.exports = {
    captionFields, reelBaseName, bandHeight, buildVerticalSource, buildTaggedAudio,
    imageSize, queuePlate, queueDay, listDays, readDay,
    WIDTH, HEIGHT, SECONDS, FPS,
};
