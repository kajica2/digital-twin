#!/usr/bin/env node
'use strict';
// tools/mj-style-action.js
//
// PRESS "Style Reference" ON ONE CELL — and report what the studio does.
//
// WHY THIS IS THE ACTION
//
//   Measured on the live account, on the artist named job:
//
//     * no server route creates a style reference (13 candidates 404,
//       the control answers);
//     * every --sref the account uses is an `s.mj.run/<code>` link;
//     * the /jobs/<id> page is the WHOLE feed with that job
//       highlighted, so "the first image" is another job's cell;
//     * clicking OUR job's cell opens the studio's action bar, and
//       that bar carries a button labelled "Style Reference" — next
//       to "Edit Reference (--edit)".
//
//   So "set as style prompt" is this button. This tool presses it and
//   reports what it produced: the style's id, its URL, and whether
//   the account now lists it.
//
//   It presses ONE button on ONE cell. It does not submit a
//   generation.
//
// Usage:
//   node tools/mj-style-action.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the action ran · 2 bad input · 3 the browser refused · 4 the action produced nothing

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-action] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-action] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-action.js <jobId> [--port 9445] [--cell 0_0]');
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

/** Open OUR cell. */
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
 * Press the "Style Reference" button.
 *
 * The label is matched EXACTLY on "Style Reference" — not /style/i,
 * because the page also carries "Style Creator" links and a
 * "Select personalizations" control, and clicking the wrong one
 * would be a false action.
 */
const PRESS = `(() => {
  const wanted = 'Style Reference';
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
    const l = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === wanted;
  });
  if (!btns.length) return { ok: false, why: 'no button labelled "' + wanted + '"' };
  const b = btns[0];
  const visible = !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length);
  b.click();
  return { ok: true, visible: visible, count: btns.length };
})()`;

/** Whatever appeared after the press: a toast, a dialog, a new chip. */
const AFTER = `(() => {
  const out = { text: '', chips: [], dialogs: [], inputs: [], srefUrls: [], pageText: '' };
  out.pageText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"]')];
  out.dialogs = dialogs.length;
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
  out.text = (scope.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 900);
  for (const el of document.querySelectorAll('button, [role="button"], a, [role="option"]')) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t && /sref|style/i.test(t) && t.length < 120) {
      if (!out.chips.includes(t)) out.chips.push(t);
    }
  }
  for (const el of scope.querySelectorAll('input, textarea')) {
    out.inputs.push({ tag: el.tagName, type: el.getAttribute('type') || '', placeholder: el.getAttribute('placeholder') || '', value: (el.value || '').slice(0, 200) });
  }
  // Any s.mj.run link that appeared anywhere on the page.
  for (const a of document.querySelectorAll('a[href*="s.mj.run"], a[href*="style"]')) {
    const h = a.getAttribute('href') || '';
    if (h && !out.srefUrls.includes(h)) out.srefUrls.push(h);
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

    log('opening the job page');
    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    if (!open.ok) { warn('could not open the cell: ' + (open.why || '?')); return 3; }
    log('opened: ' + open.src);
    await new Promise(r => setTimeout(r, 2500));

    const p = await send('Runtime.evaluate', { expression: PRESS, returnByValue: true });
    const pr = (p && p.result && p.result.value) || {};
    log('');
    if (!pr.ok) { warn('could not press the button: ' + (pr.why || '?')); return 4; }
    log(`pressed "Style Reference" (visible=${pr.visible}, ${pr.count} match(es))`);
    await new Promise(r => setTimeout(r, 4000));

    const a = await send('Runtime.evaluate', { expression: AFTER, returnByValue: true });
    const d = (a && a.result && a.result.value) || {};

    log(`--- dialogs after the press: ${d.dialogs} ---`);
    log('');
    log('--- style/sref chips now on the page ---');
    for (const c of d.chips || []) log(`  ${c}`);
    log('');
    log('--- style-ish hrefs ---');
    for (const h of d.srefUrls || []) log(`  ${h}`);
    log('');
    log('--- inputs ---');
    for (const i of d.inputs || []) log(`  <${i.tag}${i.type ? ' type=' + i.type : ''}> placeholder="${i.placeholder}" value="${i.value}"`);
    log('');
    log('--- dialog/panel text ---');
    log(d.text || '(empty)');
    log('');
    log('--- page text (first 1200) ---');
    log((d.pageText || '').slice(0, 1200));

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
