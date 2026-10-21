#!/usr/bin/env node
/**
 * doctor.mjs — the preflight that must stop the "FFmpeg is not defined" class
 * of bug from ever reaching a user again.
 *
 * The incident: a page loaded @ffmpeg/ffmpeg from unpkg at runtime and called
 * `new FFmpegFFmpeg()` — a name that never existed in any build — so every
 * render died with "FFmpeg is not defined". Two root causes, both checked
 * here:
 *   1. the environment was never verified before the tool ran (no ffmpeg
 *      binary, no vendored wasm, node too old for node:sqlite), and
 *   2. the browser loader was hand-rolled per page, with a runtime CDN
 *      dependency — so a page could drift and nothing noticed.
 *
 * Usage
 *   node bin/doctor.mjs           # human-readable checklist
 *   node bin/doctor.mjs --json    # same checklist as JSON
 *
 * Exit codes: 0 = every check passed (or was skipped), 1 = at least one FAIL.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const INSTALLER = path.join(HERE, 'install-vendor.mjs');
const JSON_MODE = process.argv.includes('--json');

const MIN_NODE_MAJOR = 22; // node:sqlite (DatabaseSync) landed in 22.5

/** Directories never scanned for source-level patterns. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  'vendor',
  'site-packages',
  '__pycache__',
]);

const checks = [];

function record(name, status, detail) {
  checks.push({ name, status, detail });
  return status;
}

const pass = (name, detail) => record(name, 'PASS', detail);
const fail = (name, detail) => record(name, 'FAIL', detail);
const skip = (name, detail) => record(name, 'SKIP', detail);

// ---------------------------------------------------------------- node ----

function checkNode() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0], 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    fail(
      'node version',
      `node ${version} is too old (need >= ${MIN_NODE_MAJOR}; node:sqlite requires it)`
    );
    return;
  }
  pass('node version', `node ${version} (>= ${MIN_NODE_MAJOR}, node:sqlite available)`);
}

async function checkSqlite() {
  try {
    const mod = await import('node:sqlite');
    if (typeof mod.DatabaseSync !== 'function') {
      fail('node:sqlite', 'node:sqlite imported but DatabaseSync is missing');
      return;
    }
    pass('node:sqlite', 'node:sqlite imported (DatabaseSync available)');
  } catch (err) {
    fail('node:sqlite', `node:sqlite is not importable: ${err.message}`);
  }
}

// -------------------------------------------------------------- ffmpeg ----

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function run(bin, args) {
  const res = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error) return { ok: false, output: '', error: res.error.message };
  return { ok: res.status === 0, output: `${res.stdout || ''}${res.stderr || ''}`, error: null };
}

function firstLine(text) {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : '(no output)';
}

function checkFfmpegBinaries() {
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) {
    fail('ffmpeg on PATH', 'ffmpeg not found on PATH — run bin/setup.sh (brew install ffmpeg)');
  } else {
    const res = run(ffmpeg, ['-version']);
    pass('ffmpeg on PATH', `${ffmpeg} — ${firstLine(res.output)}`);
  }

  const ffprobe = which('ffprobe');
  if (!ffprobe) {
    fail('ffprobe on PATH', 'ffprobe not found on PATH — run bin/setup.sh (brew install ffmpeg)');
  } else {
    const res = run(ffprobe, ['-version']);
    pass('ffprobe on PATH', `${ffprobe} — ${firstLine(res.output)}`);
  }
}

function checkFfmpegCapabilities() {
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) {
    fail('ffmpeg libx264 encoder', 'skipped — ffmpeg is not on PATH');
    fail('ffmpeg zoompan/concat filters', 'skipped — ffmpeg is not on PATH');
    return;
  }

  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  if (encoders.output.includes('libx264')) {
    pass('ffmpeg libx264 encoder', 'libx264 is present (required by lib/render/plan.mjs)');
  } else {
    fail('ffmpeg libx264 encoder', 'libx264 is missing from `ffmpeg -encoders` (required by lib/render/plan.mjs)');
  }

  const filters = run(ffmpeg, ['-hide_banner', '-filters']);
  const missing = ['zoompan', 'concat'].filter((f) => !new RegExp(`\\b${f}\\b`).test(filters.output));
  if (missing.length === 0) {
    pass('ffmpeg zoompan/concat filters', 'zoompan and concat are both present');
  } else {
    fail('ffmpeg zoompan/concat filters', `missing filter(s): ${missing.join(', ')} (required by lib/render/plan.mjs)`);
  }
}

// --------------------------------------------------------------- vendor ----

function checkVendor() {
  if (!fs.existsSync(INSTALLER)) {
    fail('vendored ffmpeg.wasm assets', `installer not found at ${path.relative(REPO_ROOT, INSTALLER)}`);
    return;
  }
  const res = spawnSync(process.execPath, [INSTALLER, '--verify'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
    fail('vendored ffmpeg.wasm assets', `bin/install-vendor.mjs --verify failed:\n${out}`);
    return;
  }
  pass('vendored ffmpeg.wasm assets', 'bin/install-vendor.mjs --verify: every pinned file matches its sha256');
}

/**
 * The installer verifies what the manifest pins. This checks the other half:
 * that the manifest actually covers the module graph — a file that the ESM
 * entry points import but the manifest does not list would 404 in the browser
 * and kill the toolchain exactly like the original bug.
 */
