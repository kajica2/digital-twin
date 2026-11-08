#!/usr/bin/env node
'use strict';
// tools/apply-refs.mjs — rewrite a Kišna soba prompt pack with the
// reference sheet URLs from the style/character reference set.
//
// The series' consistency system (the guide): every frame carries the
// same `--sref` (the style sheet), plus a `--cref` for each character
// that is actually in the frame, plus the same negative tail.
//
//   node tools/apply-refs.mjs <pack.md>... [--refs assets/kisna-soba/refs/refs.json]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let refsPath = 'assets/kisna-soba/refs/refs.json';
const packs = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--refs') refsPath = args[++i];
    else packs.push(args[i]);
}

if (!packs.length) {
    console.error('usage: node tools/apply-refs.mjs <pack.md>... [--refs refs.json]');
    process.exit(2);
}

const refs = JSON.parse(fs.readFileSync(refsPath, 'utf8'));
const STYLE = refs.style.url;
const CREFS = {
    lea: refs.lea.url,
    niko: refs.niko.url,
    muka: refs.muka.url,
    group: refs.group.url,
};
const TAIL = '--no text, watermark, extra limbs, photorealism, neon, harsh shadows, busy background';

/** Which characters a bullet names. */
function charactersIn(text) {
    const found = [];
    const lower = text.toLowerCase();
    if (lower.includes('lea')) found.push('lea');
    if (lower.includes('niko')) found.push('niko');
    if (lower.includes('muka')) found.push('muka');
    return found;
}

for (const pack of packs) {
    const abs = path.resolve(pack);
    const out = [];
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
        if (!line.startsWith('- ')) {
            out.push(line);
            continue;
        }
        let body = line.slice(2).trim();
        // Strip the flags the pack already carries; the reference set
        // supplies the style, the character locks and the negative tail.
        body = body.replace(/\s*--ar\s+\S+/g, '');
        body = body.replace(/\s*--style\s+\S+/g, '');
        body = body.replace(/\s*--v\s+\S+/g, '');
        body = body.replace(/\s*--sref\s+\S+/g, '');
        body = body.replace(/\s*--cref\s+\S+/g, '');
        body = body.replace(/\s*--cw\s+\S+/g, '');
        body = body.replace(/\s*--no\s+[^.]*?(?=\s+--|$)/g, '');
        body = body.replace(/\s*--no\s+[^.]*$/g, '');
        // The reference set owns the look: the old style clause in the
        // bullets would fight the --sref the reference sheet carries.
        body = body.replace(/,?\s*handmade 2D bedtime animation still,?/gi, '');
        body = body.replace(/,?\s*linocut print texture,?/gi, '');
        body = body.replace(/,?\s*deep blue and warm red ink on cream paper,?/gi, '');
        body = body.replace(/,?\s*no text,?\s*watermark,?\s*neon\b/gi, '');
        body = body.replace(/,?\s*no text,?\s*watermark,?\s*extra limbs[^.]*?(?=\s+--|$)/gi, '');
        body = body.replace(/,\s*,/g, ',');
        body = body.replace(/\s{2,}/g, ' ');
        body = body.trim();

        const who = charactersIn(body);
        const locks = [];
        if (who.length === 3) {
            locks.push(`--cref ${CREFS.group} --cw 100`);
        } else {
            for (const character of who) locks.push(`--cref ${CREFS[character]} --cw 100`);
        }
        out.push(`- ${body} --ar 16:9 --style raw --v 6.1 --sref ${STYLE} ${locks.join(' ')} ${TAIL}`.replace(/\s+/g, ' ').trim());
    }
    fs.writeFileSync(abs, out.join('\n'));
    console.log(`rewrote ${pack}`);
}
