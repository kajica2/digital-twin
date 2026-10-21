// Shared render plan — the single source of truth for how a set of still images
// becomes an MP4.
//
// This module is imported by BOTH sets:
//   - the local set  (browser, ffmpeg.wasm)  → pages/assets/ffmpeg-client.mjs
//   - the server set (node, system ffmpeg)   → lib/render/server.mjs
//
// Rules for this file:
//   * ESM only, no Node built-ins, no DOM. Must run in a browser unchanged.
//   * No side effects, no globals. Pure functions, deterministic output.
//   * The returned `args` array is valid for both `ffmpeg.exec([...])` (wasm)
//     and the `ffmpeg` CLI, so both sets produce byte-comparable output.
//
// The bug that motivated this module: the browser copy of the filter graph
// was duplicated inline in the page, drifted from the server's, and broke with
// "FFmpeg is not defined" because it was the only place that knew how to load
// the core. One plan, two executors, no duplicated graph.

export const KEN_BURNS_MODES = ['none', 'zoom-in', 'zoom-out', 'pan-left'];

export const CONTAINERS = ['mp4', 'mov'];

export const DEFAULTS = {
  fps: 30,
  duration: 3,
  kenBurns: 'zoom-in',
  maxLongSide: 1080,
  container: 'mp4',
  outputName: 'output.mp4',
  preset: 'veryfast',
};

/** Output geometry follows the first image's aspect ratio, long side capped. */
export function planGeometry(width, height, { maxLongSide = DEFAULTS.maxLongSide } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('planGeometry: width and height must be positive numbers');
  }
  const long = Math.max(width, height);
  const scale = Math.min(1, maxLongSide / long);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * scale), height: even(height * scale), scale };
}

function assertInt(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${value})`);
  }
}

/**
 * Build the ffmpeg argument list for an image → MP4 render.
 *
 * @param {object} opts
 * @param {string[]} opts.inputNames   File names to read, in order (one per image).
 * @param {number}   opts.width         Output width in pixels (see planGeometry).
 * @param {number}   opts.height        Output height in pixels.
 * @param {number}  [opts.fps=30]
 * @param {number}  [opts.duration=3]   Seconds each image is shown.
 * @param {string}  [opts.kenBurns='zoom-in'] One of KEN_BURNS_MODES.
 * @param {string}  [opts.container='mp4'] One of CONTAINERS.
 * @param {string}  [opts.outputName='output.mp4']
 * @param {string}  [opts.preset='veryfast']
 * @returns {{args: string[], filterComplex: string, outputName: string,
 *            width: number, height: number, frames: number,
 *            duration: number, fps: number, kenBurns: string,
 *            container: string}}
 */
export function buildRenderPlan(opts) {
  const {
    inputNames,
    width,
    height,
    fps = DEFAULTS.fps,
    duration = DEFAULTS.duration,
    kenBurns = DEFAULTS.kenBurns,
    container = DEFAULTS.container,
    outputName,
    preset = DEFAULTS.preset,
  } = opts || {};

  if (!Array.isArray(inputNames) || inputNames.length === 0) {
    throw new Error('buildRenderPlan: inputNames must be a non-empty array');
  }
  assertInt('fps', fps, 1, 120);
  assertInt('duration', duration, 1, 600);
  if (!KEN_BURNS_MODES.includes(kenBurns)) {
    throw new Error(`buildRenderPlan: unknown kenBurns mode "${kenBurns}" (expected one of ${KEN_BURNS_MODES.join(', ')})`);
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('buildRenderPlan: width and height must be positive integers');
  }
  if (!CONTAINERS.includes(container)) {
    throw new Error(`buildRenderPlan: unknown container "${container}" (expected one of ${CONTAINERS.join(', ')})`);
  }
  const finalOutputName = outputName || `output.${container}`;

  const frames = Math.max(1, Math.round(duration * fps));
  const args = [];
  const chains = [];

  inputNames.forEach((name, i) => {
    // One looping input per image: every still gets its own duration window.
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', name);

    // Scale to cover the output frame, then crop the overflow so every image
    // lands on the same pixel grid — required by the concat filter.
    const base = `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    if (kenBurns === 'none') {
      chains.push(`${base},fps=${fps}[v${i}]`);
    } else if (kenBurns === 'zoom-in') {
      chains.push(`${base},zoompan=z='min(1+0.2*on/${frames},1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}[v${i}]`);
    } else if (kenBurns === 'zoom-out') {
      chains.push(`${base},zoompan=z='max(1.2-0.2*on/${frames},1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}[v${i}]`);
    } else { // pan-left
      chains.push(`${base},zoompan=z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)/2':d=1:s=${width}x${height}:fps=${fps}[v${i}]`);
    }
  });

  const labels = inputNames.map((_, i) => `[v${i}]`).join('');
  chains.push(`${labels}concat=n=${inputNames.length}:v=1:a=0[out]`);

  const filterComplex = chains.join(';');
  const fullArgs = [
    ...args,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-preset', preset,
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-movflags', '+faststart',
    '-f', container,
    finalOutputName,
  ];

  return {
    args: fullArgs,
    filterComplex,
    outputName: finalOutputName,
    width,
    height,
    frames,
    duration,
    fps,
    kenBurns,
    container,
  };
}

/**
 * Plan for a still image → JPEG thumbnail.
 *
 * @param {object} opts
 * @param {string} opts.inputName       file to read
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {string} [opts.outputName='output.jpg']
 * @param {number} [opts.quality=2]      ffmpeg -q:v (2 = high quality, 31 = worst)
 */
export function buildThumbnailPlan({ inputName, width, height, outputName = 'output.jpg', quality = 2 }) {
  if (!inputName) throw new Error('buildThumbnailPlan: inputName is required');
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('buildThumbnailPlan: width and height must be positive integers');
  }
  const args = [
    '-i', inputName,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    '-frames:v', '1',
    '-q:v', String(quality),
    '-f', 'image2',
    outputName,
  ];
  return { args, outputName, width, height, kind: 'thumbnail' };
}

/**
 * Plan for a video → trimmed clip (re-encoded to a web-safe H.264 MP4).
 *
 * @param {object} opts
 * @param {string} opts.inputName
 * @param {number} opts.startSec
 * @param {number} opts.endSec
 * @param {string} [opts.outputName='output.mp4']
 * @param {string} [opts.container='mp4']
 */
export function buildClipPlan({ inputName, startSec, endSec, outputName, container = 'mp4' }) {
  if (!inputName) throw new Error('buildClipPlan: inputName is required');
  if (!Number.isFinite(startSec) || startSec < 0) {
    throw new Error('buildClipPlan: startSec must be a non-negative number');
  }
  if (!Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error('buildClipPlan: endSec must be greater than startSec');
  }
  if (!CONTAINERS.includes(container)) {
    throw new Error(`buildClipPlan: unknown container "${container}" (expected one of ${CONTAINERS.join(', ')})`);
  }
  const finalOutputName = outputName || `output.${container}`;
  const duration = endSec - startSec;
  const args = [
    '-ss', String(startSec),
    '-i', inputName,
    '-t', String(duration),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-f', container,
    finalOutputName,
  ];
  return { args, outputName: finalOutputName, startSec, endSec, duration, container, kind: 'clip' };
}
