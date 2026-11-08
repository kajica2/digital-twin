#!/usr/bin/env node
'use strict';
// tools/verify-composed-flags.js
//
// THE FLAG CONTRACT for a pack's composed commands — checked, not read.
//
// The house rule: "verify the composed command rather than assuming
// it". A dry run that prints the exact composed text costs no
// generation, and every duplicated-flag bug in this repo was caught
// this way.
//
// So this reads a pack through the SUBMITTER'S OWN parser and the
// COMPOSER'S OWN function, then asserts the contract:
//
//   * exactly one --ar, and it is LAST
//   * exactly one --sref (when the pack carries a style reference)
//   * never two --style, two --raw or two --s
//   * the --style/--s slot is owned by ONE side: if the prompt
//     carries --raw or --style, the config's --style AND its coupled
//     --s must both be gone
//
// Usage:
//   node tools/verify-composed-flags.js <pack.md> [<pack.md> ...]
//
// Exit: 0 every command is well-formed · 2 bad input · 3 a command is malformed

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { extractPrompts } = require(path.join(REPO, 'lib', 'mj-submitter.js'));
const { buildFullPrompt } = require(path.join(REPO, 'lib', 'mj-flags.js'));
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'mj-config.json'), 'utf8'));
const DEFAULT_ARGS = (cfg.mj && cfg.mj.defaultArgs) || '';

const packs = process.argv.slice(2).filter(a => !a.startsWith('--'));
function log(m) { process.stdout.write(m + '\n'); }
function warn(m) { process.stderr.write(m + '\n'); }

if (!packs.length) {
    warn('usage: verify-composed-flags.js <pack.md> [<pack.md> ...]');
    process.exit(2);
}

const count = (s, re) => (s.match(re) || []).length;

let bad = 0;
let checked = 0;

for (const pack of packs) {
    const abs = path.resolve(pack);
    if (!fs.existsSync(abs)) {
        warn(`no such pack: ${abs}`);
        process.exit(2);
    }
    const parsed = extractPrompts(abs);
    log(`\n${path.relative(REPO, abs)} — ${parsed.length} prompt(s)`);

    parsed.forEach((p, i) => {
        const cmd = buildFullPrompt(p.text, p.ar, DEFAULT_ARGS);
        const problems = [];

        const ar = count(cmd, /--ar/g);
        if (ar !== 1) problems.push(`--ar appears ${ar} times`);
        else if (!/--ar\s+\S+$/.test(cmd.trim())) problems.push('--ar is not LAST');

        const sref = count(cmd, /--sref/g);
        if (sref > 1) problems.push(`--sref appears ${sref} times`);

        if (count(cmd, /--style/g) > 1) problems.push(`--style appears ${count(cmd, /--style/g)} times`);
        if (count(cmd, /--raw/g) > 1) problems.push(`--raw appears ${count(cmd, /--raw/g)} times`);
        if (count(cmd, /(^|\s)--s\s/g) > 1) problems.push(`--s appears ${count(cmd, /(^|\s)--s\s/g)} times`);

        // The style slot is owned by ONE side. If the prompt carries
        // --raw or --style, the config's --style and its coupled --s
        // must both be gone — two --s flags means MJ honours the LAST
        // and the config silently overrides the artist.
        const promptOwnsStyle = /(--style\b|--raw\b)/.test(p.text);
        if (promptOwnsStyle) {
            if (/--style\b/.test(cmd)) problems.push("the config's --style survived a prompt that owns the slot");
            if (/(^|\s)--s\s/.test(cmd)) problems.push("the config's --s survived a prompt that owns the slot");
        }

        // The ratio the parser surfaced must be the ratio that is sent.
        const sent = (cmd.match(/--ar\s+(\S+)/) || [])[1];
        if (p.ar && sent !== p.ar) problems.push(`the sent ratio ${sent} is not the parsed ratio ${p.ar}`);

        checked++;
        if (problems.length) {
            bad++;
            log(`  ${String(i + 1).padStart(2, '0')}  MALFORMED: ${problems.join('; ')}`);
            log(`      ${cmd.slice(0, 160)}`);
        } else {
            log(`  ${String(i + 1).padStart(2, '0')}  ok  --ar ${sent} (last) · --sref ${sref} · --raw/--style/--s clean`);
        }
    });
}

log('');
if (bad) {
    warn(`${bad}/${checked} command(s) are malformed`);
    process.exit(3);
}
log(`${checked}/${checked} composed command(s) satisfy the flag contract`);
