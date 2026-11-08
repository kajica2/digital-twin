#!/usr/bin/env node
'use strict';
// tools/mj-style-ui-probe.js
//
// WHAT DOES THE STUDIO OFFER FOR "SET AS STYLE"? — read off the page.
//
// WHY THE UI IS THE PROBE
//
//   The route probe found NO server-side style route (13 candidates
//   404; the control answered, so the probe works). The feed shows
//   every --sref this account uses is an `s.mj.run/<code>` short link,
//   and no feed item carries a style-reference field of its own.
//
//   So if the studio's UI has a "set as style" action, that action is
//   what MINTS the s.mj.run link — it is the only way the link comes
//   into existence. This tool opens the job's page and reports what
//   the UI actually offers, so the action is driven rather than
//   guessed.
//
//   It READS first and clicks nothing: a first pass that clicked a
//   menu item could mint a style reference the artist did not want.
//
// Usage:
//   node tools/mj-style-ui-probe.js <jobId> [--port 9445]
//
// Exit: 0 the page was read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-ui] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-ui] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-ui-probe.js <jobId> [--port 9445]');
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
 * The in-page read.
 *
 * Looks for anything that mentions "style" — buttons, menu items,
 * aria-labels, titles — and reports the surrounding text so the
 * action can be identified without guessing at a selector.
 */
const READ = `(() => {
  const JOB = ${JSON.stringify(JOB)};
  const out = { job: JOB, url: location.href, title: document.title, hits: [], menus: [], buttons: [] };

  // Every element that carries the word "style" in a user-visible or
  // assistive label.
  const seen = new Set();
  const els = document.querySelectorAll('button, [role="menuitem"], [role="option"], a, [aria-label], [title], [data-testid]');
  for (const el of els) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    if (!label || label.length > 120) continue;
    if (!/style|sref|reference/i.test(label)) continue;
    const key = label + '|' + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.hits.push({
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      aria: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').trim().slice(0, 120),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    });
  }

  // Every button on the page — the "..." overflow menu's own label is
  // often the only entry point to the action.
  for (const b of document.querySelectorAll('button')) {
    const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
    if (!label) continue;
    out.buttons.push({ label: label.slice(0, 80), testid: b.getAttribute('data-testid') || '' });
    if (out.buttons.length > 80) break;
  }

  // Any menu currently open.
  for (const m of document.querySelectorAll('[role="menu"], [role="listbox"], ul')) {
    const txt = (m.textContent || '').trim().replace(/\\s+/g, ' ');
    if (txt && txt.length < 600) out.menus.push({ tag: m.tagName, role: m.getAttribute('role') || '', text: txt.slice(0, 400) });
    if (out.menus.length > 12) break;
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

    const jobUrl = 'https://www.midjourney.com/jobs/' + JOB;
    log('navigating to ' + jobUrl);
    await send('Page.navigate', { url: jobUrl });
    await new Promise(r => setTimeout(r, 9000));

    const res = await send('Runtime.evaluate', {
        expression: READ,
        returnByValue: true,
    });
    const data = (res && res.result && res.result.value) || {};

    log('url   : ' + data.url);
    log('title : ' + data.title);
    log('');
    log(`--- elements mentioning style/sref/reference (${(data.hits || []).length}) ---`);
    for (const h of data.hits || []) {
        log(`  <${h.tag}${h.role ? ' role=' + h.role : ''}${h.testid ? ' testid=' + h.testid : ''}> visible=${h.visible}`);
        if (h.aria) log(`      aria : ${h.aria}`);
        if (h.text && h.text !== h.aria) log(`      text : ${h.text}`);
    }
    log('');
    log(`--- open menus (${(data.menus || []).length}) ---`);
    for (const m of data.menus || []) log(`  <${m.tag}${m.role ? ' ' + m.role : ''}> ${m.text}`);
    log('');
    log(`--- buttons on the page (${(data.buttons || []).length}) ---`);
    for (const b of data.buttons || []) log(`  "${b.label}"${b.testid ? '  testid=' + b.testid : ''}`);

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`read failed: ${e.message}`); process.exit(3); });
