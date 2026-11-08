#!/usr/bin/env node
'use strict';
// tools/mj-style-image-menu.js
//
// THE PER-IMAGE "..." MENU — where "Set as style prompt" lives.
//
// WHY THE JOB-LEVEL MENU WAS NOT ENOUGH
//
//   The job card's overflow menu (measured) carries: Copy · Report ·
//   Download image · Run batch as HD · Open in Discord. No style
//   action. The studio's per-IMAGE menu is a different button — it
//   sits next to each grid cell, not next to the job.
//
//   So this probe finds the overflow button that is NEAREST an image
//   (by DOM proximity), presses it, and reads the items.
//
//   It reads only. Minting a style reference changes the account, and
//   that is a separate deliberate step.
//
// Usage:
//   node tools/mj-style-image-menu.js <jobId> [--port 9445]
//
// Exit: 0 the menus were read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-img] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-img] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-image-menu.js <jobId> [--port 9445]');
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
 * Find the overflow button nearest an image and press it.
 *
 * Proximity is measured by walking up from each image to a common
 * ancestor and looking for a button within it — the image card's own
 * button. A global "first More on the page" is the wrong button: the
 * measured job-level menu proved that.
 */
const PRESS = `(() => {
  const img = [...document.querySelectorAll('img')].find(i => /cdn\\.midjourney\\.com/.test(i.src || ''));
  if (!img) return { ok: false, why: 'no image on the page' };

  // Walk up from the image, looking for a card that has a button.
  let node = img;
  let card = null;
  for (let up = 0; up < 8 && node; up++) {
    const btns = [...node.querySelectorAll('button, [role="button"]')].filter(b => {
      const l = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().toLowerCase();
      return l === 'more' || l === '…' || l === '...' || l === 'more options' || l === 'more actions' || l === 'options' || l === 'menu';
    });
    if (btns.length) { card = node; var target = btns[0]; break; }
    node = node.parentElement;
  }
  if (!target) {
    // Fall back: an icon-only button inside the image's own card.
    node = img;
    for (let up = 0; up < 8 && node && !target; up++) {
      const btns = [...node.querySelectorAll('button, [role="button"]')].filter(b => {
        const l = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
        return !l && b.querySelector('svg');
      });
      if (btns.length) { card = node; target = btns[0]; }
      node = node.parentElement;
    }
  }
  if (!target) return { ok: false, why: 'no overflow button near an image' };

  const label = (target.getAttribute('aria-label') || target.getAttribute('title') || target.textContent || '').trim();
  const imgSrc = img.getAttribute('src') || '';
  target.click();
  return { ok: true, label: label.slice(0, 60) || '(icon only)', img: imgSrc };
})()`;

/** Read every visible menu item on the page. */
const READ_MENU = `(() => {
  const out = [];
  const sel = '[role="menuitem"], [role="option"], [role="menu"] li, [role="menu"] button';
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!t || t.length > 140) continue;
    if (!el.offsetWidth && !el.offsetHeight && !el.getClientRects().length) continue;
    const key = t + '|' + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: el.tagName, role: el.getAttribute('role') || '', testid: el.getAttribute('data-testid') || '', text: t });
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

    const p = await send('Runtime.evaluate', { expression: PRESS, returnByValue: true });
    const pr = (p && p.result && p.result.value) || {};
    log('');
    if (!pr.ok) {
        warn('could not press an image-level menu: ' + (pr.why || '?'));
        return 0;
    }
    log(`pressed: "${pr.label}"`);
    log(`near image: ${pr.img}`);
    await new Promise(r => setTimeout(r, 1200));

    const menu = await send('Runtime.evaluate', { expression: READ_MENU, returnByValue: true });
    const items = (menu && menu.result && menu.result.value) || [];
    log('');
    log(`--- menu items (${items.length}) ---`);
    for (const it of items) {
        const flag = /style|sref/i.test(it.text) ? '   <<<< STYLE' : '';
        log(`  <${it.tag}${it.role ? ' ' + it.role : ''}${it.testid ? ' testid=' + it.testid : ''}> ${it.text}${flag}`);
    }
    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`probe failed: ${e.message}`); process.exit(3); });
