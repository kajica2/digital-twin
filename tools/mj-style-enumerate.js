#!/usr/bin/env node
'use strict';
// tools/mj-style-enumerate.js
//
// EVERY "STYLE REFERENCE" CONTROL, with its ancestor chain — and a
// screenshot of the page so the layout can be SEEN, not inferred.
//
// WHY THE ANCESTOR CHAIN
//
//   Two controls on the page share the label "Style Reference":
//   one belongs to the COMPOSER (it opens the style picker and its
//   parent text carries "--sref 178272779"), and one belongs to the
//   IMAGE's action bar (next to "Edit Reference (--edit)"). The
//   earlier press took the FIRST match, so it pressed the composer's
//   control and reported "nothing happened" — a false negative about
//   the wrong control.
//
//   The ancestor chain names which is which without guessing a
//   selector: the image's action bar has sibling labels ("Edit
//   Reference", "Vary", "Animate"), and the composer's has the
//   "--sref" chip.
//
//   The screenshot exists because the skill's own rule is that
//   measurement SCREENS and the eye DECIDES. A DOM reading of the
//   studio is a measurement.
//
// Usage:
//   node tools/mj-style-enumerate.js <jobId> [--port 9445] [--shot out.png]
//
// Exit: 0 the page was read · 2 bad input · 3 the browser refused

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const PORT = Number(argVal('--port', '9445'));
const SHOT = argVal('--shot', null);

function log(m) { process.stdout.write(`[mj-style-enum] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-enum] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-enumerate.js <jobId> [--port 9445] [--shot out.png]');
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

/** Every element whose label mentions style/reference, with context. */
const ENUM = `(() => {
  const out = [];
  const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\\s+/g, ' ');

  for (const el of document.querySelectorAll('button, [role="button"], [role="menuitem"], a')) {
    const l = labelOf(el);
    if (!l || l.length > 140) continue;
    if (!/style|reference|sref/i.test(l)) continue;
    if (!el.offsetWidth && !el.offsetHeight && !el.getClientRects().length) continue;

    const r = el.getBoundingClientRect();
    const chain = [];
    let n = el.parentElement;
    for (let up = 0; up < 5 && n; up++) {
      const t = (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
      chain.push({ tag: n.tagName, role: n.getAttribute('role') || '', testid: n.getAttribute('data-testid') || '', text: t });
      n = n.parentElement;
    }

    // The SIBLINGS of this control — the action bar's other labels.
    const p = el.parentElement;
    const siblings = p ? [...p.querySelectorAll('button, [role="button"], a')].map(labelOf).filter(Boolean).slice(0, 14) : [];

    out.push({
      label: l,
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      siblings,
      chain,
    });
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

    await send('Page.navigate', { url: 'https://www.midjourney.com/jobs/' + JOB });
    await new Promise(r => setTimeout(r, 9000));

    // Open OUR cell so the image's action bar is present.
    await send('Runtime.evaluate', {
        expression: `(() => {
            const JOB = ${JSON.stringify(JOB)};
            const imgs = [...document.querySelectorAll('img')].filter(i => (i.src || '').includes('/' + JOB + '/'));
            if (!imgs.length) return false;
            const exact = imgs.find(i => (i.src || '').includes('/0_0_')) || imgs[0];
            exact.click();
            return true;
        })()`,
        returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 3000));

    const res = await send('Runtime.evaluate', { expression: ENUM, returnByValue: true });
    const items = (res && res.result && res.result.value) || [];

    log(`--- ${items.length} style/reference control(s) ---`);
    for (const it of items) {
        log('');
        log(`"${it.label}"  <${it.tag}${it.role ? ' ' + it.role : ''}${it.testid ? ' testid=' + it.testid : ''}>  at ${it.x},${it.y} ${it.w}x${it.h}`);
        if (it.siblings.length) log(`   siblings: ${it.siblings.join(' | ')}`);
        for (const c of it.chain) {
            const t = c.text ? ` text="${c.text}"` : '';
            log(`   parent <${c.tag}${c.role ? ' ' + c.role : ''}${c.testid ? ' testid=' + c.testid : ''}>${t}`);
        }
    }

    if (SHOT) {
        const cap = await send('Page.captureScreenshot', { format: 'png' });
        if (cap && cap.data) {
            fs.mkdirSync(path.dirname(path.resolve(SHOT)), { recursive: true });
            fs.writeFileSync(path.resolve(SHOT), Buffer.from(cap.data, 'base64'));
            log('');
            log('screenshot: ' + path.resolve(SHOT));
        } else {
            warn('the screenshot came back empty');
        }
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
