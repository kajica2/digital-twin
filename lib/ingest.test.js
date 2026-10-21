// lib/ingest.test.js — the link-dropper.
//
// Self-contained: a local http.createServer stands in for the real internet
// (no real Suno fetch, no real CDN), and the SMF bytes are built inline so
// the test is deterministic and offline. ffprobe may or may not be on PATH;
// audio analysis degrades to a clear "not installed" note when it is not,
// rather than failing the run.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  download, detectType, analyze, analyzeMidi,
  inboxFor, copyToInbox, resolveSuno, INBOXES
} = require('./ingest.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; failures.push(name + ' — expected ' + e + ', got ' + a); }
}

// ---- magic-byte detection ------------------------------------------------

const MIDI = Buffer.from([0x4D, 0x54, 0x68, 0x64, 0,0,0,6, 0,1, 0,1, 1,0xE0]);
const WAV  = (() => { const b = Buffer.alloc(12); b.write('RIFF',0,'ascii'); b.write('WAVE',8,'ascii'); return b; })();
const OGG  = Buffer.from('OggS', 'ascii');
const FLAC = Buffer.from('fLaC', 'ascii');
const MP3_ID3 = Buffer.from('ID3', 'ascii');
const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const MP4 = (() => { const b = Buffer.alloc(12); b.write('ftyp',4,'ascii'); return b; })();
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG = (() => { const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; })();
const WEBP = (() => { const b = Buffer.alloc(12); b.write('RIFF',0,'ascii'); b.write('WEBP',8,'ascii'); return b; })();
const HTML = Buffer.from('<!doctype html><html><body>hi</body></html>', 'utf8');

eq('detect: MIDI', detectType(MIDI), 'midi');
eq('detect: WAV', detectType(WAV), 'wav');
eq('detect: OGG', detectType(OGG), 'ogg');
eq('detect: FLAC', detectType(FLAC), 'flac');
eq('detect: MP3 (ID3 tag)', detectType(MP3_ID3), 'mp3');
eq('detect: MP3 (frame sync)', detectType(MP3_FRAME), 'mp3');
eq('detect: MP4/M4A', detectType(MP4), 'mp4');
eq('detect: JPG', detectType(JPG), 'jpg');
eq('detect: PNG', detectType(PNG), 'png');
eq('detect: WEBP', detectType(WEBP), 'webp');
eq('detect: HTML is unknown', detectType(HTML), 'unknown');
eq('detect: empty is unknown', detectType(Buffer.alloc(0)), 'unknown');

// ---- SMF synthesis + analyse -------------------------------------------

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }
function varint(n) {
  const out = [n & 0x7f]; let v = n >>> 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>>= 7; }
  return Buffer.from(out);
}
function chunk(type, body) {
  return Buffer.concat([Buffer.from(type, 'ascii'), u32(body.length), body]);
}

// ppq 480, tempo 120bpm (500000us), C major triad (C4 E4 G4), quarter notes.
// The on-delta is 0 each time (no gap between notes) so the four on-ticks
// land at 0, 480, 960, 1440 and the four off-ticks at 480, 960, 1440, 1920,
// giving a 2.0s score. Note: `varint(n.d)` for the on-delta would be wrong —
// n.d is the absolute offset of each note from the start, not the delta
// from the previous off; using it makes the parser see ticks at 0, 960,
// 1440, 1920, 2880, 3360 and a 3.5s duration that is not what the fixture
// is meant to encode.
function buildSmf() {
  const notes = [60, 64, 67, 72];
  const ev = [varint(0), Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])];
  for (const note of notes) {
    ev.push(varint(0), Buffer.from([0x90, note, 100]));
    ev.push(varint(480), Buffer.from([0x80, note, 0]));
  }
  ev.push(varint(0), Buffer.from([0xff, 0x2f, 0x00]));
  const track = chunk('MTrk', Buffer.concat(ev));
  const header = chunk('MThd', Buffer.concat([u16(0), u16(1), u16(480)]));
  return Buffer.concat([header, track]);
}

