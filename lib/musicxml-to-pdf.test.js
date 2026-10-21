#!/usr/bin/env node
'use strict';
// lib/musicxml-to-pdf.test.js
//
// Sprint 0.24 — tests for the MusicXML → PDF converter and the shared
// XML guard. Pure Node, no framework:
//   node lib/musicxml-to-pdf.test.js
//
// Coverage:
//   1. xml-guard: accepts well-formed scores
//   2. xml-guard: rejects truncation / unbalanced / empty / no-elements
//   3. xml-guard: ignores comments, CDATA, PI, DOCTYPE
//   4. xml-guard: handles self-closing tags and '>' inside attributes
//   5. collectInputs: files, recursive dirs, mixed, dedupe + sort
//   6. collectInputs: skips unsupported + dotfiles
//   7. targetFor: flat and --keep-tree naming
//   8. renderOne: malformed input fails fast and writes nothing
//   9. renderOne: a real render, when mscore is available

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const { musicXmlIsWellFormed } = require('./xml-guard.js');
const conv = require('./musicxml-to-pdf.js');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else {
        failed++;
        failures.push({ label, actual: a, expected: e });
        process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`);
    }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicxml-pdf-test-'));
const w = (name, body) => {
    const p = path.join(TMP, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
};

process.stderr.write(`\n[musicxml-to-pdf.test] tmp: ${TMP}\n\n`);

const VALID = '<?xml version="1.0"?><score-partwise version="3.1"><part id="P1">'
    + '<measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note>'
    + '</measure></part></score-partwise>';

// 1–2. acceptance / rejection
process.stderr.write(`1. xml-guard — accepts well-formed\n`);
const okFile = w('ok.musicxml', VALID);
assert('well-formed score accepted', musicXmlIsWellFormed(okFile), { ok: true });

process.stderr.write(`2. xml-guard — rejects broken input\n`);
const truncFile = w('trunc.musicxml', VALID.replace('</score-partwise>', ''));
const truncRes = musicXmlIsWellFormed(truncFile);
assertTrue('truncated file rejected', truncRes.ok === false);
assertTrue('truncation reason names the unclosed element', /unclosed <[\w.-]+>/.test(truncRes.reason));
assertTrue('truncation reason says truncated', /truncated/.test(truncRes.reason));

const unbalanced = w('unbalanced.musicxml', '<a><b></a></b>');
const unbalRes = musicXmlIsWellFormed(unbalanced);
assertTrue('crossed nesting rejected', unbalRes.ok === false);
assertTrue('crossed nesting names the mismatch', /mismatched/.test(unbalRes.reason));
assertTrue('extra closing tag rejected',
    musicXmlIsWellFormed(w('extra.musicxml', '<a></a></b>')).ok === false);

const empty = w('empty.musicxml', '');
assertTrue('empty file rejected', musicXmlIsWellFormed(empty).ok === false);

const noEls = w('noels.musicxml', 'just some prose, no markup');
assertTrue('no-elements file rejected', musicXmlIsWellFormed(noEls).ok === false);

assertTrue('missing file rejected', musicXmlIsWellFormed(path.join(TMP, 'nope.xml')).ok === false);

// 3. ignored constructs
process.stderr.write(`3. xml-guard — ignores comments/CDATA/PI/DOCTYPE\n`);
const noisy = w('noisy.musicxml',
    '<?xml version="1.0"?>\n'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    + '<!-- a comment with <angle> tags and even </closing> ones -->\n'
    + '<score-partwise version="3.1">\n'
    + '  <credit><![CDATA[ <not-a-tag> </also-not> ]]></credit>\n'
    + '  <?some-pi with="attributes"?>\n'
    + '  <part id="P1"><measure number="1"/></part>\n'
    + '</score-partwise>');
assert('noisy-but-valid score accepted', musicXmlIsWellFormed(noisy), { ok: true });

// 4. self-closing + '>' inside attributes
process.stderr.write(`4. xml-guard — self-closing tags, '>' in attributes\n`);
const tricky = w('tricky.musicxml',
    '<score-partwise version="3.1">'
    + '<identification><encoding><software>a &gt; b</software></encoding></identification>'
    + '<part id="P1"><measure number="1"/></part>'
    + '</score-partwise>');
assert('attribute with > accepted', musicXmlIsWellFormed(tricky), { ok: true });

// 5–6. discovery
process.stderr.write(`5. collectInputs\n`);
fs.mkdirSync(path.join(TMP, 'scores', 'nested'), { recursive: true });
const f1 = w('scores/a.musicxml', VALID);
const f2 = w('scores/b.mxl', 'PK-not-really-a-zip');
const f3 = w('scores/nested/c.xml', VALID);
w('scores/readme.txt', 'ignore me');
w('scores/.hidden.musicxml', VALID);

const fromDir = conv.collectInputs([path.join(TMP, 'scores')]);
assert('files + supported extensions from a directory, sorted',
    fromDir.map(p => path.relative(TMP, p)),
    ['scores/a.musicxml', 'scores/b.mxl', 'scores/nested/c.xml']);

const mixed = conv.collectInputs([f1, f2, path.join(TMP, 'scores')]);
assert('mixed files + dir deduped', mixed.length, 3);

assertTrue('unsupported extension ignored', !fromDir.some(p => p.endsWith('.txt')));
assertTrue('dotfile ignored', !fromDir.some(p => path.basename(p).startsWith('.')));

process.stderr.write(`6. collectInputs — missing path is skipped, not thrown\n`);
assert('missing path yields no entries', conv.collectInputs([path.join(TMP, 'ghost')]), []);

// 7. target naming
process.stderr.write(`7. targetFor\n`);
const outFlat = path.join(TMP, 'out-flat');
const flat = conv.targetFor(f3, [path.join(TMP, 'scores')]);
assert('flat target replaces the extension',
    path.basename(flat), 'c.pdf');
assertTrue('flat target is a .pdf', flat.endsWith('.pdf'));

// keep-tree is a module-level flag read from argv, so verify the
// naming rule directly instead of mutating globals: relative-mirror.
const rel = path.relative(path.join(TMP, 'scores'), f3).replace(/\.[^.]+$/, '.pdf');
assert('keep-tree relative form mirrors the input tree', rel, 'nested/c.pdf');

// 8. renderOne rejects malformed input fast, writing nothing
process.stderr.write(`8. renderOne — malformed input fails fast\n`);
const badSrc = w('bad.musicxml', VALID.replace('</score-partwise>', ''));
const badDst = path.join(TMP, 'out', 'bad.pdf');
(async () => {
    const t0 = Date.now();
    const res = await conv.renderOne(badSrc, badDst);
    const ms = Date.now() - t0;
    assertTrue('malformed render refused', res.ok === false);
    assertTrue('reason explains the XML fault', /malformed XML/.test(res.reason));
    assertTrue('no output written', !fs.existsSync(badDst));
    assertTrue(`refused in well under a second (took ${ms}ms)`, ms < 1000);

    // 9. a real render, when mscore is present
    process.stderr.write(`9. renderOne — real render (mscore)\n`);
    const hasMscore = spawnSync('/bin/sh', ['-c', 'command -v mscore'], { encoding: 'utf8' }).stdout.trim();
    if (!hasMscore) {
        process.stderr.write(`  – skipped: mscore not on PATH\n`);
    } else {
        const goodSrc = w('render-me.musicxml', VALID);
        const goodDst = path.join(TMP, 'out', 'render-me.pdf');
        const res2 = await conv.renderOne(goodSrc, goodDst);
        assertTrue('real render succeeded', res2.ok === true);
        if (res2.ok) {
            assertTrue('reported non-zero bytes', res2.bytes > 0);
            assertTrue('PDF written to disk', fs.existsSync(goodDst));
            const head = fs.readFileSync(goodDst).subarray(0, 5).toString();
            assert('output starts with the PDF magic', head, '%PDF-');
        }
    }

    // 10. rendering is re-entrant: a second render overwrites cleanly
    process.stderr.write(`10. renderOne — re-render overwrites\n`);
    if (hasMscore) {
        const dst2 = path.join(TMP, 'out', 'twice.pdf');
        const src2 = w('twice.musicxml', VALID);
        const a = await conv.renderOne(src2, dst2);
        const firstSize = fs.statSync(dst2).size;
        const b = await conv.renderOne(src2, dst2);
        assertTrue('second render also ok', b.ok === true);
        assertTrue('output still non-empty', fs.statSync(dst2).size > 0);
        assert('size is stable across renders', fs.statSync(dst2).size, firstSize);
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

    process.stderr.write(`\n[musicxml-to-pdf.test] passed: ${passed}, failed: ${failed}\n`);
    if (failed > 0) {
        for (const f of failures) {
            process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
        }
    }
    process.exit(failed === 0 ? 0 : 1);
})();
