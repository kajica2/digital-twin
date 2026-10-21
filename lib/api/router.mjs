// HTTP API router — the SERVER set's public surface.
//
// ---------------------------------------------------------------------------
// HOW TO EXERCISE THIS ROUTER WITHOUT THE STATIC SERVER
// ---------------------------------------------------------------------------
// createApiRouter({ root, dbPath, creditsPerRender, adminKey }) → router
//
// router.handle(req, res, url) → Promise<boolean>
//   * req   : a node:http IncomingMessage (needs .method and .headers)
//   * res   : a node:http ServerResponse (needs .writeHead(), .end(), .write())
//   * url   : a WHATWG URL instance (or a string path — a URL is built for you)
//   * returns true when the request was handled, false when the caller should
//     fall through to the static file handler.
//
// Example (no server needed):
//
//   import { createApiRouter } from './lib/api/router.mjs';
//   const router = createApiRouter({ root: process.cwd(), dbPath: ':memory:',
//                                    creditsPerRender: 1, adminKey: 'k' });
//   const res = mockResponse();               // see mockResponse() below
//   const handled = await router.handle(
//     { method: 'GET', headers: {} },
//     res,
//     new URL('http://localhost/api/health')
//   );
//   console.log(res.statusCode, res.body);
//
// mockResponse() — a tiny stand-in for ServerResponse:
//   function mockResponse() {
//     return {
//       statusCode: 200, headers: {}, body: '',
//       writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
//       write(chunk) { this.body += chunk; },
//       end(chunk) { if (chunk) this.body += chunk; },
//       on() {}, once() {}, emit() {},
//     };
//   }
//
// The router never throws for client mistakes: it answers with a JSON body and
// a 4xx status. Server faults answer 500 with { error: '...' }.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { openStore, newToken } from '../credits/store.mjs';
import { buildRenderPlan, buildThumbnailPlan, buildClipPlan } from '../render/plan.mjs';
import {
  ffmpegPath,
  ffmpegVersion,
  renderImagesToMp4,
  renderThumbnail,
  renderClip,
} from '../render/server.mjs';

const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;      // 25 MB decoded per image
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;     // 200 MB decoded in total
const JOB_TTL_MS = 24 * 60 * 60 * 1000;        // delete job dirs older than 24h

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

