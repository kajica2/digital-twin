#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

function log(msg) { process.stdout.write(`[serve] ${msg}\n`); }

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res, pathname) {
  send(res, 404, { 'content-type': 'text/plain' }, `404 Not Found: ${pathname}\n`);
}

const CREDITS_PER_RENDER = Number(process.env.CREDITS_PER_RENDER || 1);
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const ADMIN_KEY_SOURCE = process.env.ADMIN_KEY ? 'env' : 'default';

let apiRouterPromise = null;

/** Load and create the API router exactly once. */
function getApiRouter() {
  if (!apiRouterPromise) {
    apiRouterPromise = import('./api/router.mjs').then(({ createApiRouter }) =>
      createApiRouter({
        root: ROOT,
        dbPath: path.join(ROOT, 'data', 'credits.sqlite'),
        creditsPerRender: CREDITS_PER_RENDER,
        adminKey: ADMIN_KEY,
      })
    );
  }
  return apiRouterPromise;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch { send(res, 400, { 'content-type': 'text/plain' }, 'Bad Request\n'); return; }

  // The API is an ES module, so it is loaded with a dynamic import. The router
  // is created once and reused for every request.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      const router = await getApiRouter();
      const handled = await router.handle(req, res, new URL(req.url, 'http://localhost'));
      if (!handled) notFound(res, pathname);
    } catch (err) {
      const message = err && err.message ? err.message : 'internal error';
      send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: message }));
    }
    return;
  }

  const target = path.resolve(ROOT, '.' + pathname);
  if (!target.startsWith(ROOT + path.sep)) { send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden\n'); return; }

  let stat;
  try { stat = fs.statSync(target); }
  catch { notFound(res, pathname); return; }

  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) {
      const body = fs.readFileSync(index);
      send(res, 200, { 'content-type': MIME['.html'], 'content-length': stat.size }, body);
      return;
    }
    const entries = fs.readdirSync(target).filter(e => !e.startsWith('.')).sort();
    const rows = entries.map(e => `<li><a href="${pathname}${e}/">${e}/</a></li>`).join('\n');
    send(res, 200, { 'content-type': 'text/html' }, `<html><body><h1>${pathname}</h1><ul>${rows}</ul></body></html>`);
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(target);
  send(res, 200, { 'content-type': type, 'content-length': stat.size }, body);
});

server.listen(PORT, () => {
  log(`serving ${ROOT} on http://localhost:${PORT}`);
  log(`API base URL: http://localhost:${PORT}/api (admin key source: ${ADMIN_KEY_SOURCE})`);
  // Create the router at startup so the first request does not pay for the
  // module load, and so a broken configuration is reported immediately.
  getApiRouter().catch((err) => {
    log(`API router failed to start: ${err && err.message ? err.message : err}`);
  });
});
