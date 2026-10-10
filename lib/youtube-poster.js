#!/usr/bin/env node
'use strict';
// lib/youtube-poster.js
//
// YouTube end-to-end poster.
//
// Takes a video file and uploads it to YouTube with auto-generated
// title, description, and tags.
//
// Usage:
//   node lib/youtube-poster.js <video-file> [--cookies <file>] [--dry-run] [--title "..."] [--description "..."] [--tags "a,b,c"]
//
// Exit: 0 uploaded · 1 fatal · 2 uploaded but claim failed

const fs = require('node:fs');
const path = require('node:path');
const { parseCookieFile, toBrowserCookies, describe: describeCookies, validate, defaultCookiePath } = require('./ig-cookies.js');

// Reuse CDP helpers from mj-submitter
const { cdpConnect: cdpConnectOrig, CDPClient: CDPClientOrig, checkChromeOnPort } = require('./mj-submitter.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'youtube-config.json'), 'utf8'));

function log(msg) { process.stdout.write(`[yt-poster] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[yt-poster] ${msg}\n`); }

// Re-export for youtube-watcher
module.exports = { parseVideoFile, generateMetadata, uploadToYouTube, findVideoFile };

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const idx = ARGV.indexOf(name);
    return idx >= 0 && ARGV[idx + 1] ? ARGV[idx + 1] : fallback;
}
function expandHome(p) {
    if (!p) return p;
    return p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p;
}

const VIDEO_FILE = ARGV[0] ? path.resolve(ARGV[0]) : null;
const COOKIES_FILE = expandHome(argVal('--cookies', CONFIG.cookiesFile));
const USER_DATA_DIR = expandHome(argVal('--user-data-dir', CONFIG.userDataDir));
const BROWSER_BIN = expandHome(argVal('--browser', CONFIG.browserBin));
const PORT = parseInt(argVal('--port', String(CONFIG.chrome?.debugPort || 9446)), 10);
const DRY_RUN = ARGV.includes('--dry-run');
const OUTPUT_DIR = expandHome(argVal('--output', CONFIG.upload?.outputDir || 'youtube-inbox/uploaded'));

// CLI overrides
const CLI_TITLE = argVal('--title', null);
const CLI_DESCRIPTION = argVal('--description', null);
const CLI_TAGS = argVal('--tags', null);

// ---------- Helpers ----------

