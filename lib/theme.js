// lib/theme.js — the shared no-flash theme bootstrap.
//
// A skin changes the LOOK; a theme changes the LIGHT. Both are project
// concerns, and this file is the theme half of what lib/skin.js does for
// the skin.
//
// Every page in the family needs the same three things, and until now
// each one carried its own copy-pasted block:
//
//   1. read the saved preference BEFORE first paint (no flash)
//   2. resolve 'system' against prefers-color-scheme
//   3. write the preference back when the user picks one
//
// This is that, once. The storage key stays the PAGE's own — it is
// passed in the script tag, so a page remains standalone and its
// preference never leaks into a sibling:
//
//   <script src="../lib/theme.js" data-theme-key="ci-theme"></script>
//
// Loaded synchronously in <head> (no defer, no async): the script is
// render-blocking, so the browser cannot paint the light theme before
// the preference has been applied. That is the whole point — a
// render-blocking script in <head> is what makes "no flash" possible.
//
// Contract with the page:
//
//   DTTheme.key      the storage key in use
//   DTTheme.pref     'light' | 'dark' | 'system'  (what the user picked)
//   DTTheme.resolved 'light' | 'dark'            (what is actually painted)
//   DTTheme.set(pref)   write the preference and apply it
//   DTTheme.apply()     re-resolve 'system' (after the OS theme changes)
//
// The runtime also listens for OS theme changes while the preference is
// 'system', so a page left on "system" follows the machine.
//
// Loaded as a classic script (no modules, no bundler). Also require()-
// able in Node so the pure resolution function can be unit tested; in
// Node it exports and touches no DOM.

'use strict';

(function () {
    // The pure part: what does a preference resolve to right now?
    // Kept separate so it can be unit tested without a DOM.
    //
    // 'auto' is accepted as an alias for 'system' because the family
    // uses both words for the same thing: some pages label the middle
    // button "auto", others "system". Normalising here means a page
    // can pass either and the stored value stays canonical.
    function normalizePref(pref) {
        if (pref === 'auto') return 'system';
        if (pref === 'light' || pref === 'dark' || pref === 'system') return pref;
        return null;
    }

    function resolvePref(pref, prefersDark) {
        var p = normalizePref(pref);
        if (p === 'dark') return 'dark';
        if (p === 'light') return 'light';
        return prefersDark ? 'dark' : 'light';
    }

    // ------------------------------------------------------------------
    // Browser
    // ------------------------------------------------------------------
    if (typeof document === 'undefined') {
        module.exports = { resolvePref: resolvePref, normalizePref: normalizePref };
        return;
    }

    var script = document.currentScript;
    var KEY = (script && script.getAttribute('data-theme-key')) || 'dt-theme-pref';

    var root = document.documentElement;

    function readPref() {
        try {
            var v = normalizePref(localStorage.getItem(KEY));
            return v || 'system';
        } catch (e) {
            // localStorage throws in private mode / file:// / disabled storage.
            return 'system';
        }
    }

    function writePref(pref) {
        try { localStorage.setItem(KEY, pref); } catch (e) { /* storage disabled */ }
    }

    function prefersDark() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) {
            return false;
        }
    }

    var pref = readPref();
    var resolved = resolvePref(pref, prefersDark());

    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-pref', pref);

    var api = {
        key: KEY,
        pref: pref,
        resolved: resolved,

        /** Apply a preference: write it, paint it, tell the page. */
        set: function (next) {
            var p = normalizePref(next);
            if (!p) return;
            pref = p;
            resolved = resolvePref(pref, prefersDark());
            writePref(pref);
            root.setAttribute('data-theme-pref', pref);
            root.setAttribute('data-theme', resolved);
            api.pref = pref;
            api.resolved = resolved;
            root.dispatchEvent(new CustomEvent('dt-theme', {
                bubbles: true,
                detail: { pref: pref, resolved: resolved, key: KEY }
            }));
        },

        /** Re-resolve without writing — used when the OS theme changes. */
        apply: function () {
            resolved = resolvePref(pref, prefersDark());
            root.setAttribute('data-theme', resolved);
            api.resolved = resolved;
            root.dispatchEvent(new CustomEvent('dt-theme', {
                bubbles: true,
                detail: { pref: pref, resolved: resolved, key: KEY }
            }));
        }
    };

    window.DTTheme = api;

    // Follow the OS while the preference is 'system'.
    try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () { if (api.pref === 'system') api.apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* matchMedia unavailable */ }
})();
