#!/usr/bin/env node
// bin/ingest.js — drop a link, get a file + analysis.
//
//   node bin/ingest.js <url> [options]
//
// Downloads the URL, detects the type by magic bytes, runs the appropriate
// summary (MIDI in-process; audio via ffprobe), and optionally copies the
// result into an inbox so one of the existing watchers picks it up.
//
// Special case: a Suno song page (https://suno.com/song/<uuid>) is an SPA;
// the first download returns HTML. When that happens, resolveSuno() pulls
// the CDN audio URL out of the page and retries the download with the
// direct audio link, so a Suno link just works as a track input.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  download, detectType, analyze,
  inboxFor, copyToInbox, INBOXES, resolveSuno
} = require('../lib/ingest.js');

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  process.stdout.write([
    'Usage: node bin/ingest.js <url> [options]',
    '',
    'Options:',
    '  --inbox NAME   copy into the named inbox (overrides the type default)',
    '  --out PATH     write to a specific path instead of a temp file',
    '  --no-analyze   skip the per-type summary',
    '  --max-bytes N  refuse files larger than N (default 200MB)',
    '',
    'Default inboxes:',
    '  audio (.wav .mp3 .ogg .flac .mp4) -> audio-inbox/',
    '  midi                              -> (no default; pass --inbox or --out)',
    '',
    'Special: Suno song page URLs are resolved to the CDN audio URL and',
    'downloaded as a normal audio file.',
    ''
  ].join('\n'));
  process.exit(argv.length ? 0 : 1);
}

const url = argv[0];
const opts = { inbox: null, out: null, analyze: true, maxBytes: 200 * 1024 * 1024 };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--inbox') opts.inbox = argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--analyze') opts.analyze = true;
  else if (a === '--no-analyze') opts.analyze = false;
  else if (a === '--max-bytes') opts.maxBytes = +argv[++i];
}

function fmt(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function looksLikeHtml(res) {
  var ct = (res.contentType || '').toLowerCase();
  if (ct.indexOf('html') !== -1) return true;
  if (ct.indexOf('json') !== -1) return false;
  // Heuristic: the URL is for a known SPA host.
  try { var u = new URL(res.finalUrl || ''); return /suno\.com$/.test(u.hostname); }
  catch { return false; }
}

async function fetchAndDetect(targetUrl) {
  const t0 = Date.now();
  process.stdout.write('↓ ' + targetUrl + '\n');
  let res;
  try {
    res = await download(targetUrl, { maxBytes: opts.maxBytes });
  } catch (e) {
    process.stderr.write('  download failed: ' + e.message + '\n');
    return null;
  }
  const dt = (Date.now() - t0) / 1000;
  process.stdout.write('  ' + fmt(res.bytes) + ' in ' + dt.toFixed(2) + 's\n');
  process.stdout.write('  saved to: ' + res.path + '\n');
  if (res.contentType) process.stdout.write('  content-type: ' + res.contentType + '\n');
  const buf = fs.readFileSync(res.path);
  const type = detectType(buf);
  process.stdout.write('  detected type: ' + type + '\n');
  return { res: res, buf: buf, type: type };
}

function printAnalysis(filePath, type) {
  if (!opts.analyze) return;
  try {
    const a = analyze(filePath, type);
    process.stdout.write('  analysis:\n');
    for (const [k, v] of Object.entries(a)) {
      if (k === 'chroma' && Array.isArray(v)) {
        process.stdout.write('    ' + k + ': [' + v.map(x => +x.toFixed(3)).join(', ') + ']\n');
      } else if (typeof v === 'string') {
        process.stdout.write('    ' + k + ': ' + v + '\n');
      } else {
        process.stdout.write('    ' + k + ': ' + JSON.stringify(v) + '\n');
      }
    }
  } catch (e) {
    process.stdout.write('  analysis: error — ' + e.message + '\n');
  }
}

function routeCopy(srcPath, type) {
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.copyFileSync(srcPath, opts.out);
    process.stdout.write('  copied to: ' + opts.out + ' (explicit --out)\n');
    return;
  }
  if (opts.inbox) {
    const final = copyToInbox(srcPath, opts.inbox, type);
    process.stdout.write('  copied to: ' + final + ' (inbox: ' + opts.inbox + ')\n');
    return;
  }
  const defaultInbox = INBOXES[type];
  if (defaultInbox) {
    const final = copyToInbox(srcPath, defaultInbox, type);
    process.stdout.write('  copied to: ' + final + ' (default inbox for ' + type + ')\n');
  } else {
    process.stdout.write('  (no default inbox for ' + type + '; pass --inbox or --out to copy)\n');
  }
}

(async () => {
  let got = await fetchAndDetect(url);
  if (!got) process.exit(2);

  // Suno / SPA fallback: if the first response was HTML, resolve to the
  // direct audio URL and download again.
  if (got.type === 'unknown' && looksLikeHtml(got.res)) {
    process.stdout.write('  page HTML detected — resolving Suno CDN URL…\n');
    let direct;
    try { direct = await resolveSuno(got.res.finalUrl || url); }
    catch (e) {
      process.stderr.write('  suno resolve failed: ' + e.message + '\n');
      process.exit(3);
    }
    process.stdout.write('  resolved to: ' + direct + '\n');
    got = await fetchAndDetect(direct);
    if (!got) process.exit(2);
  }

  printAnalysis(got.res.path, got.type);
  routeCopy(got.res.path, got.type);
})().catch((e) => {
  process.stderr.write('ingest failed: ' + (e.stack || e.message) + '\n');
  process.exit(1);
});
