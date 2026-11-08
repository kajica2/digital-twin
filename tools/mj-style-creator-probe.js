#!/usr/bin/env node
'use strict';
// tools/mj-style-creator-probe.js
//
// THE STYLE CREATOR PAGE — what the feature actually offers.
//
// WHY THIS PAGE IS THE FRONT DOOR
//
//   Measured so far, on the live account:
//
//     * There is NO server route for a style reference. Thirteen
//       candidate paths 404; the control route answers, so the probe
//       works.
//     * Every --sref this account uses is an `s.mj.run/<code>` short
//       link, and no feed item carries a style-reference field.
//     * The job card's overflow menu carries: Copy · Report ·
//       Download image · Run batch as HD · Open in Discord. No style
//       action.
//     * The studio page carries a LINK labelled "Style Creator" whose
//       href is /style-creator.
//
//   So the minting of a style reference happens in the studio UI, and
//   the studio's own name for that page is the route. This probe
//   reads that page: what it asks for, and what it offers.
//
//   It READS. It does not upload, submit or save.
//
// Usage:
//   node tools/mj-style-creator-probe.js [--port 9445]
//
// Exit: 0 the page was read · 2 bad input · 3 the browser refused

const http = require('node:http');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-creator] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-creator] ${m}\n`); }

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
 * The read.
 *
 * Reports: the page's own words (its headings and labels), every
 * interactive control with its type and label, every file input (the
 * upload affordance), and every image on the page.
 */
const READ = `(() => {
  const out = { url: location.href, title: document.title, headings: [], controls: [], fileInputs: [], images: [], text: '' };

  for (const h of document.querySelectorAll('h1, h2, h3, h4, label, legend')) {
    const t = (h.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t && t.length < 200) out.headings.push({ tag: h.tagName, text: t });
  }

  for (const el of document.querySelectorAll('input, textarea, select, button, [role="button"], [role="combobox"], [role="slider"]')) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.textContent || '').trim().replace(/\\s+/g, ' ');
    out.controls.push({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      aria: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    });
  }

  for (const fi of document.querySelectorAll('input[type="file"]')) {
    out.fileInputs.push({
      accept: fi.getAttribute('accept') || '',
      multiple: fi.hasAttribute('multiple'),
      visible: !!(fi.offsetWidth || fi.offsetHeight || fi.getClientRects().length),
    });
  }

  for (const im of document.querySelectorAll('img')) {
    const src = im.getAttribute('src') || '';
    if (!src) continue;
    out.images.push({ src: src.slice(0, 160), alt: im.alt || '', w: im.naturalWidth, h: im.naturalHeight });
    if (out.images.length > 12) break;
  }

  const body = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  out.text = body.slice(0, 1500);
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

    log('navigating to https://www.midjourney.com/style-creator');
    await send('Page.navigate', { url: 'https://www.midjourney.com/style-creator' });
    await new Promise(r => setTimeout(r, 10000));

    const res = await send('Runtime.evaluate', { expression: READ, returnByValue: true });
    const d = (res && res.result && res.result.value) || {};

    log('url   : ' + d.url);
    log('title : ' + d.title);
    log('');
    log('--- headings / labels ---');
    for (const h of d.headings || []) log(`  <${h.tag}> ${h.text}`);
    log('');
    log(`--- controls (${(d.controls || []).length}) ---`);
    for (const c of d.controls || []) {
        const bits = [c.tag];
        if (c.type) bits.push('type=' + c.type);
        if (c.aria) bits.push('aria=' + c.aria);
        if (c.placeholder) bits.push('placeholder=' + c.placeholder);
        if (c.name) bits.push('name=' + c.name);
        if (c.text) bits.push('text=' + c.text);
        log(`  [${c.visible ? 'visible' : 'hidden '}] ${bits.join('  ')}`);
    }
    log('');
    log(`--- file inputs (${(d.fileInputs || []).length}) ---`);
    for (const f of d.fileInputs || []) {
        log(`  accept=${f.accept || '(any)'} multiple=${f.multiple} visible=${f.visible}`);
    }
    log('');
    log(`--- images (${(d.images || []).length}) ---`);
    for (const im of d.images || []) log(`  ${im.w}x${im.h} ${im.src}`);
    log('');
    log('--- page text ---');
    log(d.text || '(empty)');

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`probe failed: ${e.message}`); process.exit(3); });
