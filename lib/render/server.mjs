// Server-side render executor — the SERVER half of the media toolchain.
//
// The browser set (ffmpeg.wasm) and this module share ONE source of truth for
// the ffmpeg argument list: lib/render/plan.mjs. Nothing here hand-writes a
// filter graph; this file only does the things a browser cannot do: spawn the
// system ffmpeg, capture stderr, enforce a timeout, clean up temp inputs.
//
// Dependencies: node built-ins only (no npm packages).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildRenderPlan, buildThumbnailPlan, buildClipPlan, DEFAULTS } from './plan.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
// A corrupt still makes ffmpeg spin forever, re-decoding it in a loop and
// spewing stderr (no "time=" progress ever appears). The stall watchdog kills
// such a run early instead of letting it block the render queue.
const DEFAULT_STALL_MS = 30 * 1000;
const FFMPEG_MISSING = 'system ffmpeg not found on PATH — run bin/setup.sh';
const FFPROBE_MISSING = 'system ffprobe not found on PATH — run bin/setup.sh';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Resolve an executable on PATH; returns null when it is not there. */
function which(bin) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// A server started from a GUI app, an IDE or a launchd job often has a
// minimal PATH that does not include Homebrew. Without this fallback the
// server set would report "ffmpeg not found" on a machine where ffmpeg is
// installed and working.
const FALLBACK_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin',
];

function findBinary(bin) {
  const onPath = which(bin);
  if (onPath) return onPath;
  for (const dir of FALLBACK_BIN_DIRS) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Absolute path of the system ffmpeg, or null when it is not installed. */
export function ffmpegPath() {
  return findBinary('ffmpeg');
}

/** Absolute path of the system ffprobe, or null when it is not installed. */
export function ffprobePath() {
  return findBinary('ffprobe');
}

/** Version string of the system ffmpeg, e.g. "9.0.2". */
export function ffmpegVersion() {
  const bin = ffmpegPath();
  if (!bin) throw new Error(FFMPEG_MISSING);
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`ffmpeg -version exited with code ${res.status}`);
  }
  const first = String(res.stdout || '').split('\n')[0] || '';
  const match = first.match(/version\s+(?:n)?(\d+(?:\.\d+)+)/i);
  if (!match) throw new Error(`could not parse ffmpeg version from: ${first.trim()}`);
  return match[1];
}

function sanitizeBaseName(name, index) {
  const raw = String(name || '');
  const ext = path.extname(raw).toLowerCase();
  const stem = path.basename(raw, path.extname(raw));
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const safeExt = IMAGE_EXTENSIONS.has(ext) ? ext : '.png';
  // The index prefix makes the name collision-free even for duplicate inputs.
  return `img_${String(index).padStart(4, '0')}_${safeStem || 'image'}${safeExt}`;
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

/**
 * Like sanitizeBaseName, but for a video input: the extension has to survive,
 * because ffmpeg picks the demuxer from it.
 */
function sanitizeVideoName(name, index) {
  const raw = String(name || '');
  const ext = path.extname(raw).toLowerCase();
  const stem = path.basename(raw, path.extname(raw));
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const safeExt = VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
  return `vid_${String(index).padStart(4, '0')}_${safeStem || 'clip'}${safeExt}`;
}

/** Parse an ffmpeg "time=HH:MM:SS.ms" timestamp into seconds. */
function parseFfmpegTime(chunk) {
  const match = String(chunk).match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * True when an stderr line shows forward progress. ffmpeg prints a status
 * line ("frame= ... time=...") roughly twice a second, so a run that stops
 * emitting them is stuck.
 */
function isProgressLine(line) {
  if (parseFfmpegTime(line) !== null) return true;
  const frame = String(line).match(/frame=\s*(\d+)/);
  return Boolean(frame && Number(frame[1]) > 0);
}

function tail(text, lines = 20) {
  const all = String(text || '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  return all.slice(-lines).join('\n');
}

/**
 * Render a list of still images into an MP4 using the system ffmpeg.
 *
 * @param {object} opts
 * @param {{name?: string, buffer: Buffer}[]} opts.images  raw image bytes, in order
 * @param {number} [opts.fps=30]
 * @param {number} [opts.duration=3]      seconds per image
 * @param {string} [opts.kenBurns='zoom-in']
 * @param {number} [opts.width=1080]
 * @param {number} [opts.height=1080]
 * @param {string} [opts.workDir]          directory for inputs + output
 * @param {number} [opts.timeoutMs=600000]
 * @param {string} [opts.outputName='output.mp4']
 * @param {(progress: number) => void} [opts.onProgress]  0..1
 * @returns {Promise<{outputPath: string, bytes: number, plan: object, log: string}>}
 */
export async function renderImagesToMp4(opts) {
  const {
    images,
    fps = DEFAULTS.fps,
    duration = DEFAULTS.duration,
    kenBurns = DEFAULTS.kenBurns,
    container = DEFAULTS.container,
    width = 1080,
    height = 1080,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    outputName,
    onProgress,
  } = opts || {};

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('renderImagesToMp4: images must be a non-empty array');
  }
  const bin = ffmpegPath();
  if (!bin) throw new Error(FFMPEG_MISSING);

  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'dt-render-'));
  await fsp.mkdir(workDir, { recursive: true });

  const written = [];
  const inputNames = [];
  try {
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i] || {};
      const buffer = img.buffer;
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error(`renderImagesToMp4: image #${i} has no buffer`);
      }
      const fileName = sanitizeBaseName(img.name, i);
      const filePath = path.join(workDir, fileName);
      await fsp.writeFile(filePath, buffer);
      written.push(filePath);
      inputNames.push(fileName);
    }

    // plan.mjs owns the filter graph and the argument list.
    // The output extension always follows the container.
    const finalOutputName = outputName || `output.${container}`;
    const plan = buildRenderPlan({
      inputNames,
      width,
      height,
      fps,
      duration,
      kenBurns,
      container,
      outputName: finalOutputName,
    });

    // The plan's last argument is the output name; make it absolute inside workDir.
    const outputPath = path.join(workDir, path.basename(finalOutputName));
    const args = [...plan.args];
    args[args.length - 1] = outputPath;

    const totalDuration = duration * images.length;
    const { code, stderr } = await runFfmpeg(bin, args, workDir, timeoutMs, (line) => {
      const seconds = parseFfmpegTime(line);
      if (seconds !== null && onProgress) {
        const progress = Math.max(0, Math.min(1, seconds / totalDuration));
        onProgress(progress);
      }
      return isProgressLine(line);
    }, opts.stallMs === undefined ? DEFAULT_STALL_MS : Number(opts.stallMs));

    if (code !== 0) {
      throw new Error(
        `ffmpeg exited with code ${code}\n${tail(stderr, 20)}`
      );
    }

    const stat = await fsp.stat(outputPath);
    return { outputPath, bytes: stat.size, plan, log: String(stderr || '') };
  } finally {
    // The caller owns the directory; we only remove the inputs we wrote.
    await Promise.all(
      written.map((file) => fsp.rm(file, { force: true }).catch(() => {}))
    );
  }
}

