#!/usr/bin/env node
'use strict';
// tools/mj-style-set.js
//
// SET AN IMAGE AS A STYLE REFERENCE — press the studio's own action.
//
// THE MEASURED PATH TO THIS ACTION
//
//   On the live account (2026-11-06), the studio's per-image action
//   bar carries a button labelled EXACTLY "Style Reference (--sref)",
//   with "View full size" as its sibling. Its composer counterpart is
//   labelled plain "Style Reference" and lives in the composer's
//   control row next to the "--sref <id>" chip.
//
//   The two labels differ by the parenthetical, and that difference is
//   the whole selector: an earlier press that matched the plain label
//   hit the COMPOSER's control, so it reported "nothing happened" —
//   a false negative about the wrong control.
//
//   So this tool matches "Style Reference (--sref)" exactly.
//
// WHAT IT DOES
//
//   Opens the job, opens OUR cell (the /jobs/<id> page is the whole
//   feed with that job highlighted, so "the first image" is another
//   job's), presses the action, and reports:
//
//     * every request the press made, with its body;
//     * the studio's own answer — the new --sref id, if there is one.
//
//   It mints ONE style reference. It does not submit a generation.
//
// Usage:
//   node tools/mj-style-set.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the action ran and reported · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-set] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-set] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-set.js <jobId> [--port 9445] [--cell 0_0]');
    process.exit(2);
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

/** Open OUR cell, and report which one. */
const OPEN = `(() => {
  const JOB = ${JSON.stringify(JOB)};
  const CELL = ${JSON.stringify(CELL)};
  const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('/' + JOB + '/'));
  if (!imgs.length) return { ok: false, why: 'no image for this job on the page' };
  const exact = imgs.find(i => (i.src || '').includes('/' + CELL + '_')) || imgs[0];
  const src = exact.src;
  exact.click();
  return { ok: true, src: src, count: imgs.length };
})()`;

/**
 * Press the IMAGE's style action.
 *
 * The label is matched exactly, including the parenthetical — the
 * composer's control is labelled "Style Reference" and pressing it
 * does something else entirely.
 */
const PRESS = `(() => {
  const WANTED = 'Style Reference (--sref)';
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
    const l = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === WANTED;
  });
  if (!btns.length) {
    // Report what IS there, so a rename is visible rather than silent.
    const near = [...document.querySelectorAll('button, [role="button"]')]
      .map(b => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\\s+/g, ' '))
      .filter(l => /style|sref/i.test(l) && l.length < 80);
    return { ok: false, why: 'no button labelled "' + WANTED + '"', near: [...new Set(near)] };
  }
  const b = btns[0];
  const r = b.getBoundingClientRect();
  b.click();
  return { ok: true, count: btns.length, x: Math.round(r.left), y: Math.round(r.top) };
})()`;

/** After the press: the page's style state. */
const AFTER = `(() => {
  const out = { chips: [], ids: [], toasts: [], dialogs: 0, dialogText: '', inputs: [] };
  for (const el of document.querySelectorAll('button, [role="button"], a, [role="option"], span, div')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!t || t.length > 100) continue;
    if (/sref/i.test(t) && !out.chips.includes(t)) out.chips.push(t);
    const m = t.match(/\\b(\\d{8,12})\\b/);
    if (m && !out.ids.includes(m[1])) out.ids.push(m[1]);
  }
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [data-testid*="toast"]')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t && t.length < 300) out.toasts.push(t);
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"]')];
  out.dialogs = dialogs.length;
  if (dialogs.length) out.dialogText = (dialogs[dialogs.length - 1].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800);
  for (const el of document.querySelectorAll('input, textarea')) {
    const v = (el.value || '').trim();
    if (v) out.inputs.push({ tag: el.tagName, placeholder: el.getAttribute('placeholder') || '', value: v.slice(0, 200) });
  }
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
    const events = [];
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
        } else if (m.method && /^Network\./.test(m.method)) {
            events.push(m);
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    log('opening the job page');
    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    if (!open.ok) { warn('could not open the cell: ' + (open.why || '?')); return 3; }
    log('opened: ' + open.src);
    await new Promise(r => setTimeout(r, 2500));

    events.length = 0;
    const p = await send('Runtime.evaluate', { expression: PRESS, returnByValue: true });
    const pr = (p && p.result && p.result.value) || {};
    if (!pr.ok) {
        warn('could not press: ' + (pr.why || '?'));
        if (pr.near) log('style-ish labels on the page: ' + pr.near.join(' | '));
        return 3;
    }
    log(`pressed "Style Reference (--sref)" at ${pr.x},${pr.y}`);
    log('waiting 8s for the studio to answer …');
    await new Promise(r => setTimeout(r, 8000));

    // ---- the requests the press made -----------------------------------
    const reqs = new Map();
    for (const e of events) {
        if (e.method === 'Network.requestWillBeSent') {
            const r = e.params.request;
            reqs.set(e.params.requestId, { method: r.method, url: r.url, postData: (r.postData || ''), status: null, type: e.params.type || '' });
        } else if (e.method === 'Network.responseReceived') {
            const r = reqs.get(e.params.requestId);
            if (r) r.status = e.params.response.status;
        }
    }

    log('');
    log(`--- ${reqs.size} request(s) during the press ---`);
    for (const r of reqs.values()) {
        log(`  ${r.method} ${r.status === null ? '---' : r.status} [${r.type}] ${r.url.slice(0, 200)}`);
        if (r.postData) log(`      body: ${String(r.postData).replace(/\s+/g, ' ').slice(0, 500)}`);
    }

    // The bodies of the JSON answers — the minted id is in there.
    for (const [rid, r] of reqs) {
        if (!r.status || r.status >= 400) continue;
        if (!/json/i.test(r.url)) continue;
        try {
            const b = await send('Network.getResponseBody', { requestId: rid });
            const body = (b && b.body) || '';
            if (body) log(`      resp: ${body.replace(/\s+/g, ' ').slice(0, 700)}`);
        } catch (e) { /* body gone */ }
    }

    const a = await send('Runtime.evaluate', { expression: AFTER, returnByValue: true });
    const d = (a && a.result && a.result.value) || {};

    log('');
    log(`--- dialogs: ${d.dialogs} ---`);
    if (d.dialogText) log(d.dialogText);
    log('--- style/sref chips ---');
    for (const c of d.chips || []) log('  ' + c);
    log('--- numeric ids on the page ---');
    log('  ' + (d.ids || []).join(', '));
    log('--- toasts ---');
    for (const t of d.toasts || []) log('  ' + t);
    log('--- filled inputs ---');
    for (const i of d.inputs || []) log(`  <${i.tag}> placeholder="${i.placeholder}" value="${i.value}"`);

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