function parseVideoFile(videoPath) {
    const basename = path.basename(videoPath, path.extname(videoPath));
    const stats = fs.statSync(videoPath);
    
    // Parse filename pattern: sainted-word-YYYY-MM-DDTHH-MM-SS
    const match = basename.match(/sainted-word-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    let date = null;
    if (match) {
        date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`);
    }
    
    // Infer mood from filename keywords
    let mood = 'Ambient';
    const lower = basename.toLowerCase();
    if (lower.includes('ambient') || lower.includes('drone')) mood = 'Ambient';
    else if (lower.includes('beat') || lower.includes('rhythm')) mood = 'Rhythmic';
    else if (lower.includes('dark') || lower.includes('noir')) mood = 'Dark';
    else if (lower.includes('bright') || lower.includes('light')) mood = 'Bright';
    else if (lower.includes('dream') || lower.includes('sleep')) mood = 'Dreamy';
    else if (lower.includes('energy') || lower.includes('pulse')) mood = 'Energetic';
    
    return { basename, path: videoPath, size: stats.size, date, mood };
}

function generateMetadata(videoInfo, overrides = {}) {
    const cfg = CONFIG;
    const defaults = cfg.defaults || {};
    const titleCfg = cfg.title || {};
    const descCfg = cfg.description || {};
    
    // Generate title
    let title;
    if (overrides.title) {
        title = overrides.title;
    } else {
        const dateStr = videoInfo.date 
            ? videoInfo.date.toISOString().split('T')[0] 
            : new Date().toISOString().split('T')[0];
        title = `${titleCfg.prefix || ''}${dateStr} - ${videoInfo.mood}`;
    }
    
    // Generate description
    let description;
    if (overrides.description) {
        description = overrides.description;
    } else {
        description = (descCfg.template || '{mood}')
            .replace('{mood}', videoInfo.mood)
            .replace('{filename}', videoInfo.basename)
            .replace('{date}', videoInfo.date ? videoInfo.date.toISOString().split('T')[0] : '');
    }
    
    // Generate tags
    let tags;
    if (overrides.tags) {
        tags = overrides.tags.split(',').map(t => t.trim());
    } else {
        tags = [...(defaults.tags || [])];
        tags.push(videoInfo.mood);
    }
    
    return { title, description, tags };
}

function findVideoFile(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    const videoExts = ['.webm', '.mp4', '.mov', '.avi', '.mkv'];
    for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (videoExts.includes(ext)) {
            return path.join(dir, entry);
        }
    }
    return null;
}

async function launchYouTube() {
    const chrome = await checkChromeOnPort(PORT, BROWSER_BIN);
    if (chrome) {
        log(`Reusing existing Chrome on port ${PORT}`);
        return chrome;
    }
    
    log(`Launching Chrome for YouTube upload on port ${PORT}...`);
    const args = [
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + USER_DATA_DIR,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1400,900',
    ];
    
    const { spawn } = require('child_process');
    const proc = spawn(BROWSER_BIN, args, { 
        detached: true, 
        stdio: 'ignore',
        cwd: REPO
    });
    proc.unref();
    
    // Wait for Chrome to be ready
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const ready = await checkChromeOnPort(PORT, BROWSER_BIN);
        if (ready) {
            log('Chrome ready');
            return ready;
        }
    }
    throw new Error('Chrome failed to start');
}

async function uploadToYouTube(videoPath, metadata, opts = {}) {
    const chrome = await launchYouTube();
    const client = await cdpConnectOrig(chrome, 'youtube');
    
    // Load cookies into browser
    log('Loading YouTube cookies...');
    const cookies = parseCookieFile(COOKIES_FILE);
    const validation = validate(cookies);
    if (!validation.valid) {
        warn(`Cookie validation issues: ${validation.missing.join(', ')}`);
    }
    
    const browserCookies = toBrowserCookies(cookies, '.youtube.com');
    const CDP = await client.getDOMain();
    
    try {
        await CDP.Network.setCookies({ cookies: browserCookies });
    } catch (e) {
        warn(`Cookie set warning: ${e.message}`);
    }
    
    // Navigate to YouTube Studio upload page
    log('Navigating to YouTube Studio...');
    await CDP.Page.navigate({ url: 'https://studio.youtube.com' });
    await CDP.Page.loadEventFired();
    
    // Wait for studio to load
    await new Promise(r => setTimeout(r, 3000));
    
    // Check if we're logged in by looking for upload button
    const { result } = await CDP.Runtime.evaluate({
        expression: `
            document.body.innerText.includes('Create') || 
            document.body.innerText.includes('Upload videos') ||
            document.location.href.includes('studio.youtube.com')
        `,
        returnByValue: true
    });
    
    if (!result.value) {
        // Might need to go to classic upload
        log('Going to classic upload page...');
        await CDP.Page.navigate({ url: 'https://www.youtube.com/upload' });
        await CDP.Page.loadEventFired();
        await new Promise(r => setTimeout(r, 2000));
    }
    
    // Find and fill the file input
    log(`Uploading ${metadata.title}...`);
    
    // Upload via input[type="file"]
    const { result: uploadResult } = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const input = document.querySelector('input[type="file"]');
                if (!input) return { success: false, error: 'No file input found' };
                
                const dataTransfer = new DataTransfer();
                const file = new File([new Uint8Array(require('fs').readFileSync('${videoPath.replace(/\\/g, '\\\\')}'))], '${path.basename(videoPath)}', { type: 'video/webm' });
                dataTransfer.items.add(file);
                input.files = dataTransfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                
                return { success: true };
            })()
        `,
        returnByValue: true
    });
    
    if (!uploadResult.value?.success) {
        throw new Error(uploadResult.value?.error || 'Upload trigger failed');
    }
    
    // Wait for upload to complete
    log('Waiting for upload to complete...');
    let uploadComplete = false;
    let progress = 0;
    
    for (let i = 0; i < 300; i++) { // 5 min max
        await new Promise(r => setTimeout(r, 1000));
        
        // Check progress
        const { result: progressResult } = await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    const progress = document.body.innerText.match(/(\\d+)%/);
                    const complete = document.body.innerText.includes('Upload complete') || 
                                   document.body.innerText.includes('Video uploaded');
                    return { progress: progress ? parseInt(progress[1]) : 0, complete };
                })()
            `,
            returnByValue: true
        });
        
        if (progressResult.value) {
            if (progressResult.value.progress > progress) {
                progress = progressResult.value.progress;
                log(`Upload progress: ${progress}%`);
            }
            if (progressResult.value.complete) {
                uploadComplete = true;
                log('Upload complete!');
                break;
            }
        }
    }
    
    if (!uploadComplete) {
        throw new Error('Upload timed out');
    }
    
    // Fill in metadata
    log('Filling in video details...');
    
    // Title
    await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const inputs = document.querySelectorAll('input');
                const titleInput = Array.from(inputs).find(i => i.name === 'title' || i.ariaLabel?.includes('title'));
                if (titleInput) {
                    titleInput.value = '${metadata.title.replace(/'/g, "\\'")}';
                    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            })()
        `
    });
    
    // Description
    await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const textareas = document.querySelectorAll('textarea');
                const descInput = Array.from(textareas).find(t => t.name === 'description' || t.ariaLabel?.includes('description'));
                if (descInput) {
                    descInput.value = '${metadata.description.replace(/'/g, "\\'").replace(/\n/g, '\\n')}';
                    descInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            })()
        `
    });
    
    // Tags
    if (metadata.tags && metadata.tags.length > 0) {
        await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    const tags = '${metadata.tags.join(', ')}';
                    const inputs = document.querySelectorAll('input');
                    const tagsInput = Array.from(inputs).find(i => i.name?.includes('tags') || i.ariaLabel?.includes('tag'));
                    if (tagsInput) {
                        tagsInput.value = tags;
                        tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()
            `
        });
    }
    
    // Set visibility (unlisted by default)
    const visibility = opts.visibility || CONFIG.upload?.visibility || 'unlisted';
    await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const buttons = document.querySelectorAll('button, tp-yt-iron-dropdown');
                // Look for visibility selector
                const visButton = Array.from(buttons).find(b => 
                    b.innerText?.toLowerCase().includes('public') ||
                    b.innerText?.toLowerCase().includes('unlisted') ||
                    b.innerText?.toLowerCase().includes('private')
                );
            })()
        `
    });
    
    // Submit
    log('Submitting video...');
    await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const buttons = document.querySelectorAll('button');
                const publishBtn = Array.from(buttons).find(b => 
                    b.innerText?.toLowerCase().includes('publish') ||
                    b.innerText?.toLowerCase().includes('save') ||
                    b.innerText?.toLowerCase().includes('next')
                );
                if (publishBtn) publishBtn.click();
            })()
        `
    });
    
    // Wait for confirmation
    await new Promise(r => setTimeout(r, 3000));
    
    // Get video URL if possible
    let videoUrl = null;
    try {
        const { result: urlResult } = await CDP.Runtime.evaluate({
            expression: `window.location.href`,
            returnByValue: true
        });
        if (urlResult.value && urlResult.value.includes('youtube.com/watch')) {
            videoUrl = urlResult.value;
        }
    } catch (e) { /* ignore */ }
    
    return { success: true, url: videoUrl };
}

