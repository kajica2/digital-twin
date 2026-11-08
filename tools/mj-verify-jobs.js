#!/usr/bin/env node
'use strict';
// tools/mj-verify-jobs.js
//
// DOES A JOB HAVE CELLS? — asked through the browser, on BOTH CDN paths.
//
// WHY BOTH PATHS
//
//   cdn.midjourney.com serves TWO shapes for the same cell:
//
//     <job>/0_0_640_N.webp?method=shortest   the PREVIEW  (1141x640)
//     <job>/0_0.webp                         the ORIGINAL (1456x816)
//
//   MEASURED 2026-11-06: the ORIGINAL path answers 403 for a job that
//   the studio loads fine, while the PREVIEW path answers 200. So a
//   check that only walks the original path calls a rendered job dead.
//
// WHY THIS EXISTS AT ALL
//
//   The softban report in `lib/mj-web.js` asks the feed before
//   declaring one — and the feed is VIRTUALIZED, so a rendered job can
//   be missing from the snapshot. MEASURED 2026-11-06 on the 30-look
//   preset pack: jobs `dd01169d` (VHS Glitch Noir) and `2bac08ae`
//   (Analog Noir) were reported "soft-banned" and both have all four
//   cells served. The REPORT was wrong; the jobs were fine.
//
//   So the truth about a job is asked of the CDN, not of a flag.
//
// Usage:
//   node tools/mj-verify-jobs.js <jobId> [<jobId> ...]
//   node tools/mj-verify-jobs.js --from-log <logfile> [--from-log <logfile>]
//
// Exit: 0 every job checked · 2 bad input · 3 the browser refused

const fs = require('node:fs');
const http = require('node:http');

const ARGV = process.argv.slice(2);
const PORT = 9444;

function log(m) { process.stdout.write(`[mj-verify] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-verify] ${m}\n`); }

/**
 * The job ids to check.
 *
 * From argv, or from a run log. The log names a job in two ways:
 * "submitted: job <uuid>" (full) and "job <8-hex> was soft-banned"
 * (short), so the shorts are matched back to the full ids.
 */
function jobIds() {
    const ids = [];
    for (let i = 0; i < ARGV.length; i++) {
        if (ARGV[i] === '--from-log') {
            const file = ARGV[i + 1];
            if (!file) continue;
            const txt = fs.readFileSync(file, 'utf8');
            const full = [...txt.matchAll(/job ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].map(m => m[1]);
            for (const f of full) if (!ids.includes(f)) ids.push(f);
            // The soft-banned shorts are resolved against the full ids
            // when both are present; when the log only has the short
            // form, the short id is still worth asking the CDN about.
            for (const s of [...txt.matchAll(/job ([0-9a-f]{8}) was soft-banned/g)].map(m => m[1])) {
                const hit = full.find(f => f.startsWith(s));
                if (hit && !ids.includes(hit)) ids.push(hit);
            }
        } else if (!ARGV[i].startsWith('--')) {
            ids.push(ARGV[i]);
        }
    }
    return [...new Set(ids)];
}

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

async function main() {
    const ids = jobIds();
    if (!ids.length) { warn('usage: mj-verify-jobs.js <jobId>... | --from-log <logfile>'); return 2; }

    const targets = await listTargets();
    const page = targets.find(t => t.type === 'page' && /midjourney\.com/.test(t.url || ''));
    if (!page) { warn('no midjourney.com tab open — open one and retry'); return 3; }

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

    const results = [];
    for (const jid of ids) {
        const expr = `(async () => {
            const id = ${JSON.stringify(jid)};
            const out = { id, preview: 0, original: 0, sizes: {} };
            for (const slot of ['0_0','0_1','0_2','0_3']) {
                const urls = [
                    'https://cdn.midjourney.com/'+id+'/'+slot+'_640_N.webp?method=shortest',
                    'https://cdn.midjourney.com/'+id+'/'+slot+'.webp',
                ];
                let pv = 0, or = 0;
                for (let k = 0; k < urls.length; k++) {
                    try {
                        const r = await fetch(urls[k]);
                        const b = await r.blob();
                        if (r.ok && b.size > 10000) { if (k === 0) pv = b.size; else or = b.size; }
                    } catch (e) {}
                }
                out.sizes[slot] = (pv ? Math.round(pv/1024)+'KB' : '-') + '/' + (or ? Math.round(or/1024)+'KB' : '-');
                if (pv) out.preview++;
                if (or) out.original++;
            }
            return out;
        })()`;
        try {
            const r = await Promise.race([
                send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
                new Promise((_, rj) => setTimeout(() => rj(new Error('evaluate timed out')), 60000)),
            ]);
            const v = r && r.result ? r.result.value : null;
            if (!v) { warn(`${jid.slice(0, 8)} — no answer`); continue; }
            results.push(v);
            const state = v.preview === 4 ? 'RENDERED' : v.preview > 0 ? 'PARTIAL' : 'NOT RENDERED';
            log(`${jid.slice(0, 8)}  preview=${v.preview}/4 original=${v.original}/4  ${state}  ${Object.values(v.sizes).join(' ')}`);
        } catch (e) {
            warn(`${jid.slice(0, 8)} — ${e.message}`);
        }
    }
    ws.close();

    const rendered = results.filter(r => r.preview === 4).length;
    const partial = results.filter(r => r.preview > 0 && r.preview < 4).length;
    const dead = results.filter(r => r.preview === 0).length;
    log(`\n${rendered} rendered · ${partial} partial · ${dead} not rendered · of ${results.length} checked`);
    return 0;
}

main().then(c => process.exit(c)).catch(e => { warn(e.message); process.exit(3); });
