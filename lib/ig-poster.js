#!/usr/bin/env node
'use strict';
// lib/ig-poster.js
//
// Instagram end-to-end poster.
//
// Takes a post-ready reel (vertical MP4 + cover JPG + POST.md) and
// posts it to Instagram via the web interface using a headed browser.
//
// Usage:
//   node lib/ig-poster.js <reel-dir> [--cookies <file>] [--dry-run]
//
// <reel-dir> should contain:
//   - *.mp4 (the reel)
//   - *.jpg (the cover)
//   - POST.md (caption)
//
// Exit: 0 posted · 1 fatal · 2 posted but claim failed

const fs = require('node:fs');
const path = require('node:path');

const {
    parseCookieFile,
    toBrowserCookies,
    describe: describeCookies,
    validate,
    defaultCookiePath,
} = require('./ig-cookies.js');

// Reuse CDP helpers from mj-submitter
const {
    cdpConnect: cdpConnectOrig,
    CDPClient: CDPClientOrig,
    checkChromeOnPort,
} = require('./mj-submitter.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'ig-config.json'), 'utf8'));

function log(msg) { process.stdout.write(`[ig-poster] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ig-poster] ${msg}\n`); }

// Re-export for ig-watcher
module.exports = {
    cdpConnect: cdpConnectOrig,
    CDPClient: CDPClientOrig,
    checkChromeOnPort,
};

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return p;
}

const REEL_DIR = ARGV[0] ? path.resolve(ARGV[0]) : null;
const COOKIES_FILE = expandHome(argVal('--cookies', CONFIG.cookiesFile || defaultCookiePath()));
const USER_DATA_DIR = expandHome(argVal('--user-data-dir', CONFIG.userDataDir));
const BROWSER_BIN = expandHome(argVal('--browser', CONFIG.browserBin));
const PORT = parseInt(argVal('--port', String(CONFIG.chrome?.debugPort || 9445)), 10);
const DRY_RUN = ARGV.includes('--dry-run');
const OUTPUT_DIR = expandHome(argVal('--output', CONFIG.post?.outputDir || 'reel-inbox/posted'));

// ---------- Helpers ----------

/**
 * Find the reel MP4 in the directory.
 */
function findReelMp4(dir) {
    const files = fs.readdirSync(dir);
    return files.find(f => f.toLowerCase().endsWith('.mp4'));
}

/**
 * Find the cover JPG in the directory.
 */
function findCoverJpg(dir) {
    const files = fs.readdirSync(dir);
    return files.find(f => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'));
}

/**
 * Read caption from POST.md.
 */
function readCaption(dir) {
    const postMdPath = path.join(dir, 'POST.md');
    if (!fs.existsSync(postMdPath)) {
        return { text: '', hashtags: '' };
    }
    const content = fs.readFileSync(postMdPath, 'utf8');
    
    // Extract title (first heading) and body
    const lines = content.split('\n');
    let title = '';
    let body = [];
    let inNext = false;
    
    for (const line of lines) {
        if (line.startsWith('# ') && !title) {
            title = line.slice(2).trim();
        } else if (line.startsWith('## ')) {
            inNext = line.includes('Next');
        } else if (inNext && line.trim()) {
            // Skip the manual instructions
            break;
        } else if (!inNext && title && line.trim()) {
            body.push(line);
        }
    }
    
    // Extract hashtags from body
    const hashtagRegex = /#[a-zA-Z0-9_]+/g;
    const hashtags = (content.match(hashtagRegex) || []).join(' ');
    
    const text = body.length > 0 ? body.join('\n').trim() : title;
    
    return { text, hashtags };
}

/**
 * Launch Chrome with remote debugging.
 */
async function launchInstagram() {
    // Launch Chrome with Instagram profile
    const args = [
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + USER_DATA_DIR,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--window-size=1280,720',
    ];
    
    log(`Launching Chrome: ${BROWSER_BIN}`);
    log(`  profile: ${USER_DATA_DIR}`);
    log(`  port: ${PORT}`);
    
    const { spawn } = require('child_process');
    const proc = spawn(BROWSER_BIN, args, {
        detached: true,
        stdio: 'ignore',
    });
    proc.unref();
    
    // Wait for Chrome to be ready
    let attempts = 0;
    const maxAttempts = 30;
    while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000));
        if (await checkChromeOnPort(PORT)) {
            log('Chrome ready');
            return;
        }
        attempts++;
    }
    throw new Error('Chrome did not become ready');
}

// ---------- Main posting logic ----------

