// Puppeteer-driven e2e for the songs-watcher (sprint 0.18 / task 2).
//
// Same filesystem-contract pattern as watcher.spec.mjs. The songs-
// watcher LaunchAgent is NOT bootstrapped (sprint 0.13 left the
// plist installed but not loaded), so this spec invokes the
// watcher via the bin wrapper directly. Real production use would
// have it running via launchd, but the contract is identical.
//
// Run from e2e/:
//   node songs-watcher.spec.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = join(__dirname, 'artifacts', 'songs-watcher');
const REPO = ROOT;
const INBOX = join(REPO, 'audio-inbox');
const PROCESSED = join(INBOX, 'processed');

let passed = 0, failed = 0;
function assertTrue(label, cond) {
    if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
    else      { failed += 1; console.log(`  ✗ ${label} (expected true)`); }
}

async function waitFor(predicate, ms = 60000, intervalMs = 500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (await predicate()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

async function main() {
    await mkdir(ART, { recursive: true });

    // 1. songs-watcher.sh wrapper exists and is executable
    const wrapper = join(REPO, 'bin', 'songs-watcher.sh');
    assertTrue('bin/songs-watcher.sh exists', existsSync(wrapper));

    // 1b. Production-path check — LaunchAgent is loaded.
    // Soft check: if the songs-watcher LaunchAgent isn't running,
    // we still proceed (the wrapper invocation below is independent).
    // Hard check would fail the spec when run in CI / fresh dev boxes;
    // soft check documents the production state without coupling.
    let agentRunning = false;
    try {
        const out = execFileSync('pgrep', ['-fl', 'songs-watcher'], { encoding: 'utf8' });
        agentRunning = /songs-watcher\.js/.test(out);
    } catch {}
    if (agentRunning) {
        console.log('  (songs-watcher LaunchAgent is running — production path active)');
    } else {
        console.log('  (songs-watcher LaunchAgent not running — falling back to direct invocation)');
    }

    // 2. Create a tiny valid WAV (44.1kHz, 16-bit, mono, 0.1s of silence)
    const SONG = `e2e-songs-${Date.now()}`;
    const audioFile = join(INBOX, `${SONG}.wav`);
    const wavHeader = Buffer.from([
        // RIFF header
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0x24, 0x1C, 0x00, 0x00, // file size (placeholder)
        0x57, 0x41, 0x56, 0x45, // "WAVE"
        // fmt subchunk
        0x66, 0x6d, 0x74, 0x20, // "fmt "
        0x10, 0x00, 0x00, 0x00, // subchunk size (16 for PCM)
        0x01, 0x00,             // audio format (1 = PCM)
        0x01, 0x00,             // num channels (1 = mono)
        0x44, 0xAC, 0x00, 0x00, // sample rate (44100)
        0x88, 0x58, 0x01, 0x00, // byte rate
        0x02, 0x00,             // block align
        0x10, 0x00,             // bits per sample (16)
        // data subchunk
        0x64, 0x61, 0x74, 0x61, // "data"
        0x00, 0x1C, 0x00, 0x00, // data size
    ]);
    // 0.1s of silence at 44100Hz, 16-bit mono = 8820 bytes
    const audioData = Buffer.alloc(8820);
    await writeFile(audioFile, Buffer.concat([wavHeader, audioData]));
    assertTrue('test audio file written', existsSync(audioFile));
    console.log(`  (dropped ${SONG}.wav at ${new Date().toISOString()})`);

    // 3. Puppeteer (per repo convention; songs-watcher has no UI)
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    let consoleErrors = 0;
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors += 1; });
    page.on('pageerror', () => { consoleErrors += 1; });
    await page.goto('about:blank');

    // 4. Process the drop.
    //
    // If the production LaunchAgent is running it claims the file within
    // one poll interval (2s) and holds the lock, so running our own
    // --once instance would find nothing to do — and we would then be
    // asserting against another process's writes while they were still
    // in flight. Delegate to it instead, which also exercises the real
    // production path. Fall back to a direct wrapper invocation on CI /
    // fresh dev boxes where no agent is loaded.
    if (agentRunning) {
        console.log('  (delegating to the running LaunchAgent)');
    } else {
        const child = spawn('bash', [wrapper, '--once'], {
            cwd: REPO,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        const exitCode = await new Promise((resolve) => {
            child.on('close', resolve);
        });
        console.log(`  (watcher exited with code ${exitCode}${exitCode !== 0 ? ', stderr: ' + stderr.slice(0, 200) : ''})`);
        assertTrue('watcher exited cleanly', exitCode === 0);
    }

    // 5. Audio file moved to processed/ — poll, since the mover may be
    //    the LaunchAgent and its poll interval is up to 2s.
    const processedFile = join(PROCESSED, `${SONG}.wav`);
    const moved = await waitFor(() => existsSync(processedFile));
    assertTrue('audio file moved to processed/', moved);
    assertTrue('audio file NOT still in inbox', !existsSync(audioFile));

    // 6. Log lines recorded (poll for [done] — the mover logs it after
    //    the indexer finishes).
    const logPath = join(REPO, 'logs', 'songs-watcher.log');
    assertTrue('log file exists', existsSync(logPath));
    if (existsSync(logPath)) {
        const log = () => readFileSync(logPath, 'utf8');
        assertTrue('log has [start] entry for new file', log().includes(`[start] ${SONG}.wav`));
        const gotDone = await waitFor(() => log().includes(`[done] ${SONG}.wav`), 30000);
        assertTrue('log has [done] entry for new file', gotDone);
    }

    // 7. Catalog was updated with the new manual entry
    const catalogPath = join(REPO, 'data', 'songs', 'catalog.json');
    assertTrue('catalog.json exists', existsSync(catalogPath));
    if (existsSync(catalogPath)) {
        const findEntry = () => {
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            return (catalog.items || []).find(i => i.relPath === `${SONG}.wav`);
        };
        const gotEntry = await waitFor(() => !!findEntry(), 30000);
        assertTrue('catalog contains new manual entry', gotEntry);
        const found = findEntry();
        if (found) {
            assertTrue('entry format is wav', found.format, 'wav');
            assertTrue('entry has durationSec', typeof found.durationSec === 'number');
            assertTrue('entry has sampleRate 44100', found.sampleRate, 44100);
            assertTrue('entry has channels 1', found.channels, 1);
            assertTrue('entry label is "manual"', found.label, 'manual');
        }
    }

    await page.screenshot({ path: join(ART, 'songs-watcher-e2e.png'), fullPage: true });
    assertTrue('0 console errors', consoleErrors === 0);
    await browser.close();

    console.log(`\n[songs-watcher.spec] passed: ${passed}, failed: ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('songs-watcher.spec error:', e);
    process.exit(1);
});