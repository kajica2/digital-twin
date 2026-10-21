#!/usr/bin/env node
// lib/reel-watcher.js
//
// Sprint 0.17 — drop a video file into reel-inbox/, get an Instagram-
// ready Reel package out: vertical 9:16 H.264/AAC re-encode, a
// cover-frame JPG, and a POST.md with caption + hashtags derived
// from the audio file's ID3 tags (if a sibling audio file is
// present) or a static fallback.
//
// Mirrors the chart-watcher / songs-watcher patterns exactly:
//   * 2-second poll loop (fs.watch / FSEvents has known reliability
//     gaps under GUI LaunchAgents; see CHART-WATCHER.md).
//   * Lockfile-based concurrency guard (`.processing-<sha1>`).
//   * Stale-lock detection by mtime (handles "replace file at same
//     path").
//   * SIGTERM-clean shutdown.
//   * Retry-once with 5s sync sleep.
//   * Module exports for the test harness (setRunExport).
//
// What this script does NOT do (intentional):
//   * Does not upload to Instagram. Instagram's Graph API does not
//     allow third-party Reel publishing. AGENTS.md hygiene +
//     "calm, not chatty" ethos → pre-publish pipeline only. User
//     opens the IG app and taps Upload themselves.
//   * Does not read PII, network out, or call any service.
//   * Does not modify the dropped input until ffmpeg+ffprobe finish
//     successfully (move to processed/ on success, leave in place on
//     failure for retry).
//
// Usage:
//   node lib/reel-watcher.js                 # default: poll every 2s
//   node lib/reel-watcher.js --once          # process all pending, then exit
//   node lib/reel-watcher.js --interval 5    # poll every 5s
//
// The companion LaunchAgent (com.kaidjuric.digital-twin.reel-watcher)
// launches this script via bin/reel-watcher.sh — that wrapper handles
// Node resolution under launchd's stripped PATH (same pattern as
// bin/songs-watcher.sh).

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------- CLI parsing ----------
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const INTERVAL_IDX = ARGV.indexOf('--interval');
const INTERVAL_MS = INTERVAL_IDX >= 0 && ARGV[INTERVAL_IDX + 1]
    ? Math.max(500, parseInt(ARGV[INTERVAL_IDX + 1], 10) * 1000)
    : 2000;

// ---------- Paths ----------
const REPO = path.resolve(__dirname, '..');
const TEST_DIR = process.env.WATCHER_TEST_DIR || null;
const INBOX = TEST_DIR ? path.join(TEST_DIR, 'reel-inbox') : path.join(REPO, 'reel-inbox');
const PROCESSED = path.join(INBOX, 'processed');
const LOGDIR = TEST_DIR ? path.join(TEST_DIR, 'logs') : path.join(REPO, 'logs');
const LOG = path.join(LOGDIR, 'reel-watcher.log');

// ---------- External binaries ----------
//
// ffmpeg / ffprobe come from Homebrew on this Mac. We do NOT
// hardcode /opt/homebrew/bin — resolve at startup so the script
// works on any PATH.
function whichOrNull(bin) {
    try {
        const out = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim();
        return out || null;
    } catch { return null; }
}

let FFMPEG  = process.env.FFMPEG  || whichOrNull('ffmpeg');
let FFPROBE = process.env.FFPROBE || whichOrNull('ffprobe');

// ---------- Setup ----------
function ensureDirs() {
    fs.mkdirSync(INBOX,     { recursive: true });
    fs.mkdirSync(PROCESSED, { recursive: true });
    fs.mkdirSync(LOGDIR,    { recursive: true });
}

function appendLog(line) {
    const stamp = new Date().toISOString();
    fs.appendFileSync(LOG, `${stamp} ${line}\n`);
}

// ---------- Lockfile management ----------
//
// Mirrors songs-watcher / chart-watcher. The .processing-<sha1>
// namespace prefix differs per watch type ("reel-watcher:" here) so
// a shared inbox couldn't collide with another watcher if a future
// refactor moved them.
const STALE_LOCK_MS = 5 * 60 * 1000;

function lockFor(videoPath) {
    const h = crypto.createHash('sha1')
        .update('reel-watcher:')
        .update(videoPath)
        .digest('hex')
        .slice(0, 12);
    return path.join(INBOX, `.processing-${h}`);
}

function pruneStaleLocks() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return; }
    const now = Date.now();
    for (const e of entries) {
        if (!e.startsWith('.processing-')) continue;
        const p = path.join(INBOX, e);
        try {
            const age = now - fs.statSync(p).mtimeMs;
            if (age > STALE_LOCK_MS) fs.unlinkSync(p);
        } catch {}
    }
}

