#!/usr/bin/env node
'use strict';
// tools/mj-style-set2.js
//
// SET AN IMAGE AS A STYLE REFERENCE — with a REAL mouse event.
//
// WHY A REAL EVENT
//
//   The first press used `element.click()`. It made ZERO requests and
//   changed nothing — not even a toast. A studio built on pointer
//   events (pointerdown/pointerup) can ignore a synthetic click, so
//   "nothing happened" was a statement about HOW the click was made,
//   not about whether the action exists.
//
//   So this tool dispatches a genuine CDP mouse event at the button's
//   own coordinates: mouseMoved, mousePressed, mouseReleased. The
//   button is located by its EXACT label, "Style Reference (--sref)",
//   which is the image's action — the composer's control is labelled
//   plain "Style Reference" and does something else.
//
//   It also dumps the button's own attributes before pressing, so a
//   disabled button is visible as such rather than as silence.
//
// Usage:
//   node tools/mj-style-set2.js <jobId> [--port 9445] [--cell 0_0]
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

function log(m) { process.stdout.write(`[mj-style-set2] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-set2] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-set2.js <jobId> [--port 9445] [--cell 0_0]');
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

/** Locate the button and report everything about it. */
const FIND = `(() => {
  const WANTED = 'Style Reference (--sref)';
  const all = [...document.querySelectorAll('button, [role="button"], a')];
  const b = all.find(x => {
    const l = (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === WANTED;
  });
  if (!b) {
    const near = [...new Set(all.map(x => (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ')).filter(l => l && /style|sref/i.test(l) && l.length < 80))];
    return { ok: false, near };
  }
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return {
    ok: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: r.width, h: r.height,
    disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
    attrs: Object.fromEntries([...b.attributes].map(a => [a.name, a.value.slice(0, 120)])),
    outer: b.outerHTML.slice(0, 500),
  };
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
    await new Promise(r => setTimeout(r, 3000));

    const f = await send('Runtime.evaluate', { expression: FIND, returnByValue: true });
    const btn = (f && f.result && f.result.value) || {};
    if (!btn.ok) {
        warn('button not found; style-ish labels on the page: ' + (btn.near || []).join(' | '));
        return 3;
    }
    log('');
    log('--- the button ---');
    log('  at ' + Math.round(btn.x) + ',' + Math.round(btn.y) + '  ' + btn.w + 'x' + btn.h);
    log('  disabled: ' + btn.disabled);
    log('  attributes: ' + JSON.stringify(btn.attrs));
    log('  html: ' + btn.outer);

    events.length = 0;
    log('');
    log('dispatching a REAL mouse event …');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none', clickCount: 0 });
    await new Promise(r => setTimeout(r, 400));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 });
    await new Promise(r => setTimeout(r, 120));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 0 });

    log('waiting 9s …');
    await new Promise(r => setTimeout(r, 9000));

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

    for (const [rid, r] of reqs) {
        if (!r.status || r.status >= 400) continue;
        if (!/json/i.test(r.url)) continue;
        try {
            const b = await send('Network.getResponseBody', { requestId: rid });
            const body = (b && b.body) || '';
            if (body) log(`      resp: ${body.replace(/\s+/g, ' ').slice(0, 700)}`);
        } catch (e) { /* body gone */ }
    }

    // What is on the page now?
    const after = await send('Runtime.evaluate', {
        expression: `(() => {
            const out = { dialogs: 0, dialogText: '', menuItems: [], chips: [], toasts: [], inputs: [] };
            const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [role="menu"]')];
            out.dialogs = dialogs.length;
            if (dialogs.length) out.dialogText = (dialogs[dialogs.length-1].innerText || '').replace(/\\s+/g,' ').trim().slice(0,700);
            for (const el of document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] li, [role="menu"] button')) {
              const t = (el.textContent||'').trim().replace(/\\s+/g,' ');
              if (t && t.length < 120 && !out.menuItems.includes(t)) out.menuItems.push(t);
            }
            for (const el of document.querySelectorAll('button, [role="button"], a, span')) {
              const t = (el.textContent||'').trim().replace(/\\s+/g,' ');
              if (t && t.length < 100 && /sref/i.test(t) && !out.chips.includes(t)) out.chips.push(t);
            }
            for (const el of document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [data-testid*="toast"]')) {
              const t = (el.textContent||'').trim().replace(/\\s+/g,' ');
              if (t && t.length < 300) out.toasts.push(t);
            }
            for (const el of document.querySelectorAll('input, textarea')) {
              const v = (el.value||'').trim();
              if (v) out.inputs.push({ tag: el.tagName, placeholder: el.getAttribute('placeholder')||'', value: v.slice(0,200) });
            }
            return out;
        })()`,
        returnByValue: true,
    });
    const d = (after && after.result && after.result.value) || {};
    log('');
    log(`--- dialogs: ${d.dialogs} ---`);
    if (d.dialogText) log(d.dialogText);
    log('--- menu items ---');
    for (const m of d.menuItems || []) log('  ' + m);
    log('--- sref chips ---');
    for (const c of d.chips || []) log('  ' + c);
    log('--- toasts ---');
    for (const t of d.toasts || []) log('  ' + t);
    log('--- filled inputs ---');
    for (const i of d.inputs || []) log(`  <${i.tag}> placeholder="${i.placeholder}" value="${i.value}"`);

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
