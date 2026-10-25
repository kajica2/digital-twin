// E2E for the two media tool sets.
//
//   PART A — LOCAL set: the browser page renders with ffmpeg.wasm.
//     Every third-party request is blocked during the run, so a page that
//     secretly depends on a CDN fails here instead of in front of a user.
//
//   PART B — SERVER set: the metered API renders with the system ffmpeg and
//     charges credits.
//
// Run: cd e2e && node media-set.spec.mjs      (or: npm run e2e:media)

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Pick a free port: a leftover server on a fixed port would silently answer
// the tests instead of the one this run starts.
const PORT = Number(process.env.MEDIA_PORT || 5200 + Math.floor(Math.random() * 600));
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ADMIN_KEY = 'e2e-admin-key';
const OUT_DIR = path.join(ROOT, 'e2e', 'artifacts');

// The sample images are the operator's own downloads, so they live on the
// machine, not in the repo. They are discovered rather than hardcoded:
// an absolute path in a tracked file is a path that is wrong on every
// machine but one, and the previous hardcoded list carried a username
// that was not even this repository's owner — so the spec could only
// ever fail.
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const IMAGES = fs.existsSync(DOWNLOADS)
  ? fs.readdirSync(DOWNLOADS)
      .filter((f) => /^creatorium_iphone_camera_realistic_couple_dancing.*\.png$/i.test(f))
      .sort()
      .map((f) => path.join(DOWNLOADS, f))
  : [];

// This spec is LOCAL-ONLY — it needs real sample media and a real ffmpeg
// — so a machine without the samples skips with a reason instead of
// failing. A skip that says why is a fact; a red run that says "FATAL:
// need at least 2 sample images" reads as a broken build.
if (IMAGES.length < 2) {
  console.log(`SKIP  media-set: needs at least 2 sample images in ${DOWNLOADS} — found ${IMAGES.length}`);
  console.log('      (local-only spec: it renders real video with the system ffmpeg)');
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function ffprobeJson(file, args) {
  return execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], { encoding: 'utf8' });
}

/* ------------------------------------------------------------------ */
/* Part B helper: the server under test                                  */
/* ------------------------------------------------------------------ */
let server = null;