async function postReel(reelDir) {
    log(`Processing: ${reelDir}`);
    
    // Find files
    const mp4File = findReelMp4(reelDir);
    const coverFile = findCoverJpg(reelDir);
    const { text: caption, hashtags } = readCaption(reelDir);
    
    if (!mp4File) {
        throw new Error('No MP4 file found in directory');
    }
    
    const mp4Path = path.join(reelDir, mp4File);
    const coverPath = coverFile ? path.join(reelDir, coverFile) : null;
    const fullCaption = caption + (hashtags ? '\n\n' + hashtags : '');
    
    log(`  Video: ${mp4File}`);
    if (coverPath) log(`  Cover: ${coverFile}`);
    log(`  Caption: ${caption.slice(0, 50)}...`);
    
    if (DRY_RUN) {
        log('[dry-run] Would post to Instagram');
        return { ok: true, dryRun: true };
    }
    
    // Load cookies
    if (!fs.existsSync(COOKIES_FILE)) {
        throw new Error(`Cookie file not found: ${COOKIES_FILE}`);
    }
    
    const cookies = parseCookieFile(COOKIES_FILE);
    const validation = validate(cookies);
    if (!validation.valid) {
        warn(`Cookie validation: missing ${validation.missing.join(', ')}`);
    }
    log(`Cookies loaded: ${describeCookies(cookies)}`);
    
    // Ensure output dir exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Launch browser
    await launchInstagram();
    
    // Connect via CDP
    const wsUrl = await cdpConnectOrig(PORT);
    const cdp = new CDPClientOrig(wsUrl);
    await cdp.connect();
    log('Connected to Chrome via CDP');
    
    try {
        // Set cookies
        const browserCookies = toBrowserCookies(cookies);
        await cdp.send('Network.setCookies', { cookies: browserCookies });
        log('Cookies set');
        
        // Navigate to Instagram
        await cdp.send('Page.navigate', { url: 'https://www.instagram.com/' });
        await new Promise(r => setTimeout(r, 3000)); // Wait for load
        
        // Check if logged in by looking for the create button
        const createBtn = await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('a[href="/compose/"]') || document.querySelector('svg[aria-label="Create"]')`,
        });
        
        if (!createBtn.result || !createBtn.result.objectId) {
            throw new Error('Not logged in - could not find create button');
        }
        log('Logged in to Instagram');
        
        // Click create button
        await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('a[href="/compose/"]')?.click() || document.querySelector('svg[aria-label="Create"]')?.closest('a')?.click()`,
        });
        await new Promise(r => setTimeout(r, 2000));
        
        log('Preparing to upload video...');
        
        // Upload video using file input - simpler approach
        // Read file as base64
        const videoData = fs.readFileSync(mp4Path);
        const base64 = videoData.toString('base64');
        
        // Inject file input and upload
        await cdp.send('Runtime.evaluate', {
            expression: `
                (function() {
                    // Find or create file input
                    let input = document.querySelector('input[type="file"]');
                    if (!input) {
                        input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'video/mp4,video/*';
                        document.body.appendChild(input);
                    }
                    
                    // Convert base64 to blob
                    const byteCharacters = atob('${base64}');
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: 'video/mp4' });
                    
                    // Create File object
                    const file = new File([blob], '${mp4File}', { type: 'video/mp4' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    
                    return { uploaded: true, filename: '${mp4File}' };
                })()
            `,
        });
        
        await new Promise(r => setTimeout(r, 5000)); // Wait for upload
        
        // Check if we're on the edit screen - look for caption area
        const editScreen = await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('textarea') || document.querySelector('[contenteditable="true"]') || document.querySelector('div[role="textbox"]')`,
        });
        
        if (editScreen.result?.objectId) {
            // Type caption - escape special chars
            const escapedCaption = fullCaption.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
            await cdp.send('Runtime.evaluate', {
                expression: `
                    (function() {
                        const area = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]') || document.querySelector('div[role="textbox"]');
                        if (area) {
                            area.focus();
                            // Use document.execCommand for more reliable input
                            area.innerText = '${escapedCaption}';
                            area.dispatchEvent(new Event('input', { bubbles: true }));
                            area.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        return { captionSet: !!area };
                    })()
                `,
            });
            log('Caption set');
            
            // Click share/post button
            await cdp.send('Runtime.evaluate', {
                expression: `
                    (function() {
                        const btn = Array.from(document.querySelectorAll('button')).find(b => 
                            b.textContent.includes('Share') || 
                            b.textContent.includes('Post') ||
                            b.getAttribute('aria-label')?.includes('Post')
                        );
                        if (btn) btn.click();
                        return { clicked: !!btn };
                    })()
                `,
            });
            
            await new Promise(r => setTimeout(r, 5000)); // Wait for post
            
            log('Post submitted');
        }
        
        // Verify post
        await new Promise(r => setTimeout(r, 3000));
        
        // Check for success indicators
        const successCheck = await cdp.send('Runtime.evaluate', {
            expression: `
                (function() {
                    const url = window.location.href;
                    const hasPost = url.includes('/p/') || url.includes('/reel/');
                    const error = document.querySelector('[role="alert"]')?.textContent;
                    return { url, hasPost, error };
                })()
            `,
        });
        
        if (successCheck.result?.value?.hasPost) {
            log(`Posted successfully: ${successCheck.result.value.url}`);
            return { ok: true, url: successCheck.result.value.url };
        } else if (successCheck.result?.value?.error) {
            throw new Error('Post failed: ' + successCheck.result.value.error);
        } else {
            log('Post may have succeeded, manual verification recommended');
            return { ok: true, verified: false };
        }
        
    } finally {
        // Close CDP
        try { await cdp.send('Page.close'); } catch {}
    }
}

// ---------- Main ----------

async function main() {
    if (!REEL_DIR) {
        console.error('Usage: node ig-poster.js <reel-dir> [--cookies <file>] [--dry-run]');
        console.error('  <reel-dir>  Directory containing MP4, JPG cover, and POST.md');
        process.exit(1);
    }
    
    if (!fs.existsSync(REEL_DIR)) {
        console.error(`Directory not found: ${REEL_DIR}`);
        process.exit(1);
    }
    
    try {
        const result = await postReel(REEL_DIR);
        
        if (result.ok && !result.dryRun) {
            // Move to posted folder
            const postedPath = path.join(OUTPUT_DIR, path.basename(REEL_DIR));
            if (!fs.existsSync(postedPath)) {
                fs.renameSync(REEL_DIR, postedPath);
            }
            log(`Moved to: ${postedPath}`);
            process.exit(0);
        } else if (result.dryRun) {
            log('[dry-run] Not moving files');
            process.exit(0);
        } else {
            process.exit(2);
        }
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }
}

main();
