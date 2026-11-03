'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('configured admin grants work and job outputs retain owner authorization', async () => {
  const { createApiRouter } = await import('./api/router.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-api-security-'));
  const router = createApiRouter({ root, dbPath: ':memory:', adminKey: 'test-only-admin' });
  async function request(url, token, body) {
    const { Readable } = require('node:stream');
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { authorization: `Bearer ${token}`, 'x-admin-key': token };
    const chunks = [];
    const res = { writeHead(status) { this.status = status; },
      write(b) { chunks.push(Buffer.from(b)); }, end(b) { if (b) this.write(b); } };
    await router.handle(req, res, new URL(url, 'http://localhost'));
    return { status: res.status, body: Buffer.concat(chunks).toString() };
  }
  try {
    assert.equal((await request('/api/credits/grant', 'wrong', { credits: 2 })).status, 401);
    const grant = await request('/api/credits/grant', 'test-only-admin', { credits: 2 });
    assert.equal(grant.status, 200);
    const owner = JSON.parse(grant.body);
    assert.equal(owner.balance, 2);
    const output = path.join(root, 'output.mp4');
    fs.writeFileSync(output, 'OWNER OUTPUT');
    router.store.createJob({ id: 'job_test', userId: owner.userId, params: {} });
    router.store.updateJob('job_test', { status: 'done', outputPath: output });
    assert.equal((await request('/api/jobs/job_test/output', 'another-user')).status, 403);
    const ownOutput = await request('/api/jobs/job_test/output', owner.token);
    assert.equal(ownOutput.status, 200);
    assert.equal(ownOutput.body, 'OWNER OUTPUT');
  } finally {
    router.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real HTTP server protects private files and keeps public pages working', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-security-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-outside-'));
  let child;
  try {
    for (const dir of ['pages', 'assets', 'data/jobs/job_test', 'data/songs', '.git', 'logs']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const file of ['.env', '.git/config', 'logs/private.log',
      'data/jobs/job_test/output.mp4', 'assets/test-cookies.txt', 'assets/private.pem']) {
      fs.writeFileSync(path.join(root, file), 'PRIVATE');
    }
    const { DatabaseSync } = require('node:sqlite');
    new DatabaseSync(path.join(root, 'data/credits.sqlite')).close();
    fs.writeFileSync(path.join(root, 'pages/index.html'), 'PUBLIC');
    fs.writeFileSync(path.join(root, 'data/songs/catalog.json'), '{}');
    fs.writeFileSync(path.join(outside, 'secret.html'), 'PRIVATE');
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'pages/escape.html'));
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'pages/alias.html'));
    fs.mkdirSync(path.join(root, 'pages/nested'));
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'pages/nested/index.html'));
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const env = { ...process.env };
    delete env.HOST;
    delete env.ADMIN_KEY;
    child = spawn(process.execPath, [path.join(__dirname, 'serve.js'), '--port', String(port), '--root', root], { env });
    let logs = '';
    child.stdout.on('data', b => { logs += b; });
    child.stderr.on('data', b => { logs += b; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/pages/index.html'); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, logs);
    assert.match(logs, /http:\/\/127\.0\.0\.1:/);
    for (const file of ['/.env', '/%2egit/config', '/logs/private.log', '/data/credits.sqlite',
      '/data/jobs/job_test/output.mp4', '/assets/test-cookies.txt', '/assets/private.pem', '/pages/escape.html',
      '/pages/alias.html', '/pages/nested/']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(base + file, { method });
        assert.equal(res.status, 403, `${method} ${file}`);
      }
    }
    assert.equal((await fetch(base + '/assets/')).status, 404, 'no directory listing');
    assert.equal(await (await fetch(base + '/pages/')).text(), 'PUBLIC');
    assert.equal((await fetch(base + '/data/songs/catalog.json')).status, 200);
    const range = await fetch(base + '/pages/index.html', { headers: { range: 'bytes=0-2' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'PUB');
    const grant = await fetch(base + '/api/credits/grant', {
      method: 'POST', headers: { 'x-admin-key': 'dev-admin-key', 'content-type': 'application/json' },
      body: JSON.stringify({ credits: 1 }),
    });
    assert.equal(grant.status, 401, 'no implicit development admin credential');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('every configured cookie jar is checked, including the five JSON configs', () => {
  const source = fs.readFileSync(path.join(__dirname, 'secrets-guard.test.js'), 'utf8');
  const start = source.indexOf('function defaultCookiePaths()');
  const end = source.indexOf('\n/**', start);
  for (const unsafe of ['ig', 'suno', 'mj', 'x', 'youtube']) {
    const results = [];
    vm.runInNewContext(source.slice(start, end) + '\ndefaultCookiePaths();', {
      REPO: '/fixture', path, process: { env: { HOME: '/home/test' } },
      fs: { readFileSync: file => JSON.stringify({ cookiesFile:
        file === path.join('/fixture', 'lib', unsafe + '-config.json') ? '/fixture/private.jar' : '/outside/safe.jar' }) },
      require: () => ({ DEFAULT_COOKIE_FILE: '/outside/safe.jar',
        defaultCookiePath: () => '/outside/safe.jar', web: { cookiesFile: '/outside/safe.jar' } }),
      check: (...args) => results.push(args),
    });
    assert.equal(results[0][1], false, unsafe + ' config must fail');
    assert.match(results[0][2], new RegExp(unsafe + '-config.json'));
  }
});