function checkVendorImportGraph() {
  const manifestPath = path.join(REPO_ROOT, 'vendor', 'ffmpeg', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail('vendored module graph', 'vendor/ffmpeg/manifest.json is missing — run bin/install-vendor.mjs');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail('vendored module graph', `vendor/ffmpeg/manifest.json is unreadable: ${err.message}`);
    return;
  }

  const pinned = new Set(Object.keys(manifest.files || {}));
  const missing = [];
  const importRe = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

  for (const relPath of pinned) {
    if (!relPath.endsWith('.js') && !relPath.endsWith('.mjs')) continue;
    const abs = path.join(REPO_ROOT, 'vendor', 'ffmpeg', relPath);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    let m;
    while ((m = importRe.exec(source)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('./')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec));
      if (!pinned.has(resolved)) {
        missing.push(`${relPath} imports "${spec}" → ${resolved} is not in the manifest`);
      }
    }
  }

  if (missing.length) {
    fail('vendored module graph', `missing from the pin manifest:\n    ${missing.join('\n    ')}`);
  } else {
    pass('vendored module graph', 'every relative import in the vendored ESM files is pinned');
  }
}

// ----------------------------------------------------------- source lint ---

function collectFiles(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(abs, filter, out);
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Every source surface in the repo that can reach a browser or the Node
 * server, and that therefore can carry a hand-rolled ffmpeg loader.
 *
 * Scope: root *.html, every html under pages/ and twin-os/, every .mjs under
 * pages/assets/ and lib/. Third-party trees (vendor/, node_modules/, …) are
 * excluded — we do not lint code we do not own.
 */
function lintTargets() {
  const files = [];
  const root = REPO_ROOT;

  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (name.endsWith('.html')) files.push(path.join(root, name));
  }
  files.push(...collectFiles(path.join(root, 'pages'), (n) => n.endsWith('.html')));
  files.push(...collectFiles(path.join(root, 'twin-os'), (n) => n.endsWith('.html')));
  files.push(...collectFiles(path.join(root, 'pages', 'assets'), (n) => n.endsWith('.mjs')));
  files.push(...collectFiles(path.join(root, 'lib'), (n) => n.endsWith('.mjs')));

  const seen = new Set();
  return files
    .filter((abs) => (seen.has(abs) ? false : seen.add(abs)))
    .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join('/') }));
}

/**
 * Strip comments from JS source while preserving every byte offset (comment
 * bodies become spaces, newlines stay). Offsets are preserved so a hit can
 * still be reported with its original line number.
 *
 * Why: the banned patterns are about CODE. A comment that documents the old
 * bug ("this used to call `new FFmpegFFmpeg()`") is exactly what we want the
 * codebase to keep — it is the runtime call we must ban.
 */
function stripJsComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  const n = src.length;
  let i = 0;
  let prevSig = '';
  let prevWord = '';

  const regexAllowed = () => {
    if (prevSig === '') return true;
    if (/[A-Za-z0-9_$]/.test(prevSig)) {
      return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'].includes(prevWord);
    }
    return true;
  };

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      i = j;
      prevSig = c;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; break; }
        else if (d === '\n') break;
        j++;
      }
      i = j;
      prevSig = '/';
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      if (/[A-Za-z0-9_$]/.test(c)) {
        let k = i;
        while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
        prevWord = src.slice(i, k);
      } else {
        prevWord = '';
      }
    }
    i++;
  }
  return out.join('');
}

/** Strip HTML comments (offsets preserved) and JS comments inside <script> blocks. */
function stripHtmlComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let idx = 0;
  while (true) {
    const start = src.indexOf('<!--', idx);
    if (start < 0) break;
    const end = src.indexOf('-->', start + 4);
    const stop = end < 0 ? src.length : end + 3;
    blank(start, stop);
    idx = stop;
  }
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(src)) !== null) {
    const innerStart = m.index + m[0].indexOf('>', 0) + 1;
    const inner = m[1];
    const stripped = stripJsComments(inner);
    for (let k = 0; k < inner.length; k++) out[innerStart + k] = stripped[k];
  }
  return out.join('');
}

/**
 * The CODE view of an HTML file: the markup of every tag, the contents of
 * every <script> block (JS comments stripped), and nothing else. Visible text
 * between the tags is prose and is blanked out.
 *
 * Tag markup is kept on purpose: `<script src="https://unpkg.com/@ffmpeg/…">`
 * is a loader even though it is not script text.
 */
function htmlCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // 1. HTML comments are not code.
  let idx = 0;
  while (true) {
    const start = src.indexOf('<!--', idx);
    if (start < 0) break;
    const end = src.indexOf('-->', start + 4);
    const stop = end < 0 ? src.length : end + 3;
    blank(start, stop);
    idx = stop;
  }

  // 2. Locate <script> blocks — their contents are code.
  const blocks = [];
  const scriptRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  let m;
  while ((m = scriptRe.exec(src)) !== null) {
    blocks.push([m.index, m.index + m[0].length]);
  }

  // 3. Blank the prose: text outside of tags and outside of script blocks.
  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  const blankProse = (from, to) => {
    tagRe.lastIndex = from;
    let cursor = from;
    let t;
    while ((t = tagRe.exec(src)) !== null) {
      if (t.index >= to) break;
      blank(cursor, t.index);
      cursor = t.index + t[0].length;
    }
    blank(cursor, to);
  };
  let cursor = 0;
  for (const [start, end] of blocks) {
    blankProse(cursor, start);
    cursor = end;
  }
  blankProse(cursor, src.length);

  // 4. Inside script blocks, drop the JS comments but keep the code.
  for (const [start, end] of blocks) {
    const block = src.slice(start, end);
    const openEnd = block.indexOf('>') + 1;
    const closeStart = block.toLowerCase().lastIndexOf('</script');
    const js = block.slice(openEnd, closeStart < 0 ? block.length : closeStart);
    const stripped = stripJsComments(js);
    for (let k = 0; k < js.length; k++) out[start + openEnd + k] = stripped[k];
  }

  return out.join('');
}

/**
 * Loader CODE: markers of "this file pulls in the ffmpeg.wasm runtime
 * itself" instead of going through the one shared client.
 *
 * These are matched against CODE only. A page that merely says "FFmpeg.wasm"
 * in prose (how-to.html, tools.html, marketplace.html, twin-os/index.html,
 * loopable-video-segmenter.html) is documentation, not a loader, and must
 * pass.
 */