function acquireLock(videoPath) {
    const lock = lockFor(videoPath);
    try {
        fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
        return lock;
    } catch (e) {
        if (e.code === 'EEXIST') return null;
        throw e;
    }
}

function releaseLock(lock) {
    try { fs.unlinkSync(lock); } catch {}
}

// ---------- Probe + transcode ----------
//
// Instagram-friendly Reel format:
//   * 9:16 vertical (1080×1920)
//   * H.264 high-profile, 30fps, ~6 Mbps
//   * AAC LC stereo 44.1kHz @ 128 kbps
//   * MP4 container
// Source may be any ffmpeg-readable format. We re-encode (not just
// remux) because IG is picky about color space + codec flags.

const TARGET_W = 1080;
const TARGET_H = 1920;
const TARGET_FPS = 30;
const TARGET_VBITRATE = '6M';
const TARGET_ABITRATE = '128k';

function probe(videoPath) {
    // Returns { durationSec, width, height, hasAudio } or throws.
    const out = execFileSync(FFPROBE, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format', '-show_streams',
        videoPath,
    ], { encoding: 'utf8', timeout: 30_000 });
    const j = JSON.parse(out);
    const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    return {
        durationSec: parseFloat(j.format?.duration ?? '0') || 0,
        width:  parseInt(v.width  || '0'),
        height: parseInt(v.height || '0'),
        hasAudio: (j.streams || []).some(s => s.codec_type === 'audio'),
    };
}

// ID3v2 / metadata reader for the sibling audio file. We only
// surface the fields a Reel caption would actually use: TIT2
// (title), TPE1 (artist), TALB (album), TYER/TDRC (year), TCON
// (genre). Falls back gracefully if the file has no tags.
function readAudioTags(audioPath) {
    try {
        const out = execFileSync(FFPROBE, [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            audioPath,
        ], { encoding: 'utf8', timeout: 30_000 });
        const j = JSON.parse(out);
        const tags = j.format?.tags || {};
        // ffprobe lowercases keys and trims "ID3v2" prefixes.
        const get = (k) => tags[k] || tags[k.toLowerCase()] || null;
        return {
            title:  get('title')  || null,
            artist: get('artist') || null,
            album:  get('album')  || null,
            date:   get('date')   || null,
            genre:  get('genre')  || null,
        };
    } catch { return {}; }
}

// Look in the same directory as the dropped video for an audio
// file with the same basename. Reels are usually dropped with their
// source audio nearby (chart-export splits pair them up).
function findSiblingAudio(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const AUDIO_EXTS = ['.mp3', '.wav', '.aif', '.aiff', '.m4a', '.flac'];
    for (const ext of AUDIO_EXTS) {
        const p = path.join(dir, base + ext);
        if (fs.existsSync(p)) return p;
    }
    // As a last resort, any audio file in the same dir.
    try {
        const ents = fs.readdirSync(dir);
        const hit = ents.find(e => AUDIO_EXTS.includes(path.extname(e).toLowerCase()));
        return hit ? path.join(dir, hit) : null;
    } catch { return null; }
}

// Hashtag map. Built small + jazz-centric to match the project's
// domain. Future agents / sprints can extend without touching the
// watcher.
const JAZZ_TAGS = [
    '#jazz', '#trumpet', '#modjazz', '#postbop',
    '#ModalJazz', '#JazzReels', '#trumpetfeature', '#chart',
];
function pickHashtags(tags) {
    const out = new Set(JAZZ_TAGS);
    const g = (tags.genre || '').toLowerCase();
    if (g.includes('modal')) out.add('#modalmusic');
    if (g.includes('bebop') || g.includes('bop')) out.add('#bebop');
    return Array.from(out).slice(0, 10).join(' ');
}

function buildCaption(meta, baseName) {
    const t = meta.title || baseName;
    const parts = [];
    parts.push(t);
    if (meta.artist) parts.push(`— ${meta.artist}`);
    if (meta.album) parts.push(`(${meta.album})`);
    if (meta.genre) parts.push(`[${meta.genre}]`);
    parts.push('🎺 Reel from the twin.');
    parts.push('');
    parts.push(`Hashtags: ${meta.hashtags}`);
    return parts.join(' ');
}

