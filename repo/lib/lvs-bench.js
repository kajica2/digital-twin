// lib/lvs-bench.js — the mirror bench for pages/loopable-video-segmenter.html.
//
// The bench is the page's one piece of behaviour: a canvas scope that shows
// what the CLI does — beat grid in, N contiguous windows out, each window
// built as forward + reversed. It is an ILLUSTRATION of the documented
// algorithm, not a video render: nothing here decodes an MP4.
//
// A classic script, not a module, on purpose. The page lives at two depths
// (/pages/… and the repo root) and `import()` gets its specifier rewritten
// on the way to the root copy, where a bare `lib/x.mjs` would resolve as an
// npm package in the browser. A relative <script src> survives the rewrite
// and loads from both depths. Same pattern as lib/skin.js and lib/theme.js.
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
    var state = {
        segments: 4,
        loopable: true,
        hasAudio: true,
        bpm: 124,
        active: 0,
        u: 0,                    /* 0→1 forward, 1→2 reverse */
        playing: !reduceMotion
    };

    var el = {
        seg: document.getElementById('cSeg'),
        segOut: document.getElementById('cSegOut'),
        loop: document.getElementById('cLoop'),
        loopState: document.getElementById('cLoopState'),
        audio: document.getElementById('cAudio'),
        silent: document.getElementById('cSilent'),
        bpm: document.getElementById('cBpm'),
        bpmOut: document.getElementById('cBpmOut'),
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

    /* ── canvas sizing ───────────────────────────────────────────── */
    var cssW = 0, cssH = 0, dpr = 1;
    function padLeft() { return cssW < 540 ? 56 : 78; }
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
        var trackX = padL, trackW = Math.max(80, cssW - padL - padR);

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
            var x0 = trackX + (w0 / DURATION) * trackW;
            var x1 = trackX + (w1 / DURATION) * trackW;
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
            var spx = (trackW / DURATION) * (60 / state.bpm);
            var every = spx < 2.4 ? Math.ceil(2.4 / spx) : 1;
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.5);
            for (var b = 0; b < beats.length; b += every) {
                var bx = trackX + (beats[b] / DURATION) * trackW;
                ctx.fillRect(bx, y1 + h1 + 2, 1, 4);
            }
        }

        /* playhead on the source (under the numbers, so they stay legible) */
        var ph = trackX + ((win[0] + p * dur) / DURATION) * trackW;
        ctx.fillStyle = PALETTE.ink;
        ctx.fillRect(ph - .5, y1 - 8, 1, h1 + 12);

        /* segment numbers, last so they sit on top of the playhead */
        for (var si = 0; si < windows.length; si++) {
            var sx0 = trackX + (windows[si][0] / DURATION) * trackW;
            var sx1 = trackX + (windows[si][1] / DURATION) * trackW;
            if (sx1 - sx0 > 17) {
                label(pad2(si + 1), sx0 + 5, y1 + h1 / 2, 'left', si === state.active ? PALETTE.ink : PALETTE.faint, 9);
            }
        }

        /* ── row 2 · CLIP BUILD ─────────────────────────────────── */
        var y2 = y1 + h1 + 48, h2 = 34;
        label('CLIP', padL - 12, y2 + h2 / 2, 'right', PALETTE.faint);
        label('segment_' + pad2(state.active + 1) + '.mp4', trackX, y2 - 30, 'left', PALETTE.ink, 9.5);

        var midX = trackX + trackW / 2;

        /* forward half */
        ctx.fillStyle = rgba(PALETTE.signalRaw, 0.16);
        ctx.fillRect(trackX, y2, trackW / 2, h2);
        /* played portion of the forward half */
        if (forward) {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
            ctx.fillRect(trackX, y2, (trackW / 2) * p, h2);
        } else {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
            ctx.fillRect(trackX, y2, trackW / 2, h2);
        }
        ctx.strokeStyle = PALETTE.line2; ctx.lineWidth = 1;
        ctx.strokeRect(trackX + .5, y2 + .5, trackW / 2 - 1, h2 - 1);

        /* reverse half */
        if (state.loopable) {
            ctx.fillStyle = rgba(PALETTE.signalRaw, 0.10);
            ctx.fillRect(midX, y2, trackW / 2, h2);
            if (!forward) {
                var rp = p;                                   /* 0 at the end → 1 at the start */
                ctx.fillStyle = rgba(PALETTE.signalRaw, 0.55);
                ctx.fillRect(midX + (trackW / 2) * (1 - rp), y2, (trackW / 2) * rp, h2);
            }
            ctx.strokeStyle = PALETTE.line2; ctx.lineWidth = 1;
            ctx.strokeRect(midX + .5, y2 + .5, trackW / 2 - 1, h2 - 1);

            /* reverse chevrons */
            ctx.strokeStyle = rgba(PALETTE.signalRaw, 0.4);
            ctx.lineWidth = 1;
            for (var cx = midX + 8; cx < trackX + trackW - 4; cx += 14) {
                ctx.beginPath();
                ctx.moveTo(cx, y2 + h2 - 6);
                ctx.lineTo(cx - 5, y2 + h2 / 2);
                ctx.lineTo(cx, y2 + 6);
                ctx.stroke();
            }
        } else {
            ctx.setLineDash([4, 5]);
            ctx.strokeStyle = PALETTE.line;
            ctx.strokeRect(midX + .5, y2 + .5, trackW / 2 - 1, h2 - 1);
            ctx.setLineDash([]);
            label('not built · --no-loopable', midX + trackW / 4, y2 + h2 / 2, 'center', PALETTE.faint, 9);
        }

        /* half labels live above the strip so the playhead never crosses them */
        label('FORWARD', trackX + (trackW / 4), y2 - 13, 'center', forward ? PALETTE.ink : PALETTE.dim, 9);
        if (state.loopable) label('REVERSE', midX + (trackW / 4), y2 - 13, 'center', forward ? PALETTE.dim : PALETTE.ink, 9);

        /* the seam between the halves */
        ctx.fillStyle = PALETTE.signal;
        ctx.fillRect(midX - .5, y2 - 6, 1, h2 + 12);

        /* playhead inside the built clip */
        var headX;
        if (forward) {
            headX = trackX + (trackW / 2) * p;
        } else if (state.loopable) {
            headX = midX + (trackW / 2) * (1 - p);
        } else {
            headX = trackX + (trackW / 2) * p;
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

        var cellW = trackW / 3;
        for (var k = 0; k < 3; k++) {
            var cx0 = trackX + k * cellW;
            var inCell = headX >= cx0 && headX < cx0 + cellW;
            ctx.fillStyle = inCell ? rgba(PALETTE.signalRaw, 0.30) : 'rgba(236,229,214,0.04)';
            ctx.fillRect(cx0 + 2, y3, cellW - 6, h3);
            ctx.strokeStyle = inCell ? PALETTE.signal : PALETTE.line;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx0 + 2.5, y3 + .5, cellW - 7, h3 - 1);
            /* wrap arrow */
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

        /* phase badge, right aligned */
        var phase = forward ? 'FWD' : (state.loopable ? 'REV' : 'FWD');
        ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
        var pw = ctx.measureText(phase).width + 16;
        var px = trackX + trackW - pw;
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

    /* ── controls ───────────────────────────────────────────────── */
    el.seg.addEventListener('input', function () {
        state.segments = parseInt(el.seg.value, 10) || 1;
        el.segOut.textContent = state.segments;
        if (state.active >= state.segments) state.active = state.segments - 1;
        recompute(true);
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
        el.bpm.disabled = false;
        recompute(true);
    });
    el.silent.addEventListener('click', function () {
        state.hasAudio = false;
        el.silent.setAttribute('aria-pressed', 'true');
        el.audio.setAttribute('aria-pressed', 'false');
        el.bpm.disabled = true;
        recompute(true);
    });
    el.bpm.addEventListener('input', function () {
        state.bpm = parseInt(el.bpm.value, 10) || 120;
        el.bpmOut.textContent = state.bpm;
        recompute(true);
    });
    el.play.addEventListener('click', function () {
        state.playing = !state.playing;
        el.play.dataset.playing = state.playing ? 'true' : 'false';
        el.playText.textContent = state.playing ? 'Pause' : 'Play';
        el.play.setAttribute('aria-label', state.playing ? 'Pause the bench animation' : 'Play the bench animation');
    });

    /* click a segment in the source strip to make it active */
    canvas.addEventListener('click', function (e) {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var padL = padLeft(), trackW = Math.max(80, cssW - padL - 14);
        var t = ((x - padL) / trackW) * DURATION;
        if (t < 0) return;
        for (var i = 0; i < windows.length; i++) {
            if (t >= windows[i][0] && t <= windows[i][1]) {
                state.active = i;
                state.u = 0;
                updateReadout(true);
                draw();
                return;
            }
        }
    });

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

    el.segOut.textContent = state.segments;
    el.bpmOut.textContent = state.bpm;
    if (reduceMotion) {
        state.playing = false;
        el.play.dataset.playing = 'false';
        el.playText.textContent = 'Play';
    }
    recompute();
    resize();
    requestAnimationFrame(frame);
})();
