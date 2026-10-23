// lib/lvs-bench.js — the mirror bench for pages/loopable-video-segmenter.html.
//
// Two things live here:
//
//  1. THE SCOPE — a canvas illustration of what the CLI does: beat grid
//     in, N contiguous windows out, each window built as forward +
//     reversed. It is an ILLUSTRATION of the documented algorithm, not a
//     video render: nothing here decodes an MP4.
//
//  2. THE API CLIENT — the controls are shaped by the repo's real HTTP
//     surface (lib/api/router.mjs), so the window the scope draws is the
//     window you can actually render:
//
//        POST /api/render/clip   { video: {name, dataBase64}, startSec, endSec }
//                                 → 202 { jobId, status, kind, creditsCharged, balance }
//        GET  /api/jobs/:id      → { id, status, kind, progress, error, outputUrl }
//        GET  /api/jobs/:id/output → the rendered bytes
//        GET  /api/credits       → { userId, balance }
//        GET  /api/health        → { ok, ffmpeg, credits, vendor }
//
//     Every endpoint wants `Authorization: Bearer <token>`. The token is
//     pasted by the operator and kept in this browser only — the admin
//     key that mints one never belongs in a page.
//
//     The API is mounted on lib/serve.js. A static host that rewrites
//     every path to the landing page (Vercel) has no /api/* at all, so
//     the client degrades: the scope keeps working, the render control
//     explains why it is unavailable.
//
// A classic script, not a module, on purpose. The page lives at two
// depths (/pages/… and the repo root) and `import()` gets its specifier
// rewritten on the way to the root copy, where a bare `lib/x.mjs` would
// resolve as an npm package in the browser. A relative <script src>
// survives the rewrite and loads from both depths. Same pattern as
// lib/skin.js and lib/theme.js.
//
// The page is the source of truth; this file is loaded by it.

'use strict';

