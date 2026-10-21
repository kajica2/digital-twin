// lib/floating-toolset.js — the twin's floating toolset.
//
// A draggable, always-there panel that floats above whatever page it is
// dropped on: TODAY / NOW PLAYING / CODE / PATTERNS in a 2x2 grid, a
// macOS-style chrome bar, and a footer with the twin's running numbers.
//
//   <script src="/lib/floating-toolset.js"></script>
//   <floating-toolset src="/data/twin/toolset.json"></floating-toolset>
//
// No build step, no dependencies. The component owns its own styles in a
// shadow root, so dropping it on a page cannot collide with that page's
// CSS — but CSS custom properties still INHERIT through the shadow
// boundary, so the skin tokens (--primary, --bg-card, ...) reach it and
// the widget re-tints with the family like everything else.
//
// Data comes from a JSON payload (the `src` attribute) or from the
// `.data` property. The built-in fallback is the twin's own demo state,
// so the widget is useful the moment it is dropped on a page.
//
// API (element):
//   .data                      the payload object
//   .setData(obj)              replace the payload and re-render
//   .open() / .close()         show / hide (close keeps a restore tab)
//   .toggleCollapse()          body <-> header only
//   .zoomed                    true when the panel is in its wide layout
//   .toggleZoom()
//
// Events: 'toolset:close', 'toolset:open', 'toolset:collapse',
// 'toolset:move' (detail: { x, y }).
//
// Calm by default: the only motion is the equalizer in NOW PLAYING, it
// honours prefers-reduced-motion, and nothing ever pushes a notification
// at the user.

