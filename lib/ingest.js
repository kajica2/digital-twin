// lib/ingest.js — drop a link, get a file + analysis.
//
// A small, dependency-free downloader/inspector that takes a URL, fetches
// it, detects the file type by magic bytes, runs the appropriate summary
// (MIDI is parsed in-process; audio shells out to ffprobe), and optionally
// drops the result into a known inbox so one of the existing watchers
// (songs-watcher for audio, etc.) picks it up automatically.
//
//   import { download, detectType, analyze } from './lib/ingest.js';
//   const { path, bytes } = await download('https://example.com/track.mid');
//   const type = detectType(fs.readFileSync(path));
//   console.log(analyze(path, type));
//
// CLI:
//   node bin/ingest.js <url> [--inbox NAME] [--out PATH] [--no-analyze] [--max-bytes N]
//
// Design note: the SMF reader below is a focused port of the one embedded
// in lib/meditate-temperature.js (and a near-twin of the one in the SWR
// engine's lib/midi-feat.client.js). Three copies is too many; a future
// sprint should extract a shared lib/smf.js, have the browser component
// load it via a second <script> tag, and have this module import it. For
// now, the duplication is the conscious tradeoff for a warmup tool that
// does not refactor shipped code.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200 MB — tracks, not model weights

// ---- download ----------------------------------------------------------

function basenameFromUrl(url) {
  try { return path.basename(new URL(url).pathname) || 'ingest'; }
  catch { return 'ingest'; }
}

async function download(url, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' for ' + url);
  const declared = res.headers.get('content-length');
  if (declared && +declared > maxBytes) {
    throw new Error('refusing to download: ' + declared + ' bytes (max ' + maxBytes + ')');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error('refusing to write: ' + buf.length + ' bytes (max ' + maxBytes + ')');
  }
  const dest = opts.dest || path.join(os.tmpdir(),
    'ingest-' + Date.now() + '-' + basenameFromUrl(url));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return {
    path: dest,
    bytes: buf.length,
    contentType: res.headers.get('content-type'),
    finalUrl: res.url
  };
}

// ---- magic-byte detection ----------------------------------------------

function asciiAt(buf, off, len) {
  if (off + len > buf.length) return '';
  return buf.toString('ascii', off, off + len);
}

function detectType(buf) {
  if (!buf || buf.length < 3) return 'unknown';
  if (asciiAt(buf, 0, 4) === 'MThd') return 'midi';
  if (asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'WAVE') return 'wav';
  if (asciiAt(buf, 0, 4) === 'OggS') return 'ogg';
  if (asciiAt(buf, 0, 4) === 'fLaC') return 'flac';
  if (asciiAt(buf, 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 12 && asciiAt(buf, 4, 4) === 'ftyp') return 'mp4';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && asciiAt(buf, 1, 3) === 'PNG') return 'png';
  if (asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'WEBP') return 'webp';
  return 'unknown';
}

// ---- in-process SMF summary (Krumhansl-Schmuckler key) -----------------

function readVarint(buf, o) {
  var v = 0, i;
  for (i = 0; i < 4; i++) {
    var x = buf[o + i];
    if (x === undefined) throw new Error('smf: truncated variable-length value');
    v = (v << 7) | (x & 0x7f);
    if (!(x & 0x80)) return [v, o + i + 1];
  }
  throw new Error('smf: variable-length value longer than 4 bytes');
}

