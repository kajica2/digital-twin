// Shared browser client for the LOCAL tool set.
//
// One loader, one vendored copy of ffmpeg.wasm, zero runtime CDN traffic.
//
// Why this file exists (the incident that motivated it):
//   A page used to load @ffmpeg/ffmpeg from unpkg at runtime and call
//   `new FFmpegFFmpeg()` — a global that never existed in any build — so every
//   render died with "FFmpeg is not defined". A second page shipped its own
//   copy of the same loader, with a different bug.
//
// Rules for every page in this repo:
//   * Import from this module. Never import @ffmpeg/ffmpeg directly.
//   * Never reference a CDN URL for @ffmpeg/* at runtime. The assets are
//     vendored under /vendor/ffmpeg and pinned by sha256 in
//     vendor/ffmpeg/manifest.json (see bin/install-vendor.mjs).
//   * Build the ffmpeg arguments with lib/render/plan.mjs — the same module the
//     server set uses — so both sets render identically.
//
// If the toolchain is missing, every failure path ends in a
// ToolchainUnavailableError whose message says exactly how to fix it.

import { buildRenderPlan, planGeometry, KEN_BURNS_MODES, CONTAINERS } from '/lib/render/plan.mjs';

export const VENDOR_ROOT = '/vendor/ffmpeg';
export const VENDOR_MANIFEST = `${VENDOR_ROOT}/manifest.json`;
export const VENDOR_FFMPEG_ESM = `${VENDOR_ROOT}/ffmpeg/0.12.10/esm/index.js`;
export const VENDOR_CORE = `${VENDOR_ROOT}/core/0.12.6/esm/ffmpeg-core.js`;
export const VENDOR_WASM = `${VENDOR_ROOT}/core/0.12.6/esm/ffmpeg-core.wasm`;

export { buildRenderPlan, planGeometry, KEN_BURNS_MODES, CONTAINERS };

/** Thrown when the vendored toolchain is missing or broken. Message is actionable. */
export class ToolchainUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ToolchainUnavailableError';
  }
}

const FIX = 'Run `node bin/install-vendor.mjs` (or `bin/setup.sh`) in the repo root, then reload.';

let ffmpegPromise = null;

/**
 * Verify the vendored assets are present before trying to boot them.
 * @returns {Promise<object>} the vendor manifest
 */
export async function ensureToolchain() {
  let res;
  try {
    res = await fetch(VENDOR_MANIFEST, { cache: 'no-cache' });
  } catch (cause) {
    throw new ToolchainUnavailableError(`Could not reach ${VENDOR_MANIFEST}. ${FIX}`, { cause });
  }
  if (!res.ok) {
    throw new ToolchainUnavailableError(
      `The ffmpeg.wasm assets are not installed (${VENDOR_MANIFEST} → HTTP ${res.status}). ${FIX}`
    );
  }
  const manifest = await res.json();
  const required = [VENDOR_FFMPEG_ESM, VENDOR_CORE, VENDOR_WASM];
  const missing = [];
  for (const path of required) {
    const head = await fetch(path, { method: 'HEAD', cache: 'no-cache' });
    if (!head.ok) missing.push(`${path} (HTTP ${head.status})`);
  }
  if (missing.length) {
    throw new ToolchainUnavailableError(`Vendored ffmpeg.wasm files are missing: ${missing.join(', ')}. ${FIX}`);
  }
  return manifest;
}

/**
 * Boot the vendored ffmpeg.wasm (singleton).
 * @param {{onLog?: (message: string) => void}} [options]
 * @returns {Promise<object>} the FFmpeg instance
 */
