#!/usr/bin/env node
/**
 * mj-download tests — pure logic only. No browser, no network, no CDN.
 *
 * The fetch path needs a headed Chrome and a live Midjourney session, so
 * it is exercised by running the CLI (see docs/MJ-WATCHER.md); what is
 * pinned here is everything that can be wrong without a browser: the
 * filename a cell is written under, which cells a slot selection means,
 * the order prompt directories are read in, and the flag surface.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    imageFileName, promptDirs, readMeta, cellsFor, downloadPack, parseArgs, usage,
} = require('./mj-download.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e && e.message ? e.message : e}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e && e.message ? e.message : e}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
}

console.log('\n1. imageFileName — the extension follows the URL');
check('a CDN cell keeps its own slot and the served format', () => {
    assertEqual(
        imageFileName('https://cdn.midjourney.com/abc/0_0_640_N.webp?method=shortest', 0),
        '0_0.webp',
    );
});
check('slot 2 of a grid', () => {
    assertEqual(imageFileName('https://cdn.midjourney.com/abc/0_2_2048_N.webp', 2), '0_2.webp');
});
check('a png job stays png', () => {
    assertEqual(imageFileName('https://cdn.midjourney.com/abc/1_3_2048_N.png', 3), '1_3.png');
});
check('a jpeg URL without a query keeps its own basename', () => {
    assertEqual(imageFileName('https://cdn.midjourney.com/abc/0_0.jpeg', 0), '0_0.jpeg');
});
check('a query string does not leak into the filename', () => {
    const name = imageFileName('https://cdn.example.com/x/0_1_640_N.webp?foo=bar', 1);
    assert(!name.includes('?'), `filename carries a query: ${name}`);
});
check('an unparseable URL still produces a name', () => {
    assertEqual(imageFileName('not-a-url', 2), '0_2.webp');
});
check('the name is a string, never a regex match array', () => {
    assert(typeof imageFileName('https://cdn.midjourney.com/abc/0_0.jpeg', 0) === 'string');
});

console.log('\n2. cellsFor — which cells a selection means');
check('no slot means every cell the job carries', () => {
    assertEqual(cellsFor(['u0', 'u1', 'u2', 'u3'], null).map((c) => c.slot), [0, 1, 2, 3]);
});
check('a named slot means only that cell', () => {
    assertEqual(cellsFor(['u0', 'u1', 'u2', 'u3'], 2), [{ url: 'u2', slot: 2 }]);
});
check('a slot the job does not have yields nothing', () => {
    assertEqual(cellsFor(['u0'], 3), []);
});
check('a job with no urls yields nothing', () => {
    assertEqual(cellsFor([], null), []);
});

console.log('\n3. promptDirs — numeric order');
check('prompt-2 is read before prompt-10', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
    for (const n of ['prompt-10', 'prompt-2', 'prompt-1']) fs.mkdirSync(path.join(dir, n));
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'prompt-3.md'), '');
    assertEqual(promptDirs(dir), ['prompt-1', 'prompt-2', 'prompt-10']);
    fs.rmSync(dir, { recursive: true, force: true });
});
check('a missing directory yields an empty list, not a throw', () => {
    assertEqual(promptDirs('/nonexistent/mjdl-' + Date.now()), []);
});

console.log('\n4. readMeta');
check('a missing meta.json is null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
    assertEqual(readMeta(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
});
check('a corrupt meta.json is null, not a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
    fs.writeFileSync(path.join(dir, 'meta.json'), '{ not json');
    assertEqual(readMeta(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
});
check('a valid meta.json comes back parsed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ imageUrls: ['a'] }));
    assertEqual(readMeta(dir).imageUrls, ['a']);
    fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n5. parseArgs — the flag surface');
check('the defaults', () => {
    const { args } = parseArgs(['--dir', 'mj-output/x']);
    assertEqual([args.dir, args.port, args.slot, args.force, args.dryRun], ['mj-output/x', 9445, null, false, false]);
});
check('every flag parses', () => {
    const { args } = parseArgs(['--dir', 'd', '--port', '9444', '--slot', '2', '--retries', '3', '--force', '--dry-run', '--json']);
    assertEqual([args.port, args.slot, args.retries, args.force, args.dryRun, args.json], [9444, 2, 3, true, true, true]);
});
check('an unknown flag is reported, not ignored', () => {
    const { unknown } = parseArgs(['--dir', 'd', '--sloft', '2']);
    assertEqual(unknown, ['--sloft']);
});
check('--help is recognised', () => {
    assert(parseArgs(['--help']).args.help === true, '--help not recognised');
});
check('the usage text names --dir and the browser requirement', () => {
    const u = usage();
    assert(u.includes('--dir'), 'usage does not name --dir');
    assert(/headed/i.test(u), 'usage does not say the browser must be headed');
});

console.log('\n6. downloadPack — the plan, without a browser');
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
    fs.mkdirSync(path.join(dir, 'prompt-01'));
    fs.writeFileSync(path.join(dir, 'prompt-01', 'meta.json'), JSON.stringify({
        imageUrls: ['https://cdn.midjourney.com/a/0_0_640_N.webp', 'https://cdn.midjourney.com/a/0_1_640_N.webp'],
    }));
    fs.mkdirSync(path.join(dir, 'prompt-02'));
    fs.writeFileSync(path.join(dir, 'prompt-02', 'meta.json'), JSON.stringify({ imageUrls: [] }));

    await checkAsync('a dry run lists every planned file and launches nothing', async () => {
        const seen = [];
        const res = await downloadPack({ dir, dryRun: true, log: (m) => seen.push(m) });
        assertEqual(res.written, []);
        const plan = seen.filter((l) => l.includes('←'));
        if (plan.length !== 2) throw new Error(`expected 2 planned files, got ${plan.length}: ${seen.join(' | ')}`);
        assert(plan[0].includes('prompt-01/0_0.webp'), `unexpected plan line: ${plan[0]}`);
    });
    await checkAsync('a prompt with no urls is skipped and named', async () => {
        const res = await downloadPack({ dir, dryRun: true, log: () => {} });
        assertEqual(res.skipped, ['prompt-02']);
    });
    await checkAsync('a directory with no prompt dirs throws a clear error', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mjdl-'));
        let msg = '';
        try {
            await downloadPack({ dir: empty, dryRun: true, log: () => {} });
        } catch (e) {
            msg = e.message;
        }
        if (!/no prompt-NN directories/.test(msg)) throw new Error(`unexpected error: ${msg}`);
        fs.rmSync(empty, { recursive: true, force: true });
    });

    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n[mj-download.test] passed: ${passed}, failed: ${failed}`);
    process.exit(failed ? 1 : 0);
})();