var CHANNEL_DATA = [2, 2, 2, 2, 1, 1, 2];
var MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
var MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
var PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function correlate(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) {
    var xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  var den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

function analyzeMidi(buf) {
  if (buf.length < 14) throw new Error('smf: too short');
  if (asciiAt(buf, 0, 4) !== 'MThd') throw new Error('smf: missing MThd');
  var headerLen = buf.readUInt32BE(4);
  var format = (buf[8] << 8) | buf[9];
  var ntrks = (buf[10] << 8) | buf[11];
  var division = (buf[12] << 8) | buf[13];
  if (division & 0x8000) throw new Error('smf: SMPTE time division unsupported');
  var ppq = division || 480;

  var off = 8 + headerLen;
  var notes = [];
  var tempoUs = 500000;
  var timeSig = null;
  var endTick = 0;
  var tracks = 0;
  var firstChannel = null;

  while (off + 8 <= buf.length) {
    var type = asciiAt(buf, off, 4);
    var len = buf.readUInt32BE(off + 4);
    var p = off + 8;
    var end = Math.min(p + len, buf.length);
    off = end;
    if (type !== 'MTrk') continue;
    tracks++;
    var tick = 0, running = 0;
    var open = {};
    while (p < end) {
      var d = readVarint(buf, p); tick += d[0]; p = d[1];
      if (p >= end) break;
      var status = buf[p];
      if (status & 0x80) {
        p++;
        if (status < 0xf0) running = status;
        else if (status !== 0xf0 && status !== 0xf7) running = 0;
      } else if (running) {
        status = running;
      } else {
        throw new Error('smf: data byte without running status');
      }

      if (status === 0xff) {
        var mtype = buf[p++];
        var md = readVarint(buf, p); var mlen = md[0]; p = md[1];
        if (mtype === 0x51 && mlen === 3) {
          tempoUs = (buf[p] << 16) | (buf[p+1] << 8) | buf[p+2];
        } else if (mtype === 0x58 && mlen >= 2) {
          timeSig = { num: buf[p], den: 1 << buf[p+1] };
        }
        p += mlen;
        if (mtype === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        var sd = readVarint(buf, p); p = sd[1] + sd[0];
        continue;
      }
      var hi = status & 0xf0;
      var ch = status & 0x0f;
      if (firstChannel === null) firstChannel = ch;
      var n = CHANNEL_DATA[hi - 0x80] || 2;
      var d1 = buf[p]; var d2 = n > 1 ? buf[p+1] : 0;
      p += n;
      if (hi === 0x90 && d2 > 0) {
        var k = ch + ':' + d1;
        (open[k] || (open[k] = [])).push({ tick: tick, vel: d2 });
      } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        var k2 = ch + ':' + d1;
        var stack = open[k2];
        if (stack && stack.length) {
          var on = stack.pop();
          notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), note: d1, vel: on.vel, ch: ch });
        }
      }
    }
    if (tick > endTick) endTick = tick;
  }
  notes.sort(function (a, b) { return a.tick - b.tick; });
  var secPerTick = (tempoUs / 1e6) / ppq;
  for (var i = 0; i < notes.length; i++) {
    notes[i].t = notes[i].tick * secPerTick;
    notes[i].end = (notes[i].tick + notes[i].dur) * secPerTick;
  }
  var duration = endTick * secPerTick;
  for (var j = 0; j < notes.length; j++) if (notes[j].end > duration) duration = notes[j].end;

  // chromagram (velocity-weighted duration) + Krumhansl-Schmuckler key
  var chroma = new Array(12).fill(0);
  for (var k3 = 0; k3 < notes.length; k3++) chroma[notes[k3].note % 12] += notes[k3].dur * notes[k3].vel;
  var total = 0;
  for (var c = 0; c < 12; c++) total += chroma[c];
  if (total > 0) for (var c2 = 0; c2 < 12; c2++) chroma[c2] = chroma[c2] / total;

  var bestKey = 'C', bestScale = 'major', bestScore = -2;
  if (notes.length) {
    for (var root = 0; root < 12; root++) {
      var rot = new Array(12);
      for (var jj = 0; jj < 12; jj++) rot[jj] = chroma[(root + jj) % 12];
      var maj = correlate(rot, MAJOR_PROFILE);
      var min = correlate(rot, MINOR_PROFILE);
      if (maj > bestScore) { bestScore = maj; bestKey = PITCH_NAMES[root]; bestScale = 'major'; }
      if (min > bestScore) { bestScore = min; bestKey = PITCH_NAMES[root]; bestScale = 'minor'; }
    }
  }

  return {
    format: format, ppq: ppq, tracks: tracks,
    notes: notes.length,
    duration: +duration.toFixed(3),
    bpm: Math.round(6e7 / tempoUs),
    key: notes.length ? bestKey : 'C',
    scale: notes.length ? bestScale : 'major',
    confidence: notes.length ? Math.max(0, +bestScore.toFixed(3)) : 0,
    timeSig: timeSig,
    firstChannel: firstChannel,
    chroma: chroma
  };
}

// ---- audio analysis via ffprobe (degrades gracefully) -------------------

