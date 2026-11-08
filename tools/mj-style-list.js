#!/usr/bin/env node
'use strict';
// tools/mj-style-list.js
//
// THE ACCOUNT'S OWN STYLE REFERENCES — read from /api/explore-styles-likes.
//
// WHY THIS ROUTE
//
//   Measured 2026-11-06 on the live account, by watching the Style
//   Creator page load (a complete search, not a guess of route
//   names — the earlier thirteen-candidate sweep had all 404'd):
//
//     GET /api/explore-styles-likes
//
//   It answers with entries shaped like:
//
//     { "id": "0_2030310574",
//       "formatted_sref": "2030310574",
//       "liked_by_user": true,
//       "isStyleJob": true,
//       "type": "style",
//       "width": 896, "height": 1344 }
//
//   So a style reference on this account is a NUMERIC id — the same
//   number the studio shows on its `--sref 178272779` chip — and the
//   flag that consumes it is `--sref <id>`, NOT a URL.
//
//   That is the finding that changes the pipeline: the repo's
//   `--sref` handling assumed a URL (it uploads to uguu.se and passes
//   a public image URL). The account's own style references are ids.
//
// WHAT THIS TOOL REPORTS
//
//   Every style the account has, with its id, its image, and whether
//   it is the account's own (liked_by_user) or the community's.
//
//   It also cross-references the id against the artist's own jobs:
//   the feed showed one job carrying `--sref 178272779` — so if that
//   id is in this list, the artist's job is USING a style reference
//   that already exists.
//
// Usage:
//   node tools/mj-style-list.js [--port 9445] [--job <jobId>]
//
// Exit: 0 the list was read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9445'));
const JOB = argVal('--job', null);

function log(m) { process.stdout.write(`[mj-style-list] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-list] ${m}\n`); }

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

/** Read the styles list AND the artist's own job commands in one call. */
const READ = (jobId) => `(async () => {
  const out = { styles: [], job: null, styleImages: [] };

  // ---- the style references ------------------------------------------
  try {
    const r = await fetch('/api/explore-styles-likes', {
      headers: { 'X-CSRF-Protection': '1' },
      credentials: 'include',
    });
    if (r.ok) {
      const j = await r.json();
      const items = Array.isArray(j) ? j : (j.items || j.data || []);
      out.styles = items.map(s => ({
        id: s.id,
        sref: s.formatted_sref,
        liked: !!s.liked_by_user,
        isStyleJob: !!s.isStyleJob,
        type: s.type || '',
        w: s.width || 0,
        h: s.height || 0,
        job_type: s.job_type || '',
        display: s.display_name || '',
        username: s.username_v2 || '',
        itemCount: (s.items || []).length,
      }));
    }
  } catch (e) { out.stylesError = String(e && e.message || e); }

  // ---- the style images the page renders ------------------------------
  for (const el of document.querySelectorAll('img')) {
    const src = el.getAttribute('src') || '';
    if (/style/i.test(src) || /sref/i.test(src)) out.styleImages.push(src.slice(0, 160));
    if (out.styleImages.length > 10) break;
  }

  ${jobId ? `
  // ---- the artist's own job -------------------------------------------
  try {
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
    if (uid) {
      const r = await fetch('/api/imagine?user_id=' + encodeURIComponent(uid) + '&page_size=200', {
        headers: { 'X-CSRF-Protection': '1' },
        credentials: 'include',
      });
      if (r.ok) {
        const j = await r.json();
        const items = Array.isArray(j) ? j : (j.items || j.data || []);
        const hit = items.find(i => (i.id || '') === ${JSON.stringify(jobId)});
        if (hit) out.job = { id: hit.id, cmd: hit.full_command, job_type: hit.job_type };
      }
    }
  } catch (e) { out.jobError = String(e && e.message || e); }` : ''}

  return out;
})()`;

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
        expression: READ(JOB),
        awaitPromise: true,
        returnByValue: true,
    });
    const d = (res && res.result && res.result.value) || {};

    if (d.stylesError) warn('styles read failed: ' + d.stylesError);
    const styles = d.styles || [];
    log(`style references: ${styles.length}`);
    log('');
    for (const s of styles) {
        const mine = s.liked ? 'MINE' : '    ';
        log(`  ${mine} sref ${String(s.sref).padEnd(12)} id=${String(s.id).padEnd(16)} ${s.w}x${s.h} ${s.job_type} ${s.display ? '(' + s.display + ')' : ''}`);
    }

    if (d.job) {
        log('');
        log(`--- job ${d.job.id} (${d.job.job_type}) ---`);
        log('  ' + d.job.cmd);
        const m = d.job.cmd.match(/--sref\s+(\S+)/);
        if (m) {
            log('');
            log(`  the job's --sref is: ${m[1]}`);
            const known = styles.find(s => String(s.sref) === m[1] || String(s.id) === m[1]);
            log(known
                ? `  -> MATCHES a style this account already has (id ${known.id}, liked=${known.liked})`
                : '  -> NOT in the account\'s style list');
        } else {
            log('  the job carries NO --sref');
        }
    }
    if (d.jobError) warn('job read failed: ' + d.jobError);

    if ((d.styleImages || []).length) {
        log('');
        log('--- style-ish images on the page ---');
        for (const i of d.styleImages) log('  ' + i);
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