// Re-encode to vertical 9:16 with letterboxing (not cropping).
// `-vf scale=…:force_original_aspect_ratio=decrease,pad=…:(ow-iw)/2:(oh-ih)/2,setsar=1`
// keeps the full frame; ffmpeg pads instead of crops. We add a
// subtle audio fade in/out for the IG vibe. Audio filters live on
// their own `-af` chain — ffmpeg refuses to mix video (`format`)
// and audio (`afade`) filters inside one `-vf`.
function transcode({ src, dst, hasAudio }) {
    const vfilter = [
        `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease`,
        `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        `setsar=1`,
        `format=yuv420p`,
    ];
    const afilter = hasAudio
        ? ['afade=t=in:st=0:d=0.4', 'afade=t=out:st=0:d=0.4']
        : null;
    const args = [
        '-y',
        '-i', src,
        '-vf', vfilter.join(','),
        '-r', String(TARGET_FPS),
        '-c:v', 'libx264',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', TARGET_VBITRATE,
        '-movflags', '+faststart',
    ];
    if (hasAudio) {
        args.push('-af', afilter.join(','));
        args.push('-c:a', 'aac', '-b:a', TARGET_ABITRATE, '-ar', '44100');
    } else {
        args.push('-an');
    }
    args.push(dst);
    execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000 });
}

// Pull a single frame from the middle of the video as the cover.
// Middle is a stable default — the IG app lets you swap it for any
// frame at upload time anyway.
function extractCover({ src, dst, durationSec }) {
    const t = durationSec > 1 ? durationSec / 2 : 0.1;
    execFileSync(FFMPEG, [
        '-y',
        '-ss', String(t),
        '-i', src,
        '-frames:v', '1',
        '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
        '-q:v', '2',
        dst,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
}

// Re-export the transcode / extract / probe seams so the test
// harness can override them. Default = real ffmpeg/ffprobe.
function runExport({ videoPath, info, outBase }) {
    const reelMp4 = outBase + '.mp4';
    const coverJpg = outBase + '_cover.jpg';
    transcode({ src: videoPath, dst: reelMp4, hasAudio: info.hasAudio });
    extractCover({ src: videoPath, dst: coverJpg, durationSec: info.durationSec });
    return { reelMp4, coverJpg };
}

let _runExport = runExport;
function setRunExport(fn) { _runExport = fn; }

// ---------- Process one dropped file ----------
function processOne(videoPath) {
    const lock = acquireLock(videoPath);
    if (!lock) return { skipped: true };

    try {
        return processOneWithRetry(videoPath, lock);
    } finally {
        releaseLock(lock);
    }
}

function processOneWithRetry(videoPath, lock) {
    const fileName = path.basename(videoPath);
    const ext = path.extname(videoPath);
    const baseName = path.basename(videoPath, ext);
    const outBase = path.join(PROCESSED, baseName);
    const t0 = Date.now();

    appendLog(`[start] ${fileName}`);

    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 5000;
    let attempt = 0;
    let lastErr = null;

    while (attempt < MAX_ATTEMPTS) {
        attempt += 1;
        try {
            if (!FFMPEG || !FFPROBE) {
                throw new Error('ffmpeg/ffprobe not on PATH');
            }
            const info = probe(videoPath);
            const sibAudio = findSiblingAudio(videoPath);
            const audioTags = sibAudio ? readAudioTags(sibAudio) : {};
            const hashtags = pickHashtags(audioTags);
            const { reelMp4, coverJpg } = _runExport({ videoPath, info, outBase });

            const postMd = outBase + '_POST.md';
            const caption = buildCaption(
                { ...audioTags, hashtags },
                baseName,
            );
            fs.writeFileSync(postMd,
                `# ${baseName}\n\n` +
                `## Caption\n\n${caption}\n\n` +
                `## Files\n\n` +
                `- Reel (9:16 H.264/AAC): \`${path.basename(reelMp4)}\`\n` +
                `- Cover frame: \`${path.basename(coverJpg)}\`\n` +
                (sibAudio ? `- Source audio: \`${path.basename(sibAudio)}\`\n` : '') +
                `\n## Source\n\n` +
                `- Dropped: \`${fileName}\`\n` +
                `- Probed duration: ${info.durationSec.toFixed(1)}s\n` +
                `- Source size: ${info.width}×${info.height}\n` +
                `- Has audio stream: ${info.hasAudio}\n` +
                (audioTags.title  ? `- ID3 title:  ${audioTags.title}\n`  : '') +
                (audioTags.artist ? `- ID3 artist: ${audioTags.artist}\n` : '') +
                (audioTags.album  ? `- ID3 album:  ${audioTags.album}\n`  : '') +
                (audioTags.genre  ? `- ID3 genre:  ${audioTags.genre}\n`  : '') +
                `\n## Next\n\n` +
                `1. Open Instagram app → Reel → Upload.\n` +
                `2. Pick \`${path.basename(reelMp4)}\` from Files.\n` +
                `3. (Optional) Use \`${path.basename(coverJpg)}\` as the cover frame.\n` +
                `4. Paste the caption above.\n`,
            );

            // Park the original input as `<base>_source<ext>`.
            //
            // It must NOT land on `<base><ext>`: the reel output is
            // `<base>.mp4`, so for the common case of an .mp4 drop the
            // move used to overwrite the transcoded reel with the
            // original — shipping an un-transcoded 16:9 file labelled
            // as the Reel. A distinct name makes the collision
            // impossible for every source extension.
            const sourcePark = path.join(PROCESSED, `${baseName}_source${ext}`);
            try {
                fs.renameSync(videoPath, sourcePark);
            } catch (e) {
                fs.copyFileSync(videoPath, sourcePark);
                fs.unlinkSync(videoPath);
            }

            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            const tag = attempt > 1 ? `[done-retry-${attempt}]` : '[done]';
            appendLog(`${tag} ${fileName} → ${sec}s, mp4 + cover + POST.md written (source parked as ${path.basename(sourcePark)})`);
            return {
                ok: true, sec, attempts: attempt,
                outputs: { reelMp4, coverJpg, postMd, sourcePark },
            };
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_ATTEMPTS) {
                appendLog(`[retry] ${fileName} attempt ${attempt} failed (${e.message}); retrying in ${RETRY_DELAY_MS / 1000}s`);
                const sleptUntil = Date.now() + RETRY_DELAY_MS;
                while (Date.now() < sleptUntil) { /* spin */ }
            }
        }
    }

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const tail = (lastErr.stderr || lastErr.stdout || '').toString().split('\n').slice(-3).join(' | ');
    appendLog(`[fail]  ${fileName} after ${sec}s (${MAX_ATTEMPTS} attempts): ${lastErr.message} :: ${tail}`);
    return { ok: false, sec, error: lastErr.message, attempts: MAX_ATTEMPTS };
}

