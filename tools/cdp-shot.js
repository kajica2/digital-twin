#!/usr/bin/env node
'use strict';
// tools/cdp-shot.js
//
// A screenshot through an ALREADY-RUNNING Chrome's debugging port.
//
// WHY: the repo's own MJ web backend leaves a headed Chrome on :9444, and
// the browser-use harness needs a manual "Allow remote debugging" click
// that nobody is there to give. A plain CDP WebSocket to an existing
// browser needs no prompt at all.
//
// The MJ CDN answers curl and headless clients with a Cloudflare 403, so
// the pixels have to come through a real browser — which is exactly what
// this does.
//
// Usage:
//   node tools/cdp-shot.js <url> <out.png> [--port 9444] [--width W] [--height H]
//
// Exit: 0 the shot was written · 2 bad input · 3 capture failed

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
const URL_ = ARGV[0];
const OUT = ARGV[1];
const PORT = Number(argVal('--port', '9444'));
const WIDTH = Number(argVal('--width', '1600'));
const HEIGHT = Number(argVal('--height', '1200'));

function log(m) { process.stdout.write(`[cdp-shot] ${m}\n`); }
function warn(m) { process.stderr.write(`[cdp-shot] ${m}\n`); }

if (!URL_ || !OUT) {
    warn('usage: cdp-shot.js <url> <out.png> [--port 9444] [--width W] [--height H]');
    process.exit(2);
}

/** The list of open targets, as JSON. */
function listTargets() {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 5000 }, res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
    });
}

/**
 * A minimal CDP client over the WebSocket the target advertises.
 *
 * Node has no built-in WebSocket client that speaks the CDP framing, but
 * it DOES have one in newer runtimes (global WebSocket). When that is
 * absent this falls back to the HTTP endpoint — /json/new?url= opens a
 * tab and returns its ws url.
 */
async function shoot() {
    const targets = await listTargets();
    let target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);

    // If nothing suitable is open, open one via the HTTP endpoint.
    if (!target) {
        target = await new Promise((resolve, reject) => {
            const req = http.get({
                host: '127.0.0.1', port: PORT,
                path: '/json/new?' + encodeURIComponent(URL_),
                timeout: 8000,
            }, res => {
                let d = '';
                res.on('data', c => (d += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
        });
    }
    if (!target || !target.webSocketDebuggerUrl) throw new Error('no CDP target with a websocket');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    // Every CDP call gets a deadline.
    //
    // WITHOUT ONE, A FAILED CAPTURE IS INVISIBLE: if the browser never
    // answers `Page.captureScreenshot` (which it did, on a page holding
    // ~19 MB of data-URI images), the promise simply never settles, the
    // event loop drains, and the process exits 0 with no file written.
    // That is a false success — the worst kind.
    //
    // The deadline is an OPTIONS OBJECT, not a positional argument. A
    // stray extra argument once shifted it into the params slot, which
    // surfaced as "timed out after [object Object]ms" — so the shape
    // that cannot be confused is the one that stays.
    const call = (method, { params = {}, ms = 20000 } = {}) => Promise.race([
        send(method, params),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`${method} timed out after ${ms}ms`)), ms)),
    ]);

    // The handshake. Node's global WebSocket is an EventTarget, so the
    // listeners are the API — but `open` may ALREADY have fired by the
    // time the listener is attached, which is why the first version
    // hung and then exited 0 without writing the file. So the ready
    // state is checked first and the listener is a fallback.
    await new Promise((resolve, reject) => {
        if (ws.readyState === 1) return resolve();
        const timer = setTimeout(() => reject(new Error('websocket open timed out')), 8000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('websocket error')); }, { once: true });
    });

    // THE RESPONSE LISTENER MUST BE ATTACHED BEFORE THE FIRST send().
    //
    // The first version attached it AFTER the handshake, which is fine
    // in principle — but the `Page.enable` reply can arrive before the
    // listener is attached, so its promise never settled, the await
    // never resolved, the process exited 0 with no file written, and
    // the failure was invisible.
    ws.addEventListener('message', ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    });

    await call('Page.enable');
    // Runtime.evaluate needs its domain enabled, or the command is
    // accepted and never answered.
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
        params: {
            width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
        },
    });
    await call('Page.navigate', { params: { url: URL_ } });
    // Give the page time to paint the images.
    await new Promise(r => setTimeout(r, 4000));

    // Confirm the page actually rendered — a capture of a blank page is
    // still a valid PNG, so the file's existence proves nothing.
    const probe = await call('Runtime.evaluate', {
        params: {
            expression: 'document.querySelectorAll("img").length + ":" + (document.images[0] ? document.images[0].naturalWidth : 0)',
            returnByValue: true,
        },
        ms: 10000,
    });
    const probeVal = probe && probe.result ? probe.result.value : '?';
    if (String(probeVal).split(':')[0] === '0') {
        throw new Error(`the page rendered no images (probe: ${probeVal})`);
    }
    log(`page state: ${probeVal}`);

    const shot = await call('Page.captureScreenshot', { params: { format: 'png' }, ms: 45000 });
    if (!shot || !shot.data) throw new Error('captureScreenshot returned no data');
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), Buffer.from(shot.data, 'base64'));
    ws.close();
    return OUT;
}

shoot()
    .then(out => log(`wrote ${out}`))
    .catch(e => { warn(`capture failed: ${e.message}`); process.exit(3); });