(function () {
    'use strict';

    var HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';

    var STORAGE_KEY = 'dt-floating-toolset-pos';

    // ---- the twin's demo state -------------------------------------------

    var DEMO = {
        title: '~/twin — online · local',
        status: 'online',
        live: true,
        panels: {
            today: {
                items: [
                    { time: '09:00', label: 'morning warm-up' },
                    { time: '10:30', label: 'deep work block' },
                    { time: '14:00', label: 'chaos_magick review' }
                ]
            },
            nowPlaying: {
                title: 'Coltrane — Naima',
                meta: 'Bb minor · 76 BPM',
                peaks: [0.18, 0.32, 0.52, 0.28, 0.66, 0.42, 0.74, 0.36,
                        0.58, 0.88, 0.44, 0.30, 0.62, 0.50, 0.78, 0.36,
                        0.22, 0.46, 0.70, 0.40, 0.28, 0.54, 0.34, 0.20]
            },
            code: {
                items: [
                    { repo: 'resona', task: 'fix YIN threshold', done: true },
                    { repo: 'lyra', task: 'wire MRT2 client', done: true },
                    { repo: 'chaos_magick', task: 'Vercel redeploy', done: true }
                ]
            },
            patterns: {
                items: [
                    { when: '9am', label: 'warm-up', detail: 'always jazz' },
                    { when: '2pm', label: 'focus', detail: '73min blocks' },
                    { when: '8pm', label: 'explore', detail: 'new repos' }
                ]
            }
        },
        footer: {
            left: 'twin  3 agents running · 8 events today · 0.4¢ spent',
            right: 'local'
        }
    };

    // ---- pure helpers (unit tested in floating-toolset.test.js) ----------

    function isObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    /**
     * Merge a payload over the demo state without ever losing a whole
     * panel to a partial object: a payload that names only `footer` still
     * gets the demo's four panels.
     */
    function mergePayload(base, patch) {
        if (!isObject(patch)) return clone(base);
        var out = clone(base);
        if (typeof patch.title === 'string') out.title = patch.title;
        if (typeof patch.status === 'string') out.status = patch.status;
        if (typeof patch.live === 'boolean') out.live = patch.live;
        if (isObject(patch.panels)) {
            Object.keys(patch.panels).forEach(function (key) {
                out.panels[key] = isObject(patch.panels[key])
                    ? Object.assign({}, out.panels[key], patch.panels[key])
                    : patch.panels[key];
            });
        }
        if (isObject(patch.footer)) {
            out.footer = Object.assign({}, out.footer, patch.footer);
        }
        return out;
    }

    function clone(v) {
        return JSON.parse(JSON.stringify(v));
    }

    /** Keep a dragged panel inside the viewport. */
    function clampPosition(x, y, w, h, vw, vh) {
        var maxX = Math.max(0, vw - w);
        var maxY = Math.max(0, vh - h);
        return {
            x: Math.min(Math.max(0, Math.round(x)), maxX),
            y: Math.min(Math.max(0, Math.round(y)), maxY)
        };
    }

    /** Escape text for an HTML string context. */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---- styles -----------------------------------------------------------

    var STYLE = [
        ':host {',
        '  position: fixed;',
        '  right: 24px; bottom: 24px;',
        '  z-index: 900;',
        '  display: block;',
        '  font-family: var(--font-body, var(--sans, system-ui, sans-serif));',
        '  color: var(--text-primary, #14171e);',
        '}',
        ':host([hidden]) { display: none; }',
        '.win {',
        '  width: 470px;',
        '  background: var(--bg-card, #fff);',
        '  border: 1px solid var(--line, #e9e3d6);',
        '  border-radius: var(--radius-lg, 14px);',
        '  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0,0,0,.12));',
        '  overflow: hidden;',
        '  user-select: none;',
        '}',
        ':host([zoomed]) .win { width: min(560px, calc(100vw - 48px)); }',
        '',
        /* chrome bar */
        '.bar {',
        '  display: flex; align-items: center; gap: 10px;',
        '  padding: 9px 12px;',
        '  background: var(--bg-soft, #f4f0e7);',
        '  border-bottom: 1px solid var(--line, #e9e3d6);',
        '  cursor: grab;',
        '}',
        '.bar:active { cursor: grabbing; }',
        '.lights { display: flex; gap: 6px; flex: 0 0 auto; }',
        '.light {',
        '  width: 11px; height: 11px; border-radius: 50%;',
        '  border: none; padding: 0; cursor: pointer;',
        '  font-size: 0; line-height: 0;',
        '}',
        '.light.red { background: #ff5f57; }',
        '.light.yellow { background: #febc2e; }',
        '.light.green { background: #28c840; }',
        '.light:focus-visible { outline: 2px solid var(--accent, #2f6f5e); outline-offset: 2px; }',
        '.bar-title {',
        '  flex: 1 1 auto; min-width: 0;',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11.5px; letter-spacing: .01em;',
        '  color: var(--text-secondary, #3a4256);',
        '  text-align: center;',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
        '}',
        '.live {',
        '  display: inline-flex; align-items: center; gap: 5px;',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;',
        '  color: var(--error, #d92b2b);',
        '}',
        '.live-dot {',
        '  width: 7px; height: 7px; border-radius: 50%;',
        '  background: var(--error, #d92b2b);',
        '}',
        '.live[hidden] { display: none; }',
        '',
        /* panel grid */
        '.grid {',
        '  display: grid;',
        '  grid-template-columns: 1fr 1fr;',
        '  gap: 1px;',
        '  background: var(--line, #e9e3d6);',
        '}',
        ':host([zoomed]) .grid { grid-template-columns: 1fr; }',
        '.card {',
        '  background: var(--bg-card, #fff);',
        '  padding: 11px 12px 12px;',
        '  min-width: 0;',
        '}',
        '.card-head {',
        '  display: flex; align-items: center; gap: 6px;',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 10px; letter-spacing: .14em; text-transform: uppercase;',
        '  color: var(--text-secondary, #3a4256);',
        '  margin-bottom: 8px;',
        '}',
        '.dot {',
        '  width: 6px; height: 6px; border-radius: 50%;',
        '  background: var(--primary, #c97b3f);',
        '  flex: 0 0 auto;',
        '}',
        '.row {',
        '  display: flex; align-items: baseline; gap: 8px;',
        '  font-size: 12.5px; line-height: 1.5;',
        '  color: var(--text-primary, #14171e);',
        '}',
        '.row + .row { margin-top: 4px; }',
        '.row-time {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px; color: var(--text-tertiary, #7c7a72);',
        '  flex: 0 0 42px;',
        '}',
        '.row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '',
        /* now playing */
        '.np-title { font-size: 13px; font-weight: 600; }',
        '.np-meta {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 10.5px; color: var(--text-tertiary, #7c7a72);',
        '  margin-top: 2px;',
        '}',
        '.wave {',
        '  display: flex; align-items: flex-end; gap: 2px;',
        '  height: 26px; margin-top: 9px;',
        '}',
        '.wave span {',
        '  flex: 1 1 auto;',
        '  background: var(--primary, #c97b3f);',
        '  border-radius: 1px;',
        '  min-height: 2px;',
        '  opacity: .78;',
        '  transform-origin: bottom;',
        '  animation: eq 1.6s ease-in-out infinite alternate;',
        '}',
        '@keyframes eq {',
        '  from { transform: scaleY(.55); opacity: .6; }',
        '  to { transform: scaleY(1); opacity: .9; }',
        '}',
        '',
        /* code */
        '.code-row {',
        '  display: flex; align-items: baseline; gap: 7px;',
        '  font-size: 12.5px; line-height: 1.5;',
        '}',
        '.code-row + .code-row { margin-top: 4px; }',
        '.check {',
        '  width: 11px; height: 11px; flex: 0 0 auto;',
        '  border-radius: 3px;',
        '  background: var(--primary, #c97b3f);',
        '  position: relative; top: 1px;',
        '}',
        '.code-repo { font-weight: 600; }',
        '.code-task {',
        '  color: var(--text-secondary, #3a4256);',
        '  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
        '}',
        '',
        /* patterns */
        '.pat {',
        '  display: flex; align-items: baseline; gap: 6px;',
        '  font-size: 12.5px; line-height: 1.5;',
        '}',
        '.pat + .pat { margin-top: 4px; }',
        '.pat-when {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px; color: var(--text-tertiary, #7c7a72);',
        '  flex: 0 0 30px;',
        '}',
        '.pat-arrow { color: var(--primary, #c97b3f); }',
        '.pat-detail { color: var(--text-secondary, #3a4256); }',
        '',
        /* footer */
        '.foot {',
        '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
        '  padding: 8px 12px;',
        '  border-top: 1px solid var(--line, #e9e3d6);',
        '  background: var(--bg-soft, #f4f0e7);',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 10.5px; color: var(--text-secondary, #3a4256);',
        '}',
        '.foot-right { color: var(--text-tertiary, #7c7a72); }',
        '',
        /* collapsed + closed states */
        ':host([collapsed]) .grid, :host([collapsed]) .foot { display: none; }',
        '.restore {',
        '  position: fixed;',
        '  right: 24px; bottom: 24px;',
        '  z-index: 900;',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px; letter-spacing: .06em;',
        '  padding: 8px 13px;',
        '  border-radius: var(--radius-pill, 999px);',
        '  border: 1px solid var(--line, #e9e3d6);',
        '  background: var(--bg-card, #fff);',
        '  color: var(--text-secondary, #3a4256);',
        '  cursor: pointer;',
        '  box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,.08));',
        '}',
        '.restore:hover { color: var(--text-primary, #14171e); border-color: var(--primary, #c97b3f); }',
        '.restore[hidden] { display: none; }',
        '',
        '@media (prefers-reduced-motion: reduce) {',
        '  .wave span { animation: none !important; opacity: .55; }',
        '}',
        '@media (max-width: 520px) {',
        '  .win { width: calc(100vw - 32px); }',
        '  :host([zoomed]) .win { width: calc(100vw - 32px); }',
        '}'
    ].join('\n');

    // ---- rendering --------------------------------------------------------

    function panelHead(label) {
        return '<div class="card-head"><span class="dot"></span>' + escapeHtml(label) + '</div>';
    }

    function renderToday(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return panelHead('Today') + '<div class="row-label">nothing scheduled</div>';
        return panelHead('Today') + items.map(function (it) {
            return '<div class="row"><span class="row-time">' + escapeHtml(it.time || '') +
                '</span><span class="row-label">' + escapeHtml(it.label || '') + '</span></div>';
        }).join('');
    }

    function renderNowPlaying(panel) {
        var p = panel || {};
        var peaks = Array.isArray(p.peaks) ? p.peaks : [];
        var bars = peaks.length
            ? peaks.map(function (v, i) {
                var h = Math.max(2, Math.round(Number(v || 0) * 26));
                return '<span style="height:' + h + 'px;animation-delay:' + (i * 60) + 'ms"></span>';
            }).join('')
            : '';
        return panelHead('Now Playing') +
            '<div class="np-title">' + escapeHtml(p.title || '—') + '</div>' +
            '<div class="np-meta">' + escapeHtml(p.meta || '') + '</div>' +
            (bars ? '<div class="wave" data-wave aria-hidden="true">' + bars + '</div>' : '');
    }

    function renderCode(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return panelHead('Code') + '<div class="row-label">no open work</div>';
        return panelHead('Code') + items.map(function (it) {
            return '<div class="code-row">' +
                (it.done ? '<span class="check" aria-hidden="true"></span>' : '<span class="check" style="background:transparent;border:1px solid var(--line,#e9e3d6)" aria-hidden="true"></span>') +
                '<span class="code-repo">' + escapeHtml(it.repo || '') + '</span>' +
                '<span class="code-task">— ' + escapeHtml(it.task || '') + '</span>' +
                '</div>';
        }).join('');
    }

    function renderPatterns(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return panelHead('Patterns') + '<div class="row-label">nothing noticed yet</div>';
        return panelHead('Patterns') + items.map(function (it) {
            return '<div class="pat">' +
                '<span class="pat-when">' + escapeHtml(it.when || '') + '</span>' +
                '<span>' + escapeHtml(it.label || '') + '</span>' +
                '<span class="pat-arrow" aria-hidden="true">▸</span>' +
                '<span class="pat-detail">' + escapeHtml(it.detail || '') + '</span>' +
                '</div>';
        }).join('');
    }

    function renderFooter(footer) {
        var f = footer || {};
        return '<div class="foot">' +
            '<span class="foot-left">' + escapeHtml(f.left || '') + '</span>' +
            '<span class="foot-right">' + escapeHtml(f.right || '') + '</span>' +
            '</div>';
    }

    // ---- the element ------------------------------------------------------
    //
    // Everything below touches HTMLElement, so it only runs in a browser.
    // The pure helpers above are exported for the Node unit suite.

    if (HAS_DOM) {

    function FloatingToolset() {
        return Reflect.construct(HTMLElement, [], FloatingToolset);
    }
    FloatingToolset.observedAttributes = ['src', 'zoomed'];
    FloatingToolset.prototype = Object.create(HTMLElement.prototype);
    FloatingToolset.prototype.constructor = FloatingToolset;
    Object.setPrototypeOf(FloatingToolset, HTMLElement);

    FloatingToolset.prototype.connectedCallback = function () {
        if (this._mounted) return;
        this._mounted = true;

        var root = this.attachShadow({ mode: 'open' });
        var style = document.createElement('style');
        style.textContent = STYLE;
        root.appendChild(style);

        this._win = document.createElement('div');
        this._win.className = 'win';
        this._win.setAttribute('role', 'region');
        this._win.setAttribute('aria-label', 'Twin toolset');
        root.appendChild(this._win);

        this._restore = document.createElement('button');
        this._restore.className = 'restore';
        this._restore.type = 'button';
        this._restore.textContent = 'twin';
        this._restore.setAttribute('aria-label', 'Restore the twin toolset');
        this._restore.hidden = true;
        this._restore.addEventListener('click', this.open.bind(this));
        root.appendChild(this._restore);

        this._data = mergePayload(DEMO, null);
        this._collapsed = false;
        this._closed = false;

        this._restorePosition();
        this.render();

        var self = this;
        this._onResize = function () { self._clampToViewport(); };
        window.addEventListener('resize', this._onResize);

        var src = this.getAttribute('src');
        if (src) this._load(src);
    };

    FloatingToolset.prototype.disconnectedCallback = function () {
        if (this._onResize) window.removeEventListener('resize', this._onResize);
    };

    FloatingToolset.prototype.attributeChangedCallback = function (name, oldV, newV) {
        if (oldV === newV) return;
        if (name === 'src' && newV && this._mounted) this._load(newV);
    };

    FloatingToolset.prototype._load = function (url) {
        var self = this;
        fetch(url, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) { self.setData(json); })
            .catch(function (err) {
                // The widget keeps its built-in state — a missing payload
                // is not a reason to show an empty panel.
                console.warn('[floating-toolset] payload not loaded:', err && err.message);
            });
    };

    FloatingToolset.prototype.setData = function (obj) {
        this._data = mergePayload(DEMO, obj);
        this.render();
        return this;
    };

    Object.defineProperty(FloatingToolset.prototype, 'data', {
        get: function () { return this._data; }
    });

    Object.defineProperty(FloatingToolset.prototype, 'zoomed', {
        get: function () { return this.hasAttribute('zoomed'); }
    });

    FloatingToolset.prototype.render = function () {
        if (!this._mounted) return;
        var d = this._data;
        var p = d.panels || {};

        this._win.innerHTML =
            '<div class="bar" data-bar tabindex="0" role="toolbar" aria-label="Twin toolset window controls">' +
            '<div class="lights">' +
            '<button type="button" class="light red" data-act="close" aria-label="Close the toolset"></button>' +
            '<button type="button" class="light yellow" data-act="collapse" aria-label="Collapse the toolset"></button>' +
            '<button type="button" class="light green" data-act="zoom" aria-label="Widen the toolset"></button>' +
            '</div>' +
            '<div class="bar-title">' + escapeHtml(d.title || '') + '</div>' +
            '<span class="live"' + (d.live ? '' : ' hidden') + '><span class="live-dot"></span>live</span>' +
            '</div>' +
            '<div class="grid">' +
            '<div class="card" data-panel="today">' + renderToday(p.today) + '</div>' +
            '<div class="card" data-panel="now-playing">' + renderNowPlaying(p.nowPlaying) + '</div>' +
            '<div class="card" data-panel="code">' + renderCode(p.code) + '</div>' +
            '<div class="card" data-panel="patterns">' + renderPatterns(p.patterns) + '</div>' +
            '</div>' +
            renderFooter(d.footer);

        this._bar = this._win.querySelector('[data-bar]');
        this._barTitle = this._win.querySelector('.bar-title');

        var self = this;
        this._win.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('[data-act]');
            if (!btn) return;
            var act = btn.getAttribute('data-act');
            if (act === 'close') self.close();
            else if (act === 'collapse') self.toggleCollapse();
            else if (act === 'zoom') self.toggleZoom();
        });

        this._bar.addEventListener('pointerdown', function (ev) {
            if (ev.target.closest && ev.target.closest('[data-act]')) return;
            self._startDrag(ev);
        });

        this._bar.addEventListener('keydown', function (ev) {
            var step = ev.shiftKey ? 24 : 8;
            var dx = 0, dy = 0;
            if (ev.key === 'ArrowLeft') dx = -step;
            else if (ev.key === 'ArrowRight') dx = step;
            else if (ev.key === 'ArrowUp') dy = -step;
            else if (ev.key === 'ArrowDown') dy = step;
            else return;
            ev.preventDefault();
            var rect = self._win.getBoundingClientRect();
            self._setPosition(rect.left + dx, rect.top + dy);
        });

        if (this._collapsed) this.setAttribute('collapsed', '');
        else this.removeAttribute('collapsed');
    };

    // ---- drag -------------------------------------------------------------

    FloatingToolset.prototype._startDrag = function (ev) {
        var self = this;
        var rect = this._win.getBoundingClientRect();
        var dx = ev.clientX - rect.left;
        var dy = ev.clientY - rect.top;
        var moved = false;

        function move(e) {
            moved = true;
            self._setPosition(e.clientX - dx, e.clientY - dy);
        }
        function up() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (moved) {
                var r = self._win.getBoundingClientRect();
                self._savePosition(r.left, r.top);
                self.dispatchEvent(new CustomEvent('toolset:move', {
                    detail: { x: Math.round(r.left), y: Math.round(r.top) }
                }));
            }
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        ev.preventDefault();
    };

    FloatingToolset.prototype._setPosition = function (x, y) {
        var rect = this._win.getBoundingClientRect();
        var pos = clampPosition(x, y, rect.width, rect.height,
            window.innerWidth, window.innerHeight);
        this.style.left = pos.x + 'px';
        this.style.top = pos.y + 'px';
        this.style.right = 'auto';
        this.style.bottom = 'auto';
    };

    FloatingToolset.prototype._clampToViewport = function () {
        if (!this._win || this.style.left === '') return;
        var rect = this._win.getBoundingClientRect();
        var pos = clampPosition(rect.left, rect.top, rect.width, rect.height,
            window.innerWidth, window.innerHeight);
        if (pos.x !== Math.round(rect.left) || pos.y !== Math.round(rect.top)) {
            this._setPosition(pos.x, pos.y);
        }
    };

    FloatingToolset.prototype._savePosition = function (x, y) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                x: Math.round(x), y: Math.round(y),
                collapsed: this._collapsed, zoomed: this.zoomed
            }));
        } catch (e) { /* storage may be unavailable — the panel still works */ }
    };

    FloatingToolset.prototype._restorePosition = function () {
        var raw = null;
        try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
        if (!raw) return;
        var saved;
        try { saved = JSON.parse(raw); } catch (e) { return; }
        if (!saved || typeof saved !== 'object') return;
        if (saved.collapsed) { this._collapsed = true; this.setAttribute('collapsed', ''); }
        if (saved.zoomed) this.setAttribute('zoomed', '');
        if (typeof saved.x === 'number' && typeof saved.y === 'number') {
            this.style.left = saved.x + 'px';
            this.style.top = saved.y + 'px';
            this.style.right = 'auto';
            this.style.bottom = 'auto';
        }
    };

    // ---- state ------------------------------------------------------------

    FloatingToolset.prototype.open = function () {
        this._closed = false;
        this.removeAttribute('hidden');
        this.style.display = '';
        if (this._restore) this._restore.hidden = true;
        this.dispatchEvent(new CustomEvent('toolset:open'));
        return this;
    };

    FloatingToolset.prototype.close = function () {
        this._closed = true;
        this.style.display = 'none';
        if (this._restore) this._restore.hidden = false;
        this.dispatchEvent(new CustomEvent('toolset:close'));
        return this;
    };

    FloatingToolset.prototype.toggleCollapse = function () {
        this._collapsed = !this._collapsed;
        if (this._collapsed) this.setAttribute('collapsed', '');
        else this.removeAttribute('collapsed');
        this._savePosition(this._win.getBoundingClientRect().left, this._win.getBoundingClientRect().top);
        this.dispatchEvent(new CustomEvent('toolset:collapse', { detail: { collapsed: this._collapsed } }));
        return this;
    };

    FloatingToolset.prototype.toggleZoom = function () {
        if (this.zoomed) this.removeAttribute('zoomed');
        else this.setAttribute('zoomed', '');
        this._savePosition(this._win.getBoundingClientRect().left, this._win.getBoundingClientRect().top);
        return this;
    };

    if (window.customElements && !window.customElements.get('floating-toolset')) {
        window.customElements.define('floating-toolset', FloatingToolset);
    }

    } // end HAS_DOM

    // Node export for the unit suite — the pure helpers only.
    if (typeof module === 'object' && module.exports) {
        module.exports = {
            DEMO: DEMO,
            mergePayload: mergePayload,
            clampPosition: clampPosition,
            escapeHtml: escapeHtml,
            renderToday: renderToday,
            renderNowPlaying: renderNowPlaying,
            renderCode: renderCode,
            renderPatterns: renderPatterns,
            renderFooter: renderFooter
        };
    }
})();