const LOADER_CODE = [
  { re: /@ffmpeg\/ffmpeg/, label: '@ffmpeg/ffmpeg (library reference)' },
  { re: /@ffmpeg\/util/, label: '@ffmpeg/util (library reference)' },
  { re: /@ffmpeg\/core/, label: '@ffmpeg/core (library reference)' },
  { re: /new\s+FFmpeg\s*\(/, label: 'new FFmpeg( (constructs the wasm class)' },
  { re: /createFFmpeg\s*\(/, label: 'createFFmpeg( (removed in 0.12+)' },
  { re: /toBlobURL/, label: 'toBlobURL (CDN → blob URL loader)' },
];

/**
 * The two incident markers are unconditional hard failures: `new
 * FFmpegFFmpeg` never existed in any build and `createFFmpeg(` was removed in
 * 0.12+. Unlike the loader rule above, they are not excused by a reference to
 * the shared client, and they are matched against prose too — a page whose
 * visible text shows the old call is as broken as one that executes it.
 *
 * Comments are still excluded: writing down "the old code called
 * `new FFmpegFFmpeg()`" is how the incident gets documented, and the loader
 * code it describes cannot run.
 */
const INCIDENT_MARKERS = [
  { re: /new\s+FFmpegFFmpeg\b/, label: 'new FFmpegFFmpeg (never existed in any build)' },
  { re: /createFFmpeg\s*\(/, label: 'createFFmpeg( (removed in 0.12+; the API is new FFmpeg())' },
];

/**
 * A runtime CDN dependency is a hard failure wherever it appears: the
 * vendored copy must be used instead, so the toolchain works offline and
 * the pinned sha256 still means something.
 */
const CDN_DEPENDENCY = [
  { re: /unpkg\.com\/@ffmpeg/, label: 'unpkg.com/@ffmpeg (runtime CDN dependency)' },
  { re: /cdn\.jsdelivr\.net\/npm\/@ffmpeg/, label: 'cdn.jsdelivr.net/npm/@ffmpeg (runtime CDN dependency)' },
];

/** The one shared browser loader. A file that references it is exempt. */
const SHARED_CLIENT = 'pages/assets/ffmpeg-client.mjs';

/**
 * A CDN URL in code that also uses ffmpeg is a runtime dependency on the
 * network. Scoped to CODE: a page that links a CDN asset and merely mentions
 * FFmpeg in prose (vhs-gif-maker.html pulls gif.js from unpkg) is not an
 * ffmpeg loader.
 */
const CDN_RUNTIME = /https:\/\/unpkg\.com/;
const FFMPEG_USE = /ffmpeg/i;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function findAll(text, re) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  let m;
  while ((m = r.exec(text)) !== null) {
    out.push(m.index);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}

/**
 * The CODE view of a file: everything that could execute, with comments
 * removed. For HTML that is the contents of <script> blocks plus the markup
 * of the tags themselves (an attribute can carry a loader URL); visible text
 * between tags is prose and is left out.
 */
function codeView(abs, src) {
  if (!abs.endsWith('.html')) return stripJsComments(src);
  return htmlCode(src);
}

/**
 * The CODE + PROSE view of a file: comments removed, everything else kept.
 * Used for the incident markers, which must not hide in a comment.
 */
function codeAndProseView(abs, src) {
  return abs.endsWith('.html') ? stripHtmlComments(src) : stripJsComments(src);
}

function checkSourceLint() {
  const files = lintTargets();
  const sources = files.map(({ abs, rel }) => ({
    rel,
    code: codeView(abs, fs.readFileSync(abs, 'utf8')),
    prose: codeAndProseView(abs, fs.readFileSync(abs, 'utf8')),
  }));

  // --- incident markers: unconditional, code and prose ---------------------
  const incidentHits = [];
  for (const { rel, prose } of sources) {
    for (const { re, label } of INCIDENT_MARKERS) {
      for (const idx of findAll(prose, re)) {
        incidentHits.push(`${rel}:${lineOf(prose, idx)} — ${label}`);
      }
    }
  }
  if (incidentHits.length) {
    fail('source lint: no incident markers', incidentHits.map((h) => `    ${h}`).join('\n'));
  } else {
    pass(
      'source lint: no incident markers',
      `scanned ${files.length} file(s): no new FFmpegFFmpeg, no createFFmpeg( (code or prose)`
    );
  }

  // --- runtime CDN dependency: unconditional -------------------------------
  const cdnHits = [];
  for (const { rel, code } of sources) {
    for (const { re, label } of CDN_DEPENDENCY) {
      for (const idx of findAll(code, re)) {
        cdnHits.push(`${rel}:${lineOf(code, idx)} — ${label}`);
      }
    }
    // Any CDN URL in code that also uses ffmpeg is a runtime network
    // dependency, whatever else the file does.
    if (CDN_RUNTIME.test(code) && FFMPEG_USE.test(code)) {
      const idx = code.search(CDN_RUNTIME);
      cdnHits.push(
        `${rel}:${lineOf(code, idx)} — https://unpkg.com in code that uses ffmpeg (runtime CDN dependency)`
      );
    }
  }
  if (cdnHits.length) {
    fail('source lint: no runtime CDN dependency', cdnHits.map((h) => `    ${h}`).join('\n'));
  } else {
    pass(
      'source lint: no runtime CDN dependency',
      'no page or module loads ffmpeg from a CDN at runtime'
    );
  }

  // --- one shared loader ---------------------------------------------------
  const loaderHits = [];
  for (const { rel, code } of sources) {
    const markers = LOADER_CODE.filter(({ re }) => re.test(code));
    if (!markers.length) continue;

    // The shared client itself is the loader — it is the one place allowed
    // to touch the library directly.
    if (rel === SHARED_CLIENT) continue;

    // A file that goes through the shared client is fine.
    if (code.includes('ffmpeg-client.mjs')) continue;

    for (const { label } of markers) {
      loaderHits.push(`${rel} — ${label} without ${SHARED_CLIENT}`);
    }
  }
  if (loaderHits.length) {
    fail('source lint: one shared ffmpeg loader', loaderHits.map((h) => `    ${h}`).join('\n'));
  } else {
    pass(
      'source lint: one shared ffmpeg loader',
      `every file that loads the ffmpeg.wasm runtime goes through ${SHARED_CLIENT}`
    );
  }
}

// --------------------------------------------------- optional modules ------

async function importCleanly(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return { state: 'missing' };
  try {
    await import(pathToFileURL(abs).href);
    return { state: 'ok' };
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

async function checkOptionalModule(name, relPath) {
  const res = await importCleanly(relPath);
  if (res.state === 'missing') {
    skip(name, `${relPath} does not exist yet (optional — the server set is built separately)`);
  } else if (res.state === 'ok') {
    pass(name, `${relPath} imports cleanly`);
  } else {
    fail(name, `${relPath} failed to import: ${res.error}`);
  }
}

// ---------------------------------------------------------------- main ----

async function main() {
  checkNode();
  await checkSqlite();
  checkFfmpegBinaries();
  checkFfmpegCapabilities();
  checkVendor();
  checkVendorImportGraph();
  checkSourceLint();
  await checkOptionalModule('server API router', 'lib/api/router.mjs');
  await checkOptionalModule('credit store', 'lib/credits/store.mjs');
  await checkOptionalModule('server render executor', 'lib/render/server.mjs');

  const ok = checks.every((c) => c.status !== 'FAIL');

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  console.log('');
  console.log('🩺 Digital Twin — media toolchain preflight');
  console.log('');
  for (const c of checks) {
    console.log(`${c.status.padEnd(4)} ${c.name}`);
    for (const line of String(c.detail).split('\n')) console.log(`     ${line}`);
  }
  console.log('');
  const failed = checks.filter((c) => c.status === 'FAIL');
  const skipped = checks.filter((c) => c.status === 'SKIP');
  if (failed.length) {
    console.log(`❌ ${failed.length} check(s) FAILED — the media toolchain is not ready.`);
    console.log('');
    return 1;
  }
  console.log(
    `✅ All ${checks.length - skipped.length} check(s) passed${skipped.length ? ` (${skipped.length} skipped — optional)` : ''}.`
  );
  console.log('');
  return 0;
}

process.exit(await main());