/**
 * Spawn ffmpeg without a shell, capture stderr, enforce a timeout and a
 * stall watchdog. Resolves { code, stderr } — never rejects for a non-zero
 * exit code.
 *
 * @param {(line: string) => boolean} [onLine]  called per stderr line; return
 *        true when the line shows forward progress (resets the stall timer).
 */
function runFfmpeg(bin, args, cwd, timeoutMs, onLine, stallMs = DEFAULT_STALL_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    // ffmpeg can spew unbounded stderr (e.g. a corrupt input decoded in a
    // loop), so only the tail is kept — never the whole stream.
    const MAX_STDERR_BYTES = 256 * 1024;
    // A runaway decode loop emits megabytes of error lines while making no
    // progress at all. Only non-progress output counts towards this budget —
    // ffmpeg's status lines are excluded, so a long render never trips it.
    const MAX_ERROR_SPEW_BYTES = 4 * 1024 * 1024;
    let stderr = '';
    let errorBytes = 0;
    let pending = '';
    let timedOut = false;
    let stalled = false;
    let sawProgress = false;
    let lastProgressAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const stallTimer = setInterval(() => {
      // Rule 1: the error spew — ffmpeg is spinning on a broken input.
      if (errorBytes > MAX_ERROR_SPEW_BYTES) {
        stalled = true;
        child.kill('SIGKILL');
        return;
      }
      // Rule 2: silence after progress started.
      if (sawProgress && Date.now() - lastProgressAt > stallMs) {
        stalled = true;
        child.kill('SIGKILL');
        return;
      }
      // Rule 3: nothing at all happened for a long time — a silent hang.
      // The window is generous because ffmpeg buffers its inputs before the
      // first status line.
      if (!sawProgress && Date.now() - lastProgressAt > stallMs * 4) {
        stalled = true;
        child.kill('SIGKILL');
      }
    }, 1000);
    stallTimer.unref?.();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
      // ffmpeg separates its status lines with "\r", its log lines with "\n".
      pending += chunk;
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const isProgress = onLine ? onLine(line) : false;
        if (isProgress) {
          sawProgress = true;
          lastProgressAt = Date.now();
        } else {
          errorBytes += line.length + 1;
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(stallTimer);
      if (err && err.code === 'ENOENT') reject(new Error(FFMPEG_MISSING));
      else reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(stallTimer);
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms and was killed`));
        return;
      }
      if (stalled) {
        reject(new Error(
          `ffmpeg stalled: no output progress and was killed\n${tail(stderr, 20)}`
        ));
        return;
      }
      if (code === null && signal) {
        reject(new Error(`ffmpeg was killed by signal ${signal}\n${tail(stderr, 20)}`));
        return;
      }
      resolve({ code: code === null ? 1 : code, stderr });
    });
  });
}

/**
 * Probe a video file with ffprobe.
 * @returns {Promise<{duration: number, width: number, height: number, codec: string}>}
 */
export async function probeVideo(filePath) {
  const bin = ffprobePath();
  if (!bin) throw new Error(FFPROBE_MISSING);
  const res = spawnSync(
    bin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { encoding: 'utf8' }
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `ffprobe exited with code ${res.status}\n${tail(res.stderr, 20)}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || '{}');
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const stream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  if (!stream) throw new Error('no video stream found');
  const duration = Number(parsed.format?.duration ?? stream.duration ?? 0) || 0;
  return {
    duration,
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    codec: String(stream.codec_name || ''),
  };
}