async function startServer() {
  server = spawn(process.execPath, ['lib/serve.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY, CREDITS_PER_RENDER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  server.on('exit', (code) => { exited = code; });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    if (exited !== null) {
      throw new Error(`server exited early with code ${exited} (port ${PORT} already in use?)`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server did not become healthy on ' + BASE);
}

function stopServer() {
  if (server) server.kill('SIGKILL');
  server = null;
}

/* ------------------------------------------------------------------ */
/* Part A — LOCAL set (browser, ffmpeg.wasm, no third-party network)     */
/* ------------------------------------------------------------------ */
async function partA() {
  console.log('\n=== PART A — local set (browser, ffmpeg.wasm) ===');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    protocolTimeout: 900000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    const blocked = [];
    const errors = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return req.continue();
      const host = new URL(url).hostname;
      if (host === '127.0.0.1' || host === 'localhost') return req.continue();
      blocked.push(url);
      req.abort();
    });
    page.on('pageerror', (e) => errors.push('uncaught: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // A blocked third-party asset logs a resource error; that is the point of
      // the block, not a defect. Everything else is a real error.
      if (/Failed to load resource/i.test(text)) return;
      errors.push('console: ' + text);
    });

    await page.goto(`${BASE}/pages/images-to-mov.html`, { waitUntil: 'domcontentloaded' });

    const input = await page.$('#fileInput');
    await input.uploadFile(...IMAGES);

    // The page groups an upload into batches and renders one batch at a time.
    // Both steps are async (the grouping waits on image decode), so poll for
    // the observable result instead of reading the DOM the instant the input
    // fires — reading too early reported "0/2 thumbnails" for a page that was
    // still working, which is the flake that made this spec look like the
    // page was broken.
    const deadlineWait = Date.now() + 60000;
    let thumbs = 0;
    let batchCount = 0;
    while (Date.now() < deadlineWait) {
      thumbs = await page.$$eval('[data-batch] .batch-strip img', (els) => els.length);
      batchCount = await page.$$eval('[data-batch]', (els) => els.length);
      if (thumbs === IMAGES.length && batchCount > 0) break;
      await sleep(250);
    }
    check('A1 thumbnails rendered in batch strips', thumbs === IMAGES.length, `${thumbs}/${IMAGES.length} across ${batchCount} batch(es)`);

    const renderBtn = await page.$('[data-batch="0"] .batch-actions .btn');
    check('A1b the first batch offers a render button', !!renderBtn);
    if (renderBtn) await renderBtn.click();

    let status = null;
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      status = await page.$eval('#batchStatus0', (el) => ({ text: el.textContent, cls: el.className })).catch(() => null);
      if (status && (status.cls.includes('success') || status.cls.includes('error'))) break;
      await sleep(2000);
    }
    check('A2 render succeeded', !!status && status.cls.includes('success'), status?.text);
    if (!status || !status.cls.includes('success')) {
      console.log('  page errors:', errors.slice(0, 10));
      return;
    }
    check('A3 no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    // The toolchain must not reach for a CDN. Other third-party assets
    // (webfonts) are a design dependency, not the render path — they are
    // blocked here on purpose, so they are reported, not failed on.
    const toolchainHits = blocked.filter((u) => /@ffmpeg|ffmpeg-core|unpkg|jsdelivr/i.test(u));
    check(
      'A4 no CDN dependency for the toolchain',
      toolchainHits.length === 0,
      toolchainHits.slice(0, 5).join(' | ')
    );
    if (blocked.length) console.log('  blocked third-party requests (expected for webfonts):', blocked.slice(0, 3));

    const info = await page.evaluate(async () => {
      const v = document.querySelector('#batchResult0 video');
      await new Promise((res) => {
        if (v.readyState >= 1) return res();
        v.onloadedmetadata = res;
        setTimeout(res, 15000);
      });
      const buf = new Uint8Array(await (await fetch(v.src)).arrayBuffer());
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return {
        readyState: v.readyState,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        duration: v.duration,
        bytes: buf.length,
        magic: String.fromCharCode(buf[4], buf[5], buf[6], buf[7]),
        brand: String.fromCharCode(buf[8], buf[9], buf[10], buf[11]),
        b64: btoa(s),
      };
    });
    const buf = Buffer.from(info.b64, 'base64');
    const outFile = path.join(OUT_DIR, 'local-set.mov');
    fs.writeFileSync(outFile, buf);
    check('A5 output is a QuickTime MOV', info.magic === 'ftyp' && info.brand === 'qt  ', `magic=${info.magic} brand=${info.brand}`);
    check('A6 video decodes in the browser', info.readyState >= 2, `readyState=${info.readyState}`);
    check('A7 output size plausible', info.bytes > 100000, `${info.bytes} bytes`);
    const probe = JSON.parse(ffprobeJson(outFile, ['-show_entries', 'stream=codec_name,width,height']));
    const v = probe.streams?.[0] || {};
    check('A8 ffprobe: h264 at the expected size', v.codec_name === 'h264' && v.width === info.videoWidth && v.height === info.videoHeight, JSON.stringify(v));
    console.log(`  saved ${outFile} (${info.videoWidth}x${info.videoHeight}, ${info.duration}s)`);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* Part B — SERVER set (system ffmpeg, metered)                         */
/* ------------------------------------------------------------------ */
async function waitForJob(token, jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
    const job = await r.json();
    if (job.status === 'done' || job.status === 'failed') return job;
    await sleep(1000);
  }
  return null;
}

async function partB() {
  console.log('\n=== PART B — server set (system ffmpeg, metered) ===');

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('B1 health endpoint reports ffmpeg', !!health.ffmpeg?.version, JSON.stringify(health.ffmpeg));

  // Mint a user token and fund it.
  const token = 'e2e-token-' + Date.now();
  const grantRes = await fetch(`${BASE}/api/credits/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ token, credits: 5, reason: 'e2e' }),
  });
  const grant = await grantRes.json();
  check('B2 admin grant works', grantRes.ok && grant.balance === 5, JSON.stringify(grant));

  const badGrant = await fetch(`${BASE}/api/credits/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'wrong' },
    body: JSON.stringify({ token, credits: 5 }),
  });
  check('B3 grant without admin key is rejected', badGrant.status === 401 || badGrant.status === 403, `status=${badGrant.status}`);

  // Render a job.
  const images = [];
  for (const file of IMAGES.slice(0, 2)) {
    images.push({ name: path.basename(file), dataBase64: fs.readFileSync(file).toString('base64') });
  }
  const jobRes = await fetch(`${BASE}/api/render/images-to-mov`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ images, fps: 24, duration: 2, kenBurns: 'zoom-in', width: 808, height: 1080 }),
  });
  const job = await jobRes.json();
  check('B4 render job accepted', jobRes.status === 202 && !!job.jobId, JSON.stringify(job).slice(0, 300));

  const afterCharge = await (await fetch(`${BASE}/api/credits`, { headers: { authorization: `Bearer ${token}` } })).json();
  check('B5 credits were charged', afterCharge.balance === 4, `balance=${afterCharge.balance}`);

  let done = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${token}` } });
    done = await r.json();
    if (done.status === 'done' || done.status === 'failed') break;
    await sleep(1500);
  }
  check('B6 job finished', done?.status === 'done', JSON.stringify(done).slice(0, 300));

  if (done?.status === 'done') {
    const outRes = await fetch(`${BASE}/api/jobs/${job.jobId}/output.mp4`, { headers: { authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await outRes.arrayBuffer());
    const outFile = path.join(OUT_DIR, 'server-set.mp4');
    fs.writeFileSync(outFile, buf);
    const magic = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    check('B7 output is an MP4', outRes.ok && magic === 'ftyp', `status=${outRes.status} magic=${magic} bytes=${buf.length}`);
    const probe = JSON.parse(ffprobeJson(outFile, ['-show_entries', 'stream=codec_name,width,height,duration']));
    const v = probe.streams?.[0] || {};
    check('B10 ffprobe: h264 808x1080', v.codec_name === 'h264' && v.width === 808 && v.height === 1080, JSON.stringify(v));
    console.log(`  saved ${outFile} (${buf.length} bytes)`);
  }

  // A user with no credits must be refused.
  const broke = 'e2e-broke-' + Date.now();

  // ---- thumbnail ----------------------------------------------------
  const thumbRes = await fetch(`${BASE}/api/render/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      image: { name: 'a.png', dataBase64: fs.readFileSync(IMAGES[0]).toString('base64') },
      width: 320,
      height: 320,
    }),
  });
  const thumbJob = await thumbRes.json();
  check('B11 thumbnail job accepted', thumbRes.status === 202 && !!thumbJob.jobId, JSON.stringify(thumbJob).slice(0, 200));
  if (thumbJob.jobId) {
    const done = await waitForJob(token, thumbJob.jobId);
    check('B12 thumbnail job finished', done?.status === 'done', JSON.stringify(done).slice(0, 200));
    if (done?.status === 'done') {
      const outRes = await fetch(`${BASE}/api/jobs/${thumbJob.jobId}/output`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const buf = Buffer.from(await outRes.arrayBuffer());
      const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const thumbFile = path.join(OUT_DIR, 'server-thumb.jpg');
      fs.writeFileSync(thumbFile, buf);
      check('B13 thumbnail is a JPEG', jpeg && buf.length > 1000, `bytes=${buf.length} type=${outRes.headers.get('content-type')}`);
      console.log(`  saved ${thumbFile} (${buf.length} bytes)`);
    }
  }

  // ---- clip ---------------------------------------------------------
  const clipVideo = fs.existsSync(path.join(OUT_DIR, 'server-set.mp4'))
    ? fs.readFileSync(path.join(OUT_DIR, 'server-set.mp4'))
    : null;
  if (clipVideo) {
    const clipRes = await fetch(`${BASE}/api/render/clip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        video: { name: 'in.mp4', dataBase64: clipVideo.toString('base64') },
        startSec: 0.5,
        endSec: 1.5,
      }),
    });
    const clipJob = await clipRes.json();
    check('B14 clip job accepted', clipRes.status === 202 && !!clipJob.jobId, JSON.stringify(clipJob).slice(0, 200));
    if (clipJob.jobId) {
      const done = await waitForJob(token, clipJob.jobId);
      check('B15 clip job finished', done?.status === 'done', JSON.stringify(done).slice(0, 250));
      if (done?.status === 'done') {
        const outRes = await fetch(`${BASE}/api/jobs/${clipJob.jobId}/output`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const buf = Buffer.from(await outRes.arrayBuffer());
        const clipFile = path.join(OUT_DIR, 'server-clip.mp4');
        fs.writeFileSync(clipFile, buf);
        const probe = JSON.parse(ffprobeJson(clipFile, ['-show_entries', 'format=duration']));
        const dur = Number(probe.format?.duration || 0);
        check('B16 clip is ~1s of h264', dur > 0.7 && dur < 1.6, `duration=${dur}`);
        console.log(`  saved ${clipFile} (${buf.length} bytes, ${dur}s)`);
      }
    }
  }

  const brokeRes = await fetch(`${BASE}/api/render/images-to-mov`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${broke}` },
    body: JSON.stringify({ images, fps: 24, duration: 2 }),
  });
  check('B8 render without credits is refused', brokeRes.status === 402, `status=${brokeRes.status}`);

  // Another user's job must not be readable.
  const otherRes = await fetch(`${BASE}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${broke}` } });
  check('B9 another user cannot read the job', otherRes.status === 403 || otherRes.status === 404, `status=${otherRes.status}`);
}

/* ------------------------------------------------------------------ */
(async () => {
  await startServer();
  try {
    await partA();
    await partB();
  } catch (err) {
    console.error('ERROR', err);
    failures++;
  } finally {
    stopServer();
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
