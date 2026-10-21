#!/usr/bin/env node
/**
 * install-vendor.mjs — download and PIN the ffmpeg.wasm assets used by the
 * local (browser) tool set.
 *
 * Why this exists
 * ---------------
 * The original incident: a page loaded @ffmpeg/ffmpeg from unpkg at runtime
 * and called `new FFmpegFFmpeg()` — a name that never existed in any build —
 * so every render died with "FFmpeg is not defined". Two root causes:
 *   1. a runtime CDN dependency (the network, not the repo, decides whether
 *      the page works), and
 *   2. a hand-rolled loader duplicated in every page (each page drifted).
 *
 * The fix: vendor the pinned core into the repo, record a sha256 per file in
 * vendor/ffmpeg/manifest.json, and serve it from the repo. The manifest is
 * the pin: re-running the installer re-downloads and re-validates the bytes
 * against the recorded hashes, and refuses to write a file that does not
 * match.
 *
 * The file list is DISCOVERED, not hand-written. The upstream ESM builds use
 * relative imports (index.js → classes.js → utils.js), so omitting a single
 * file breaks the module graph in the browser — that is exactly how utils.js
 * was nearly lost. unpkg serves a JSON index per directory:
 *   https://unpkg.com/<pkg>@<version>/dist/esm/?meta
 * which lists every file in that directory. We download all of them and pin
 * them. The hand-written list survives only as a fallback for when the ?meta
 * endpoint is unavailable.
 *
 * Usage
 *   node bin/install-vendor.mjs            # download + write/refresh manifest
 *   node bin/install-vendor.mjs --verify   # no network; verify files vs manifest
 *   node bin/install-vendor.mjs --offline  # like --verify, but a missing
 *                                           # manifest is a failure, not a hint
 *
 * Exit codes: 0 = ok, 1 = failure.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor', 'ffmpeg');
const MANIFEST_PATH = path.join(VENDOR_ROOT, 'manifest.json');

const VERSIONS = { ffmpeg: '0.12.10', util: '0.12.1', core: '0.12.6' };

/**
 * The upstream directories that make up the vendored tool set.
 * `prefix` is the CDN path; `dir` is where it lands under vendor/ffmpeg/.
 */
const PACKAGES = [
  {
    key: 'ffmpeg',
    pkg: '@ffmpeg/ffmpeg',
    version: VERSIONS.ffmpeg,
    prefix: '/dist/esm/',
    dir: `ffmpeg/${VERSIONS.ffmpeg}/esm`,
    fallback: ['index.js', 'worker.js', 'const.js', 'errors.js', 'classes.js', 'utils.js'],
  },
  {
    key: 'util',
    pkg: '@ffmpeg/util',
    version: VERSIONS.util,
    prefix: '/dist/esm/',
    dir: `util/${VERSIONS.util}/esm`,
    fallback: ['index.js', 'const.js', 'errors.js', 'types.js'],
  },
  {
    key: 'core',
    pkg: '@ffmpeg/core',
    version: VERSIONS.core,
    prefix: '/dist/esm/',
    dir: `core/${VERSIONS.core}/esm`,
    fallback: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
  },
];

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]; // 3 retries after the first attempt

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

async function fetchWithRetry(url, { as = 'buffer' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      process.stderr.write(
        `  … retry ${attempt}/${RETRY_DELAYS_MS.length} for ${url} in ${delay}ms\n`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': 'digital-twin-install-vendor' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (as === 'json') return await res.json();
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `failed to download ${url}: ${lastError && lastError.message ? lastError.message : lastError}`
  );
}

/**
 * Discover every file in an upstream directory.
 * Primary source: unpkg's ?meta JSON index. Fallback: the hard-coded list.
 */
async function discoverFiles(spec) {
  const base = `https://unpkg.com/${spec.pkg}@${spec.version}`;
  const metaUrl = `${base}${spec.prefix}?meta`;
  try {
    const meta = await fetchWithRetry(metaUrl, { as: 'json' });
    const files = Array.isArray(meta && meta.files) ? meta.files : [];
    const names = files
      .filter((f) => f && typeof f.path === 'string')
      .filter((f) => f.type !== 'directory' && !f.path.endsWith('/'))
      .map((f) => f.path.replace(/^\/dist\/esm\//, ''))
      .filter((name) => name && !name.includes('/'));
    if (names.length) {
      return { names, source: 'discovered', metaUrl };
    }
    process.stderr.write(
      `  ! ${metaUrl} listed no files — falling back to the built-in file list\n`
    );
  } catch (err) {
    process.stderr.write(`  ! directory discovery failed (${err.message})\n`);
    process.stderr.write(`  ! falling back to the built-in file list for ${spec.pkg}\n`);
  }
  return { names: [...spec.fallback], source: 'fallback', metaUrl };
}

async function writeAtomic(dest, buf) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dest);
}

async function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.files) {
      throw new Error('manifest has no "files" object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`vendor manifest is unreadable: ${err.message}`);
  }
}

