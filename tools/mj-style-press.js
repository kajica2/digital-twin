#!/usr/bin/env node
'use strict';
// tools/mj-style-press.js
//
// PRESS "STYLE REFERENCE" — before/after, with EVERY request reported.
//
// WHY THE FIRST PRESS LOOKED LIKE A NO-OP
//
//   The earlier press reported "no dialog, no new chip" — but it
//   FILTERED the request log down to the "interesting" ones, so two
//   unfiltered requests were never shown, and it read the FIRST
//   textarea on the page rather than the composer's.
//
//   This version reports EVERY request, reads the composer's own
//   value before and after, and distinguishes the composer control
//   from the image's action button by recording whether the button
//   exists BEFORE the cell is opened.
//
//   The decisive observation is the BEFORE/AFTER pair:
//
//     the button exists already  -> it is a COMPOSER control
//     the button appears on open -> it is the IMAGE's action
//
// Usage:
//   node tools/mj-style-press.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the press was observed · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-press] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-press] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-press.js <jobId> [--port 9445] [--cell 0_0]');
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

/** Every composer-like textarea on the page, with its value. */
const COMPOSERS = `(() => {
  const out = [];
  for (const ta of document.querySelectorAll('textarea')) {
    out.push({
      value: (ta.value || '').slice(0, 300),
      placeholder: ta.getAttribute('placeholder') || '',
      visible: !!(ta.offsetWidth || ta.offsetHeight || ta.getClientRects().length),
      testid: ta.getAttribute('data-testid') || '',
    });
  }
  return out;
})()`;

/** Does a button labelled exactly "Style Reference" exist? */
const HAS_BTN = `(() => {
  const b = [...document.querySelectorAll('button, [role="button"]')].find(x => {
    const l = (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === 'Style Reference';
  });
  if (!b) return { exists: false };
  const r = b.getBoundingClientRect();
  return {
    exists: true,
    visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
    x: Math.round(r.left), y: Math.round(r.top),
    testid: b.getAttribute('data-testid') || '',
    parentText: (b.parentElement && b.parentElement.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
  };
})()`;

const OPEN = `(() => {
  const JOB = ${JSON.stringify(JOB)};
  const CELL = ${JSON.stringify(CELL)};
  const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('/' + JOB + '/'));
  if (!imgs.length) return { ok: false, why: 'no image for this job on the page' };
  const exact = imgs.find(i => (i.src || '').includes('/' + CELL + '_')) || imgs[0];
  const src = exact.src;
  exact.click();
  return { ok: true, src: src };
})()`;

const PRESS = `(() => {
  const b = [...document.querySelectorAll('button, [role="button"]')].find(x => {
    const l = (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === 'Style Reference';
  });
  if (!b) return { ok: false, why: 'not found' };
  b.click();
  return { ok: true };
})()`;

/** The chips and any sref-looking ids on the page. */
const CHIPS = `(() => {
  const out = { chips: [], ids: [], toasts: [] };
  for (const el of document.querySelectorAll('button, [role="button"], a, [role="option"]')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!t || t.length > 100) continue;
    if (/sref|style/i.test(t) && !out.chips.includes(t)) out.chips.push(t);
    const m = t.match(/\\b(\\d{8,12})\\b/);
    if (m && !out.ids.includes(m[1])) out.ids.push(m[1]);
  }
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [data-testid*="toast"]')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t && t.length < 300) out.toasts.push(t);
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

    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    // ---- BEFORE opening the cell --------------------------------------
    const beforeBtn = await send('Runtime.evaluate', { expression: HAS_BTN, returnByValue: true });
    const bb = (beforeBtn && beforeBtn.result && beforeBtn.result.value) || {};
    const beforeC = await send('Runtime.evaluate', { expression: COMPOSERS, returnByValue: true });
    const bc = (beforeC && beforeC.result && beforeC.result.value) || [];

    log('--- BEFORE opening the cell ---');
    log('  "Style Reference" button exists: ' + bb.exists + (bb.exists ? `  visible=${bb.visible} at ${bb.x},${bb.y}` : ''));
    if (bb.exists) log('  its parent text: ' + bb.parentText);
    for (const c of bc) log(`  textarea [${c.visible ? 'vis' : 'hid'}] placeholder="${c.placeholder}" value="${c.value}"`);

    // ---- open the cell -------------------------------------------------
    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    if (!open.ok) { warn('could not open the cell: ' + (open.why || '?')); return 3; }
    log('');
    log('opened: ' + open.src);
    await new Promise(r => setTimeout(r, 2500));

    const afterBtn = await send('Runtime.evaluate', { expression: HAS_BTN, returnByValue: true });
    const ab = (afterBtn && afterBtn.result && afterBtn.result.value) || {};
    log('  "Style Reference" now: exists=' + ab.exists + (ab.exists ? ` visible=${ab.visible} at ${ab.x},${ab.y}` : ''));
    log('');
    log(ab.exists && !bb.exists
        ? '  => the button APPEARS on open: it is the IMAGE\'s action'
        : '  => the button was ALREADY there: it is a COMPOSER control');

    // ---- press it, and watch everything --------------------------------
    events.length = 0;
    const p = await send('Runtime.evaluate', { expression: PRESS, returnByValue: true });
    const pr = (p && p.result && p.result.value) || {};
    if (!pr.ok) { warn('could not press: ' + (pr.why || '?')); return 3; }
    log('');
    log('pressed. waiting 6s …');
    await new Promise(r => setTimeout(r, 6000));

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
    log(`--- EVERY request during the press (${reqs.size}) ---`);
    for (const r of reqs.values()) {
        log(`  ${r.method} ${r.status === null ? '---' : r.status} [${r.type}] ${r.url.slice(0, 170)}`);
        if (r.postData) log(`      body: ${String(r.postData).replace(/\s+/g, ' ').slice(0, 400)}`);
    }

    const afterC = await send('Runtime.evaluate', { expression: COMPOSERS, returnByValue: true });
    const ac = (afterC && afterC.result && afterC.result.value) || [];
    log('');
    log('--- AFTER: the composers ---');
    for (const c of ac) log(`  textarea [${c.visible ? 'vis' : 'hid'}] placeholder="${c.placeholder}" value="${c.value}"`);

    const chips = await send('Runtime.evaluate', { expression: CHIPS, returnByValue: true });
    const ch = (chips && chips.result && chips.result.value) || {};
    log('');
    log('--- style/sref chips ---');
    for (const c of ch.chips || []) log('  ' + c);
    log('--- numeric ids ---');
    log('  ' + (ch.ids || []).join(', '));
    log('--- toasts ---');
    for (const t of ch.toasts || []) log('  ' + t);

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