export async function loadFFmpeg({ onLog } = {}) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      await ensureToolchain();
      let mod;
      try {
        mod = await import(VENDOR_FFMPEG_ESM);
      } catch (cause) {
        throw new ToolchainUnavailableError(`Could not load ${VENDOR_FFMPEG_ESM}. ${FIX}`, { cause });
      }
      const { FFmpeg } = mod;
      if (typeof FFmpeg !== 'function') {
        throw new ToolchainUnavailableError(
          `The vendored @ffmpeg/ffmpeg module did not export an FFmpeg class (got ${typeof FFmpeg}). ${FIX}`
        );
      }
      const ff = new FFmpeg();
      if (onLog) ff.on('log', ({ message }) => onLog(message));
      try {
        // Same-origin URLs: the module worker, the core and the wasm all resolve
        // against this origin, so nothing crosses a network boundary at runtime.
        await ff.load({ coreURL: VENDOR_CORE, wasmURL: VENDOR_WASM });
      } catch (cause) {
        throw new ToolchainUnavailableError(`ffmpeg.wasm failed to load: ${cause?.message || cause}. ${FIX}`, { cause });
      }
      return ff;
    })().catch((err) => {
      ffmpegPromise = null; // allow a retry after the toolchain is installed
      throw err;
    });
  }
  return ffmpegPromise;
}

/** Drop the cached instance (used by tests and by the "New" button). */
export function resetFFmpeg() {
  ffmpegPromise = null;
}

/** Natural pixel size of an image file. */
export async function probeImageSize(file) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return size;
}

const PASSTHROUGH_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * Normalise an input image to PNG bytes.
 * The vendored core is a trimmed ffmpeg build; feeding it a format it cannot
 * decode (e.g. webp) fails deep inside ffmpeg with an opaque message, so we
 * transcode to PNG in the browser first.
 */
async function toPngBytes(file) {
  const ext = PASSTHROUGH_EXT[file.type];
  if (ext) {
    return { bytes: new Uint8Array(await file.arrayBuffer()), ext };
  }
  const bitmap = await createImageBitmap(file);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`Could not convert ${file.name || 'image'} to PNG`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png' };
}

/**
 * Render a set of images to an MP4 in the browser.
 *
 * @param {object} opts
 * @param {File[]} opts.files          input images, in order
 * @param {number} [opts.fps=30]
 * @param {number} [opts.duration=3]   seconds per image
 * @param {string} [opts.kenBurns='zoom-in']
 * @param {number} [opts.width]        defaults to the first image's aspect ratio
 * @param {number} [opts.height]
 * @param {string} [opts.container='mp4'] 'mp4' or 'mov'
 * @param {(message: string) => void} [opts.onLog]
 * @returns {Promise<Uint8Array>} the encoded video bytes
 */
export async function renderImagesToMp4({
  files,
  fps = 30,
  duration = 3,
  kenBurns = 'zoom-in',
  width,
  height,
  container = 'mp4',
  onLog,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('renderImagesToMp4: at least one image is required');
  }
  if (!CONTAINERS.includes(container)) {
    throw new Error(`renderImagesToMp4: unknown container "${container}"`);
  }
  const ff = await loadFFmpeg({ onLog });

  let w = width;
  let h = height;
  if (!w || !h) {
    const first = await probeImageSize(files[0]);
    const geo = planGeometry(first.width, first.height);
    w = geo.width;
    h = geo.height;
  }

  const inputNames = [];
  for (let i = 0; i < files.length; i++) {
    const { bytes, ext } = await toPngBytes(files[i]);
    const name = `img_${String(i).padStart(4, '0')}.${ext}`;
    await ff.writeFile(name, bytes);
    inputNames.push(name);
  }

  const plan = buildRenderPlan({ inputNames, width: w, height: h, fps, duration, kenBurns, container });
  const rc = await ff.exec(plan.args, 10 * 60 * 1000);
  if (rc !== 0 && rc !== undefined) {
    throw new Error(`ffmpeg exited with code ${rc} (see the browser console for [ffmpeg] logs)`);
  }

  const out = await ff.readFile(plan.outputName);
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out.buffer || out);
  if (bytes.length < 1024) throw new Error(`ffmpeg output too small (${bytes.length} bytes)`);
  const magic = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (magic !== 'ftyp') throw new Error(`ffmpeg output is not a valid MP4/MOV (got "${magic}" at offset 4)`);
  return bytes;
}
