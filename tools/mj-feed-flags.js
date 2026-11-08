#!/usr/bin/env node
'use strict';
// tools/mj-feed-flags.js
//
// WHAT FLAGS DOES THIS ACCOUNT ACTUALLY USE? — measured across the feed.
//
// WHY MEASURE THE ACCOUNT'S VOCABULARY
//
//   A set's flags are an artistic decision, and the repo's rule is
//   that the ARTIST'S OWN flags win and each is resolved exactly
//   once. But the template job the artist pointed at carries
//   `--profile ub2pnlv` — and the repo's own docs record that the
//   account's personalization is applied to EVERY generation by
//   default. So is that code a deliberate grade on this one job, or
//   the account's default that happens to ride along?
//
//   The distinction matters: hardcoding a default into a registry
//   pins an accident. So the feed is the answer key — it shows which
//   codes ride on MANY jobs (the account's default) and which ride on
//   ONE (a deliberate choice).
//
//   It reports the distribution of every flag the account uses.
//
// Usage:
//   node tools/mj-feed-flags.js [--port 9445] [--page-size 200]
//
// Exit: 0 the feed was read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9445'));
const PAGE_SIZE = Number(argVal('--page-size', '200'));

function log(m) { process.stdout.write(`[mj-feed-flags] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-feed-flags] ${m}\n`); }

function listTargets() {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 6000 }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

const READ = (pageSize) => `(async () => {
  const fromPerf = (performance.getEntriesByType('resource') || [])
    .map(e => e.name || '')
    .filter(n => n.includes('/api/imagine'))
    .map(n => (n.match(/user_id=([0-9a-f-]{36})/) || [])[1])
    .filter(Boolean);
  let uid = fromPerf[0];
  if (!uid) {
    for (const k of Object.keys(localStorage)) {
      const m = k.match(/([0-9a-f-]{36})/);
      if (m) { uid = m[1]; break; }
    }
  }
  if (!uid) return { error: 'no user_id' };
  const r = await fetch('/api/imagine?user_id=' + encodeURIComponent(uid) + '&page_size=' + ${JSON.stringify(String(pageSize))}, {
    headers: { 'X-CSRF-Protection': '1' },
    credentials: 'include',
  });
  if (!r.ok) return { error: 'feed status ' + r.status };
  const j = await r.json();
  const items = Array.isArray(j) ? j : (j.items || j.data || []);
  return {
    user_id: uid,
    count: items.length,
    items: items.map(it => ({ id: it.id, cmd: it.full_command || '', job_type: it.job_type || '' })),
  };
})()`;

/** Every occurrence of a flag, with its values. */
function flagValues(cmd, flag) {
    const out = [];
    const re = new RegExp('(?:^|\\s)' + flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?:[ =]+)([^\\s]+)', 'g');
    let m;
    while ((m = re.exec(cmd)) !== null) out.push(m[1]);
    return out;
}

async function main() {
    const targets = await listTargets();
    const page = targets.find(t => t.type === 'page' && /midjourney\.com/.test(t.url || ''));
    if (!page) {
        warn('no midjourney.com tab open on :' + PORT);
        return 3;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((rs, rj) => {
        const i = ++id;
        pending.set(i, { rs, rj });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await new Promise((rs, rj) => {
        if (ws.readyState === 1) return rs();
        ws.addEventListener('open', () => rs(), { once: true });
        ws.addEventListener('error', () => rj(new Error('websocket error')), { once: true });
    });
    ws.addEventListener('message', ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) p.rj(new Error(m.error.message));
            else p.rs(m.result);
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');

    const res = await send('Runtime.evaluate', {
        expression: READ(PAGE_SIZE),
        awaitPromise: true,
        returnByValue: true,
    });
    const data = (res && res.result && res.result.value) || {};
    if (data.error) { warn('feed read failed: ' + data.error); return 2; }

    log(`user_id ${data.user_id} · ${data.count} job(s)`);
    log('');

    const FLAGS = ['--ar', '--sref', '--cref', '--edit', '--profile', '--style', '--raw', '--s', '--stylize', '--chaos', '--weird', '--v', '--hd', '--no'];
    const counts = new Map();
    const jobTypes = new Map();

    for (const it of data.items || []) {
        jobTypes.set(it.job_type, (jobTypes.get(it.job_type) || 0) + 1);
        for (const f of FLAGS) {
            for (const v of flagValues(it.cmd, f)) {
                const key = f + ' ' + v;
                if (!counts.has(key)) counts.set(key, new Set());
                counts.get(key).add(it.id);
            }
        }
    }

    log('--- flag values, by how many jobs carry them ---');
    const rows = [...counts.entries()].sort((a, b) => b[1].size - a[1].size);
    for (const [key, ids] of rows) {
        const one = ids.size === 1 ? '   <<< ON ONE JOB ONLY' : '';
        log(`  ${String(ids.size).padStart(3)} job(s)   ${key}${one}`);
    }

    log('');
    log('--- job types ---');
    for (const [t, n] of [...jobTypes.entries()].sort((a, b) => b[1] - a[1])) {
        log(`  ${String(n).padStart(4)}  ${t}`);
    }

    // Which jobs carry each one-off flag? That is the interesting set.
    log('');
    log('--- the flags that ride on ONE job only (deliberate, not defaults) ---');
    for (const [key, ids] of rows) {
        if (ids.size !== 1) continue;
        const job = data.items.find(it => ids.has(it.id));
        if (!job) continue;
        log(`  ${key}`);
        log(`      job ${job.id}`);
        log(`      cmd: ${job.cmd.slice(0, 300)}`);
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
