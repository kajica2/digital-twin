/*!
 * <process-graph> — browse and dry-run allowlisted process packages.
 *
 * Loads data/twin/process-graphs.json (or any catalog URL via `src`),
 * renders a selectable list of packages, and on "Dry-run" POSTs to
 * /api/process/<id> with { dryRun: true }. Apply is deliberately not
 * offered in the browser component — packages with placeholders refuse
 * apply anyway, and browserOk=false packages must go through the CLI.
 *
 * Works as a classic script (defines the custom element) and as a
 * CommonJS module (exports the pure helpers for unit tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.ProcessGraphLib = api;
    if (api.ProcessGraph && typeof customElements !== 'undefined' && !customElements.get('process-graph')) {
      customElements.define('process-graph', api.ProcessGraph);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined'
    && typeof HTMLElement !== 'undefined';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function findPackage(catalog, id) {
    if (!catalog || !Array.isArray(catalog.packages)) return null;
    return catalog.packages.find((p) => p && p.id === id) || null;
  }

  function listPackages(catalog) {
    if (!catalog || !Array.isArray(catalog.packages)) return [];
    return catalog.packages.map((p) => ({
      id: p.id,
      title: p.title || p.id,
      summary: p.summary || '',
      browserOk: !!p.browserOk,
      nodes: (p.nodes || []).length,
      edges: (p.edges || []).length,
    }));
  }

  function apiBaseFrom(src) {
    // src like ../../data/twin/process-graphs.json → try /api/process
    // Prefer absolute /api/process when served from the twin's own server.
    return '/api/process';
  }

  const CSS = `
:host {
  display: block;
  font-family: var(--font-body, 'Outfit', system-ui, sans-serif);
  color: var(--ink, var(--text-primary, #1a1812));
}
.wrap {
  display: grid;
  gap: 18px;
}
.list {
  display: grid;
  gap: 10px;
}
.card {
  text-align: left;
  width: 100%;
  cursor: pointer;
  background: var(--surface, var(--bg-card, #fff));
  border: 1px solid var(--line, #e5e1d8);
  border-radius: var(--radius-md, 10px);
  padding: 14px 16px;
  color: inherit;
  font: inherit;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.card:hover, .card[aria-pressed="true"] {
  border-color: var(--primary, var(--accent, #c97b3f));
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,.06));
}
.card:focus-visible {
  outline: 2px solid var(--primary, var(--accent, #c97b3f));
  outline-offset: 2px;
}
.card .title {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 4px;
}
.card .meta {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  letter-spacing: .04em;
  color: var(--ink-muted, var(--text-secondary, #6b6560));
  margin-bottom: 6px;
}
.card .blurb {
  font-size: 13px;
  color: var(--ink-muted, var(--text-secondary, #6b6560));
  line-height: 1.45;
}
.badge {
  display: inline-block;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--line, #e5e1d8);
  margin-left: 8px;
  vertical-align: middle;
}
.badge.ok { color: var(--accent, #2f6f5e); border-color: var(--accent, #2f6f5e); }
.badge.cli { color: var(--ink-faint, #9a948c); }

.detail {
  border: 1px solid var(--line, #e5e1d8);
  border-radius: var(--radius-md, 10px);
  background: var(--surface, var(--bg-card, #fff));
  padding: 16px 18px;
}
.detail h3 {
  font-size: 18px;
  margin: 0 0 6px;
  letter-spacing: -0.01em;
}
.detail .summary {
  font-size: 14px;
  color: var(--ink-muted, var(--text-secondary, #6b6560));
  margin-bottom: 14px;
}
.nodes {
  list-style: none;
  padding: 0;
  margin: 0 0 14px;
  display: grid;
  gap: 8px;
}
.nodes li {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  line-height: 1.45;
  padding: 8px 10px;
  background: var(--bg-warm, var(--code-bg, #f4f1ea));
  border-radius: 8px;
  border: 1px solid var(--line-soft, var(--line, #e5e1d8));
}
.nodes .label { font-weight: 600; color: var(--ink, #1a1812); }
.nodes .cmd { color: var(--ink-muted, #6b6560); display: block; margin-top: 2px; word-break: break-all; }
.nodes .opt { color: var(--ink-faint, #9a948c); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }

.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
button.act {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  padding: 8px 14px;
  cursor: pointer;
  background: var(--bg-warm, var(--bg-card, #f4f1ea));
  color: var(--ink, #1a1812);
  border: 1px solid var(--line, #e5e1d8);
  border-radius: var(--radius-md, 8px);
}
button.act:hover { border-color: var(--primary, #c97b3f); color: var(--primary, #c97b3f); }
button.act.primary {
  background: var(--primary, #c97b3f);
  color: #fff;
  border-color: var(--primary, #c97b3f);
}
button.act:disabled { opacity: .55; cursor: not-allowed; }
.status {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  color: var(--ink-muted, #6b6560);
}
pre.plan {
  margin-top: 14px;
  background: var(--code-bg, #1a1812);
  color: var(--code-text, #f7f5f0);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.empty {
  font-size: 14px;
  color: var(--ink-muted, #6b6560);
  padding: 18px;
  border: 1px dashed var(--line, #e5e1d8);
  border-radius: 10px;
}
`;

  // Everything below touches HTMLElement, so it only runs in a browser.
  // The pure helpers above are exported for the Node unit suite.
  let ProcessGraph = null;

  if (HAS_DOM) {
    ProcessGraph = class extends HTMLElement {
      static get observedAttributes() {
        return ['src', 'selected'];
      }

      constructor() {
        super();
        this._root = this.attachShadow({ mode: 'open' });
        this._catalog = null;
        this._selected = null;
        this._planText = '';
        this._status = '';
        this._loading = false;
      }

      get src() {
        return this.getAttribute('src') || '';
      }
      set src(v) {
        if (v == null || v === '') this.removeAttribute('src');
        else this.setAttribute('src', v);
      }

      get selected() {
        return this.getAttribute('selected') || this._selected || '';
      }
      set selected(v) {
        this._selected = v || '';
        if (v) this.setAttribute('selected', v);
        else this.removeAttribute('selected');
        this._render();
      }

      connectedCallback() {
        if (this.src) this._load(this.src);
        else this._render();
      }

      attributeChangedCallback(name, oldV, newV) {
        if (oldV === newV) return;
        if (name === 'src' && newV) this._load(newV);
        if (name === 'selected') {
          this._selected = newV || '';
          this._planText = '';
          this._status = '';
          this._render();
        }
      }

      setData(catalog) {
        this._catalog = catalog;
        this._render();
      }

      async _load(url) {
        this._status = 'loading catalog…';
        this._render();
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          this._catalog = await r.json();
          this._status = '';
        } catch (err) {
          this._status = 'catalog load failed: ' + (err && err.message ? err.message : err);
          this._catalog = null;
        }
        this._render();
      }

      async _dryRun(id) {
        this._loading = true;
        this._status = 'dry-run…';
        this._render();
        try {
          const r = await fetch(apiBaseFrom(this.src) + '/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dryRun: true, withOptional: true }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            this._status = body.error || ('HTTP ' + r.status);
            this._planText = '';
          } else {
            this._planText = body.text || JSON.stringify(body.plan, null, 2);
            this._status = 'dry-run ready';
          }
        } catch (err) {
          this._status = 'dry-run failed: ' + (err && err.message ? err.message : err);
          this._planText = '';
        }
        this._loading = false;
        this._render();
      }

      _select(id) {
        this._selected = id;
        this.setAttribute('selected', id);
        this._planText = '';
        this._status = '';
        this._render();
        this.dispatchEvent(new CustomEvent('process:select', {
          detail: { id },
          bubbles: true,
          composed: true,
        }));
      }

      _render() {
        const packages = listPackages(this._catalog);
        const selected = findPackage(this._catalog, this._selected);

        let listHtml;
        if (!this._catalog) {
          listHtml = `<div class="empty">${escapeHtml(this._status || 'No catalog loaded.')}</div>`;
        } else if (!packages.length) {
          listHtml = `<div class="empty">No process packages in the catalog.</div>`;
        } else {
          listHtml = `<div class="list" role="listbox" aria-label="Process packages">` +
            packages.map((p) => {
              const pressed = p.id === this._selected ? 'true' : 'false';
              const badge = p.browserOk
                ? `<span class="badge ok">browserOk</span>`
                : `<span class="badge cli">CLI</span>`;
              return `<button type="button" class="card" role="option" aria-pressed="${pressed}" data-id="${escapeHtml(p.id)}">
              <div class="title">${escapeHtml(p.title)}${badge}</div>
              <div class="meta">${escapeHtml(p.id)} · ${p.nodes} nodes · ${p.edges} edges</div>
              <div class="blurb">${escapeHtml(p.summary)}</div>
            </button>`;
            }).join('') +
            `</div>`;
        }

        let detailHtml = '';
        if (selected) {
          const nodes = (selected.nodes || []).map((n) => {
            const opt = n.optional ? `<span class="opt">optional</span>` : '';
            return `<li>
            <span class="label">${escapeHtml(n.label || n.id)}</span> ${opt}
            <span class="cmd">$ ${escapeHtml(n.cmd || '')}</span>
          </li>`;
          }).join('');
          detailHtml = `<div class="detail" data-detail>
          <h3>${escapeHtml(selected.title)}</h3>
          <p class="summary">${escapeHtml(selected.summary || '')}</p>
          <ul class="nodes">${nodes}</ul>
          <div class="row">
            <button type="button" class="act primary" data-dry ${this._loading ? 'disabled' : ''}>Dry-run</button>
            <span class="status" data-status>${escapeHtml(this._status)}</span>
          </div>
          ${this._planText ? `<pre class="plan" data-plan>${escapeHtml(this._planText)}</pre>` : ''}
        </div>`;
        }

        this._root.innerHTML = `<style>${CSS}</style><div class="wrap">${listHtml}${detailHtml}</div>`;

        this._root.querySelectorAll('.card[data-id]').forEach((btn) => {
          btn.addEventListener('click', () => this._select(btn.getAttribute('data-id')));
        });
        const dry = this._root.querySelector('[data-dry]');
        if (dry && selected) {
          dry.addEventListener('click', () => this._dryRun(selected.id));
        }
      }
    };
  }

  return {
    ProcessGraph,
    escapeHtml,
    findPackage,
    listPackages,
    apiBaseFrom,
  };
});