/**
 * Render a still image into a JPEG thumbnail using the system ffmpeg.
 *
 * The argument list comes from lib/render/plan.mjs (buildThumbnailPlan) so the
 * browser set and the server set crop and scale identically.
 *
 * @param {object} opts
 * @param {{name?: string, buffer: Buffer}} opts.image
 * @param {number} [opts.width=1080]
 * @param {number} [opts.height=1080]
 * @param {number} [opts.quality=2]       ffmpeg -q:v (2 = high quality)
 * @param {string} [opts.workDir]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.outputName='output.jpg']
 * @returns {Promise<{outputPath: string, bytes: number, plan: object, log: string}>}
 */
export async function renderThumbnail(opts) {
  const {
    image,
    width = 1080,
    height = 1080,
    quality = 2,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    outputName = 'output.jpg',
  } = opts || {};

  if (!image || !Buffer.isBuffer(image.buffer)) {
    throw new Error('renderThumbnail: image.buffer is required');
  }
  const bin = ffmpegPath();
  if (!bin) throw new Error(FFMPEG_MISSING);

  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'dt-thumb-'));
  await fsp.mkdir(workDir, { recursive: true });

  const fileName = sanitizeBaseName(image.name, 0);
  const filePath = path.join(workDir, fileName);
  await fsp.writeFile(filePath, image.buffer);
  try {
    const plan = buildThumbnailPlan({
      inputName: fileName,
      width,
      height,
      outputName,
      quality,
    });
    const outputPath = path.join(workDir, path.basename(outputName));
    const args = [...plan.args];
    args[args.length - 1] = outputPath;

    const { code, stderr } = await runFfmpeg(bin, args, workDir, timeoutMs, () => true,
      opts.stallMs === undefined ? DEFAULT_STALL_MS : Number(opts.stallMs));
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}\n${tail(stderr, 20)}`);
    }
    const stat = await fsp.stat(outputPath);
    return { outputPath, bytes: stat.size, plan, log: String(stderr || '') };
  } finally {
    await fsp.rm(filePath, { force: true }).catch(() => {});
  }
}

/**
 * Cut a video into a clip (re-encoded to a web-safe H.264 MP4) using the
 * system ffmpeg. The argument list comes from lib/render/plan.mjs
 * (buildClipPlan).
 *
 * @param {object} opts
 * @param {{name?: string, buffer: Buffer}} opts.video
 * @param {number} opts.startSec
 * @param {number} opts.endSec
 * @param {string} [opts.container='mp4']
 * @param {string} [opts.workDir]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.outputName]
 * @returns {Promise<{outputPath: string, bytes: number, plan: object, log: string}>}
 */
export async function renderClip(opts) {
  const {
    video,
    startSec,
    endSec,
    container = 'mp4',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts || {};

  if (!video || !Buffer.isBuffer(video.buffer)) {
    throw new Error('renderClip: video.buffer is required');
  }
  const bin = ffmpegPath();
  if (!bin) throw new Error(FFMPEG_MISSING);

  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'dt-clip-'));
  await fsp.mkdir(workDir, { recursive: true });

  const fileName = sanitizeVideoName(video.name, 0);
  const filePath = path.join(workDir, fileName);
  await fsp.writeFile(filePath, video.buffer);
  try {
    const finalOutputName = opts.outputName || `output.${container}`;
    const plan = buildClipPlan({
      inputName: fileName,
      startSec,
      endSec,
      container,
      outputName: finalOutputName,
    });
    const outputPath = path.join(workDir, path.basename(finalOutputName));
    const args = [...plan.args];
    args[args.length - 1] = outputPath;

    const { code, stderr } = await runFfmpeg(bin, args, workDir, timeoutMs, () => true,
      opts.stallMs === undefined ? DEFAULT_STALL_MS : Number(opts.stallMs));
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}\n${tail(stderr, 20)}`);
    }
    const stat = await fsp.stat(outputPath);
    return { outputPath, bytes: stat.size, plan, log: String(stderr || '') };
  } finally {
    await fsp.rm(filePath, { force: true }).catch(() => {});
  }
}
