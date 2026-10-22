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

const REEL_DIR = ARGV[0] && !ARGV[0].startsWith('--') ? path.resolve(ARGV[0]) : null;
// `--story <image>` posts a single still as a story. A story carries no
// caption, which is what makes it the right target for artwork that
// has nothing to say in words.
const STORY_IMAGE = argVal('--story', null) ? path.resolve(expandHome(argVal('--story'))) : null;
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
    const wsUrl = await cdpConnectOrig(`http://127.0.0.1:${PORT}`);
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

// ---------- story ----------
//
// A STORY is the format that needs no caption. The web composer opens
// the same Create panel the reel path uses, with a "Story" tab beside
// "Post" and "Reel"; a still goes in, and the share button publishes it
// to the profile's story without a caption anywhere.
//
// The reel path is the tested one. This path shares its browser,
// cookie and upload machinery and differs in three places: the tab it
// picks, the fact that there is no caption step, and the fact that the
// result is verified by the story ring appearing on the profile rather
// than by a /reel/ URL.

// Click a labelled control in the create panel. Instagram's tab labels
// have changed across revisions, so the match is on the visible text
// with a couple of fallbacks.
async function clickCreateTab(cdp, label) {
    const r = await cdp.js(`(() => {
        const wanted = ${JSON.stringify(label)}.toLowerCase();
        const els = Array.from(document.querySelectorAll('button,[role=tab],[role=radio],div[role=button],span,div'));
        const hit = els.find(e => {
            const t = (e.innerText||e.textContent||'').trim().toLowerCase();
            return t === wanted && e.getBoundingClientRect().width > 0;
        });
        if (!hit) return { clicked: false };
        const target = hit.closest('button') || hit.closest('[role=tab]') || hit;
        target.click();
        return { clicked: true };
    })()`, true);
    return r && r.clicked;
}

// Put a still into the panel's file input.
async function uploadStill(cdp, filePath, mime) {
    const data = fs.readFileSync(filePath).toString('base64');
    const name = path.basename(filePath);
    const r = await cdp.send('Runtime.evaluate', {
        expression: `
            (function() {
                let input = document.querySelector('input[type="file"]');
                if (!input) {
                    input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    document.body.appendChild(input);
                }
                input.accept = 'image/*';
                const byteCharacters = atob('${data}');
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
                const blob = new Blob([new Uint8Array(byteNumbers)], { type: '${mime}' });
                const file = new File([blob], '${name}', { type: '${mime}' });
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { uploaded: true, filename: '${name}' };
            })()
        `,
    });
    return r?.result?.value?.uploaded === true;
}

