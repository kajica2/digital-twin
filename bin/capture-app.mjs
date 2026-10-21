#!/usr/bin/env node
// bin/capture-app.mjs
//
// Capture the screen (or a specific window) in 5-second segments.
// macOS only — this is a thin shell around /usr/sbin/screencapture,
// which records video continuously until it receives SIGINT; we
// sleep for `seconds` and SIGINT to stop, producing a single clip.
//
// The first run may prompt for Screen Recording permission in
// System Settings → Privacy & Security → Screen Recording for the
// terminal that invoked it. One grant covers the whole session.
//
// Usage:
//   bin/capture-app.mjs                               # 1 × 5s
//   bin/capture-app.mjs --seconds 10 --count 4        # 4 × 10s
//   bin/capture-app.mjs --window-id 12345             # specific window
//   bin/capture-app.mjs --seconds 5 --count 3 \\
//                   --output-dir recordings/
//   bin/capture-app.mjs --dry-run                     # plan only
//   bin/capture-app.mjs --help

'use strict';

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HELP = `bin/capture-app.mjs — capture a screen or window in N-second clips.

Options:
  --seconds N          length of each clip (default 5)
  --count N            how many clips back-to-back (default 1)
  --output-dir DIR     where to write the clips (default ./recordings)
  --window-id N        restrict to a specific window ID (see lsappinfo)
  --no-cursor          omit the cursor from the capture
  --no-sound           silently skip if screencapture errors (default off)
  --dry-run            print the plan, do not capture
  --help, -h           this text

Outputs:
  <output-dir>/clip-001.mov, clip-002.mov, ...

Notes:
  • macOS only — uses /usr/sbin/screencapture.
  • The first run may ask for Screen Recording permission in
    System Settings → Privacy & Security → Screen Recording.
  • Each clip takes \`seconds\` plus a brief finalize (≈0.5 s) wall.
  • \`--count\` clips run sequentially; do not parallelize screen
    capture from the same terminal or the frames will overlap.
`;

const argv = process.argv.slice(2);
function arg(name) {
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return null;
}
function flag(name) {
  return argv.includes('--' + name) || argv.includes('--no-' + name.replace(/^no-/, ''));
}

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('bin/capture-app.mjs is macOS only — uses screencapture(1).');
  console.error(`Detected platform: ${process.platform}. Exiting.`);
  process.exit(2);
}

const seconds = Math.max(1, parseInt(arg('seconds') || '5', 10));
// screencapture(1) -V <seconds> enforces no minimum we have hit on
// recent macOS; small values (1–2 s) write a real QuickTime and a
// few-frame clip is fine for the use case.
const count   = Math.max(1, parseInt(arg('count')   || '1', 10));
const outDir  = arg('output-dir') || 'recordings';
const winId   = arg('window-id');
const noCursor = flag('no-cursor');
const silent   = flag('no-sound');

if (!seconds || !count) {
  console.error('--seconds and --count must be positive integers');
  process.exit(2);
}

const outAbs = resolve(outDir);
if (!existsSync(outAbs)) mkdirSync(outAbs, { recursive: true });

const plan = {
  platform: process.platform,
  seconds, count, outDir: outAbs,
  windowId: winId || null,
  noCursor,
};
console.log(JSON.stringify(plan, null, 2));

if (argv.includes('--dry-run')) {
  console.log('--dry-run: plan printed, not capturing.');
  process.exit(0);
}

(async () => {
  for (let i = 1; i <= count; i++) {
    const idx = String(i).padStart(3, '0');
    const path = join(outAbs, `clip-${idx}.mov`);
    await captureOne(path);
  }
  console.log(`done. ${count} clip(s) in ${outAbs}`);
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});

async function captureOne(path) {
  // Refuse to overwrite an existing take — a re-run on top of the
  // same --output-dir should let the user keep the prior recording
  // without surprise.
  if (existsSync(path)) {
    throw new Error(`output already exists: ${path}\n  (move it or choose a fresh --output-dir)`);
  }

  // screencapture(1) flag syntax on recent macOS:
  //   screencapture [-V<seconds>] [-C] [-l<windowid>] [-t<fmt>] <file>
  // The output filename is a positional argument; the format is
  // inferred from the extension. Concatenated flags (-V5) are the
  // canonical form for value-bearing flags.
  const args = [`-V${seconds}`];
  if (!noCursor) args.push('-C');           // capture cursor with screen
  if (winId)     args.push(`-l${winId}`);
  args.push(path);

  const t0 = Date.now();
  const exitCode = await new Promise((resolve) => {
    const sp = spawn('/usr/sbin/screencapture', args, { stdio: 'inherit' });
    sp.on('exit', (code) => resolve(code ?? 1));
  });
  const dt = Date.now() - t0;

  const exists = existsSync(path);
  const size = exists ? statSync(path).size : 0;
  console.log(`captured clip ${path} (${(dt / 1000).toFixed(2)}s wall, ${size} bytes, exit ${exitCode})`);

  if (!exists || size === 0) {
    const msg = `screencapture did not write a usable file to ${path} (exit ${exitCode}).\n` +
                `If this is the first run, grant Screen Recording permission\n` +
                `to the calling terminal in System Settings → Privacy & Security.`;
    if (silent) { console.error('warning:', msg); return; }
    throw new Error(msg);
  }
}
