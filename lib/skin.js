// lib/skin.js — the skin runtime.
//
// Lets a page switch skin without a rebuild: the whole kai-systems
// family re-skins from one URL (`?skin=studio`) and one localStorage
// key.
//
// How a page uses it, in <head>:
//
//   <link rel="stylesheet" href="../assets/skins/house.css" data-skin-stylesheet>
//   <script src="../lib/skin.js"></script>
//
// Both are synchronous — no defer, no async. The script is
// render-blocking and comes after the link, so the browser cannot paint
// the default skin before the runtime has had its chance to swap the
// href: no flash of the wrong skin.
//
// Everything is derived from that one link. No data-* configuration on
// the script tag, no manifest, no build step:
//
//   href '…/skins/house.css'  ->  directory '…/skins/'
//                               ->  default skin 'house'
//
// Resolution order for the active skin (first match wins):
//   1. ?skin=<name> in the URL
//   2. localStorage['dt-skin']
//   3. the default skin derived from the link
//
// `document.documentElement.dataset.skin` is set to the active skin on
// every load, even when nothing was switched, so CSS can hook
// [data-skin="…"].
//
// Loaded as a classic script (no modules, no bundler). Also require()-
// able in Node so the pure decision function can be unit tested; in
// Node it exports and does nothing else.

'use strict';

