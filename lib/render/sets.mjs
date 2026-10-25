// lib/render/sets.mjs
//
// The Node-side half of an image-set render: which files make up a set, in
// what order, at what output size, and how long each one is on screen.
//
// This is NOT part of `plan.mjs`. `plan.mjs` is browser-safe by rule (ESM, no
// Node built-ins, no DOM) because the page and the server share it. Reading a
// directory is a filesystem question, so it lives here, and the plan keeps
// receiving the file list it has always received.

import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp']);

export const SIZE_PRESETS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '4:3': { width: 1440, height: 1080 },
  '21:9': { width: 2560, height: 1080 },
};

/**
 * Sort names the way a person reads a set: `frame-2` before `frame-10`.
 *
 * A plain lexicographic sort puts `10` between `1` and `2`, which silently
 * scrambles any set with ten or more members — and looks like a content bug,
 * not a sorting one.
 */
export function naturalSort(names) {
  const chunk = (s) => String(s).match(/(\d+|\D+)/g) || [];
  return [...names].sort((a, b) => {
    const ca = chunk(a);
    const cb = chunk(b);
    for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
      const x = ca[i];
      const y = cb[i];
      if (x === y) continue;
      const nx = /^\d+$/.test(x);
      const ny = /^\d+$/.test(y);
      if (nx && ny) return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
    return ca.length - cb.length;
  });
}

/**
 * `16:9` / `9:16` / `1:1` / `1920x1080` -> {width, height}.
 *
 * Dimensions are floored to even numbers: H.264 4:2:0 cannot encode an odd
 * height, and a render that fails to play is worse than one a pixel smaller.
 */
export function parseSize(spec) {
  const raw = String(spec || '').trim();
  if (SIZE_PRESETS[raw]) return { ...SIZE_PRESETS[raw] };
  const m = raw.match(/^(\d+)x(\d+)$/i);
  if (!m) {
    throw new Error(`unknown size "${spec}" — use ${Object.keys(SIZE_PRESETS).join(', ')} or WxH`);
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16) throw new Error(`size ${raw} is too small`);
  return { width: width - (width % 2), height: height - (height % 2) };
}

/**
 * Every image under one input: a file, or a directory walked to a shallow
 * depth (a pack's subfolders are usually stills, not another pack).
 */
export function collectImages(inputs, { maxDepth = 4 } = {}) {
  const found = [];
  const missing = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      found.push(abs);
    }
  };
  for (const input of inputs) {
    const abs = path.resolve(String(input));
    if (!fs.existsSync(abs)) {
      missing.push(input);
      continue;
    }
    if (fs.statSync(abs).isDirectory()) walk(abs, 0);
    else if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) found.push(abs);
    else missing.push(`${input} (not an image)`);
  }
  return { images: naturalSort(found), missing };
}

/**
 * Seconds per image.
 *
 * `each` is the natural handle for a set; `total` is the handle for a platform
 * limit. `total` wins when both are given, and it has to account for the fades
 * the plan will subtract, or the clip comes out short.
 */
export function planDurations({ count, fps = 30, each, total, transition = 'none', fade = 0 } = {}) {
  if (!Number.isFinite(count) || count < 1) throw new Error('planDurations: need at least one image');
  const fadeSec = transition === 'crossfade' ? Math.max(0, Number(fade) || 0) : 0;
  let seconds = Number(each);
  if (Number.isFinite(Number(total)) && Number(total) > 0) {
    // N segments of S overlap (N-1) times by F: N*S - (N-1)*F = total.
    seconds = (Number(total) + (count - 1) * fadeSec) / count;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`planDurations: each ${each} is not a duration`);
  // Two frames is the shortest segment that still reads as a segment.
  const floor = 2 / fps;
  return { each: Math.max(seconds, floor), total: Number(total) || null };
}