(function () {
    if (typeof document === 'undefined') return;   // node — nothing to draw

    var canvas = document.getElementById('benchCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');

    /* Reduced motion: the scope still draws, it just does not animate. */
    var reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var DURATION = 96;          /* seconds of "source video" */
    var MAX_UPLOAD = 25 * 1024 * 1024;   /* the router's MAX_IMAGE_BYTES */

    var state = {
        segments: 4,
        loopable: true,
        hasAudio: true,
        bpm: 124,
        active: 0,
        u: 0,                    /* 0→1 forward, 1→2 reverse */
        playing: !reduceMotion,
        /* the API's window — what /api/render/clip would be asked for */
        window: { start: 0, end: 0 },
        /* the API's state */
        api: { reachable: false, health: null, token: '', balance: null },
        job: { id: null, status: 'idle', progress: 0, error: null, outputUrl: null },
        file: null,
        drag: null
    };

    var el = {
        seg: document.getElementById('cSeg'),
        segOut: document.getElementById('cSegOut'),
        loop: document.getElementById('cLoop'),
        loopState: document.getElementById('cLoopState'),
        audio: document.getElementById('cAudio'),
        silent: document.getElementById('cSilent'),
        beats: document.getElementById('cBeats'),
        start: document.getElementById('cStart'),
        end: document.getElementById('cEnd'),
        video: document.getElementById('cVideo'),
        videoHint: document.getElementById('cVideoHint'),
        token: document.getElementById('cToken'),
        balance: document.getElementById('cBalance'),
        render: document.getElementById('cRender'),
        renderText: document.getElementById('cRenderText'),
        job: document.getElementById('cJob'),
        badge: document.getElementById('apiBadge'),
        output: document.getElementById('benchOutput'),
        video_out: document.getElementById('benchVideo'),
        outMeta: document.getElementById('benchOutMeta'),
        play: document.getElementById('cPlay'),
        playText: document.getElementById('cPlayText'),
        roPath: document.getElementById('roPath'),
        roSeg: document.getElementById('roSeg'),
        roWin: document.getElementById('roWin'),
        roLoop: document.getElementById('roLoop'),
        summary: document.getElementById('benchSummary'),
        tableBody: document.getElementById('benchTableBody')
    };

    /* deterministic noise so the beat grid is organic but stable */
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function buildBeats() {
        var rnd = mulberry32(0x5EED ^ (state.bpm * 31));
        var spb = 60 / state.bpm;
        var beats = [0];
        var t = 0;
        while (t < DURATION) {
            t += spb * (0.9 + rnd() * 0.2);
            if (t >= DURATION) break;
            beats.push(t);
        }
        return beats;
    }

    function buildWindows() {
        var n = state.segments, i;
        if (!state.hasAudio) {
            var w = DURATION / n, eq = [];
            for (i = 0; i < n; i++) eq.push([i * w, (i + 1) * w]);
            return eq;
        }
        var beats = buildBeats();
        var per = Math.floor(beats.length / n), rem = beats.length % n;
        var wins = [], idx = 0;
        for (i = 0; i < n; i++) {
            var count = per + (i < rem ? 1 : 0);
            if (count < 1) {                       /* more segments than beats */
                var step = DURATION / n;
                wins.push([idx * step, (idx + 1) * step]);
            } else {
                wins.push([beats[idx], beats[Math.min(idx + count - 1, beats.length - 1)]]);
            }
            idx += count;
        }
        return wins;
    }

    var windows = buildWindows();

    /* ── colour helpers ──────────────────────────────────────────── */
    function readVar(name, fallback) {
        var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    }
    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        var n = parseInt(hex, 16);
        if (isNaN(n)) return { r: 255, g: 255, b: 255 };
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    function toRgb(value, fallback) {
        value = (value || '').trim();
        if (value.charAt(0) === '#') return hexToRgb(value);
        var m = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        if (m) return { r: +m[1], g: +m[2], b: +m[3] };
        return hexToRgb(fallback);
    }
    function mix(a, b, t) {
        var A = toRgb(a, '#c97b3f'), B = toRgb(b, '#ffffff');
        return 'rgb(' + Math.round(A.r + (B.r - A.r) * t) + ',' +
                        Math.round(A.g + (B.g - A.g) * t) + ',' +
                        Math.round(A.b + (B.b - A.b) * t) + ')';
    }
    function rgba(value, alpha) {
        var c = toRgb(value, '#c97b3f');
        return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    }
    var PALETTE = {};
    function refreshPalette() {
        /* The bench palette lives in the page's .bench-wrap scope (see the
           page's CSS) and the status colours come from the skin, so a skin
           swap re-tints the whole scope without touching this file. */
        var bench = document.querySelector('.bench-wrap');
        var cs = bench ? getComputedStyle(bench) : null;
        function benchVar(name, fallback) {
            var v = cs ? cs.getPropertyValue(name).trim() : '';
            return v || fallback;
        }
        var primary = readVar('--primary', '#c97b3f');
        if (primary.charAt(0) !== '#' && primary.indexOf('rgb') !== 0) primary = '#c97b3f';
        PALETTE.signal = mix(primary, '#ffffff', 0.22);   /* lifted for the dark bench */
        PALETTE.signalRaw = primary;
        PALETTE.ink = benchVar('--bench-ink', '#ece5d6');
        PALETTE.dim = benchVar('--bench-dim', '#9b9280');
        PALETTE.faint = benchVar('--bench-faint', '#5f5849');
        PALETTE.line = benchVar('--bench-line', 'rgba(236,229,214,0.13)');
        PALETTE.line2 = benchVar('--bench-line-2', 'rgba(236,229,214,0.26)');
        PALETTE.ok = mix(readVar('--ok', '#047857'), '#cdeedb', 0.42);
        PALETTE.warn = mix(readVar('--warn', '#b45309'), '#f6e2bd', 0.42);
    }
    refreshPalette();

    /* ── formatting ──────────────────────────────────────────────── */
    function fmt(t) {
        var m = Math.floor(t / 60);
        var s = t - m * 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function sec(t) { return t.toFixed(3); }

    /* ── canvas sizing ───────────────────────────────────────────── */
    var cssW = 0, cssH = 0, dpr = 1;
    function padLeft() { return cssW < 540 ? 56 : 78; }
    function trackW() { return Math.max(80, cssW - padLeft() - 14); }
    function resize() {
        var rect = canvas.getBoundingClientRect();
        var w = Math.max(300, rect.width || canvas.parentNode.clientWidth || 640);
        var h = 262;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        cssW = w; cssH = h;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    }

    /* ── drawing ─────────────────────────────────────────────────── */
    function label(text, x, y, align, color, size) {
        ctx.font = '500 ' + (size || 9.5) + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color || PALETTE.dim;
        ctx.fillText(text, x, y);
    }

    function draw() {
        if (!cssW) return;
        ctx.clearRect(0, 0, cssW, cssH);

        var padL = padLeft(), padR = 14, padT = 26;
        var trackX = padL, tw = trackW();

        var win = windows[state.active] || windows[0] || [0, DURATION];
        var dur = Math.max(0.001, win[1] - win[0]);

        /* phase: 0→1 forward, 1→2 reverse */
        var u = state.u % 2;
        var forward = u <= 1;
        var p = forward ? u : 2 - u;

        /* ── row 1 · SOURCE ─────────────────────────────────────── */
        var y1 = padT + 16, h1 = 30;
        label('SOURCE', padL - 12, y1 + h1 / 2, 'right', PALETTE.faint);
        label('96s · ' + (state.hasAudio ? 'beat grid ' + state.bpm + ' bpm' : 'no audio'), trackX, y1 - 14, 'left', PALETTE.faint, 9);

        /* segment windows */
        for (var i = 0; i < windows.length; i++) {
            var w0 = windows[i][0], w1 = windows[i][1];
            var x0 = trackX + (w0 / DURATION) * tw;
            var x1 = trackX + (w1 / DURATION) * tw;
            var isActive = i === state.active;
            ctx.fillStyle = isActive ? rgba(PALETTE.signalRaw, 0.20) : 'rgba(236,229,214,0.045)';
            ctx.fillRect(x0, y1, Math.max(1, x1 - x0), h1);
            ctx.strokeStyle = isActive ? PALETTE.signal : PALETTE.line;
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + .5, y1 + .5, Math.max(1, x1 - x0) - 1, h1 - 1);
            if (isActive) {
                ctx.fillStyle = PALETTE.signal;
                ctx.fillRect(x0, y1 - 3, Math.max(1, x1 - x0), 2);
            }
        }

        /* beat ticks */
        if (state.hasAudio) {
            var beats = buildBeats();
            var spx = (tw / DURATION) * (60 / state.bpm);
            var every = spx < 2.4 ? Math.ceil(2.4 / spx) : 1;
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.5);
            for (var b = 0; b < beats.length; b += every) {
                var bx = trackX + (beats[b] / DURATION) * tw;
                ctx.fillRect(bx, y1 + h1 + 2, 1, 4);
            }
        }

        /* playhead on the source (under the numbers, so they stay legible) */
        var ph = trackX + ((win[0] + p * dur) / DURATION) * tw;
        ctx.fillStyle = PALETTE.ink;
        ctx.fillRect(ph - .5, y1 - 8, 1, h1 + 12);

        /* segment numbers, last so they sit on top of the playhead */
        for (var si = 0; si < windows.length; si++) {
            var sx0 = trackX + (windows[si][0] / DURATION) * tw;
            var sx1 = trackX + (windows[si][1] / DURATION) * tw;
            if (sx1 - sx0 > 17) {
                label(pad2(si + 1), sx0 + 5, y1 + h1 / 2, 'left', si === state.active ? PALETTE.ink : PALETTE.faint, 9);
            }
        }

        /* the API window — the bracket you can drag and render */
        var wx0 = trackX + (state.window.start / DURATION) * tw;
        var wx1 = trackX + (state.window.end / DURATION) * tw;
        ctx.strokeStyle = PALETTE.ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(wx0 + .5, y1 - 5.5, Math.max(2, wx1 - wx0), h1 + 11);
        ctx.fillStyle = PALETTE.ink;
        ctx.fillRect(wx0, y1 - 7, 3, 5);
        ctx.fillRect(wx1 - 3, y1 - 7, 3, 5);

        /* ── row 2 · CLIP BUILD ─────────────────────────────────── */
        var y2 = y1 + h1 + 48, h2 = 34;
        label('CLIP', padL - 12, y2 + h2 / 2, 'right', PALETTE.faint);
        label('segment_' + pad2(state.active + 1) + '.mp4', trackX, y2 - 30, 'left', PALETTE.ink, 9.5);

        var midX = trackX + tw / 2;

        ctx.fillStyle = rgba(PALETTE.signalRaw, 0.16);
        ctx.fillRect(trackX, y2, tw / 2, h2);
        if (forward) {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
            ctx.fillRect(trackX, y2, (tw / 2) * p, h2);
        } else {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
            ctx.fillRect(trackX, y2, tw / 2, h2);
        }
        ctx.strokeStyle = PALETTE.line2; ctx.lineWidth = 1;
        ctx.strokeRect(trackX + .5, y2 + .5, tw / 2 - 1, h2 - 1);

        if (state.loopable) {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.10);
            ctx.fillRect(midX, y2, tw / 2, h2);
            if (!forward) {
                var rp = p;
                ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
                ctx.fillRect(midX + (tw / 2) * (1 - rp), y2, (tw / 2) * rp, h2);
            }
            ctx.strokeStyle = PALETTE.line2; ctx.lineWidth = 1;
            ctx.strokeRect(midX + .5, y2 + .5, tw / 2 - 1, h2 - 1);

            ctx.strokeStyle = rgba(PALETTE.signalRaw, 0.4);
            ctx.lineWidth = 1;
            for (var cx = midX + 8; cx < trackX + tw - 4; cx += 14) {
                ctx.beginPath();
                ctx.moveTo(cx, y2 + h2 - 6);
                ctx.lineTo(cx - 5, y2 + h2 / 2);
                ctx.lineTo(cx, y2 + 6);
                ctx.stroke();
            }
        } else {
            ctx.setLineDash([4, 5]);
            ctx.strokeStyle = PALETTE.line;
            ctx.strokeRect(midX + .5, y2 + .5, tw / 2 - 1, h2 - 1);
            ctx.setLineDash([]);
            label('not built · --no-loopable', midX + tw / 4, y2 + h2 / 2, 'center', PALETTE.faint, 9);
        }

        label('FORWARD', trackX + (tw / 4), y2 - 13, 'center', forward ? PALETTE.ink : PALETTE.dim, 9);
        if (state.loopable) label('REVERSE', midX + (tw / 4), y2 - 13, 'center', forward ? PALETTE.dim : PALETTE.ink, 9);

        ctx.fillStyle = PALETTE.signal;
        ctx.fillRect(midX - .5, y2 - 6, 1, h2 + 12);

        var headX;
        if (forward) {
            headX = trackX + (tw / 2) * p;
        } else if (state.loopable) {
            headX = midX + (tw / 2) * (1 - p);
        } else {
            headX = trackX + (tw / 2) * p;
        }
        ctx.fillStyle = PALETTE.ink;
        ctx.fillRect(headX - .5, y2 - 6, 1, h2 + 12);
        ctx.beginPath();
        ctx.arc(headX, y2 - 10, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE.ink;
        ctx.fill();

        /* ── row 3 · LOOP ────────────────────────────────────────── */
        var y3 = y2 + h2 + 30, h3 = 22;
        label('LOOP', padL - 12, y3 + h3 / 2, 'right', PALETTE.faint);

        var cellW = tw / 3;
        for (var k = 0; k < 3; k++) {
            var cx0 = trackX + k * cellW;
            var inCell = headX >= cx0 && headX < cx0 + cellW;
            ctx.fillStyle = inCell ? rgba(PALETTE.signalRaw, 0.30) : 'rgba(236,229,214,0.04)';
            ctx.fillRect(cx0 + 2, y3, cellW - 6, h3);
            ctx.strokeStyle = inCell ? PALETTE.signal : PALETTE.line;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx0 + 2.5, y3 + .5, cellW - 7, h3 - 1);
            ctx.strokeStyle = inCell ? PALETTE.signal : PALETTE.faint;
            ctx.beginPath();
            ctx.moveTo(cx0 + cellW - 10, y3 + h3 / 2);
            ctx.lineTo(cx0 + cellW - 4, y3 + h3 / 2);
            ctx.moveTo(cx0 + cellW - 7, y3 + h3 / 2 - 3);
            ctx.lineTo(cx0 + cellW - 4, y3 + h3 / 2);
            ctx.lineTo(cx0 + cellW - 7, y3 + h3 / 2 + 3);
            ctx.stroke();
        }

        /* ── row 4 · status strip ───────────────────────────────── */
        var y4 = y3 + h3 + 22;
        var st = state.loopable ? 'SEAM · none' : 'SEAM · plain cut';
        label(st, trackX, y4, 'left', state.loopable ? PALETTE.ok : PALETTE.warn, 9.5);
        var tNow = win[0] + p * dur;
        label('t ' + fmt(tNow) + '  ·  window ' + fmt(win[0]) + ' → ' + fmt(win[1]) +
              '  ·  ' + dur.toFixed(2) + 's', trackX, y4 + 16, 'left', PALETTE.faint, 9);

        var phase = forward ? 'FWD' : (state.loopable ? 'REV' : 'FWD');
        ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
        var pw = ctx.measureText(phase).width + 16;
        var px = trackX + tw - pw;
        ctx.strokeStyle = PALETTE.line2; ctx.lineWidth = 1;
        ctx.strokeRect(px + .5, y4 - 9.5, pw, 19);
        ctx.fillStyle = forward ? PALETTE.ink : PALETTE.signal;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(phase, px + pw / 2, y4);
    }

    /* ── readouts ───────────────────────────────────────────────── */
    function updateReadout(announce) {
        var win = windows[state.active] || [0, 0];
        var dur = win[1] - win[0];
        el.roPath.textContent = state.hasAudio ? 'beat detection' : 'equal-time fallback';
        el.roPath.className = 'ro-v' + (state.hasAudio ? '' : ' warn');
        el.roSeg.textContent = pad2(state.active + 1) + ' / ' + pad2(state.segments);
        el.roWin.textContent = fmt(win[0]) + ' → ' + fmt(win[1]);
        el.roLoop.textContent = state.loopable ? 'seamless · ' + dur.toFixed(2) + 's' : 'plain cut';
        el.roLoop.className = 'ro-v ' + (state.loopable ? 'ok' : 'warn');

        el.beats.textContent = state.hasAudio ? buildBeats().length + ' beats' : 'equal time';

        var rows = '';
        for (var i = 0; i < windows.length; i++) {
            rows += '<tr><td>segment_' + pad2(i + 1) + '</td><td>' + fmt(windows[i][0]) +
                    '</td><td>' + fmt(windows[i][1]) + '</td><td>' +
                    (state.loopable ? 'forward + reverse' : 'plain cut') + '</td></tr>';
        }
        el.tableBody.innerHTML = rows;
        if (announce) {
            el.summary.textContent = state.segments + ' segments, ' +
                (state.hasAudio ? 'beat detection' : 'equal-time fallback') + ', ' +
                (state.loopable ? 'forward plus reverse mirror build' : 'plain cuts, no mirror');
        }
    }

    function recompute(announce) {
        windows = buildWindows();
        if (state.active >= windows.length) state.active = windows.length - 1;
        updateReadout(announce);
        draw();
    }

    /* ── the window: the API's startSec / endSec ───────────────── */
    function setWindow(start, end, fromUser) {
        state.window.start = Math.max(0, Math.min(DURATION, start));
        state.window.end = Math.max(state.window.start + 0.001, Math.min(DURATION, end));
        if (fromUser !== 'skip-inputs') {
            el.start.value = sec(state.window.start);
            el.end.value = sec(state.window.end);
        }
        draw();
    }
    function selectSegment(i) {
        state.active = i;
        state.u = 0;
        setWindow(windows[i][0], windows[i][1]);
        updateReadout();
        draw();
    }

    /* ── the API client ─────────────────────────────────────────── */
    var TOKEN_KEY = 'lvs-token';

    function token() {
        try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
    }
    function saveToken(value) {
        try {
            if (value) localStorage.setItem(TOKEN_KEY, value);
            else localStorage.removeItem(TOKEN_KEY);
        } catch (_) {}
    }

    function authHeaders() {
        var h = { 'content-type': 'application/json' };
        var t = token();
        if (t) h.authorization = 'Bearer ' + t;
        return h;
    }

    function setBadge(stateName, text) {
        if (!el.badge) return;
        el.badge.setAttribute('data-state', stateName);
        el.badge.textContent = text;
    }

    function setJob(status, text) {
        state.job.status = status;
        if (el.job) {
            el.job.setAttribute('data-state', status);
            el.job.textContent = text;
        }
        updateRenderButton();
    }

    function updateRenderButton() {
        if (!el.render) return;
        var running = state.job.status === 'working';
        var ready = state.api.reachable && !!token() && !!state.file && !running;
        el.render.disabled = !ready;
        if (running) {
            el.renderText.textContent = 'Rendering…';
        } else if (!state.api.reachable) {
            el.renderText.textContent = 'No API here';
        } else if (!token()) {
            el.renderText.textContent = 'Need a token';
        } else if (!state.file) {
            el.renderText.textContent = 'Choose a video';
        } else {
            el.renderText.textContent = 'Render window';
        }
    }

    /* GET /api/health — is the server set there at all? */
    function probeApi() {
        setBadge('probing', 'checking the api…');
        return fetch('/api/health', { headers: { accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('health ' + res.status);
                return res.json();
            })
            .then(function (health) {
                state.api.reachable = true;
                state.api.health = health;
                var ff = health.ffmpeg && health.ffmpeg.version ? ' · ffmpeg ' + health.ffmpeg.version : '';
                setBadge('ok', 'api ok' + ff);
                updateRenderButton();
                return refreshCredits();
            })
            .catch(function () {
                state.api.reachable = false;
                state.api.health = null;
                setBadge('down', 'no api on this host');
                updateRenderButton();
            });
    }

    /* GET /api/credits — the balance the next render will spend */
    function refreshCredits() {
        if (!token()) {
            state.api.balance = null;
            el.balance.textContent = '—';
            updateRenderButton();
            return Promise.resolve();
        }
        return fetch('/api/credits', { headers: { authorization: 'Bearer ' + token() } })
            .then(function (res) {
                if (!res.ok) throw new Error('credits ' + res.status);
                return res.json();
            })
            .then(function (data) {
                state.api.balance = data.balance;
                el.balance.textContent = data.balance + ' credit' + (data.balance === 1 ? '' : 's');
                updateRenderButton();
            })
            .catch(function () {
                state.api.balance = null;
                el.balance.textContent = 'no access';
                updateRenderButton();
            });
    }

    function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(new Error('could not read the file')); };
            reader.onload = function () {
                var result = String(reader.result || '');
                var comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.readAsDataURL(file);
        });
    }

    /* POST /api/render/clip → poll /api/jobs/:id → GET the output */
    function renderWindow() {
        if (!state.file) return;
        var file = state.file;
        setJob('working', 'reading ' + file.name + '…');

        fileToBase64(file)
            .then(function (dataBase64) {
                setJob('working', 'POST /api/render/clip…');
                return fetch('/api/render/clip', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        video: { name: file.name, dataBase64: dataBase64 },
                        startSec: Number(state.window.start),
                        endSec: Number(state.window.end)
                    })
                });
            })
            .then(function (res) {
                return res.json().then(function (body) {
                    if (!res.ok) {
                        var err = new Error(body.message || body.error || ('HTTP ' + res.status));
                        err.status = res.status;
                        throw err;
                    }
                    return body;
                });
            })
            .then(function (job) {
                state.job.id = job.jobId;
                if (typeof job.balance === 'number') {
                    state.api.balance = job.balance;
                    el.balance.textContent = job.balance + ' credit' + (job.balance === 1 ? '' : 's');
                }
                setJob('working', 'job ' + job.jobId + ' queued…');
                return pollJob(job.jobId);
            })
            .then(function (job) {
                if (!job || job.status !== 'done') {
                    throw new Error((job && job.error) || 'the render did not finish');
                }
                setJob('working', 'fetching the output…');
                return fetch(job.outputUrl, { headers: { authorization: 'Bearer ' + token() } })
                    .then(function (res) {
                        if (!res.ok) throw new Error('output ' + res.status);
                        return res.blob();
                    });
            })
            .then(function (blob) {
                if (el.video_out && el.video_out.dataset.objectUrl) {
                    URL.revokeObjectURL(el.video_out.dataset.objectUrl);
                }
                var url = URL.createObjectURL(blob);
                if (el.video_out) {
                    el.video_out.dataset.objectUrl = url;
                    el.video_out.src = url;
                }
                if (el.output) el.output.hidden = false;
                if (el.outMeta) {
                    el.outMeta.textContent = 'rendered · ' + blob.size + ' bytes · ' +
                        sec(state.window.start) + 's → ' + sec(state.window.end) + 's · ' +
                        'job ' + (state.job.id || '');
                }
                setJob('done', 'done · ' + blob.size + ' bytes');
            })
            .catch(function (err) {
                setJob('error', err && err.message ? err.message : 'the render failed');
            });
    }

    function pollJob(jobId) {
        return new Promise(function (resolve, reject) {
            var tries = 0;
            function tick() {
                tries += 1;
                fetch('/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + token() } })
                    .then(function (res) {
                        if (!res.ok) throw new Error('job ' + res.status);
                        return res.json();
                    })
                    .then(function (job) {
                        state.job.progress = job.progress || 0;
                        if (job.status === 'done') { resolve(job); return; }
                        if (job.status === 'error') { reject(new Error(job.error || 'render failed')); return; }
                        setJob('working', 'job ' + jobId + ' · ' + Math.round((job.progress || 0) * 100) + '%');
                        if (tries > 600) { reject(new Error('the job timed out')); return; }
                        setTimeout(tick, 700);
                    })
                    .catch(reject);
            }
            tick();
        });
    }

    /* ── controls ───────────────────────────────────────────────── */
    el.seg.addEventListener('input', function () {
        state.segments = parseInt(el.seg.value, 10) || 1;
        el.segOut.textContent = state.segments;
        if (state.active >= state.segments) state.active = state.segments - 1;
        recompute(true);
        selectSegment(state.active);
    });
    el.loop.addEventListener('change', function () {
        state.loopable = el.loop.checked;
        el.loopState.textContent = state.loopable ? 'on' : 'off';
        recompute(true);
    });
    el.audio.addEventListener('click', function () {
        state.hasAudio = true;
        el.audio.setAttribute('aria-pressed', 'true');
        el.silent.setAttribute('aria-pressed', 'false');
        recompute(true);
        selectSegment(state.active);
    });
    el.silent.addEventListener('click', function () {
        state.hasAudio = false;
        el.silent.setAttribute('aria-pressed', 'true');
        el.audio.setAttribute('aria-pressed', 'false');
        recompute(true);
        selectSegment(state.active);
    });

    el.start.addEventListener('change', function () {
        var v = parseFloat(el.start.value);
        if (isNaN(v)) return;
        setWindow(v, state.window.end, 'skip-inputs');
        el.start.value = sec(state.window.start);
    });
    el.end.addEventListener('change', function () {
        var v = parseFloat(el.end.value);
        if (isNaN(v)) return;
        setWindow(state.window.start, v, 'skip-inputs');
        el.end.value = sec(state.window.end);
    });

    el.video.addEventListener('change', function () {
        var file = el.video.files && el.video.files[0];
        if (!file) {
            state.file = null;
            el.videoHint.textContent = 'No file chosen.';
            updateRenderButton();
            return;
        }
        if (file.size > MAX_UPLOAD) {
            state.file = null;
            el.videoHint.textContent = 'Too big — the endpoint takes ' +
                Math.round(MAX_UPLOAD / 1024 / 1024) + ' MB.';
            updateRenderButton();
            return;
        }
        state.file = file;
        el.videoHint.textContent = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
        updateRenderButton();
    });

    el.token.addEventListener('change', function () {
        saveToken(el.token.value.trim());
        el.token.value = token() ? '••••••••••••' : '';
        refreshCredits();
    });

    el.render.addEventListener('click', renderWindow);

    el.play.addEventListener('click', function () {
        state.playing = !state.playing;
        el.play.dataset.playing = state.playing ? 'true' : 'false';
        el.playText.textContent = state.playing ? 'Pause' : 'Play';
        el.play.setAttribute('aria-label', state.playing ? 'Pause the bench animation' : 'Play the bench animation');
    });

    /* ── the scope is interactive: pick a segment, drag the window ── */
    function pointerTime(e) {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        return ((x - padLeft()) / trackW()) * DURATION;
    }
    function inWindow(t) {
        return t >= state.window.start && t <= state.window.end;
    }
    canvas.addEventListener('pointerdown', function (e) {
        var t = pointerTime(e);
        if (t < 0 || t > DURATION) return;
        if (inWindow(t)) {
            state.drag = { from: t, start: state.window.start, end: state.window.end };
        } else {
            for (var i = 0; i < windows.length; i++) {
                if (t >= windows[i][0] && t <= windows[i][1]) { selectSegment(i); return; }
            }
            setWindow(t, Math.min(DURATION, t + 5));
        }
        canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
        if (!state.drag) return;
        var t = pointerTime(e);
        var delta = t - state.drag.from;
        var len = state.drag.end - state.drag.start;
        var start = Math.max(0, Math.min(DURATION - len, state.drag.start + delta));
        setWindow(start, start + len);
    });
    function endDrag() { state.drag = null; }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    /* ── loop ───────────────────────────────────────────────────── */
    var last = performance.now();
    function frame(now) {
        var dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (state.playing) {
            var win = windows[state.active] || [0, 1];
            var dur = Math.max(0.001, win[1] - win[0]);
            state.u += (dt / dur) * 0.55;
            if (state.u >= 2) {
                state.u = 0;
                state.active = (state.active + 1) % windows.length;
                updateReadout();
            }
            draw();
        }
        requestAnimationFrame(frame);
    }

    /* keep the palette honest when the skin or theme flips */
    function onThemeChange() { refreshPalette(); draw(); }
    document.addEventListener('dt-theme', onThemeChange);
    if ('MutationObserver' in window) {
        new MutationObserver(onThemeChange).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-theme', 'data-skin']
        });
    }
    window.addEventListener('resize', resize);
    if ('ResizeObserver' in window) {
        new ResizeObserver(resize).observe(canvas.parentNode);
    }

    /* ── boot ───────────────────────────────────────────────────── */
    el.segOut.textContent = state.segments;
    if (el.token) {
        el.token.value = token() ? '••••••••••••' : '';
        el.token.placeholder = token() ? '••••••••••••' : 'paste a token';
    }
    if (reduceMotion) {
        state.playing = false;
        el.play.dataset.playing = 'false';
        el.playText.textContent = 'Play';
    }
    recompute();
    selectSegment(0);
    resize();
    requestAnimationFrame(frame);

    probeApi();
})();