(function () {
    var STORAGE_KEY = 'dt-skin';

    /**
     * The skins this project ships.
     *
     * A static host has no directory listing, so the browser cannot
     * enumerate the skins directory — which means an unknown name in
     * `?skin=` would be REQUESTED, and the browser would log a 404 for
     * a file that was never meant to exist. Asking for a skin that is
     * not there should be a no-op, not a broken request.
     *
     * So the runtime knows the names. `lib/skin-lint.js` checks this
     * list against the files in assets/skins/ and fails if they drift,
     * so adding a skin is: drop the file in, add the name here.
     */
    var KNOWN_SKINS = ['house', 'studio'];

    // How long to wait after an `error` before declaring a skin dead.
    // Changing a stylesheet's href aborts the previous request, and
    // some browsers report that abort as an error on the link, so a
    // real failure has to be confirmed rather than taken at face value.
    var FAIL_GRACE_MS = 250;

    // A skin name is a filename stem. Anything else is either a typo or
    // an attempt to make us fetch something outside the skins
    // directory, so it is rejected before it reaches an href.
    var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    /** Reduce a candidate skin name to a safe one, or null. */
    function normalize(name) {
        if (name == null) return null;
        var s = String(name).trim();
        if (!s || !NAME_RE.test(s)) return null;
        if (s === '.' || s === '..') return null;
        return s;
    }

    /**
     * The pure decision function.
     *
     * @param {{param?: string, stored?: string, defaultName?: string, available?: string[]}} opts
     * @returns {{name: string|null, source: 'param'|'stored'|'default'|'fallback'}}
     *
     * `available` is the list of known skin names. When it is omitted
     * or empty the runtime cannot enumerate the skins directory (a
     * static host usually has no directory listing), so any name is
     * treated as available and the stylesheet's `error` event becomes
     * the real fallback. When a list IS available, a param or stored
     * value outside it resolves to the default with source 'fallback'.
     */
    function resolve(opts) {
        var o = opts || {};
        var available = Object.prototype.toString.call(o.available) === '[object Array]' ? o.available : [];
        var def = normalize(o.defaultName);
        var param = normalize(o.param);
        var stored = normalize(o.stored);

        function known(name) {
            if (!available.length) return true;
            for (var i = 0; i < available.length; i++) {
                if (normalize(available[i]) === name) return true;
            }
            return false;
        }

        if (param) {
            if (known(param)) return { name: param, source: 'param' };
            return { name: def, source: 'fallback' };
        }
        if (stored) {
            if (known(stored)) return { name: stored, source: 'stored' };
            return { name: def, source: 'fallback' };
        }
        return { name: def, source: 'default' };
    }

    // --- browser-only helpers ------------------------------------------------

    /** Read the `skin` query parameter from a search string. */
    function paramFromSearch(search) {
        if (!search) return null;
        var q = String(search);
        if (q.charAt(0) === '?') q = q.slice(1);
        if (!q) return null;
        var parts = q.split('&');
        for (var i = 0; i < parts.length; i++) {
            var eq = parts[i].indexOf('=');
            var key = eq === -1 ? parts[i] : parts[i].slice(0, eq);
            var raw = eq === -1 ? '' : parts[i].slice(eq + 1);
            if (safeDecode(key) !== 'skin') continue;
            return safeDecode(raw);
        }
        return null;
    }

    /** decodeURIComponent throws on a malformed escape; treat it as text. */
    function safeDecode(s) {
        try {
            return decodeURIComponent(String(s).replace(/\+/g, ' '));
        } catch (e) {
            return String(s);
        }
    }

    /**
     * Drop `?skin=` from the visible URL so a reload does not re-trigger
     * the swap and a copied link stays clean. Other parameters and the
     * hash are preserved.
     */
    function stripSkinParam(win) {
        try {
            var loc = win.location;
            if (!loc || !win.history || !win.history.replaceState) return;
            var search = String(loc.search || '');
            if (!search) return;
            var parts = search.replace(/^\?/, '').split('&');
            var kept = [];
            var found = false;
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (!part) continue;
                var eq = part.indexOf('=');
                var key = eq === -1 ? part : part.slice(0, eq);
                if (safeDecode(key) === 'skin') { found = true; continue; }
                kept.push(part);
            }
            // Nothing to remove: leave the history entry alone.
            if (!found) return;
            var next = loc.pathname + (kept.length ? '?' + kept.join('&') : '') + (loc.hash || '');
            win.history.replaceState(win.history.state, '', next);
        } catch (e) { /* history is optional */ }
    }

    /** localStorage can throw (private mode, file://, storage disabled). */
    function readStored(win) {
        try {
            var v = win.localStorage.getItem(STORAGE_KEY);
            return v == null ? null : v;
        } catch (e) {
            return null;
        }
    }

    function writeStored(win, name) {
        try {
            win.localStorage.setItem(STORAGE_KEY, name);
            return true;
        } catch (e) {
            return false;
        }
    }

    function clearStored(win) {
        try {
            win.localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* storage is optional */ }
    }

    /** '…/skins/house.css' -> 'house' */
    function skinFromHref(href) {
        if (!href) return null;
        var clean = String(href).split('#')[0].split('?')[0];
        var file = clean.slice(clean.lastIndexOf('/') + 1);
        return normalize(file.replace(/\.css$/i, ''));
    }

    /** '…/skins/house.css' + 'studio' -> '…/skins/studio.css' */
    function hrefForSkin(href, name) {
        var clean = String(href).split('#')[0].split('?')[0];
        var slash = clean.lastIndexOf('/');
        var dir = slash === -1 ? '' : clean.slice(0, slash + 1);
        return dir + name + '.css';
    }

    /**
     * Known skin names.
     *
     * `window.DT_SKINS` overrides the list for a page that wants a
     * different set; otherwise the project's own KNOWN_SKINS applies.
     * An empty result means "accept anything" — the stylesheet's
     * `error` event then performs the real fallback.
     */
    function availableFrom(win) {
        try {
            if (win.DT_SKINS && Object.prototype.toString.call(win.DT_SKINS) === '[object Array]') {
                var list = [];
                for (var i = 0; i < win.DT_SKINS.length; i++) {
                    var n = normalize(win.DT_SKINS[i]);
                    if (n) list.push(n);
                }
                return list;
            }
        } catch (e) { /* treat as unknown */ }
        return KNOWN_SKINS.slice();
    }

    /** True when a stylesheet with this href is actually in the document. */
    function stylesheetApplied(doc, href) {
        try {
            var sheets = doc.styleSheets || [];
            for (var i = 0; i < sheets.length; i++) {
                if (sheets[i] && sheets[i].href === href) return true;
            }
        } catch (e) { /* cross-origin stylesheet access */ }
        return false;
    }

    /**
     * Wire one skin <link> to the runtime: decide the skin, rewrite the
     * href if needed, and undo the switch if the stylesheet fails.
     */
    function attach(win, doc, link, param) {
        var originalHref = link.getAttribute('href') || '';
        var defaultName = skinFromHref(originalHref);
        var stored = readStored(win);

        var decision = resolve({
            param: param,
            stored: stored,
            defaultName: defaultName,
            available: availableFrom(win),
        });
        var active = decision.name;

        // The attribute is always set, even when nothing was switched,
        // so CSS can rely on [data-skin="…"] being accurate.
        var root = doc.documentElement;
        if (root && active) root.setAttribute('data-skin', active);

        if (active && active !== defaultName) {
            // The URL is the explicit request, so it is what persists.
            if (decision.source === 'param') writeStored(win, active);

            var targetHref = hrefForSkin(originalHref, active);
            var settled = false;

            function revert() {
                if (settled) return;
                settled = true;
                // Never leave the page unstyled: go back to the default.
                link.setAttribute('href', originalHref);
                if (doc.documentElement) doc.documentElement.removeAttribute('data-skin');
                // The stored preference points at a skin that does not
                // exist, so it would fail again on every visit.
                if (readStored(win) === active) clearStored(win);
            }

            link.addEventListener('load', function () {
                // The skin arrived; nothing to undo.
                settled = true;
            });

            link.addEventListener('error', function () {
                if (settled) return;
                // Swapping the href aborts the request for the previous
                // stylesheet, and some browsers report that abort as an
                // error on this very link. Wait a moment and let the
                // document tell us whether the skin actually applied
                // before giving up on it.
                win.setTimeout(function () {
                    if (settled) return;
                    if (stylesheetApplied(doc, targetHref)) { settled = true; return; }
                    revert();
                }, FAIL_GRACE_MS);
            });

            link.setAttribute('href', targetHref);
        } else if (decision.source === 'param' && active) {
            // The URL asked for the skin the page already ships with.
            writeStored(win, active);
        }

        return active;
    }

    /** Boot the runtime: find the skin link, now or as soon as it lands. */
    function init(win, doc) {
        if (!win || !doc) return null;
        // The parameter is read once, here: the URL is cleaned up right
        // after, so a later read would find nothing.
        var param = paramFromSearch(win.location && win.location.search);
        var link = doc.querySelector('link[data-skin-stylesheet]');
        if (link) return attach(win, doc, link, param);

        // Normally the link is parsed before this script runs. If a page
        // puts the script first, catch the link the moment it lands so
        // the href is still swapped before the first paint.
        if (typeof win.MutationObserver === 'function') {
            var observer = new win.MutationObserver(function () {
                var found = doc.querySelector('link[data-skin-stylesheet]');
                if (!found) return;
                observer.disconnect();
                attach(win, doc, found, param);
            });
            var target = doc.documentElement || doc;
            observer.observe(target, { childList: true, subtree: true });
        }
        return null;
    }

    var DTSkin = {
        STORAGE_KEY: STORAGE_KEY,
        KNOWN_SKINS: KNOWN_SKINS,
        resolve: resolve,
        normalize: normalize,
        skinFromHref: skinFromHref,
        hrefForSkin: hrefForSkin,
        paramFromSearch: paramFromSearch,
        init: init,
    };

    // CommonJS (Node, tests) — the file must not touch browser APIs here.
    if (typeof module === 'object' && module && typeof module.exports === 'object') {
        module.exports = DTSkin;
    }

    if (typeof window !== 'undefined' && window && typeof document !== 'undefined') {
        window.DTSkin = DTSkin;
        DTSkin.init(window, document);
        // The parameter has done its job; take it out of the URL so a
        // reload does not re-trigger the swap.
        stripSkinParam(window);
    }
})();