/** Read and JSON-parse a request body, with a size guard. */
function readJsonBody(req, limitBytes = MAX_TOTAL_BYTES * 2) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(reject, Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return finish(resolve, {});
      try {
        finish(resolve, JSON.parse(raw));
      } catch {
        finish(reject, Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

function bearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Create the API router.
 * @param {{root?: string, dbPath?: string, creditsPerRender?: number, adminKey?: string}} [opts]
 */
export function createApiRouter(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const rawDbPath = opts.dbPath || path.join(root, 'data', 'credits.sqlite');
  const dbPath = rawDbPath === ':memory:' ? ':memory:' : path.resolve(rawDbPath);
  const creditsPerRender = Number.isFinite(Number(opts.creditsPerRender))
    ? Number(opts.creditsPerRender)
    : 1;
  const adminKey = String(opts.adminKey ?? 'dev-admin-key');
  const jobsDir = path.join(root, 'data', 'jobs');

  const store = openStore({ dbPath });
  fs.mkdirSync(jobsDir, { recursive: true });
  cleanupOldJobs(jobsDir);

  // In-process render queue: one job at a time.
  const queue = [];
  const inFlight = new Map(); // jobId -> job (queued or running)
  let running = false;

  async function cleanupOldJobs(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  function pump() {
    if (running || queue.length === 0) return;
    running = true;
    const job = queue.shift();
    runJob(job)
      .catch(() => { /* runJob never rejects; belt and braces */ })
      .finally(() => {
        running = false;
        pump();
      });
  }

  async function runJob(job) {
    const { jobId, userId, params, payload, cost } = job;
    store.updateJob(jobId, { status: 'running' });
    const workDir = path.join(jobsDir, jobId);
    await fsp.mkdir(workDir, { recursive: true });
    try {
      const onProgress = (progress) => {
        job.progress = Math.max(0, Math.min(1, progress));
      };
      let result;
      if (params.kind === 'thumbnail') {
        result = await renderThumbnail({
          image: payload.image,
          width: params.width,
          height: params.height,
          quality: params.quality,
          workDir,
          timeoutMs: params.timeoutMs,
          outputName: 'output.jpg',
          onProgress,
        });
      } else if (params.kind === 'clip') {
        result = await renderClip({
          video: payload.video,
          startSec: params.startSec,
          endSec: params.endSec,
          container: params.container,
          workDir,
          timeoutMs: params.timeoutMs,
          outputName: `output.${params.container}`,
          onProgress,
        });
      } else {
        result = await renderImagesToMp4({
          images: payload.images,
          fps: params.fps,
          duration: params.duration,
          kenBurns: params.kenBurns,
          width: params.width,
          height: params.height,
          workDir,
          timeoutMs: params.timeoutMs,
          outputName: `output.${params.container}`,
          onProgress,
        });
      }
      job.progress = 1;
      store.updateJob(jobId, {
        status: 'done',
        outputPath: result.outputPath,
        error: null,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      store.updateJob(jobId, { status: 'failed', error: message });
      // Failed renders must not cost the user credits.
      try {
        store.refund(userId, cost, 'refund:' + jobId);
      } catch {
        // refund is idempotent; ignore bookkeeping failures
      }
    } finally {
      inFlight.delete(jobId);
    }
  }

  /** Resolve the admin key from the request header. */
  function isAdmin(req) {
    const header = req.headers && (req.headers['x-admin-key'] || req.headers['X-Admin-Key']);
    if (!header) return false;
    return String(header) === adminKey;
  }

  // The files the browser set needs at runtime. Their presence is what
  // "installed" means — the manifest only adds the hash pin.
  const REQUIRED_VENDOR_FILES = [
    'ffmpeg/0.12.10/esm/index.js',
    'core/0.12.6/esm/ffmpeg-core.js',
    'core/0.12.6/esm/ffmpeg-core.wasm',
    'util/0.12.1/esm/index.js',
  ];

  let vendorCache = null;

  function findManifest(vendorRoot) {
    const candidates = [
      path.join(vendorRoot, 'manifest.json'),
      path.join(root, 'vendor', 'manifest.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  function vendorStatus() {
    if (vendorCache) return vendorCache;
    const vendorRoot = path.join(root, 'vendor', 'ffmpeg');
    const manifestPath = findManifest(vendorRoot);
    let installed = REQUIRED_VENDOR_FILES.every((rel) =>
      fs.existsSync(path.join(vendorRoot, rel))
    );
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
    // When the manifest pins files by hash, they must all be present and
    // match. The manifest may list them as an array or as a path → meta map.
    const entries = [];
    if (Array.isArray(manifest)) {
      for (const item of manifest) {
        entries.push(typeof item === 'string' ? { path: item } : item);
      }
    } else if (manifest && Array.isArray(manifest.files)) {
      for (const item of manifest.files) {
        entries.push(typeof item === 'string' ? { path: item } : item);
      }
    } else if (manifest && manifest.files && typeof manifest.files === 'object') {
      for (const [rel, meta] of Object.entries(manifest.files)) {
        entries.push({ path: rel, ...(meta || {}) });
      }
    }
    if (entries.length > 0) {
      installed =
        installed &&
        entries.every((entry) => {
          const rel = entry && entry.path;
          const expected = entry && (entry.sha256 || entry.hash || null);
          if (!rel) return false;
          const abs = path.join(vendorRoot, rel);
          if (!fs.existsSync(abs)) return false;
          if (!expected) return true;
          try {
            const actual = crypto
              .createHash('sha256')
              .update(fs.readFileSync(abs))
              .digest('hex');
            return actual === expected;
          } catch {
            return false;
          }
        });
    }
    vendorCache = { installed, manifestPath };
    return vendorCache;
  }

  async function handleHealth(res) {
    let version = null;
    let binPath = null;
    try {
      version = ffmpegVersion();
      binPath = ffmpegPath();
    } catch {
      version = null;
    }
    sendJson(res, 200, {
      ok: true,
      ffmpeg: { version, path: binPath },
      credits: { perRender: creditsPerRender, dbPath },
      vendor: vendorStatus(),
    });
  }

  function jobView(job, progress) {
    return {
      id: job.id,
      status: job.status,
      kind: (job.params && job.params.kind) || job.kind || 'video',
      progress: job.status === 'done' ? 1 : Number(progress || 0),
      error: job.error,
      outputUrl: job.status === 'done' ? `/api/jobs/${job.id}/output` : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /** An error that maps to an HTTP status. */
  function httpError(status, message) {
    return Object.assign(new Error(message), { statusCode: status });
  }

  /** Content type for a rendered output, derived from its extension. */
  function outputContentType(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.webm') return 'video/webm';
    return 'video/mp4';
  }

  /** Decode one base64 upload into { name, buffer }, enforcing the size caps. */
  function decodeUpload(value, label) {
    if (!value || typeof value.dataBase64 !== 'string' || !value.dataBase64) {
      throw httpError(400, `${label} is missing dataBase64`);
    }
    const buffer = Buffer.from(value.dataBase64, 'base64');
    if (buffer.length === 0) {
      throw httpError(400, `${label} decoded to zero bytes`);
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw httpError(400, `${label} is ${buffer.length} bytes (max ${MAX_IMAGE_BYTES})`);
    }
    return {
      name: typeof value.name === 'string' && value.name ? value.name : `${label}.bin`,
      buffer,
    };
  }

  /**
   * Create a job, charge the credits and put it on the render queue.
   * Shared by every render endpoint so the metering rules cannot drift apart.
   */
  function enqueueRenderJob(res, token, { kind, params, payload }) {
    const { userId } = store.userForToken(token);
    const cost = creditsPerRender;
    const jobId = 'job_' + crypto.randomBytes(10).toString('hex');
    try {
      store.createJob({ id: jobId, userId, params });
    } catch (err) {
      sendError(res, 500, `could not create job: ${err.message}`);
      return true;
    }
    let balance;
    try {
      balance = store.charge(userId, cost, 'job:' + jobId);
    } catch (err) {
      if (err.code === 'insufficient_credits') {
        store.updateJob(jobId, { status: 'failed', error: 'insufficient_credits' });
        sendJson(res, 402, { error: 'insufficient_credits', balance: store.balance(userId) });
        return true;
      }
      sendError(res, 500, `could not charge credits: ${err.message}`);
      return true;
    }

    const job = { jobId, userId, kind, params, payload, cost, progress: 0 };
    queue.push(job);
    inFlight.set(jobId, job);
    pump();

    sendJson(res, 202, {
      jobId,
      status: 'queued',
      kind,
      creditsCharged: cost,
      balance,
    });
    return true;
  }

  async function handle(req, res, url) {
    const parsed = url instanceof URL ? url : new URL(String(url), 'http://localhost');
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    if (!pathname.startsWith('/api')) return false;

    // CORS preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-admin-key',
        'access-control-max-age': '600',
      });
      res.end();
      return true;
    }

    try {
      // ---- health -------------------------------------------------------
      if (pathname === '/api/health' && method === 'GET') {
        await handleHealth(res);
        return true;
      }

      // ---- credits ------------------------------------------------------
      if (pathname === '/api/credits/pricing' && method === 'GET') {
        sendJson(res, 200, {
          creditsPerRender,
          currencies: [{ code: 'credit', amount: creditsPerRender }],
        });
        return true;
      }

      if (pathname === '/api/credits' && method === 'GET') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const { userId } = store.userForToken(token);
        sendJson(res, 200, { userId, balance: store.balance(userId) });
        return true;
      }

      if (pathname === '/api/credits/grant' && method === 'POST') {
        if (!isAdmin(req)) {
          sendError(res, 401, 'missing or invalid admin key');
          return true;
        }
        const body = await readJsonBody(req);
        const credits = Number(body.credits);
        if (!Number.isInteger(credits) || credits <= 0) {
          sendError(res, 400, 'credits must be a positive integer');
          return true;
        }
        let token = typeof body.token === 'string' ? body.token.trim() : '';
        let generatedToken = null;
        if (!token) {
          token = newToken();
          generatedToken = token;
        }
        const { userId, created } = store.userForToken(token);
        const balance = store.grant(userId, credits, body.reason || 'admin grant');
        const payload = { userId, balance };
        // The raw token is only echoed when the server generated it.
        if (generatedToken) payload.token = generatedToken;
        else payload.token = body.token;
        payload.created = created;
        sendJson(res, 200, payload);
        return true;
      }

      // ---- render -------------------------------------------------------
      if (pathname === '/api/render/images-to-mov' && method === 'POST') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const body = await readJsonBody(req);
        const images = body.images;
        if (!Array.isArray(images) || images.length === 0) {
          sendError(res, 400, 'images must be a non-empty array');
          return true;
        }
        if (images.length > MAX_IMAGES) {
          sendError(res, 400, `too many images: ${images.length} (max ${MAX_IMAGES})`);
          return true;
        }
        const decoded = [];
        let total = 0;
        for (let i = 0; i < images.length; i += 1) {
          const upload = decodeUpload(images[i], `image #${i}`);
          total += upload.buffer.length;
          if (total > MAX_TOTAL_BYTES) {
            sendError(res, 400, `total image size exceeds ${MAX_TOTAL_BYTES} bytes`);
            return true;
          }
          decoded.push({
            name: typeof images[i]?.name === 'string' && images[i].name ? images[i].name : `image-${i}.png`,
            buffer: upload.buffer,
          });
        }

        const params = {
          kind: 'video',
          fps: body.fps === undefined ? 30 : Number(body.fps),
          duration: body.duration === undefined ? 3 : Number(body.duration),
          kenBurns: body.kenBurns === undefined ? 'zoom-in' : String(body.kenBurns),
          width: body.width === undefined ? 1080 : Number(body.width),
          height: body.height === undefined ? 1080 : Number(body.height),
          // The output URL is fixed at /api/jobs/<id>/output, so the
          // container is fixed too.
          container: 'mp4',
          timeoutMs: 10 * 60 * 1000,
          imageCount: decoded.length,
        };

        // Validate through the plan module — its errors map to 400.
        try {
          buildRenderPlan({
            inputNames: decoded.map((_, i) => `img-${i}.png`),
            width: params.width,
            height: params.height,
            fps: params.fps,
            duration: params.duration,
            kenBurns: params.kenBurns,
            container: params.container,
          });
        } catch (err) {
          sendError(res, 400, err.message);
          return true;
        }

        return enqueueRenderJob(res, token, { kind: 'video', params, payload: { images: decoded } });
      }

      // ---- render: thumbnail -------------------------------------------
      if (pathname === '/api/render/thumbnail' && method === 'POST') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const body = await readJsonBody(req);
        const image = decodeUpload(body.image, 'image');
        const params = {
          kind: 'thumbnail',
          width: body.width === undefined ? 1080 : Number(body.width),
          height: body.height === undefined ? 1080 : Number(body.height),
          quality: body.quality === undefined ? 2 : Number(body.quality),
          timeoutMs: 5 * 60 * 1000,
        };
        try {
          buildThumbnailPlan({
            inputName: 'image.png',
            width: params.width,
            height: params.height,
            quality: params.quality,
          });
        } catch (err) {
          sendError(res, 400, err.message);
          return true;
        }
        return enqueueRenderJob(res, token, { kind: 'thumbnail', params, payload: { image } });
      }

      // ---- render: clip -------------------------------------------------
      if (pathname === '/api/render/clip' && method === 'POST') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const body = await readJsonBody(req);
        const video = decodeUpload(body.video, 'video');
        const params = {
          kind: 'clip',
          startSec: Number(body.startSec),
          endSec: Number(body.endSec),
          container: 'mp4',
          timeoutMs: 10 * 60 * 1000,
        };
        try {
          buildClipPlan({
            inputName: 'clip.mp4',
            startSec: params.startSec,
            endSec: params.endSec,
            container: params.container,
          });
        } catch (err) {
          sendError(res, 400, err.message);
          return true;
        }
        return enqueueRenderJob(res, token, { kind: 'clip', params, payload: { video } });
      }

      // ---- jobs ---------------------------------------------------------
      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && method === 'GET') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const { userId } = store.userForToken(token);
        const job = store.getJob(jobMatch[1]);
        if (!job) {
          sendError(res, 404, 'job not found');
          return true;
        }
        if (job.userId !== userId) {
          sendError(res, 403, 'not your job');
          return true;
        }
        const pending = inFlight.get(job.id);
        const progress = pending ? pending.progress : job.status === 'done' ? 1 : 0;
        sendJson(res, 200, jobView(job, progress));
        return true;
      }

      const outputMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/output(\.[a-z0-9]+)?$/);
      if (outputMatch && method === 'GET') {
        const token = bearerToken(req);
        if (!token) {
          sendError(res, 401, 'missing bearer token');
          return true;
        }
        const { userId } = store.userForToken(token);
        const job = store.getJob(outputMatch[1]);
        if (!job) {
          sendError(res, 404, 'job not found');
          return true;
        }
        if (job.userId !== userId) {
          sendError(res, 403, 'not your job');
          return true;
        }
        if (job.status !== 'done' || !job.outputPath) {
          sendError(res, 404, 'job output is not ready');
          return true;
        }
        let stat;
        try {
          stat = fs.statSync(job.outputPath);
        } catch {
          sendError(res, 404, 'job output file is missing');
          return true;
        }
        res.writeHead(200, {
          'content-type': outputContentType(job.outputPath),
          'content-length': stat.size,
          'access-control-allow-origin': '*',
        });
        // Written chunk by chunk (not via pipe) so the router also works with
        // a plain mock response object in tests.
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(job.outputPath);
          stream.on('data', (chunk) => {
            res.write(chunk);
            if (typeof res.pause === 'function' && typeof res.once === 'function') {
              if (res.writableNeedDrain) {
                stream.pause();
                res.once('drain', () => stream.resume());
              }
            }
          });
          stream.on('error', reject);
          stream.on('end', resolve);
        });
        res.end();
        return true;
      }

      sendError(res, 404, `unknown API route: ${method} ${pathname}`);
      return true;
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 500;
      sendError(res, status, err && err.message ? err.message : 'internal error');
      return true;
    }
  }

  return {
    handle,
    store,
    root,
    dbPath,
    creditsPerRender,
    adminKey,
    jobsDir,
    /** Exposed for tests/cleanup. */
    close() {
      store.close();
    },
  };
}
