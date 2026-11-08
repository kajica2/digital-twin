#!/usr/bin/env node
'use strict';
// tools/mj-style-lightbox.js
//
// THE LIGHTBOX OF ONE SPECIFIC JOB'S IMAGE — read every action.
//
// WHY THE EARLIER PROBES MISSED IT
//
//   The page at /jobs/<id> is NOT a single job — it is the whole feed
//   with that job highlighted. So "the first image on the page" is
//   some OTHER job's cell (measured: job a393d417 while probing
//   c6403638). The per-image overflow menu read was therefore a
//   DIFFERENT job's menu.
//
//   The fix is to find the image whose CDN src carries OUR job id and
//   open THAT one. And the studio's style action lives in the
//   lightbox — clicking a cell opens it — not in the card's overflow.
//
//   So this probe: finds our cell, clicks it, reads the lightbox.
//
//   It READS. It does not press any style action — minting a style
//   reference changes the account and is a separate deliberate step.
//
// Usage:
//   node tools/mj-style-lightbox.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the lightbox was read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-lightbox] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-lightbox] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-lightbox.js <jobId> [--port 9445] [--cell 0_0]');
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

/**
 * Find OUR cell and click it.
 *
 * The src carries the job id and the slot, so the match is exact:
 *   https://cdn.midjourney.com/<jobId>/0_0_640_N.webp?method=shortest
 */
const OPEN = `(() => {
  const JOB = ${JSON.stringify(JOB)};
  const CELL = ${JSON.stringify(CELL)};
  const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('/' + JOB + '/'));
  if (!imgs.length) return { ok: false, why: 'no image for this job on the page', seen: [...document.querySelectorAll('img')].length };
  const exact = imgs.find(i => (i.src || '').includes('/' + CELL + '_')) || imgs[0];
  const src = exact.src;
  exact.click();
  return { ok: true, src: src, count: imgs.length };
})()`;

/**
 * Read the open lightbox.
 *
 * The studio renders it in a portal, so it is found by its own
 * markers, not by position.
 */
const READ_LB = `(() => {
  const out = { dialogs: 0, actions: [], text: '', srefChips: [], inputs: [] };

  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="lightbox"], [data-testid*="modal"]')];
  out.dialogs = dialogs.length;
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

  // Every control inside the scope that names a style-ish action.
  const seen = new Set();
  for (const el of scope.querySelectorAll('button, [role="button"], [role="menuitem"], a')) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!label || label.length > 140) continue;
    const key = label + '|' + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    out.actions.push({ tag: el.tagName, testid: el.getAttribute('data-testid') || '', aria: el.getAttribute('aria-label') || '', text: label.slice(0, 120), visible });
  }

  // The style chips the page shows for this job.
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (/sref|style/i.test(t) && t.length < 80) {
      const key = t;
      if (out.srefChips.includes(key)) continue;
      out.srefChips.push(key);
    }
  }

  for (const el of scope.querySelectorAll('input, textarea')) {
    out.inputs.push({ tag: el.tagName, type: el.getAttribute('type') || '', placeholder: el.getAttribute('placeholder') || '', value: (el.value || '').slice(0, 120) });
  }

  out.text = (scope.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200);
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

    log('navigating to the job page');
    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    log('');
    if (!open.ok) {
        warn('could not open the cell: ' + (open.why || '?'));
        return 0;
    }
    log(`opened our cell: ${open.src}`);
    log(`(${open.count} image(s) for this job on the page)`);
    await new Promise(r => setTimeout(r, 2500));

    const lb = await send('Runtime.evaluate', { expression: READ_LB, returnByValue: true });
    const d = (lb && lb.result && lb.result.value) || {};

    log(`--- lightbox dialogs: ${d.dialogs} ---`);
    log('');
    log(`--- actions in scope (${(d.actions || []).length}) ---`);
    for (const a of d.actions || []) {
        const flag = /style|sref/i.test(a.text + ' ' + a.aria) ? '   <<<< STYLE' : '';
        log(`  [${a.visible ? 'vis' : 'hid'}] <${a.tag}${a.testid ? ' testid=' + a.testid : ''}> ${a.text || a.aria}${flag}`);
    }
    log('');
    log(`--- style/sref chips on the page (${(d.srefChips || []).length}) ---`);
    for (const c of d.srefChips || []) log(`  ${c}`);
    log('');
    log(`--- inputs (${(d.inputs || []).length}) ---`);
    for (const i of d.inputs || []) log(`  <${i.tag}${i.type ? ' type=' + i.type : ''}> placeholder="${i.placeholder}" value="${i.value}"`);
    log('');
    log('--- lightbox text ---');
    log(d.text || '(empty)');

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`probe failed: ${e.message}`); process.exit(3); });
