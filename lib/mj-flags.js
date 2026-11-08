// lib/mj-flags.js
//
// The Midjourney flag composer — shared by the Node submitter and the
// browser console.
//
// WHY THIS IS A SEPARATE FILE.
//
// The flag rules below are not cosmetic: they decide what Midjourney
// actually renders. `--ar` is resolved exactly ONCE and emitted LAST,
// because MJ honours the LAST `--ar` it sees; `--style`/`--s` are one
// coupled parameter; `--sref` is resolved once. Every one of those rules
// was a real bug in this repo's history, each one caught by a test.
//
// A browser console that re-implemented the rules would be a second
// source of truth: it could show one command while the submitter sent
// another, and the user would have no way to tell. So the console loads
// THIS FILE — the same bytes the submitter runs — and the composed
// command on screen is the command that gets sent.
//
// It is a classic script (no modules, no bundler), the same shape as
// lib/theme.js and lib/skin.js:
//
//   <script src="../lib/mj-flags.js"></script>
//   <script>
//     window.MJFlags.buildFullPrompt('a trumpet at dawn', '16:9', '--ar 16:9');
//   </script>
//
// In Node it is `require('./mj-flags.js')`.
//
// Usage:
//   node lib/mj-flags.js --prompt "x" --ar 16:9 [--defaults "<flags>"]
//
// Exit: 0 ok · 2 bad input

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Flag parsing
    //
    // A flag may carry SEVERAL values (`--sref url1 url2`), so flags are
    // parsed as SEGMENTS rather than split on whitespace — otherwise the
    // second value would be orphaned into the prompt body.
    //
    // The text BEFORE the first flag is returned as `prefix`: a caller
    // may pass free text in defaultArgs, and rebuilding the string from
    // the flag segments alone would silently discard it.
    // ------------------------------------------------------------------
    function parseFlagSegments(text) {
        const s = String(text || '').trim();
        if (!s) return { prefix: '', segments: [] };
        const re = /(^|\s)(--[a-zA-Z][\w-]*)(?=\s|$)/g;
        const marks = [];
        let m;
        while ((m = re.exec(s)) !== null) {
            marks.push({ idx: m.index + m[1].length, flag: m[2] });
        }
        if (!marks.length) return { prefix: s, segments: [] };
        const segments = marks.map((mark, i) => {
            const end = i + 1 < marks.length ? marks[i + 1].idx : s.length;
            const values = s.slice(mark.idx + mark.flag.length, end).trim().split(/\s+/).filter(Boolean);
            return { flag: mark.flag, values };
        });
        return { prefix: s.slice(0, marks[0].idx).trim(), segments };
    }

    // ------------------------------------------------------------------
    // buildFullPrompt — compose the final prompt text handed to Midjourney.
    //
    // `--ar` is resolved exactly ONCE and emitted last:
    //
    //   * The prompt may already carry one (e.g. `--prompt "… --ar 1:1"`),
    //     in which case it wins.
    //   * Otherwise the caller's `ar` (from --prompt-file extraction or the
    //     --ar flag) wins.
    //   * Otherwise the config default's `--ar` is used.
    //
    // The old implementation appended `--ar <caller>` and then appended the
    // whole `defaultArgs` string — which itself contains `--ar 3:4` — because
    // its guard tested the extracted prompt text (from which `extractPrompts`
    // had already stripped every flag). The result was `--ar 16:9 --ar 3:4`.
    // Midjourney honours the LAST `--ar`, so the config default silently
    // overrode the requested ratio.
    //
    // Emitting `--ar` last also matches how these prompts are authored:
    // "… --style raw --s 250 --ar 16:9".
    //
    // `--sref` is resolved exactly once too, with this precedence:
    //
    //   1. A `--sref` in the prompt text wins outright (it is the author's
    //      own style reference and is sent as-is).
    //   2. Otherwise the LAST `--sref` in the defaults string wins.
    //
    // Rule 2 exists because mj-web.js composes its effective defaults as
    // `config defaultArgs` + `user --sref/--sref-url fragment`, so the
    // user's reference is always the last one. The config default
    // (`--sref 6965361632`) is DROPPED in that case — the default must
    // never sit alongside the user's reference. This is the same class of
    // bug as the duplicated `--ar` (see PM-2026-09-24-dup-flags): the old
    // code only stripped the default's copy when the PROMPT carried one,
    // so the mj-web path emitted two `--sref` flags and MJ silently took
    // the wrong one.
    // ------------------------------------------------------------------
    function buildFullPrompt(prompt, ar, defaultArgs) {
        const promptText = String(prompt || '');
        const defaults = String(defaultArgs || '').trim();
        // Like --sref below, the guard matches the FLAG, not a value: a prompt
        // carrying a bare `--ar` still means the prompt owns that flag, so the
        // caller/default ratio must not be emitted alongside it.
        const promptHasAr = /--ar(?=\s|$)/.test(promptText);
        // If the prompt carries --style, leave style entirely to the prompt
        // (don't double up with the defaults' --style raw + --s 250).
        // If the prompt lacks --style, keep the defaults' --style raw intact.
        //
        // `--raw` is the same switch as `--style raw` (MJ v5+ alias), so a
        // prompt carrying `--raw` also owns the style slot. Without this the
        // config's `--style raw` was appended alongside the prompt's `--raw`.
        const promptHasStyle = /(--style\b|--raw\b)/.test(promptText);
        // The prompt owns `--s` when it carries one itself. Otherwise the
        // config's `--s` value is used. Two `--s` flags is the same failure
        // class as the duplicated `--ar` (PM-2026-09-24-dup-flags): MJ honours
        // the LAST one, so the config's value silently overrode the artist's.
        // The guard matches the FLAG, not a value: a bare `--s` still counts.
        //
        // `--stylize` is the long spelling of `--s`. MJ treats them as one
        // parameter, so a prompt carrying `--stylize 50` owns the slot exactly
        // as `--s 50` would — and before this guard learned the long form, a
        // pack written with `--stylize` got the config's `--s 21` appended after
        // it and silently rendered flat.
        const promptHasS = /(--s|--stylize)(?=\s|$)/.test(promptText);
        const defaultAr = (defaults.match(/--ar\s+(\S+)/) || [])[1] || null;

        // --sref is resolved exactly once, like --ar. A prompt that names its own
        // style reference wins; the defaults' copies are dropped so MJ never sees
        // two --sref flags and silently takes the wrong one. (Same class of bug
        // as the duplicated --ar — see PM-2026-09-24-dup-flags.)
        //
        // The guard matches the FLAG, not a value: a prompt ending in a bare
        // `--sref` (the author forgot the id) still means "the prompt carries a
        // --sref", so the config default must not be emitted alongside it. The
        // old `/--sref\s+\S+/` missed that form and produced two --sref flags.
        // `--srefs 1` must NOT match, hence the flag boundary.
        const promptHasSref = /--sref(?=\s|$)/.test(promptText);

        const { prefix, segments } = parseFlagSegments(defaults);

        // The winning --sref segment (the last one) and every other --sref
        // segment, which is dropped.
        const srefSegments = segments.filter((s) => s.flag === '--sref');
        const chosenSref = srefSegments.length ? srefSegments[srefSegments.length - 1] : null;

        // Keep the winning --sref in place, drop every other --sref, and drop
        // --ar entirely (we emit it ourselves, last).
        let kept = [];
        let srefKept = false;
        for (const seg of segments) {
            if (seg.flag === '--ar') continue;
            if (seg.flag === '--sref') {
                if (promptHasSref) continue;               // the prompt's own wins
                if (chosenSref && !srefKept) { kept.push(chosenSref); srefKept = true; }
                continue;                                  // every other copy goes
            }
            if (seg.flag === '--s' && (promptHasS || promptHasStyle)) {
                // The prompt owns --s: either it carries its own --s, or it
                // carries --style/--raw, and the config's --style raw is
                // coupled to the config's --s 250. Either way the defaults'
                // --s would be appended after the prompt's own, and MJ honours
                // the LAST --s — so the config's value would silently
                // override the artist's. Same failure class as the
                // duplicated --ar (PM-2026-09-24-dup-flags).
                continue;
            }
            // `--raw` and `--style raw` are the same switch, so a prompt that
            // carries either owns the slot: emitting the config's `--raw`
            // alongside a prompt's own `--raw` would be a literal duplicate
            // parameter (v8 dropped the `--style` presets, so `--raw` is now
            // the spelling the config ships).
            if (promptHasStyle && seg.flag === '--raw') continue;
            if (promptHasStyle && seg.flag === '--style') {
                // Prompt carries --style: drop the defaults' style so it
                // doesn't get appended after the prompt's own.
                if (seg.values[0] && !/^raw$/i.test(seg.values[0])) kept.push(seg);
                continue;
            }
            kept.push(seg);
        }

        // Any free text before the first flag is preserved — rebuilding from the
        // flag segments alone would silently discard caller data.
        let defaultsRest = [prefix].concat(kept.map((seg) =>
            (seg.values.length ? `${seg.flag} ${seg.values.join(' ')}` : seg.flag)))
            .filter(Boolean)
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        let fullPrompt = promptText;
        if (defaultsRest) fullPrompt += ` ${defaultsRest}`;
        if (!promptHasAr) {
            const chosen = ar || defaultAr;
            if (chosen) fullPrompt += ` --ar ${chosen}`;
        }
        return fullPrompt;
    }

    // ------------------------------------------------------------------
    // Ratio helpers
    //
    // The ratio is a FIRST-CLASS field, not just a flag buried in the
    // text. The submitter's parser (`extractPrompts` in mj-submitter.js)
    // strips `--ar` off the prompt text and surfaces it separately as
    // `p.ar`; the console does the same, so a saved prompt and a
    // submitted prompt carry the ratio the same way.
    // ------------------------------------------------------------------

    /** Split a prompt's own `--ar` off its text. The FIRST match wins. */
    function splitAr(text) {
        const s = String(text || '');
        const m = /--ar\s+(\S+)/.exec(s);
        if (!m) return { text: s.trim(), ar: null };
        const stripped = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length))
            .replace(/\s{2,}/g, ' ')
            .trim();
        return { text: stripped, ar: m[1] };
    }

    /** The `--ar` carried by a defaults string, if any. */
    function arFromDefaults(defaults) {
        const m = /--ar\s+(\S+)/.exec(String(defaults || ''));
        return m ? m[1] : null;
    }

    const api = { parseFlagSegments, buildFullPrompt, splitAr, arFromDefaults };

    // CommonJS (Node, tests) — the file must not touch browser APIs here.
    if (typeof module === 'object' && module && typeof module.exports === 'object') {
        module.exports = api;
        return;
    }

    if (typeof window !== 'undefined' && window) {
        window.MJFlags = api;
    }
})();

// CLI — `node lib/mj-flags.js --prompt "x" --ar 16:9` prints the composed
// command. Useful for checking a defaults string without a browser.
if (typeof module === 'object' && module && typeof require === 'function'
    && typeof require.main === 'object' && require.main === module) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { buildFullPrompt } = module.exports;

    const argv = process.argv.slice(2);
    const arg = (name) => {
        const i = argv.indexOf(name);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
    };

    const prompt = arg('--prompt');
    if (!prompt) {
        process.stderr.write('usage: node lib/mj-flags.js --prompt "<text>" [--ar 16:9] [--defaults "<flags>"]\n');
        process.exit(2);
    }

    let defaults = arg('--defaults');
    if (defaults === null) {
        try {
            const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));
            defaults = (cfg.mj && cfg.mj.defaultArgs) || '';
        } catch {
            defaults = '';
        }
    }

    process.stdout.write(buildFullPrompt(prompt, arg('--ar'), defaults) + '\n');
}