const SMF = buildSmf();
const midiSummary = analyzeMidi(SMF);
check('smf: format', midiSummary.format === 0, 'format=' + midiSummary.format);
check('smf: ppq', midiSummary.ppq === 480, 'ppq=' + midiSummary.ppq);
check('smf: notes count', midiSummary.notes === 4, 'notes=' + midiSummary.notes);
check('smf: bpm exact', midiSummary.bpm === 120, 'bpm=' + midiSummary.bpm);
check('smf: duration ~2s', Math.abs(midiSummary.duration - 2.0) < 1e-3, 'dur=' + midiSummary.duration);
check('smf: key is C major', midiSummary.key === 'C' && midiSummary.scale === 'major',
  'key=' + midiSummary.key + ' ' + midiSummary.scale);
check('smf: chroma peaks on C', midiSummary.chroma[0] === Math.max(...midiSummary.chroma));

// ---- inbox routing ----------------------------------------------------

eq('inboxFor: wav', inboxFor('wav'), 'audio-inbox');
eq('inboxFor: mp3', inboxFor('mp3'), 'audio-inbox');
eq('inboxFor: midi', inboxFor('midi'), null);
eq('inboxFor: unknown', inboxFor('unknown'), null);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
const srcFile = path.join(tmp, 'clip.wav');
fs.writeFileSync(srcFile, WAV);
const copied = copyToInbox(srcFile, 'audio-inbox', 'wav');
check('inbox: copy lands in the named inbox',
  copied === path.resolve('audio-inbox', 'clip.wav') && fs.existsSync(copied),
  copied);
fs.unlinkSync(copied);
fs.rmdirSync(tmp, { recursive: true });

// ---- download + resolveSuno (local HTTP server) -----------------------

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: 'http://127.0.0.1:' + port, port });
    });
  });
}

(async () => {
  // 1. plain file download
  const direct = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(MP3_FRAME);
  });
  const got = await download(direct.url, { dest: path.join(os.tmpdir(), 'ingest-direct-' + Date.now() + '.mp3') });
  check('download: bytes', got.bytes === MP3_FRAME.length, 'got=' + got.bytes);
  check('download: content-type', got.contentType === 'audio/mpeg', 'ct=' + got.contentType);
  const dlBuf = fs.readFileSync(got.path);
  check('download: bytes match', dlBuf.equals(MP3_FRAME));
  direct.server.close();

  // 2. resolveSuno: server returns HTML with a fake CDN URL
  const sunoPage = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head>' +
      '<meta property="og:title" content="My Track">' +
      '<meta property="og:audio" content="https://cdn1.suno.ai/abc123.mp3">' +
      '</head><body>nope</body></html>');
  });
  const directAudio = await resolveSuno(sunoPage.url);
  check('resolveSuno: extracts CDN URL', directAudio === 'https://cdn1.suno.ai/abc123.mp3',
    'got=' + directAudio);
  sunoPage.server.close();

  // 3. resolveSuno failure mode: HTML with no audio URL gives a clear error
  const bare = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>no audio here</body></html>');
  });
  let resolveErr = null;
  try { await resolveSuno(bare.url); }
  catch (e) { resolveErr = e.message; }
  check('resolveSuno: no audio URL throws a clear error',
    resolveErr && /no audio URL found/.test(resolveErr), resolveErr || '(no throw)');
  bare.server.close();

  // 4. maxBytes guard
  const big = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream',
      'content-length': String(2 * 1024 * 1024) });
    res.end(Buffer.alloc(2 * 1024 * 1024));
  });
  let guardErr = null;
  try { await download(big.url, { maxBytes: 1024 * 1024 }); }
  catch (e) { guardErr = e.message; }
  check('download: maxBytes guard fires on declared size',
    guardErr && /refusing/i.test(guardErr), guardErr || '(no throw)');
  big.server.close();

  // ---- summary ---------------------------------------------------------
  process.stderr.write(`\n[ingest.test] passed: ${passed}, failed: ${failed}\n`);
  if (failed > 0) for (const f of failures) process.stderr.write('  FAILED: ' + f + '\n');
  process.exit(failed === 0 ? 0 : 1);
})();