// ---------- Main ----------

async function main() {
    if (!VIDEO_FILE) {
        console.error('Usage: node youtube-poster.js <video-file> [--title "..."] [--description "..."] [--tags "a,b,c"] [--dry-run]');
        process.exit(1);
    }
    
    if (!fs.existsSync(VIDEO_FILE)) {
        console.error(`Video file not found: ${VIDEO_FILE}`);
        process.exit(1);
    }
    
    // Validate cookies
    if (!fs.existsSync(COOKIES_FILE)) {
        console.error(`Cookie file not found: ${COOKIES_FILE}`);
        console.error('Export cookies from a logged-in YouTube browser to Netscape format.');
        process.exit(1);
    }
    
    const cookies = parseCookieFile(COOKIES_FILE);
    const validation = validate(cookies);
    log(`Cookies: ${describeCookies(cookies)}`);
    if (!validation.valid) {
        warn(`Warning: missing cookie fields: ${validation.missing.join(', ')}`);
    }
    
    // Parse video
    const videoInfo = parseVideoFile(VIDEO_FILE);
    log(`Video: ${videoInfo.basename} (${(videoInfo.size / 1024 / 1024).toFixed(1)} MB)`);
    log(`Mood: ${videoInfo.mood}${videoInfo.date ? `, Date: ${videoInfo.date.toISOString()}` : ''}`);
    
    // Generate metadata
    const metadata = generateMetadata(videoInfo, {
        title: CLI_TITLE,
        description: CLI_DESCRIPTION,
        tags: CLI_TAGS
    });
    log(`Title: ${metadata.title}`);
    log(`Tags: ${metadata.tags.join(', ')}`);
    
    if (DRY_RUN) {
        log('[DRY RUN] Would upload with the above metadata.');
        process.exit(0);
    }
    
    try {
        const result = await uploadToYouTube(VIDEO_FILE, metadata);
        if (result.url) {
            log(`Uploaded! URL: ${result.url}`);
        } else {
            log('Uploaded! (URL not captured)');
        }
        
        // Move to uploaded directory
        if (OUTPUT_DIR) {
            const destDir = path.join(REPO, OUTPUT_DIR);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            const destPath = path.join(destDir, path.basename(VIDEO_FILE));
            fs.renameSync(VIDEO_FILE, destPath);
            log(`Moved to: ${destPath}`);
        }
        
        process.exit(0);
    } catch (e) {
        console.error(`Upload failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
});
