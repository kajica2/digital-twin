// lib/batch-detect.js — work out which images belong to the same batch.
//
// A batch is a run of images that came out of the same generation job:
//   2026-10-23/frame-01.png … frame-08.png      one day, one run
//   prompt-01/01_full.png, 01_thumb.png          one frame, two sizes
//   batch1.png, batch2.png, batch3.png           a numbered run
//
// The rule this file exists to enforce: **never put images from different
// batches in the same video**. A batch is a folder, or a filename stem.
// Two images are in the same batch only when they agree on BOTH.
//
//   scope   the parent folder (drop a folder in and the folder decides)
//   prefix  the filename stem with the frame number and the size/variant
//           word taken off — "frame-01_full" → "frame"
//
// So "frame-01.png" and "frame-02.png" share a prefix and land together;
// "frame-01.png" and "cover-01.png" do not, and neither do files from two
// different folders. That is the whole idea: the grouping is conservative
// on purpose. A wrong split is visible and one click to fix; a wrong
// merge is a video with the wrong stills in it.
//
// Three signals, in order of how much they are trusted:
//
//   1. the folder      strongest. Two folders are two batches, always.
//   2. the prefix     "frame", "batch", "cover" — the stem minus number
//   3. the frame no.  "01" inside a prefix, used for ordering and for
//                     spotting the same frame at two sizes
//
// The same frame at two sizes (01_full.png next to 01_thumb.png) is ONE
// frame, not two, so the bigger one wins and the video is not twice as
// long as it should be.
//
// No DOM, no Node built-ins, no globals beyond BatchDetect itself, and
// every function is pure — the same file list always gives the same
// batches. That is what makes it testable, and the tests are the
// contract:
//
//   node lib/batch-detect.test.js
//
// How a page uses it:
//
//   <script src="../lib/batch-detect.js"></script>
//   ...
//   const { batches } = BatchDetect.detectBatches(files);

