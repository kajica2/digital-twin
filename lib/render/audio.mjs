// lib/render/audio.mjs
//
// How long is that track, really?
//
// An MP3's container header is not a measurement. A VBR file with no Xing
// header makes ffmpeg ESTIMATE the duration from the bitrate, and the
// estimate can be tens of seconds long — a track that really decodes for
// 3:34.8 can claim 4:14.9. Muxing against the estimate produces a video
// that is cut short (or a still set that never covers the song).
//
// The only number that counts is the one ffmpeg gets to the end of.
//
//   node -e "import('./lib/render/audio.mjs').then(m => console.log(m.probeAudioDuration('track.mp3')))"
//
// ZERO DEPENDENCIES beyond ffmpeg, which the renderer already needs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The duration the track ACTUALLY decodes to, in seconds.
 *
 * Decodes the file to the null muxer and reads the last timestamp ffmpeg
 * reports. Costs a fraction of the track's length (a null decode runs at
 * several hundred times realtime) and is the only figure that matches what
 * a listener hears.
 *
 * @param {string} file
 * @param {{ timeoutMs?: number, ffmpeg?: string }} [opts]
 * @returns {number|null} seconds, or null when it cannot be measured
 */
export function probeAudioDuration(file, { timeoutMs = DEFAULT_TIMEOUT_MS, ffmpeg = 'ffmpeg' } = {}) {
  if (!file || !existsSync(file)) return null;
  const res = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const times = [...text.matchAll(/time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];
  if (!times.length) return null;
  const last = times[times.length - 1];
  const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  return seconds > 0 ? Number(seconds.toFixed(3)) : null;
}

/**
 * The duration the file's HEADER claims, in seconds.
 *
 * Kept separate on purpose: comparing the two is how a broken header gets
 * noticed instead of silently truncating a song.
 */
export function probeAudioHeaderDuration(file, { timeoutMs = DEFAULT_TIMEOUT_MS, ffprobe = 'ffprobe' } = {}) {
  if (!file || !existsSync(file)) return null;
  const res = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8', timeout: timeoutMs });
  const value = Number(String(res.stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null;
}

/**
 * The length of the track, and what its header claimed.
 *
 * @returns {{seconds:number|null, headerSeconds:number|null, headerOffBy:number}}
 *   `headerOffBy` is how many seconds the header over- or under-stated the
 *   real length (0 when they agree or when either is unknown).
 */
export function measureTrack(file, opts = {}) {
  const seconds = probeAudioDuration(file, opts);
  const headerSeconds = probeAudioHeaderDuration(file, opts);
  const headerOffBy = seconds !== null && headerSeconds !== null
    ? Number((headerSeconds - seconds).toFixed(3))
    : 0;
  return { seconds, headerSeconds, headerOffBy };
}