function analyzeAudio(filePath, type) {
  var probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams',
    '-of', 'json', filePath
  ], { encoding: 'utf8', timeout: 15000 });
  if (probe.error) {
    if (probe.error.code === 'ENOENT') {
      return { codec: 'unknown (ffprobe not installed)', note: 'install ffmpeg for full audio summary' };
    }
    return { error: probe.error.message };
  }
  if (probe.status !== 0) {
    return { error: 'ffprobe exited ' + probe.status, stderr: (probe.stderr || '').slice(0, 200) };
  }
  try {
    var data = JSON.parse(probe.stdout);
    var stream = (data.streams || []).find(function (s) { return s.codec_type === 'audio'; }) || (data.streams || [])[0] || {};
    var fmt = data.format || {};
    return {
      codec: stream.codec_name,
      duration: fmt.duration ? +parseFloat(fmt.duration).toFixed(3) : null,
      bitrate: stream.bit_rate ? +stream.bit_rate : (fmt.bit_rate ? +fmt.bit_rate : null),
      sampleRate: stream.sample_rate ? +stream.sample_rate : null,
      channels: stream.channels || null,
      format: fmt.format_name,
      size: fmt.size ? +fmt.size : null
    };
  } catch (e) {
    return { error: 'parse: ' + e.message };
  }
}

// ---- dispatch -----------------------------------------------------------

function analyze(filePath, type) {
  var buf = fs.readFileSync(filePath);
  if (type === 'midi') return analyzeMidi(buf);
  if (type === 'wav' || type === 'mp3' || type === 'ogg' || type === 'flac' || type === 'mp4') {
    return analyzeAudio(filePath, type);
  }
  if (type === 'unknown') return { note: 'unknown file type', bytes: buf.length, head: buf.slice(0, 16).toString('hex') };
  return { note: 'no analyser for type: ' + type, bytes: buf.length };
}

// ---- inbox routing ------------------------------------------------------

var INBOXES = {
  wav: 'audio-inbox', mp3: 'audio-inbox', ogg: 'audio-inbox',
  flac: 'audio-inbox', mp4: 'audio-inbox',
  midi: null, jpg: null, png: null, webp: null, unknown: null
};

function inboxFor(type) { return INBOXES[type] || null; }

function copyToInbox(srcPath, inbox, type) {
  var dir = path.resolve(inbox);
  fs.mkdirSync(dir, { recursive: true });
  var finalPath = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, finalPath);
  return finalPath;
}

// ---- Suno page resolver ------------------------------------------------
// Suno song pages are an SPA; the page HTML does not contain the audio as
// an <audio> element, but it does carry the CDN URL in either a meta tag
// (`<meta property="og:audio" content="https://cdn.suno.ai/...">`) or the
// page's embedded JSON (`"audio_url":"https://..."`). This fetcher grabs the
// first matching URL — enough to then hand the direct audio URL to
// `download()` for the real ingest.

var SUNO_AUDIO_RE = /https?:\/\/cdn[0-9]?\.suno\.ai\/[^"'<>\\\s]+\.(?:mp3|m4a|wav|ogg|flac)/i;

async function resolveSuno(pageUrl, opts) {
  opts = opts || {};
  var res = await fetch(pageUrl, {
    redirect: 'follow',
    headers: { 'user-agent': opts.userAgent || 'digital-twin-ingest/0.1' }
  });
  if (!res.ok) throw new Error('suno page fetch: HTTP ' + res.status + ' for ' + pageUrl);
  var html = await res.text();
  var m = html.match(SUNO_AUDIO_RE);
  if (!m) {
    // Some Suno pages reference the audio in a meta or JSON we can sniff
    // even when the regex above misses. Try a few more patterns before
    // giving up so the failure message is specific.
    var fallback = html.match(/https?:\/\/[^"'<>\\\s]+\.(?:mp3|m4a|wav)/i);
    if (fallback) return fallback[0];
    throw new Error('suno: no audio URL found in page (page may be JS-rendered without a static audio link)');
  }
  return m[0];
}

module.exports = {
  download: download,
  detectType: detectType,
  analyze: analyze,
  analyzeMidi: analyzeMidi,
  inboxFor: inboxFor,
  copyToInbox: copyToInbox,
  INBOXES: INBOXES,
  resolveSuno: resolveSuno
};
