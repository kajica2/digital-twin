#!/usr/bin/env node
'use strict';
// tools/mj-style-clipboard.js
//
// CONFIRM: does "Style Reference (--sref)" COPY the style reference?
//
// THE MEASUREMENT
//
//   The button's own markup answers it:
//
//     <button title="Style Reference (--sref)" class="... cursor-copy ...">
//       <img alt="https://s.mj.run/cATLXOMsR-o"
//            src="https://s.mj.run/cATLXOMsR-o?thumb=true&size=128">
//       <span title="View full size">…
//
//   So the control is a THUMBNAIL OF THE STYLE REFERENCE ALREADY ON
//   THE IMAGE, and `cursor-copy` says clicking it copies that
//   reference's URL. It is not a button that MINTS a style reference —
//   which is why pressing it produced no request and no toast.
//
//   That is the whole answer to "set as style prompt": the job's
//   style reference is `https://s.mj.run/cATLXOMsR-o`, and the studio
//   hands it to you by copying it.
//
//   This tool PROVES it: it clears the clipboard, presses the button
//   with a real mouse event, and reads the clipboard back.
//
// Usage:
//   node tools/mj-style-clipboard.js <jobId> [--port 9445] [--cell 0_0]
//
// Exit: 0 the clipboard was checked · 2 bad input · 3 the browser refused

const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const JOB = ARGV.find(a => !a.startsWith('--') && a.includes('-'));
const CELL = argVal('--cell', '0_0');
const PORT = Number(argVal('--port', '9445'));

function log(m) { process.stdout.write(`[mj-style-clip] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-style-clip] ${m}\n`); }

if (!JOB) {
    warn('usage: mj-style-clipboard.js <jobId> [--port 9445] [--cell 0_0]');
    process.exit(2);
}

function clipboard(action, value) {
    try {
        if (action === 'read') {
            return execFileSync('osascript', ['-e', 'tell application "System Events" to get the clipboard as text'],
                { encoding: 'utf8', timeout: 8000 }).trim();
        }
        execFileSync('osascript', ['-e', `set the clipboard to "${String(value).replace(/"/g, '\\"')}"`],
            { encoding: 'utf8', timeout: 8000 });
        return '';
    } catch (e) {
        return '';
    }
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
  exact.click();
  return { ok: true, src: exact.src };
})()`;

/** The button AND the style reference its thumbnail points at. */
const FIND = `(() => {
  const WANTED = 'Style Reference (--sref)';
  const b = [...document.querySelectorAll('button, [role="button"]')].find(x => {
    const l = (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').trim().replace(/\\s+/g, ' ');
    return l === WANTED;
  });
  if (!b) return { ok: false };
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  const img = b.querySelector('img');
  return {
    ok: true,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    class: b.getAttribute('class') || '',
    thumbSrc: img ? (img.getAttribute('src') || '') : '',
    thumbAlt: img ? (img.getAttribute('alt') || '') : '',
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

    const o = await send('Runtime.evaluate', { expression: OPEN, returnByValue: true });
    const open = (o && o.result && o.result.value) || {};
    if (!open.ok) { warn('could not open the cell: ' + (open.why || '?')); return 3; }
    log('opened: ' + open.src);
    await new Promise(r => setTimeout(r, 3000));

    const f = await send('Runtime.evaluate', { expression: FIND, returnByValue: true });
    const btn = (f && f.result && f.result.value) || {};
    if (!btn.ok) { warn('the "Style Reference (--sref)" button was not found'); return 3; }

    log('');
    log('--- the button, as the studio renders it ---');
    log('  class      : ' + btn.class);
    log('  thumb src  : ' + btn.thumbSrc);
    log('  thumb alt  : ' + btn.thumbAlt);

    // ---- clear the clipboard, press, read it back ----------------------
    const sentinel = 'MJ-STYLE-CLIPBOARD-SENTINEL-000';
    clipboard('write', sentinel);
    log('');
    log('clipboard seeded with the sentinel: ' + clipboard('read').slice(0, 60));

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none', clickCount: 0 });
    await new Promise(r => setTimeout(r, 300));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 });
    await new Promise(r => setTimeout(r, 120));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 0 });
    await new Promise(r => setTimeout(r, 2500));

    const after = clipboard('read');
    log('');
    log('--- clipboard after the press ---');
    log('  ' + (after || '(empty)'));
    log('');
    if (after && after !== sentinel) {
        log('=> THE BUTTON COPIED SOMETHING. The style reference is:');
        log('   ' + after);
    } else if (after === sentinel) {
        log('=> the clipboard is UNCHANGED: the button did not copy.');
    } else {
        log('=> the clipboard is empty.');
    }

    return 0;
}

main()
    .then(code => { process.exit(code); })
    .catch(e => { warn(`failed: ${e.message}`); process.exit(3); });