function printTable(rows) {
  const nameW = Math.max(...rows.map((r) => r.path.length), 4);
  const bytesW = Math.max(...rows.map((r) => String(r.bytes).length), 5);
  console.log('');
  console.log(`  ${'file'.padEnd(nameW)}  ${'bytes'.padStart(bytesW)}  sha256`);
  console.log(`  ${'-'.repeat(nameW)}  ${'-'.repeat(bytesW)}  ${'-'.repeat(64)}`);
  for (const r of rows) {
    console.log(
      `  ${r.path.padEnd(nameW)}  ${String(r.bytes).padStart(bytesW)}  ${r.sha256.slice(0, 12)}`
    );
  }
  console.log('');
}

async function verify({ requireManifest }) {
  const manifest = await readManifest();
  if (!manifest) {
    console.error(
      requireManifest
        ? 'FAIL: no vendor manifest found at vendor/ffmpeg/manifest.json (offline mode requires it).'
        : 'FAIL: no vendor manifest found at vendor/ffmpeg/manifest.json. Run: node bin/install-vendor.mjs'
    );
    return 1;
  }

  const entries = Object.entries(manifest.files);
  const failures = [];
  const rows = [];

  for (const [relPath, meta] of entries) {
    const abs = path.join(VENDOR_ROOT, relPath);
    if (!existsSync(abs)) {
      failures.push(`${relPath}: missing on disk (expected ${meta.bytes} bytes)`);
      continue;
    }
    const buf = await fs.readFile(abs);
    const actual = sha256(buf);
    if (actual !== meta.sha256) {
      failures.push(
        `${relPath}: sha256 mismatch\n      expected ${meta.sha256}\n      actual   ${actual}`
      );
      continue;
    }
    rows.push({ path: relPath, bytes: buf.length, sha256: actual });
  }

  if (rows.length) printTable(rows);

  if (failures.length) {
    console.error(`FAIL: ${failures.length} vendor file(s) failed verification:`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  console.log(
    `PASS: ${entries.length} vendored file(s) match the pinned manifest (sha256 verified).`
  );
  return 0;
}

async function install() {
  const existing = await readManifest();
  const pinned = existing ? existing.files : {};
  const rows = [];
  const files = {};
  const failures = [];

  console.log(`Installing vendored ffmpeg.wasm assets into ${rel(VENDOR_ROOT)}/`);
  console.log(
    `  @ffmpeg/ffmpeg@${VERSIONS.ffmpeg}  @ffmpeg/util@${VERSIONS.util}  @ffmpeg/core@${VERSIONS.core}`
  );

  for (const spec of PACKAGES) {
    const { names, source, metaUrl } = await discoverFiles(spec);
    console.log(`  ${spec.pkg}@${spec.version}: ${names.length} file(s) (${source})`);

    for (const name of names) {
      const url = `https://unpkg.com/${spec.pkg}@${spec.version}${spec.prefix}${name}`;
      const relPath = `${spec.dir}/${name}`;
      const abs = path.join(VENDOR_ROOT, relPath);

      let buf;
      try {
        buf = await fetchWithRetry(url);
      } catch (err) {
        failures.push(`${relPath}: ${err.message}`);
        continue;
      }

      const digest = sha256(buf);
      const prior = pinned[relPath];
      if (prior && prior.sha256 !== digest) {
        // Hard error: the pinned bytes changed. Refuse to write the corrupted file.
        failures.push(
          `${relPath}: sha256 mismatch against the pinned manifest\n` +
            `      url      ${url}\n` +
            `      expected ${prior.sha256}\n` +
            `      actual   ${digest}\n` +
            `      the file was NOT written`
        );
        continue;
      }

      await writeAtomic(abs, buf);
      files[relPath] = { url, sha256: digest, bytes: buf.length };
      rows.push({ path: relPath, bytes: buf.length, sha256: digest });
    }
  }

  if (failures.length) {
    console.error(`FAIL: ${failures.length} asset(s) failed to install:`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    versions: { ...VERSIONS },
    files,
  };
  await writeAtomic(
    MANIFEST_PATH,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  );

  printTable(rows);
  console.log(
    existing
      ? `PASS: installed ${rows.length} file(s); all matched the pinned sha256 values.`
      : `PASS: installed ${rows.length} file(s) and wrote the pin manifest (${rel(MANIFEST_PATH)}).`
  );
  return 0;
}

function usage() {
  console.log(
    [
      'Usage: node bin/install-vendor.mjs [--verify | --offline]',
      '',
      '  (no flag)  download the pinned ffmpeg.wasm assets and write/refresh the pin manifest',
      '  --verify   verify the vendored files against the manifest (no network access)',
      '  --offline  same as --verify, but a missing manifest is a hard failure',
    ].join('\n')
  );
}

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg !== '--verify' && arg !== '--offline') {
      console.error(`Unknown argument: ${arg}`);
      usage();
      return 2;
    }
  }

  if (args.includes('--offline')) return verify({ requireManifest: true });
  if (args.includes('--verify')) return verify({ requireManifest: false });
  return install();
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  console.error(`FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
