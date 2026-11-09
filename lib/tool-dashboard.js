// lib/tool-dashboard.js — family dashboards for the twin's test suites.
//
// One floating panel per *family* of tools (watchers, midjourney, suno, …),
// not one panel per suite. The chrome matches <floating-toolset>: Shadow
// DOM, skin tokens through inheritance, traffic-light window controls,
// drag, collapse, zoom, and a restore tab on close.
//
//   <script src="/lib/tool-dashboard.js"></script>
//   <tool-dashboard src="/data/twin/tool-dashboards.json"
//                   family="watchers"></tool-dashboard>
//
// The 2×2 grid is TESTS / RUN / DOCS / STATUS. Pure helpers are exported
// for Node (familyToPayload, mergeCatalog, clampPosition, …) so the unit
// suite needs no browser.
//
// Events: 'dashboard:close', 'dashboard:open', 'dashboard:collapse',
// 'dashboard:move', 'dashboard:family' (detail: { id }).

(function () {
    'use strict';

    var HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';
    var STORAGE_KEY = 'dt-tool-dashboard-pos';

    // ---- demo family (used when no catalog is loaded) --------------------

    var DEMO_FAMILY = {
        id: 'watchers',
        label: 'Watchers',
        title: '~/twin — watchers',
        blurb: 'Chart, songs and reel inboxes — the calm drop-zone fleet.',
        suites: ['test:watcher', 'test:songs-watcher', 'test:reel-watcher'],
        run: [
            { cmd: 'npm run test:watcher', note: 'chart inbox' },
            { cmd: 'npm run test:songs-watcher', note: 'audio inbox' },
            { cmd: 'npm run test:reel-watcher', note: 'reel inbox' }
        ],
        docs: [
            { href: '../docs/CHART-WATCHER.md', label: 'Chart watcher' },
            { href: '../docs/SONGS-WATCHER.md', label: 'Songs watcher' },
            { href: '../docs/REEL-WATCHER.md', label: 'Reel watcher' }
        ],
        status: { state: 'green', detail: '3 suites · LaunchAgents live' }
    };

    var DEMO_CATALOG = {
        generatedFor: 'npm run test:all',
        suiteCount: 3,
        familyCount: 1,
        families: [DEMO_FAMILY]
    };

    // ---- pure helpers ----------------------------------------------------

    function isObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function clone(v) {
        return JSON.parse(JSON.stringify(v));
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
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

    /**
     * Normalise one family entry from the catalog into the panel payload
     * shape: title, live, panels.tests / .run / .docs / .status, footer.
     */
    function familyToPayload(family) {
        var f = isObject(family) ? family : DEMO_FAMILY;
        var suites = Array.isArray(f.suites) ? f.suites.slice() : [];
        var run = Array.isArray(f.run) ? f.run.map(function (r) {
            if (typeof r === 'string') return { cmd: r, note: '' };
            return {
                cmd: typeof r.cmd === 'string' ? r.cmd : '',
                note: typeof r.note === 'string' ? r.note : ''
            };
        }).filter(function (r) { return r.cmd; }) : [];
        var docs = Array.isArray(f.docs) ? f.docs.map(function (d) {
            if (typeof d === 'string') return { href: d, label: d };
            return {
                href: typeof d.href === 'string' ? d.href : '',
                label: typeof d.label === 'string' ? d.label : (d.href || '')
            };
        }).filter(function (d) { return d.href; }) : [];
        var status = isObject(f.status) ? {
            state: typeof f.status.state === 'string' ? f.status.state : 'unknown',
            detail: typeof f.status.detail === 'string' ? f.status.detail : ''
        } : { state: 'unknown', detail: '' };

        return {
            id: typeof f.id === 'string' ? f.id : 'unknown',
            label: typeof f.label === 'string' ? f.label : (f.id || 'Family'),
            title: typeof f.title === 'string' ? f.title : ('~/twin — ' + (f.id || 'tools')),
            blurb: typeof f.blurb === 'string' ? f.blurb : '',
            live: true,
            panels: {
                tests: { items: suites },
                run: { items: run },
                docs: { items: docs },
                status: status
            },
            footer: {
                left: suites.length + ' suite' + (suites.length === 1 ? '' : 's') +
                    (status.detail ? ' · ' + status.detail : ''),
                right: typeof f.id === 'string' ? f.id : 'local'
            }
        };
    }

    /**
     * Merge a catalog (or a partial one) over the demo catalog. Never
     * mutates either argument. Families are replaced wholesale when
     * present; suiteCount / familyCount are derived when missing.
     */
    function mergeCatalog(base, patch) {
        var out = clone(isObject(base) ? base : DEMO_CATALOG);
        if (!isObject(patch)) return out;
        if (typeof patch.generatedFor === 'string') out.generatedFor = patch.generatedFor;
        if (Array.isArray(patch.families)) {
            out.families = patch.families.map(function (f) { return clone(f); });
        }
        out.familyCount = out.families.length;
        out.suiteCount = out.families.reduce(function (n, f) {
            return n + (Array.isArray(f.suites) ? f.suites.length : 0);
        }, 0);
        return out;
    }

    /** Find a family by id in a catalog. */
    function findFamily(catalog, id) {
        if (!isObject(catalog) || !Array.isArray(catalog.families)) return null;
        if (typeof id !== 'string' || !id) return null;
        for (var i = 0; i < catalog.families.length; i++) {
            if (catalog.families[i] && catalog.families[i].id === id) {
                return catalog.families[i];
            }
        }
        return null;
    }

    /** Every suite id listed across the catalog (for coverage checks). */
    function listSuites(catalog) {
        if (!isObject(catalog) || !Array.isArray(catalog.families)) return [];
        var out = [];
        catalog.families.forEach(function (f) {
            if (Array.isArray(f.suites)) {
                f.suites.forEach(function (s) { out.push(s); });
            }
        });
        return out;
    }

    // ---- styles (same chrome language as floating-toolset) ---------------

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
        /* Cap to the viewport so a phone-width screen does not push the
           left edge off-screen (right:24 + 490 > 360). border-box so the
           1px border is inside the width — otherwise getBoundingClientRect
           reports 345 on a 343 content box and the phone gutter is a lie. */
        '  box-sizing: border-box;',
        '  width: min(490px, calc(100vw - 32px));',
        '  background: var(--bg-card, #fff);',
        '  border: 1px solid var(--line, #e9e3d6);',
        '  border-radius: var(--radius-lg, 14px);',
        '  box-shadow: var(--shadow-lg, 0 16px 48px rgba(0,0,0,.12));',
        '  overflow: hidden;',
        '  user-select: none;',
        '}',
        ':host([zoomed]) .win { width: min(580px, calc(100vw - 48px)); }',
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
        '  max-height: 180px;',
        '  overflow: auto;',
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
        '.suite {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px; line-height: 1.55;',
        '  color: var(--text-primary, #14171e);',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
        '}',
        '.suite + .suite { margin-top: 3px; }',
        '.run-row {',
        '  display: flex; flex-direction: column; gap: 1px;',
        '  margin-bottom: 7px;',
        '}',
        '.run-cmd {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px; color: var(--text-primary, #14171e);',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
        '}',
        '.run-note {',
        '  font-size: 11px; color: var(--text-tertiary, #7c7a72);',
        '}',
        '.doc-row {',
        '  display: block;',
        '  font-size: 12.5px; line-height: 1.5;',
        '  color: var(--accent-text, #2f6f5e);',
        '  text-decoration: none;',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
        '}',
        '.doc-row + .doc-row { margin-top: 4px; }',
        '.doc-row:hover { text-decoration: underline; }',
        '.status-state {',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 12px; letter-spacing: .06em; text-transform: uppercase;',
        '  color: var(--accent-text, #2f6f5e);',
        '  margin-bottom: 6px;',
        '}',
        '.status-state[data-state="green"] { color: var(--accent-text, #2f6f5e); }',
        '.status-state[data-state="amber"] { color: var(--warning, #b45309); }',
        '.status-state[data-state="red"] { color: var(--error, #d92b2b); }',
        '.status-detail {',
        '  font-size: 12.5px; color: var(--text-secondary, #3a4256);',
        '  line-height: 1.45;',
        '}',
        '.blurb {',
        '  font-size: 12px; color: var(--text-tertiary, #7c7a72);',
        '  margin-top: 8px; line-height: 1.4;',
        '}',
        '.foot {',
        '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
        '  padding: 8px 12px;',
        '  border-top: 1px solid var(--line, #e9e3d6);',
        '  background: var(--bg-soft, #f4f0e7);',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 10.5px; color: var(--text-secondary, #3a4256);',
        '}',
        '.foot-right { color: var(--text-tertiary, #7c7a72); }',
        ':host([collapsed]) .grid, :host([collapsed]) .foot { display: none; }',
        ':host([closed]) .win { display: none; }',
        '.restore {',
        '  display: none;',
        '  margin-top: 8px;',
        '  font-family: var(--mono, ui-monospace, monospace);',
        '  font-size: 11px;',
        '  padding: 7px 12px;',
        '  background: var(--bg-card, #fff);',
        '  color: var(--text-primary, #14171e);',
        '  border: 1px solid var(--line, #e9e3d6);',
        '  border-radius: var(--radius-md, 10px);',
        '  box-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,.08));',
        '  cursor: pointer;',
        '}',
        ':host([closed]) .restore { display: inline-flex; }',
        '.restore:hover { color: var(--accent-text, #2f6f5e); border-color: var(--accent, #2f6f5e); }',
        '@media (prefers-reduced-motion: reduce) {',
        '  .live-dot { animation: none; }',
        '}'
    ].join('\n');

    // ---- render helpers --------------------------------------------------

    function renderTests(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return '<div class="suite">(no suites)</div>';
        return items.map(function (s) {
            return '<div class="suite">' + escapeHtml(s) + '</div>';
        }).join('');
    }

    function renderRun(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return '<div class="run-note">(no run commands)</div>';
        return items.map(function (r) {
            return '<div class="run-row">' +
                '<div class="run-cmd">' + escapeHtml(r.cmd) + '</div>' +
                (r.note ? '<div class="run-note">' + escapeHtml(r.note) + '</div>' : '') +
                '</div>';
        }).join('');
    }

    function renderDocs(panel) {
        var items = (panel && Array.isArray(panel.items)) ? panel.items : [];
        if (!items.length) return '<div class="run-note">(no docs)</div>';
        return items.map(function (d) {
            return '<a class="doc-row" href="' + escapeHtml(d.href) + '" target="_blank" rel="noopener">' +
                escapeHtml(d.label || d.href) + '</a>';
        }).join('');
    }

    function renderStatus(panel, blurb) {
        var state = (panel && panel.state) || 'unknown';
        var detail = (panel && panel.detail) || '';
        return '<div class="status-state" data-state="' + escapeHtml(state) + '">' +
            escapeHtml(state) + '</div>' +
            (detail ? '<div class="status-detail">' + escapeHtml(detail) + '</div>' : '') +
            (blurb ? '<div class="blurb">' + escapeHtml(blurb) + '</div>' : '');
    }

    function renderWindow(payload) {
        var p = payload || familyToPayload(DEMO_FAMILY);
        var panels = p.panels || {};
        return [
            '<div class="win" part="win">',
            '  <div class="bar" part="bar">',
            '    <div class="lights">',
            '      <button type="button" class="light red" data-action="close" aria-label="Close"></button>',
            '      <button type="button" class="light yellow" data-action="collapse" aria-label="Collapse"></button>',
            '      <button type="button" class="light green" data-action="zoom" aria-label="Widen"></button>',
            '    </div>',
            '    <div class="bar-title">' + escapeHtml(p.title) + '</div>',
            '    <div class="live"' + (p.live ? '' : ' hidden') + '>',
            '      <span class="live-dot"></span>live',
            '    </div>',
            '  </div>',
            '  <div class="grid" part="grid">',
            '    <div class="card" data-panel="tests">',
            '      <div class="card-head"><span class="dot"></span>Tests</div>',
            renderTests(panels.tests),
            '    </div>',
            '    <div class="card" data-panel="run">',
            '      <div class="card-head"><span class="dot"></span>Run</div>',
            renderRun(panels.run),
            '    </div>',
            '    <div class="card" data-panel="docs">',
            '      <div class="card-head"><span class="dot"></span>Docs</div>',
            renderDocs(panels.docs),
            '    </div>',
            '    <div class="card" data-panel="status">',
            '      <div class="card-head"><span class="dot"></span>Status</div>',
            renderStatus(panels.status, p.blurb),
            '    </div>',
            '  </div>',
            '  <div class="foot" part="foot">',
            '    <span class="foot-left">' + escapeHtml((p.footer && p.footer.left) || '') + '</span>',
            '    <span class="foot-right">' + escapeHtml((p.footer && p.footer.right) || '') + '</span>',
            '  </div>',
            '</div>',
            '<button type="button" class="restore" data-action="open" aria-label="Restore tool dashboard">',
            '  restore · ' + escapeHtml(p.label || p.id || 'dashboard'),
            '</button>'
        ].join('\n');
    }

    // ---- element ---------------------------------------------------------

    if (HAS_DOM && !customElements.get('tool-dashboard')) {
        function ToolDashboard() {
            var self = Reflect.construct(HTMLElement, [], ToolDashboard);
            self._payload = familyToPayload(DEMO_FAMILY);
            self._catalog = clone(DEMO_CATALOG);
            self._familyId = 'watchers';
            // Requested family that was not in the catalog yet (e.g. an
            // embedder wrote family="suno" before the fetch landed). Kept
            // so a later catalog load can honour it instead of locking
            // onto the demo fallback.
            self._pendingFamily = null;
            self._pos = null;
            self._drag = null;
            self._root = self.attachShadow({ mode: 'open' });
            return self;
        }
        ToolDashboard.prototype = Object.create(HTMLElement.prototype);
        ToolDashboard.prototype.constructor = ToolDashboard;

        Object.defineProperty(ToolDashboard.prototype, 'data', {
            get: function () { return this._payload; },
            set: function (v) { this.setData(v); }
        });

        Object.defineProperty(ToolDashboard.prototype, 'catalog', {
            get: function () { return this._catalog; }
        });

        Object.defineProperty(ToolDashboard.prototype, 'familyId', {
            get: function () { return this._familyId; }
        });

        Object.defineProperty(ToolDashboard.prototype, 'closed', {
            get: function () { return this.hasAttribute('closed'); }
        });

        Object.defineProperty(ToolDashboard.prototype, 'zoomed', {
            get: function () { return this.hasAttribute('zoomed'); }
        });

        ToolDashboard.prototype.setData = function (obj) {
            if (isObject(obj) && Array.isArray(obj.families)) {
                this._catalog = mergeCatalog(DEMO_CATALOG, obj);
                // Honour a pending family request the same way _load does —
                // an embedder may have asked for family=suno before the
                // catalog arrived, and that request must survive.
                var id = this.getAttribute('family') || this._pendingFamily ||
                    this._familyId ||
                    (this._catalog.families[0] && this._catalog.families[0].id);
                this.showFamily(id);
                return;
            }
            if (isObject(obj) && (Array.isArray(obj.suites) || obj.panels)) {
                // A raw family or an already-shaped payload.
                if (obj.panels) {
                    this._payload = obj;
                    this._familyId = obj.id || this._familyId;
                } else {
                    this._payload = familyToPayload(obj);
                    this._familyId = this._payload.id;
                }
                this.render();
                return;
            }
            this._payload = familyToPayload(DEMO_FAMILY);
            this.render();
        };

        ToolDashboard.prototype.showFamily = function (id) {
            var requested = typeof id === 'string' ? id : '';
            var found = findFamily(this._catalog, requested);
            var fam = found || this._catalog.families[0] || DEMO_FAMILY;
            this._familyId = fam.id;
            this._payload = familyToPayload(fam);
            // Only rewrite the attribute when the requested family is
            // actually in the catalog. Rewriting it to the demo
            // fallback ("watchers") before the catalog loads would
            // erase an embedder's non-default family= and lock the
            // panel onto Watchers forever.
            if (found) {
                this._pendingFamily = null;
                if (this.hasAttribute('family') && this.getAttribute('family') !== fam.id) {
                    this.setAttribute('family', fam.id);
                }
            } else if (requested) {
                this._pendingFamily = requested;
            }
            this.render();
            this.dispatchEvent(new CustomEvent('dashboard:family', {
                detail: {
                    id: fam.id,
                    requested: requested || fam.id,
                    found: !!found
                },
                bubbles: true
            }));
        };

        ToolDashboard.prototype.open = function () {
            this.removeAttribute('closed');
            this.dispatchEvent(new CustomEvent('dashboard:open', { bubbles: true }));
        };

        ToolDashboard.prototype.close = function () {
            this.setAttribute('closed', '');
            this.dispatchEvent(new CustomEvent('dashboard:close', { bubbles: true }));
        };

        ToolDashboard.prototype.toggleCollapse = function () {
            if (this.hasAttribute('collapsed')) this.removeAttribute('collapsed');
            else this.setAttribute('collapsed', '');
            this.dispatchEvent(new CustomEvent('dashboard:collapse', {
                detail: { collapsed: this.hasAttribute('collapsed') },
                bubbles: true
            }));
        };

        ToolDashboard.prototype.toggleZoom = function () {
            if (this.hasAttribute('zoomed')) this.removeAttribute('zoomed');
            else this.setAttribute('zoomed', '');
        };

        ToolDashboard.prototype.connectedCallback = function () {
            var self = this;
            if (!this._wired) {
                this._wired = true;
                this._root.addEventListener('click', function (ev) {
                    var btn = ev.target.closest('[data-action]');
                    if (!btn) return;
                    var action = btn.getAttribute('data-action');
                    if (action === 'close') self.close();
                    else if (action === 'collapse') self.toggleCollapse();
                    else if (action === 'zoom') self.toggleZoom();
                    else if (action === 'open') self.open();
                });
                this._root.addEventListener('pointerdown', function (ev) {
                    var bar = ev.target.closest('.bar');
                    if (!bar || ev.target.closest('.light')) return;
                    self._startDrag(ev);
                });
            }
            this._load();
        };

        ToolDashboard.prototype.attributeChangedCallback = function (name, _old, value) {
            if (name === 'family' && value && value !== this._familyId) {
                this.showFamily(value);
            }
            if (name === 'src' && this.isConnected) this._load();
        };

        ToolDashboard.observedAttributes = ['src', 'family'];

        ToolDashboard.prototype._load = function () {
            var self = this;
            var src = this.getAttribute('src');
            if (!src) {
                var localWanted = this.getAttribute('family') || this._pendingFamily;
                if (localWanted) this.showFamily(localWanted);
                else this.render();
                return;
            }
            fetch(src, { cache: 'no-store' }).then(function (r) {
                if (!r.ok) throw new Error('catalog ' + r.status);
                return r.json();
            }).then(function (json) {
                self._catalog = mergeCatalog(DEMO_CATALOG, json);
                // Re-read the attribute at completion time — an
                // embedder may have set family= while the fetch was in
                // flight, and showFamily must not have rewritten it to
                // the demo fallback in the meantime.
                var wanted = self.getAttribute('family') ||
                    self._pendingFamily ||
                    self._familyId ||
                    (self._catalog.families[0] && self._catalog.families[0].id);
                self.showFamily(wanted);
                self.dispatchEvent(new CustomEvent('dashboard:catalog', {
                    detail: { catalog: self._catalog },
                    bubbles: true
                }));
            }).catch(function () {
                // Failed fetch leaves the demo family populated rather than empty.
                var wanted = self.getAttribute('family') || self._pendingFamily;
                if (wanted) self.showFamily(wanted);
                else self.render();
            });
        };

        ToolDashboard.prototype.render = function () {
            var style = this._root.querySelector('style');
            if (!style) {
                style = document.createElement('style');
                style.textContent = STYLE;
                this._root.appendChild(style);
            }
            var wrap = this._root.querySelector('[data-host]');
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.setAttribute('data-host', '');
                this._root.appendChild(wrap);
            }
            wrap.innerHTML = renderWindow(this._payload);
            this._applyPos();
        };

        ToolDashboard.prototype._readStoredPos = function () {
            try {
                var raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                var p = JSON.parse(raw);
                if (typeof p.x === 'number' && typeof p.y === 'number') return p;
            } catch (e) { /* ignore */ }
            return null;
        };

        ToolDashboard.prototype._writeStoredPos = function (pos) {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); }
            catch (e) { /* ignore */ }
        };

        ToolDashboard.prototype._applyPos = function () {
            if (!this._pos) this._pos = this._readStoredPos();
            if (!this._pos) {
                this.style.left = '';
                this.style.top = '';
                this.style.right = '24px';
                this.style.bottom = '24px';
                return;
            }
            this.style.right = 'auto';
            this.style.bottom = 'auto';
            this.style.left = this._pos.x + 'px';
            this.style.top = this._pos.y + 'px';
        };

        ToolDashboard.prototype._startDrag = function (ev) {
            var self = this;
            var rect = this.getBoundingClientRect();
            this._drag = {
                ox: ev.clientX - rect.left,
                oy: ev.clientY - rect.top,
                w: rect.width,
                h: rect.height
            };
            this.style.right = 'auto';
            this.style.bottom = 'auto';
            this.style.left = rect.left + 'px';
            this.style.top = rect.top + 'px';
            var move = function (e) {
                if (!self._drag) return;
                var next = clampPosition(
                    e.clientX - self._drag.ox,
                    e.clientY - self._drag.oy,
                    self._drag.w,
                    self._drag.h,
                    window.innerWidth,
                    window.innerHeight
                );
                self.style.left = next.x + 'px';
                self.style.top = next.y + 'px';
                self._pos = next;
            };
            var up = function () {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                self._drag = null;
                if (self._pos) {
                    self._writeStoredPos(self._pos);
                    self.dispatchEvent(new CustomEvent('dashboard:move', {
                        detail: { x: self._pos.x, y: self._pos.y },
                        bubbles: true
                    }));
                }
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            ev.preventDefault();
        };

        customElements.define('tool-dashboard', ToolDashboard);
        window.ToolDashboard = ToolDashboard;
    }

    // ---- exports (Node + browser) ----------------------------------------

    var api = {
        DEMO_FAMILY: DEMO_FAMILY,
        DEMO_CATALOG: DEMO_CATALOG,
        familyToPayload: familyToPayload,
        mergeCatalog: mergeCatalog,
        findFamily: findFamily,
        listSuites: listSuites,
        clampPosition: clampPosition,
        escapeHtml: escapeHtml,
        renderTests: renderTests,
        renderRun: renderRun,
        renderDocs: renderDocs,
        renderStatus: renderStatus,
        renderWindow: renderWindow,
        HAS_DOM: HAS_DOM
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (HAS_DOM) {
        window.ToolDashboardLib = api;
    }
})();