// ---------- Main loop ----------
//
// Supported video formats — anything ffmpeg can decode. Common
// Reel source formats: .mp4, .mov, .m4v. We accept a wide net so
// the user doesn't have to convert upstream.
const SUPPORTED_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];

function listPending() {
    let entries;
    try { entries = fs.readdirSync(INBOX); } catch { return []; }
    const now = Date.now();
    return entries
        .filter(e => SUPPORTED_EXTS.includes(path.extname(e).toLowerCase()))
        .filter(e => {
            const lock = lockFor(path.join(INBOX, e));
            if (!fs.existsSync(lock)) return true;
            try {
                const lockAge = now - fs.statSync(lock).mtimeMs;
                const fileMtime = fs.statSync(path.join(INBOX, e)).mtimeMs;
                const lockMtime = fs.statSync(lock).mtimeMs;
                if (lockAge > STALE_LOCK_MS) { try { fs.unlinkSync(lock); } catch {}; return true; }
                if (fileMtime > lockMtime)   { try { fs.unlinkSync(lock); } catch {}; return true; }
            } catch {}
            return false;
        })
        .map(e => path.join(INBOX, e))
        .sort();
}

function tick() {
    for (const f of listPending()) processOne(f);
}

// Module exports for the test harness.
module.exports = {
    INBOX, PROCESSED, LOGDIR, LOG, REPO,
    SUPPORTED_EXTS, TARGET_W, TARGET_H,
    lockFor, listPending, pruneStaleLocks,
    processOne, processOneWithRetry,
    setRunExport,
    ensureDirs,
};

function main() {
    ensureDirs();
    pruneStaleLocks();
    appendLog(`[boot]  reel-watcher started (interval=${INTERVAL_MS}ms once=${ONCE})`);

    if (!FFMPEG || !FFPROBE) {
        appendLog(`[boot]  FATAL: ffmpeg/ffprobe not on PATH — install with \`brew install ffmpeg\``);
        process.stderr.write(`[reel-watcher] FATAL: ffmpeg/ffprobe not on PATH\n`);
        process.exit(2);
    }
    appendLog(`[boot]  ffmpeg=${FFMPEG} ffprobe=${FFPROBE}`);

    if (ONCE) {
        tick();
        appendLog(`[exit]  --once mode, exiting`);
        return;
    }

    let running = true;
    const stop = () => {
        if (!running) return;
        running = false;
        appendLog(`[exit]  reel-watcher stopped (signal)`);
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    tick();
    const loop = setInterval(() => {
        if (!running) { clearInterval(loop); return; }
        tick();
    }, INTERVAL_MS);
}

if (require.main === module) main();