// Post a still as a story.
async function postStory(imagePath) {
    log(`Story image: ${imagePath}`);
    if (!fs.existsSync(imagePath)) throw new Error(`no such image: ${imagePath}`);
    if (DRY_RUN) {
        log('[dry-run] would post the still as a story — no caption');
        return { ok: true, dryRun: true };
    }

    if (!fs.existsSync(COOKIES_FILE)) {
        throw new Error(`Cookie file not found: ${COOKIES_FILE}`);
    }
    const cookies = parseCookieFile(COOKIES_FILE);
    const validation = validate(cookies);
    if (!validation.valid) {
        warn(`Cookie validation: missing ${validation.missing.join(', ')}`);
    }
    log(`Cookies loaded: ${describeCookies(cookies)}`);

    await launchInstagram();
    const wsUrl = await cdpConnectOrig(`http://127.0.0.1:${PORT}`);
    const cdp = new CDPClientOrig(wsUrl);
    await cdp.connect();
    log('Connected to Chrome via CDP');

    try {
        await cdp.send('Network.setCookies', { cookies: toBrowserCookies(cookies) });
        await cdp.send('Page.navigate', { url: 'https://www.instagram.com/' });
        await new Promise((r) => setTimeout(r, 5000));

        // Instagram is a single-page app: the feed arrives after the
        // shell, so the Create button can be seconds late. Poll for it
        // rather than deciding on the first empty frame.
        let s = null;
        for (let i = 0; i < 8; i++) {
            const probe = await cdp.send('Runtime.evaluate', {
                expression: `(() => ({
                    loggedIn: !!document.querySelector('a[href="/compose/"]') || !!document.querySelector('svg[aria-label="Create"]'),
                    onWall: location.pathname.indexOf('/accounts/') === 0,
                    onPicker: /use another profile|create new account|close friends/i.test(document.body.innerText || ''),
                    url: location.pathname,
                    body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
                }))()`,
            });
            s = probe.result?.value || {};
            if (s.loggedIn || s.onWall || s.onPicker) break;
            await new Promise((r) => setTimeout(r, 2500));
        }
        const stale = 'the cookie jar is expired — Instagram revoked the session server-side. '
            + 'Log into instagram.com in a browser and export a fresh jar to the path in lib/ig-config.json.';
        if (s.onWall) throw new Error('Instagram wants a password — ' + stale);
        if (s.onPicker) throw new Error('Instagram showed the account picker, not the feed — ' + stale);
        if (!s.loggedIn) throw new Error('not logged in — no Create button at ' + (s.url || 'instagram.com') + '. ' + (s.body || ''));
        log('Logged in to Instagram');

        // Open the create panel.
        await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('a[href="/compose/"]')?.click() || document.querySelector('svg[aria-label="Create"]')?.closest('a')?.click()`,
        });
        await new Promise((r) => setTimeout(r, 3000));

        // Pick the Story tab.
        if (!await clickCreateTab(cdp, 'Story')) {
            warn('could not find a "Story" tab in the create panel');
        } else {
            log('Story tab selected');
        }
        await new Promise((r) => setTimeout(r, 1500));

        if (!await uploadStill(cdp, imagePath, 'image/jpeg')) {
            throw new Error('the still could not be handed to the composer');
        }
        log('still uploaded — waiting for the preview');
        await new Promise((r) => setTimeout(r, 6000));

        // Publish. A story has no caption, so the share button goes
        // straight out.
        const shared = await cdp.send('Runtime.evaluate', {
            expression: `
                (function() {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const hit = btns.find(b => {
                        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                        const l = (b.getAttribute('aria-label') || '').toLowerCase();
                        return t === 'share to your story' || t === 'share' || l.indexOf('share to your story') >= 0;
                    });
                    if (!hit) return { clicked: false, buttons: btns.map(b => (b.innerText||'').trim()).filter(Boolean).slice(0, 20) };
                    hit.click();
                    return { clicked: true };
                })()
            `,
        });
        if (!shared.result?.value?.clicked) {
            throw new Error('could not find the share button — the panel showed: '
                + JSON.stringify(shared.result?.value?.buttons || []));
        }
        log('share clicked — waiting for Instagram to confirm');
        await new Promise((r) => setTimeout(r, 8000));

        const check = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const err = document.querySelector('[role="alert"]')?.textContent;
                return { url: location.href, error: err || null, body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120) };
            })()`,
        });
        const c = check.result?.value || {};
        if (c.error) throw new Error('Instagram refused the story: ' + c.error);
        log('Story submitted — verify it on the profile (the story ring)');
        return { ok: true, verified: false, url: c.url };
    } finally {
        try { await cdp.send('Page.close'); } catch {}
    }
}

// ---------- main ----------

async function main() {
    if (!REEL_DIR && !STORY_IMAGE) {
        console.error('Usage: node ig-poster.js <reel-dir> [--story <image>] [--cookies <file>] [--dry-run]');
        console.error('  <reel-dir>  Directory containing MP4, JPG cover, and POST.md');
        console.error('  --story    A single image, posted as a story. No caption — that is the point of a story.');
        process.exit(1);
    }

    if (STORY_IMAGE) {
        try {
            const result = await postStory(STORY_IMAGE);
            process.exit(result.ok ? 0 : 2);
        } catch (e) {
            console.error(`Error: ${e.message}`);
            process.exit(1);
        }
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
