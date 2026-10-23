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
module.exports = { parseVideoFile, generateMetadata, uploadToYouTube, findVideoFile, cdpDomains, waitForDocument, ensureUploadDialog, makeClient };

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
const CLI_VISIBILITY = argVal('--visibility', null);

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
        // An empty segment ("a, ,b") is not a tag — it is a typo in the
        // command line, and YouTube's tag box rejects it.
        tags = overrides.tags.split(',').map(t => t.trim()).filter(Boolean);
    } else {
        tags = [...(defaults.tags || [])];
        // The mood is a tag, but not twice: the default list often
        // already carries it.
        if (!tags.includes(videoInfo.mood)) tags.push(videoInfo.mood);
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

/**
 * A domain proxy over the CDP client.
 *
 * The client in lib/mj-submitter.js exposes connect(), send() and js()
 * only — there is no getDOMain(), so CDP.Page.navigate({...}) has to
 * be built on top of send().
 */
function cdpDomains(client) {
    return new Proxy({}, {
        get(_target, domain) {
            return new Proxy({}, {
                get(_domainTarget, method) {
                    return (params = {}) => client.send(`${domain}.${method}`, params);
                },
            });
        },
    });
}

/**
 * Wait until the page has a document.
 *
 * The client has no event subscription, so the Page.loadEventFired
 * EVENT cannot be awaited — and calling it as a command returns a
 * protocol error. The document's readyState is the honest signal.
 */
async function waitForDocument(client, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const state = await client.js('document.readyState');
            if (state === 'complete' || state === 'interactive') return state;
        } catch (e) {
            // The execution context may not exist yet.
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return 'timeout';
}

/**
 * Open YouTube Studio's upload dialog.
 *
 * The channel dashboard has no file input at all — the uploader is
 * behind the "Upload videos" entry in the Create menu, and the input
 * only appears once the dialog is open. Returns 'already-open',
 * 'opened', 'no-entry' or 'timeout'.
 */
async function ensureUploadDialog(client, CDP, sleep, timeoutMs = 20000) {
    const hasInput = async () => {
        try {
            return (await client.js("document.querySelectorAll('input[type=file]').length")) > 0;
        } catch (e) {
            return false;
        }
    };
    if (await hasInput()) return 'already-open';

    const clicked = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const label = (e) => ((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).trim();
                const candidates = Array.from(document.querySelectorAll('button,[role=button],[role=menuitem],tp-yt-paper-item,a'));
                const hit = candidates.find(e => label(e) === 'Upload videos');
                if (!hit) return { clicked: false, seen: candidates.map(label).filter(Boolean).slice(0, 20) };
                hit.click();
                return { clicked: true };
            })()
        `,
        returnByValue: true,
    });
    if (!clicked?.result?.value?.clicked) return 'no-entry';

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(500);
        if (await hasInput()) return 'opened';
    }
    return 'timeout';
}

/**
 * Build a connected CDP client.
 *
 * cdpConnect resolves to a WebSocket URL, not to a client — using it
 * as one leaves you holding a string, and the first send() dies with
 * "client.send is not a function".
 */
async function makeClient(debugUrl, connect = cdpConnectOrig, Client = CDPClientOrig) {
    const wsUrl = await connect(debugUrl);
    const client = new Client(wsUrl);
    await client.connect();
    return client;
}

async function uploadToYouTube(videoPath, metadata, opts = {}) {
    // A client can be injected, and the sleeps can be short-circuited.
    //
    // Without this seam the upload path was unreachable by any test,
    // which is how a call to a method the client does not have
    // (client.getDOMain) survived in the committed code: the pure
    // parts were tested, the plumbing was not.
    const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    let client = opts.client;
    if (!client) {
        await launchYouTube();
        // cdpConnect takes a DEBUG URL, not the /json/version object
        // that checkChromeOnPort returns. Passing the object made it
        // request "[object Object]/json" and the upload never reached
        // the browser.
        client = await makeClient(`http://127.0.0.1:${PORT}`);
    }

    // Load cookies into browser
    log('Loading YouTube cookies...');
    const cookies = parseCookieFile(COOKIES_FILE);
    const validation = validate(cookies);
    if (!validation.valid) {
        warn(`Cookie validation issues: ${validation.missing.join(', ')}`);
    }
    
    const browserCookies = toBrowserCookies(cookies, 'https://studio.youtube.com');
    const CDP = cdpDomains(client);
    
    try {
        await CDP.Network.setCookies({ cookies: browserCookies });
    } catch (e) {
        warn(`Cookie set warning: ${e.message}`);
    }
    
    // Navigate to YouTube Studio upload page
    log('Navigating to YouTube Studio...');
    await CDP.Page.navigate({ url: 'https://studio.youtube.com' });
    await waitForDocument(client);
    
    // Wait for studio to load
    await sleep(3000);
    
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
        await waitForDocument(client);
        await sleep(2000);
    }
    
    // Find and fill the file input
    log(`Uploading ${metadata.title}...`);

    // Open the upload dialog first.
    //
    // The channel dashboard has NO file input — the uploader lives
    // behind the "Upload videos" entry in the Create menu, and the
    // input only exists once that dialog is open. Handing a file to
    // an input nobody is listening to starts nothing.
    const dialog = await ensureUploadDialog(client, CDP, sleep);
    log(`upload dialog: ${dialog}`);
    if (dialog === 'no-entry' || dialog === 'timeout') {
        warn('the upload dialog did not open — the video may not have been uploaded');
    }

    // Hand the file to the composer.
    //
    // `input.files` is read-only in current Chrome, so the old
    // DataTransfer → input.files = dataTransfer.files dance throws.
    // It leaned on `require('fs')`, which does not exist in the page
    // context at all, so the expression died before it read a byte and
    // the upload silently never started. DOM.setFileInputFiles sets
    // the file natively — the same call puppeteer's uploadFile() makes.
    await CDP.DOM.enable();

    // Find the input through a JavaScript handle, not through a node
    // id.
    //
    // The node-id route asks the browser for the document, then asks
    // it for a node inside that document — and Studio's dialog
    // re-renders between the two calls, so the id it handed back was
    // already gone ("No node with given id found"). A remote object
    // handle survives the re-render.
    const found = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                let input = document.querySelector('input[type="file"]');
                if (!input) {
                    input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'video/*';
                    input.style.display = 'none';
                    document.body.appendChild(input);
                }
                return input;
            })()
        `,
        returnByValue: false,
    });
    const objectId = found?.result?.objectId;
    if (!objectId) throw new Error('no file input to hand the video to');
    await CDP.DOM.setFileInputFiles({ objectId, files: [videoPath] });

    // Tell the page about it.
    //
    // DOM.setFileInputFiles sets the file but fires no event, and
    // YouTube's uploader starts on the input's change event. Puppeteer's
    // uploadFile() dispatches it for exactly this reason. Without it
    // the file sits in the input and the upload never starts.
    await CDP.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function () {
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return this.files ? this.files.length : 0;
        }`,
        returnByValue: true,
    });
    log('change event dispatched');
    log('file handed to the composer');
    
    // Wait for upload to complete
    log('Waiting for upload to complete...');
    let uploadComplete = false;
    let progress = 0;
    
    // A 150 MB master does not upload in five minutes on every
    // connection — the old budget turned a slow uplink into a failed
    // publish, which is the worst possible way to lose the file.
    const uploadBudgetMs = Number(process.env.YT_UPLOAD_TIMEOUT_MS || 900000);
    for (let i = 0; i < uploadBudgetMs / 1000; i++) {
        await sleep(1000);
        
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
    //
    // Studio's fields are React-controlled, so assigning `.value` and
    // firing an input event is NOT enough: React keeps its own value
    // tracker and quietly ignores the change, which publishes a video
    // with an empty title. The native value setter is what React's own
    // test suite uses to make a controlled input believe it.
    const SET_VALUE = `
        const setNativeValue = (el, v) => {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
    `;

    const titleSet = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                ${SET_VALUE}
                const inputs = document.querySelectorAll('input');
                const titleInput = Array.from(inputs).find(i => i.name === 'title' || i.ariaLabel?.includes('title') || i.placeholder?.includes('title'));
                if (!titleInput) return { set: false, reason: 'no title field' };
                setNativeValue(titleInput, ${JSON.stringify(metadata.title)});
                return { set: titleInput.value === ${JSON.stringify(metadata.title)}, value: titleInput.value };
            })()
        `,
        returnByValue: true
    });
    log(titleSet?.result?.value?.set
        ? `title set ("${titleSet.result.value.value}")`
        : `title NOT set (${titleSet?.result?.value?.reason || 'value did not stick'})`);

    // Description
    const descSet = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                ${SET_VALUE}
                const textareas = document.querySelectorAll('textarea');
                const descInput = Array.from(textareas).find(t => t.name === 'description' || t.ariaLabel?.includes('description'));
                if (!descInput) return { set: false, reason: 'no description field' };
                setNativeValue(descInput, ${JSON.stringify(metadata.description)});
                return { set: descInput.value === ${JSON.stringify(metadata.description)}, len: descInput.value.length };
            })()
        `,
        returnByValue: true
    });
    log(descSet?.result?.value?.set
        ? `description set (${descSet.result.value.len} chars)`
        : `description NOT set (${descSet?.result?.value?.reason || 'value did not stick'})`);

    // Tags
    if (metadata.tags && metadata.tags.length > 0) {
        const tagSet = await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    ${SET_VALUE}
                    const tags = ${JSON.stringify(metadata.tags.join(', '))};
                    const inputs = document.querySelectorAll('input');
                    const tagsInput = Array.from(inputs).find(i => i.name?.includes('tags') || i.ariaLabel?.includes('tag'));
                    if (!tagsInput) return { set: false, reason: 'no tags field' };
                    setNativeValue(tagsInput, tags);
                    return { set: tagsInput.value === tags, value: tagsInput.value };
                })()
            `,
            returnByValue: true
        });
        log(tagSet?.result?.value?.set
            ? `tags set (${metadata.tags.length})`
            : `tags NOT set (${tagSet?.result?.value?.reason || 'value did not stick'})`);
    }
    
    // Publish — with a visibility that is actually applied.
    //
    // The visibility selector is NOT on the details screen. It lives on
    // the Visibility step of the publish flow, one or two "Next" clicks
    // further on. The old code computed `visibility` and then dropped
    // it on the floor, so every upload inherited YouTube Studio's
    // Private default and the video was invisible to everyone but the
    // owner.
    const visibility = String(opts.visibility || CONFIG.upload?.visibility || 'unlisted').toLowerCase();
    log(`visibility target: ${visibility}`);

    const VIS_LABEL = `
        const label = (e) => ((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
    `;

    // Walk the wizard forward until the visibility control appears.
    let visibilitySet = false;
    for (let step = 0; step < 6; step++) {
        const probe = await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    ${VIS_LABEL}
                    const wanted = ${JSON.stringify(visibility)};
                    // Only real controls count. A stray "Public" chip in
                    // the page body must not be mistaken for the radio.
                    const cands = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, [role=radio], [role=checkbox], tp-yt-paper-dropdown, tp-yt-iron-dropdown, [role=combobox]'));
                    const radio = cands.find(e => label(e) === wanted && e.getBoundingClientRect().width);
                    if (radio) { radio.click(); return { state: 'radio' }; }
                    const dd = cands.find(e => /^(private|unlisted|public)$/.test(label(e)) && e.getBoundingClientRect().width);
                    if (dd) { dd.click(); return { state: 'opened', current: label(dd) }; }
                    return { state: 'none' };
                })()
            `,
            returnByValue: true
        });
        const st = probe?.result?.value?.state;
        if (st === 'radio') {
            visibilitySet = true;
            log(`visibility set to ${visibility}`);
            break;
        }
        if (st === 'opened') {
            // The menu is open: pick the wanted value out of it.
            const pick = await CDP.Runtime.evaluate({
                expression: `
                    (() => {
                        ${VIS_LABEL}
                        const wanted = ${JSON.stringify(visibility)};
                        const menu = document.querySelector('yt-dropdown-menu, tp-yt-paper-menu, [role=menu]');
                        const scope = menu || document;
                        const items = Array.from(scope.querySelectorAll('yt-dropdown-menu-item, tp-yt-paper-item, [role=menuitem], [role=option], li, button, div[role=button]'));
                        const hit = items.find(e => label(e) === wanted && e.getBoundingClientRect().width);
                        if (!hit) return { picked: false, seen: items.map(label).filter(Boolean).slice(0, 20) };
                        hit.click();
                        return { picked: true };
                    })()
                `,
                returnByValue: true
            });
            if (pick?.result?.value?.picked) {
                visibilitySet = true;
                log(`visibility set to ${visibility}`);
                break;
            }
            log(`visibility menu opened but "${visibility}" was not among: ${JSON.stringify(pick?.result?.value?.seen || [])}`);
        }
        // Not on this screen yet — advance the wizard.
        const advanced = await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    ${VIS_LABEL}
                    const btns = Array.from(document.querySelectorAll('button, [role=button]'));
                    const next = btns.find(b => label(b) === 'next' && b.getBoundingClientRect().width);
                    if (!next) return { advanced: false };
                    next.click();
                    return { advanced: true };
                })()
            `,
            returnByValue: true
        });
        if (!advanced?.result?.value?.advanced) break;
        log('advanced to the next step of the publish flow');
        await sleep(3000);
    }
    if (!visibilitySet) {
        warn(`the visibility control was not found — the video may be left on YouTube Studio's default (private)`);
    }

    // Publish.
    log('Publishing...');
    const published = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                ${VIS_LABEL}
                const btns = Array.from(document.querySelectorAll('button, [role=button]'));
                const pub = btns.find(b => label(b) === 'publish' && b.getBoundingClientRect().width)
                    || btns.find(b => label(b) === 'save' && b.getBoundingClientRect().width);
                if (!pub) return { clicked: false, seen: btns.map(label).filter(Boolean).slice(0, 20) };
                pub.click();
                return { clicked: true, which: label(pub) };
            })()
        `,
        returnByValue: true
    });
    if (!published?.result?.value?.clicked) {
        warn(`no publish button found (saw: ${JSON.stringify(published?.result?.value?.seen || [])})`);
    }

    // Wait for confirmation
    await sleep(8000);

    // The publish dialog may have opened with its own Publish button.
    const confirmed = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                ${VIS_LABEL}
                const dialog = document.querySelector('[role=dialog], tp-yt-paper-dialog');
                if (dialog) {
                    const btns = Array.from(dialog.querySelectorAll('button, [role=button]'));
                    const pub = btns.find(b => label(b) === 'publish' && b.getBoundingClientRect().width);
                    if (pub) { pub.click(); return { confirmed: true }; }
                }
                return { confirmed: false };
            })()
        `,
        returnByValue: true
    });
    if (confirmed?.result?.value?.confirmed) log('publish confirmed in the dialog');
    
    // Get video URL if possible
    let videoUrl = null;
    try {
        const { result: urlResult } = await CDP.Runtime.evaluate({
            expression: `
                (() => {
                    // The publish confirmation links to the new video;
                    // the address bar usually still points at the studio.
                    const link = Array.from(document.querySelectorAll('a[href*="/watch?v="]'))
                        .map(a => a.href)
                        .find(h => h.includes('/watch?v='));
                    return { href: link || window.location.href, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) };
                })()
            `,
            returnByValue: true
        });
        if (urlResult.value?.href && urlResult.value.href.includes('/watch?v=')) {
            videoUrl = urlResult.value.href;
        }
        if (urlResult.value?.text) log(`page says: ${urlResult.value.text}`);
    } catch (e) { /* ignore */ }

    return { success: true, url: videoUrl, visibilitySet };
}

// ---------- Main ----------

async function main() {
    if (!VIDEO_FILE) {
        console.error('Usage: node youtube-poster.js <video-file> [--title "..."] [--description "..."] [--tags "a,b,c"] [--visibility public|unlisted|private] [--dry-run]');
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
        const result = await uploadToYouTube(VIDEO_FILE, metadata, { visibility: CLI_VISIBILITY });
        if (result.url) {
            log(`Uploaded! URL: ${result.url}`);
        } else {
            log('Uploaded! (URL not captured)');
        }
        if (result.visibilitySet === false) {
            warn('the visibility was NOT set — check the video in YouTube Studio');
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

if (require.main === module) {
    main().catch(e => {
        console.error(`Fatal: ${e.message}`);
        process.exit(1);
    });
}
