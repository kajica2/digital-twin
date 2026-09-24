#!/usr/bin/env node
// lib/serve.js
//
// Sprint 0.22 — minimal static file server for the repo root.
// Replaces `python3 -m http.server` as the LaunchAgent's program.
//
// Why: macOS TCC grants filesystem access per-binary. Under launchd,
// `node` (from ~/.hermes) is allowed to read ~/Documents, while
// /usr/bin/python3 and /bin/ls are not — a python-based server
// returns 404 for every path because its chdir() into the repo is
// denied with `Operation not permitted`. Node already has the grant,
// so serving from Node keeps the same port + contract with no
// extra permission setup and no dependencies.
//
// Usage:
//   node lib/serve.js                 # 0.0.0.0:5173, repo root
//   node lib/serve.js --port 8080
//   node lib/serve.js --root /path    # alternate doc root
//
// Pure Node, no deps. Read-only: GET/HEAD only.

'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const url  = require('node:url');

const ROOT = path.resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
function flag(names, fallback) {
  for (const name of names) {
    const i = ARGV.indexOf(name);
    if (i !== -1 && ARGV[i + 1]) return ARGV[i + 1];
  }
  return fallback;
}
const PORT = parseInt(flag(['--port'], process.env.PORT || '5173'), 10);
// `--bind` is accepted as an alias for `--host` so the LaunchAgent's
// python-era arguments keep working verbatim.
const HOST = flag(['--host', '--bind'], process.env.HOST || '0.0.0.0');
const DOC_ROOT = path.resolve(flag(['--root'], ROOT));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.mid':  'audio/midi',
  '.midi': 'audio/midi',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.pdf':  'application/pdf',
  '.xml':  'application/xml; charset=utf-8',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
};

function log(msg) { process.stdout.write(`[serve] ${msg}\n`); }

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body == null) res.end();
  else res.end(body);
}

function notFound(res, pathname) {
  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' },
    `404 Not Found: ${pathname}\n`);
}

function listDir(res, dirPath, pathname) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));

  const base = pathname.endsWith('/') ? pathname : pathname + '/';
  const rows = entries.map(e => {
    const name = e.name + (e.isDirectory() ? '/' : '');
    const href = base + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
    return `<li><a href="${href}">${name}</a></li>`;
  }).join('\n');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>${pathname}</title>
<style>
  body { font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; }
  h1 { font-size: 1rem; font-weight: 600; }
  ul { list-style: none; padding: 0; }
  li { padding: 2px 0; }
  a { text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
<h1>Index of ${pathname}</h1>
<ul>
${rows}
</ul>`;
  send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, html);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain', allow: 'GET, HEAD' }, 'Method Not Allowed\n');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch {
    send(res, 400, { 'content-type': 'text/plain' }, 'Bad Request\n');
    return;
  }

  // Resolve inside DOC_ROOT; reject traversal outside it.
  const target = path.resolve(DOC_ROOT, '.' + pathname);
  if (target !== DOC_ROOT && !target.startsWith(DOC_ROOT + path.sep)) {
    send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden\n');
    return;
  }

  let stat;
  try { stat = fs.statSync(target); }
  catch { notFound(res, pathname); return; }

  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) {
      // Serve the directory index.
      stat = fs.statSync(index);
      const body = req.method === 'HEAD' ? null : fs.readFileSync(index);
      send(res, 200, {
        'content-type': MIME['.html'],
        'content-length': stat.size,
        'cache-control': 'no-cache',
      }, body);
      return;
    }
    if (req.method === 'HEAD') {
      send(res, 200, { 'content-type': MIME['.html'] });
      return;
    }
    listDir(res, target, pathname);
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // Catalogs are rebuilt by the watchers; never let a proxy or the
  // browser serve a stale one. The panel also cache-busts with ?_=...
  const cache = ext === '.json' ? 'no-store' : 'no-cache';

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cache,
  });
  if (req.method === 'HEAD') { res.end(); return; }

  const stream = fs.createReadStream(target);
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);

  res.on('close', () => { try { stream.destroy(); } catch {} });
});

server.on('error', (err) => {
  log(`FATAL: ${err.code || ''} ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`serving ${DOC_ROOT} on http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping (${sig})`);
  server.close(() => process.exit(0));
  // Don't hang on keep-alive sockets.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
