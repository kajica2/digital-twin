#!/usr/bin/env node
'use strict';
// lib/suno-styles.test.js
//
// Tests for the PURE half of the Suno style-variant builder.
//
// The builder is the piece that decides what text Suno receives. It
// composes the tags out of two parts — a reference-lock DIRECTIVE (the
// "Copy Prompt" block of a protocol) and the song's own style
// DESCRIPTOR — under the server's 1000-character tag cap, with the
// descriptor always preserved. If the cap is enforced on the wrong
// half, the generation loses the style that makes it a variation of
// the reference song rather than a different song.
//
//   node lib/suno-styles.test.js

const path = require('node:path');

const {
    LIMITS,
    parsePresetsFromHtml,
    loadPresets,
    copyPrompt,
    truncateAtBoundary,
    composeTags,
    influenceValue,
    buildVariants,
} = require('./suno-styles.js');

const REPO = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function assert(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: a, expected: e });
           process.stderr.write(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}\n`); }
}
function assertTrue(label, cond) {
    if (cond) { passed++; process.stderr.write(`  ✓ ${label}\n`); }
    else { failed++; failures.push({ label, actual: 'false', expected: 'true' });
           process.stderr.write(`  ✗ ${label}\n`); }
}

process.stderr.write(`\n[suno-styles.test]\n\n`);

// ---------- 1. influenceValue — "90% - 95%" -> 0.92 ----------

assert('a two-number range becomes its midpoint',
    influenceValue('90% - 95%'), 0.92);
assert('a single number becomes itself',
    influenceValue('88%'), 0.88);
assert('a range is floored to two decimals, never above the max',
    influenceValue('88% - 95%'), 0.91);
assert('percent signs and dashes are ignored',
    influenceValue('92%-96%'), 0.94);
assert('a value with no digits is null, not zero',
    influenceValue('n/a'), null);
assert('an empty range is null',
    influenceValue(''), null);
assertTrue('a parsed influence is never above 1',
    influenceValue('95% - 100%') <= 1);
assertTrue('a parsed influence is never below 0',
    influenceValue('0% - 5%') >= 0);

// ---------- 2. truncateAtBoundary — cut on a sentence, not mid-word ----------

assert('short text is returned unchanged',
    truncateAtBoundary('short enough', 100), 'short enough');
assert('a budget of zero yields an empty string',
    truncateAtBoundary('anything', 0), '');
assert('the cut never exceeds the budget',
    truncateAtBoundary('one. two. three. four. five.', 20).length <= 20, true);
assertTrue('a mid-sentence cut prefers a sentence boundary',
    truncateAtBoundary('one. two. three. four.', 20).endsWith('.'));
assertTrue('a cut with no sentence boundary falls back to a word boundary',
    !/\s$/.test(truncateAtBoundary('aaaa bbbb cccc dddd', 10)));

// ---------- 3. composeTags — directive + descriptor under the cap ----------

assert('a short directive and descriptor are joined by a space',
    composeTags('keep it', 'deep minor pentatonic', 1000), 'keep it deep minor pentatonic');
assert('an empty descriptor yields the directive alone',
    composeTags('keep it', '', 1000), 'keep it');
assert('an empty directive yields the descriptor alone',
    composeTags('', 'deep minor', 1000), 'deep minor');
assert('the composed tags never exceed the cap',
    composeTags('x'.repeat(2000), 'deep minor', 1000).length <= 1000, true);
assertTrue('the descriptor survives the cap — it is the song, not the directive',
    composeTags('x'.repeat(2000), 'ETHIO JAZZ', 1000).endsWith('ETHIO JAZZ'));
assert('a directive that fits is not truncated at all',
    composeTags('short', 'descriptor here', 1000), 'short descriptor here');
assert('a descriptor longer than the cap is cut on its own',
    composeTags('d', 'y'.repeat(2000), 1000), 'y'.repeat(1000));

// ---------- 4. copyPrompt — the "Copy Prompt" block only ----------

const PROTOCOL = [
    'Master Conditioning Directive:',
    'Do the thing.',
    '',
    'Copy Prompt',
    'Preserve the reference exactly.',
    '',
    'Best for:',
    'everything',
].join('\n');

assert('the directive is the text after "Copy Prompt"',
    copyPrompt(PROTOCOL), 'Preserve the reference exactly.');
assert('text with no "Copy Prompt" block is returned whole',
    copyPrompt('just text'), 'just text');
assertTrue('the "Best for:" scaffolding is not part of the directive',
    copyPrompt(PROTOCOL).indexOf('Best for:') === -1);
assertTrue('the "Master Conditioning Directive:" header is not part of it',
    copyPrompt(PROTOCOL).indexOf('Master Conditioning') === -1);

// ---------- 5. parsePresetsFromHtml — the bracket matcher ----------

const HTML_WITH_PRESETS = `
  <script>
    const PRESETS = [
      { name: "Alpha", target: "everything", influence: "90% - 95%",
        prompt: "Master Conditioning Directive:\\n\\nDo alpha.\\n\\nCopy Prompt\\n\\nAlpha directive.\\n\\nBest for:\\n\\nall" },
      { name: "Beta", target: "nothing", influence: "88%",
        prompt: "Master Conditioning Directive:\\n\\nDo beta.\\n\\nCopy Prompt\\n\\nBeta directive.\\n\\nBest for:\\n\\nnone" },
    ];
  </script>`;

const parsed = parsePresetsFromHtml(HTML_WITH_PRESETS);
assert('two presets are parsed', parsed.length, 2);
assert('the name is trimmed', parsed[0].name, 'Alpha');
assert('the influence is trimmed', parsed[1].influence, '88%');
assertTrue('the prompt is preserved verbatim', parsed[0].prompt.indexOf('Do alpha.') !== -1);

assertTrue('a page with no PRESETS array throws',
    (() => { try { parsePresetsFromHtml('<html></html>'); return false; } catch { return true; } })());
assertTrue('an unterminated array throws instead of reading to the end of the file',
    (() => { try { parsePresetsFromHtml('const PRESETS = [{ name: "x" }'); return false; } catch { return true; } })());

// A "] " inside a protocol's prose must not terminate the array early.
const HTML_WITH_BRACKET = `
  const PRESETS = [
    { name: "Bracket", target: "t", influence: "90%",
      prompt: "Copy Prompt\\n\\nUse the [edit] mode." },
  ];`;
assert('a bracket inside a protocol string does not truncate the array',
    parsePresetsFromHtml(HTML_WITH_BRACKET).length, 1);

// ---------- 6. the real presets on pages/suno-prompts.html ----------

const presets = loadPresets(REPO);
assert('the canonical page carries 10 protocols', presets.length, 10);
assertTrue('every protocol has a name', presets.every(p => p.name.length > 0));
assertTrue('every protocol has an influence range', presets.every(p => /%/.test(p.influence)));
assertTrue('every protocol carries a Copy Prompt block',
    presets.every(p => p.prompt.indexOf('Copy Prompt') !== -1));
assert('the protocol names are unique',
    new Set(presets.map(p => p.name)).size, presets.length);

// ---------- 7. buildVariants — the whole pipeline ----------

const DESCRIPTOR = 'Ethio-jazz, instrumental; vibraphone, Rhodes, organ, and upright bass; hypnotic, syncopated 13/8 at 96 BPM;';
const variants = buildVariants({ presets, descriptor: DESCRIPTOR, songTitle: 'KO TO TAMO VERA' });

assert('one variant per protocol', variants.length, 10);
assert('the variant carries the protocol name', variants[0].preset, presets[0].name);
assert('the variant title is "<song> - <protocol>"',
    variants[0].title, `KO TO TAMO VERA - ${presets[0].name}`);
assert('the influence is the range midpoint',
    variants[0].influenceValue, influenceValue(presets[0].influence));
assertTrue('every variant has a numeric influence',
    variants.every(v => typeof v.influenceValue === 'number' && v.influenceValue > 0));
assertTrue('every title fits the 100-character server limit',
    variants.every(v => v.title.length <= LIMITS.title));
assertTrue('every tag string fits the 1000-character server limit',
    variants.every(v => v.tags.length <= LIMITS.tags));
assertTrue('every variant preserves the song descriptor',
    variants.every(v => v.tags.indexOf('hypnotic, syncopated 13/8 at 96 BPM') !== -1));
assertTrue('every variant carries its own directive',
    variants.every(v => v.directive.length > 0 && v.tags.indexOf(v.directive) === 0));
assert('the reported tag length matches the tag string',
    variants[0].tagsLength, variants[0].tags.length);
assert('the reported title length matches the title string',
    variants[0].titleLength, variants[0].title.length);

// The builder must be deterministic: the same inputs give the same
// variants, or a re-run would change what the song sounds like.
assert('the builder is deterministic',
    buildVariants({ presets, descriptor: DESCRIPTOR, songTitle: 'KO TO TAMO VERA' })
        .map(v => v.tags).join('|'),
    variants.map(v => v.tags).join('|'));

// A missing descriptor still yields a usable variant (the directive alone).
const noDesc = buildVariants({ presets, descriptor: '', songTitle: 'X' });
assertTrue('an empty descriptor leaves the directive intact',
    noDesc.every(v => v.tags.length > 0));

// ---------- report ----------

process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
    failures.forEach(f => process.stderr.write(`  FAILED: ${f.label}\n`));
    process.exit(1);
}