(function () {
    'use strict';

    /**
     * Words that mark a file as a different SIZE or VERSION of the same
     * frame. They are only ever stripped from the END of a stem, so
     * "v1-frame.png" keeps its prefix and "frame-v1.png" does not.
     */
    const VARIANT_WORDS = new Set([
        'full', 'thumb', 'thumbnail', 'small', 'preview', 'final',
        'copy', 'orig', 'original', 'hires', 'hi-res',
        'v1', 'v2', 'v3', '2x', '3x', '4x',
    ]);

    /**
     * Split a name into the part that is a variant word and the rest.
     * Returns null when the stem does not end in a variant word, or when
     * stripping it would leave nothing ("full.png" is a name, not a
     * variant of nothing).
     */
    function stripVariant(stem) {
        const m = /^(.*?)[ _.\-#]*([A-Za-z][A-Za-z0-9]*)$/.exec(stem);
        if (!m) return null;
        const head = m[1];
        const word = m[2].toLowerCase();
        if (!head) return null;
        if (!VARIANT_WORDS.has(word)) return null;
        return { head: head, variant: word };
    }

    /**
     * Split a stem into the part before a trailing frame number and the
     * number itself. "frame-01" → {head:'frame', index:1};
     * "01" → {head:'', index:1}.
     */
    function stripIndex(stem) {
        // The digit run must be COMPLETE: "plate-12345" is a name, not
        // frame 2345 of "plate-1".
        const m = /(\d+)$/.exec(stem);
        if (!m) return null;
        const digits = m[1];
        if (digits.length > 4) return null;
        const head = stem.slice(0, stem.length - digits.length).replace(/[\s_.\-#()]+$/, '');
        return { head: head, index: parseInt(digits, 10) };
    }

    /** Lowercase, and anything that is not a letter or digit becomes a dash. */
    function normalize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    /**
     * Read a filename (and optionally its path) into its parts.
     *
     * @param {string} filename  the base name, e.g. "frame-01_full.png"
     * @param {string} [relPath] the path relative to the dropped root,
     *                            e.g. "2026-10-23/frame-01_full.png"
     * @returns {{base:string, dir:string, stem:string, ext:string,
     *            prefix:string, prefixNorm:string, index:number|null,
     *            variant:string|null}}
     */
    function parseName(filename, relPath) {
        const raw = relPath || filename || '';
        const parts = raw.split('/').filter(Boolean);
        const base = parts.length ? parts[parts.length - 1] : raw;
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';

        // Peel from the end: variant word, frame number, variant word…
        // "cover-final-01" → prefix "cover", index 1, variant "final".
        let rest = stem;
        let index = null;
        let variant = null;
        for (let pass = 0; pass < 4; pass++) {
            const v = stripVariant(rest);
            if (v) {
                rest = v.head;
                variant = v.variant;
                continue;
            }
            const i = stripIndex(rest);
            if (i) {
                rest = i.head;
                index = i.index;
                continue;
            }
            break;
        }

        return {
            base: base,
            dir: dir,
            stem: stem,
            ext: ext,
            prefix: rest,
            prefixNorm: normalize(rest),
            index: index,
            variant: variant,
        };
    }

    /**
     * The identity of a FRAME inside a batch. Two files with the same
     * frame key are the same frame at two sizes, so only one is kept.
     */
    function frameKeyOf(parsed) {
        // The prefix is part of the key on purpose: "frame-01" and "01"
        // can be the same frame written two ways, but "01_full" and
        // "01_thumb" are the same frame at two sizes and must collapse
        // to one. The variant word is already gone from the prefix, so
        // those two agree here and those two do not.
        if (parsed.index !== null) return 'i' + parsed.index + '|' + parsed.prefixNorm;
        return 'p|' + (parsed.prefixNorm || parsed.stem);
    }

    /** Natural order, so "frame-2" comes before "frame-10". */
    function byName(a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
    }

    /**
     * A file descriptor. Everything the detector needs is here, so the
     * detector never has to touch the DOM or a File object.
     *
     * @typedef {object} BatchFile
     * @property {string}  name       the base name
     * @property {string}  [path]     path relative to the dropped root
     * @property {number}  [bytes]    file size
     * @property {number}  [width]    pixel width, if already known
     * @property {number}  [height]   pixel height, if already known
     */

    /**
     * Attach the parsed parts to a file descriptor.
     * @param {BatchFile} file
     * @returns {BatchFile & {parsed:object, frameKey:string}}
     */
    function describe(file) {
        const parsed = parseName(file.name, file.path);
        return Object.assign({}, file, { parsed: parsed, frameKey: frameKeyOf(parsed) });
    }

    /**
     * Keep one copy of each frame: the biggest one.
     *
     * A frame is "bigger" by pixel area when the size is known, and by
     * file size otherwise. A thumbnail and a full render of the same
     * frame are the same frame; only the full render belongs in the
     * video.
     *
     * The rule is deliberately narrow: two files collapse into one ONLY
     * when their names differ by a variant word ("01_full" against
     * "01_thumb"). Two files with the SAME name and no variant word are
     * not variants of each other — they are two different images that
     * happen to be called the same thing, and dropping one of them
     * would lose a frame the user still has.
     *
     * @param {Array} files  described files
     * @returns {{kept:Array, dropped:Array}}
     */
    function partitionVariants(files) {
        const kept = [];
        const dropped = [];
        files.forEach(f => {
            const twin = kept.find(k => k.frameKey === f.frameKey && k.parsed.variant !== f.parsed.variant);
            if (!twin) {
                kept.push(f);
                return;
            }
            if (isBigger(f, twin)) {
                kept[kept.indexOf(twin)] = f;
                dropped.push({ file: twin, because: f.name });
            } else {
                dropped.push({ file: f, because: twin.name });
            }
        });
        return { kept: kept, dropped: dropped };
    }

    /**
     * One file per frame — the biggest copy of each.
     * @param {Array} files  described files
     * @returns {Array}
     */
    function pickCanonicalVariants(files) {
        return partitionVariants(files).kept;
    }

    function area(file) {
        if (Number.isFinite(file.width) && Number.isFinite(file.height)) {
            return file.width * file.height;
        }
        return 0;
    }

    function isBigger(candidate, current) {
        const a = area(candidate);
        const b = area(current);
        if (a && b) return a > b;
        if (a && !b) return true;
        if (!a && b) return false;
        return Number(candidate.bytes || 0) > Number(current.bytes || 0);
    }

    /**
     * Order the frames of one batch: numbered frames first, in number
     * order; then anything unnumbered, in name order.
     *
     * Unnumbered files go last on purpose. A file called "cover.png"
     * next to "01.png"…"08.png" is usually a poster, not a frame of the
     * run, and a poster at the end of a loop is less wrong than a poster
     * in the middle of it. The UI shows the order, so this is visible.
     */
    function orderBatch(files) {
        const numbered = files.filter((f) => f.parsed.index !== null)
            .sort((a, b) => a.parsed.index - b.parsed.index || byName(a, b));
        const unnumbered = files.filter((f) => f.parsed.index === null).sort(byName);
        return numbered.concat(unnumbered);
    }

    /**
     * A label a human can read.
     */
    function labelFor(scope, prefixNorm, count) {
        const scopeLabel = scope ? scope.split('/').pop() : '';
        if (prefixNorm && scopeLabel) return scopeLabel + ' · ' + prefixNorm;
        if (prefixNorm) return prefixNorm;
        if (scopeLabel) return scopeLabel;
        return count > 1 ? 'batch of ' + count : 'single image';
    }

    /**
     * Group files into batches.
     *
     * @param {BatchFile[]} files
     * @param {object} [opts]
     * @param {string} [opts.mode='auto']  'auto' (filename + folder),
     *                                     'folder' (folder only),
     *                                     'single' (one batch, all of them)
     * @returns {{batches:Array, mode:string, total:number}}
     */
    function detectBatches(files, opts) {
        const options = opts || {};
        const mode = options.mode || 'auto';
        const list = (files || []).filter(Boolean).map(describe);

        if (mode === 'single') {
            const { kept, dropped } = partitionVariants(list);
            return {
                mode: mode,
                total: list.length,
                batches: [{
                    key: 'single',
                    label: list.length > 1 ? 'all images (' + list.length + ')' : 'single image',
                    scope: '',
                    prefix: '',
                    files: orderBatch(kept),
                    count: kept.length,
                    dropped: dropped,
                    singleton: kept.length <= 1,
                    reason: 'one video, by request',
                }],
            };
        }

        if (mode === 'folder') {
            const groups = new Map();
            list.forEach((f) => {
                const key = f.parsed.dir || '(no folder)';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(f);
            });
            return {
                mode: mode,
                total: list.length,
                batches: [...groups.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([key, group]) => {
                        const { kept, dropped } = partitionVariants(group);
                        return {
                            key: 'dir:' + key,
                            label: labelFor(key, '', kept.length),
                            scope: key,
                            prefix: '',
                            files: orderBatch(kept),
                            count: kept.length,
                            dropped: dropped,
                            singleton: kept.length <= 1,
                            reason: 'grouped by folder',
                        };
                    }),
            };
        }

        // --- auto: scope + prefix ---
        const groups = new Map();
        list.forEach((f) => {
            const scope = f.parsed.dir || '';
            const prefix = f.parsed.prefixNorm;
            const key = scope + '::' + prefix;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        });

        // A file with no prefix at all ("01_full.png") carries only a
        // frame number. It joins the batch in its folder that already
        // has that frame number, because that is the same frame written
        // two ways — but only if exactly one such batch exists, so the
        // guess is never made on a coin toss.
        const byKey = new Map([...groups.entries()]);
        const loose = [...byKey.keys()].filter((k) => k.endsWith('::'));
        loose.forEach((looseKey) => {
            const looseFiles = byKey.get(looseKey);
            const looseScope = looseKey.slice(0, -2);
            const looseIndices = new Set(
                looseFiles.map((f) => f.parsed.index).filter((n) => n !== null)
            );
            if (!looseIndices.size) return;
            const candidates = [...byKey.keys()].filter((k) => {
                if (k === looseKey) return false;
                if (!k.startsWith(looseScope + '::')) return false;
                const other = byKey.get(k);
                return other.some((f) => looseIndices.has(f.parsed.index));
            });
            if (candidates.length !== 1) return;
            const target = candidates[0];
            byKey.get(target).push(...looseFiles);
            byKey.delete(looseKey);
        });

        const batches = [...byKey.entries()]
            .map(([key, group]) => {
                const sep = key.indexOf('::');
                const scope = key.slice(0, sep);
                const prefix = key.slice(sep + 2);
                const { kept, dropped } = partitionVariants(group);
                return {
                    key: key,
                    label: labelFor(scope, prefix, kept.length),
                    scope: scope,
                    prefix: prefix,
                    files: orderBatch(kept),
                    count: kept.length,
                    dropped: dropped,
                    singleton: kept.length <= 1,
                    reason: scope
                        ? 'folder "' + scope + '" + name "' + (prefix || '(number only)') + '"'
                        : 'name "' + (prefix || '(number only)') + '"',
                };
            })
            .sort((a, b) => {
                if (a.count !== b.count) return b.count - a.count;
                return a.label.localeCompare(b.label);
            });

        return { mode: mode, total: list.length, batches: batches };
    }

    const BatchDetect = {
        VARIANT_WORDS: VARIANT_WORDS,
        parseName: parseName,
        normalize: normalize,
        describe: describe,
        frameKeyOf: frameKeyOf,
        partitionVariants: partitionVariants,
        pickCanonicalVariants: pickCanonicalVariants,
        orderBatch: orderBatch,
        labelFor: labelFor,
        detectBatches: detectBatches,
    };

    // CommonJS (Node, tests) — the file must not touch browser APIs here.
    if (typeof module === 'object' && module && typeof module.exports === 'object') {
        module.exports = BatchDetect;
    }

    if (typeof window !== 'undefined' && window) {
        window.BatchDetect = BatchDetect;
    }
})();
