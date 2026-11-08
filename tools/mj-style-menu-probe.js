#!/usr/bin/env node
'use strict';
// tools/mj-style-menu-probe.js
//
// FIND THE "SET AS STYLE PROMPT" ACTION — read the studio's own menus.
//
// WHY A MENU PROBE
//
//   The route probe found no server route for a style reference, and
//   the page scan found a "Style Creator" LINK plus a `--sref
//   178272779` chip. The action the artist named ("set as style
//   prompt") is a per-image OVERFLOW action in the studio, so the
//   label lives inside a menu that only exists after the menu button
//   is pressed.
//
//   This probe PRESSES the menu and READS what appears. It does not
//   press the action itself — minting a style reference changes the
//   account, and that is a separate, deliberate step.
//
//   It also reports the "Style Creator" link's href, because that is
//   the feature's own front door and its URL says what it does.
//
// Usage:
//   node tools/mj-style-menu-probe.js <jobId> [--port 9445]
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

function log(m) { process.stdout.write(`[mj-style-menu] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-menu] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-menu-probe.js <jobId> [--port 9445]');
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

/** The "Style Creator" link's href, and every image on the page. */
const BEFORE = `(() => {
  const out = { styleCreator: [], images: [], menus: [] };
  for (const a of document.querySelectorAll('a')) {
    const t = (a.textContent || '').trim();
    if (/style creator/i.test(t)) out.styleCreator.push({ text: t, href: a.getAttribute('href') || '' });
  }
  const imgs = [...document.querySelectorAll('img')].filter(i => /cdn\\.midjourney\\.com/.test(i.src || ''));
  for (const im of imgs) out.images.push({ src: im.src, alt: im.alt || '', w: im.naturalWidth, h: im.naturalHeight });
  return out;
})()`;

/**
 * The menu READ.
 *
 * Runs after the overflow button is pressed. It reports every visible
 * menu item on the page — the studio renders its overflow menus in a
 * portal, so the items are not children of the button.
 */
const READ_MENU = `(() => {
  const out = { items: [], visible: [] };
  const sel = '[role="menuitem"], [role="option"], [role="menu"] li, [role="menu"] button, [data-testid*="menu"] *';
  for (const el of document.querySelectorAll(sel)) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!t || t.length > 120) continue;
    if (!el.offsetWidth && !el.offsetHeight && !el.getClientRects().length) continue;
    const key = t + '|' + el.tagName + '|' + (el.getAttribute('role') || '');
    if (out.visible.includes(key)) continue;
    out.visible.push(key);
    out.items.push({
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      text: t.slice(0, 120),
    });
  }
  return out;
})()`;

/**
 * Click the FIRST overflow button ("More" / "…" / a bare dots
 * button) on the page. The studio puts one on each image card.
 *
 * It reports what it clicked so the probe is auditable — a blind
 * click on the wrong element would be a false finding.
 */
const CLICK_OVERFLOW = `(() => {
  const cands = [...document.querySelectorAll('button, [role="button"]')];
  const score = (b) => {
    const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
    const l = label.toLowerCase();
    if (l === 'more' || l === '…' || l === '...' || l === 'more options' || l === 'more actions') return 100;
    if (l === 'options' || l === 'menu') return 50;
    if (!label && b.querySelector('svg')) return 30;   // an icon-only button
    return 0;
  };
  const scored = cands.map(b => ({ b, s: score(b) })).filter(x => x.s > 0);
  scored.sort((a, z) => z.s - a.s);
  if (!scored.length) return { clicked: false, why: 'no overflow-looking button found' };
  const el = scored[0].b;
  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  el.click();
  return { clicked: true, label: label.slice(0, 60), score: scored[0].s, candidates: scored.length };
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

    const before = (await send('Runtime.evaluate', { expression: BEFORE, returnByValue: true }));
    const b = (before && before.result && before.result.value) || {};
    log('');
    log('--- "Style Creator" link ---');
    for (const s of b.styleCreator || []) log(`  "${s.text}" -> ${s.href}`);
    log('');
    log(`--- images on the page (${(b.images || []).length}) ---`);
    for (const im of (b.images || []).slice(0, 8)) {
        log(`  ${im.w}x${im.h}  ${im.src.slice(0, 120)}`);
    }

    // Press the overflow button and read what appears.
    const clicked = await send('Runtime.evaluate', { expression: CLICK_OVERFLOW, returnByValue: true });
    const c = (clicked && clicked.result && clicked.result.value) || {};
    log('');
    if (!c.clicked) {
        warn('no overflow button found: ' + (c.why || '?'));
        return 0;
    }
    log(`pressed the overflow button: "${c.label}" (score ${c.score}, ${c.candidates} candidate(s))`);
    await new Promise(r => setTimeout(r, 1200));

    const menu = await send('Runtime.evaluate', { expression: READ_MENU, returnByValue: true });
    const m = (menu && menu.result && menu.result.value) || {};
    log('');
    log(`--- menu items (${(m.items || []).length}) ---`);
    for (const it of m.items || []) {
        const flag = /style|sref/i.test(it.text) ? '  <<< STYLE' : '';
        log(`  <${it.tag}${it.role ? ' ' + it.role : ''}${it.testid ? ' testid=' + it.testid : ''}> ${it.text}${flag}`);
    }
    if (!(m.items || []).length) {
        warn('the menu press opened nothing readable');
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`probe failed: ${e.message}`); process.exit(3); });
