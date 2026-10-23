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
module.exports = { parseVideoFile, generateMetadata, uploadToYouTube, findVideoFile, cdpDomains, waitForDocument, ensureUploadDialog, makeClient, applyVideoDetails, resolveVideoId, currentChannelId };

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
// --resume <videoId> sets the details of a video that is already
// uploaded, without uploading the file again.
const RESUME_ID = argVal('--resume', null);

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

/**
 * Read a value out of a Studio form field.
 *
 * The fields are contenteditable divs, not inputs — an input query
 * finds nothing, which is why an earlier version of this tool
 * reported "no title field" on a page that plainly had one.
 */
const FIELD_JS = `
    const field = (needle) => Array.from(document.querySelectorAll('[contenteditable="true"]'))
        .find(e => ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || ''))
            .toLowerCase().includes(needle));
`;

/**
 * Press Enter.
 *
 * The tag box commits a tag as a chip on Enter, and nothing else
 * commits it.
 */
async function pressEnter(CDP) {
    await CDP.Input.dispatchKeyEvent({
        type: 'rawKeyDown', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    });
    await CDP.Input.dispatchKeyEvent({
        type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
}

/**
 * Set a video's details on its Studio edit page.
 *
 * The upload dialog is not where the details can be written: the
 * fields live on the video's own edit page, they are contenteditable
 * divs, and the tag box is behind "Show more". Every one of those was
 * found by driving the live page, not by reading the DOM.
 */
async function applyVideoDetails(client, CDP, metadata, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const report = { title: false, description: false, tags: false, visibility: false, saved: false };

    const evaluate = async (expression) => {
        const res = await CDP.Runtime.evaluate({ expression, returnByValue: true });
        return res?.result?.value;
    };

    // --- title and description -------------------------------------
    const textFields = [
        { key: 'title', needle: 'describes your video', value: metadata.title },
        { key: 'description', needle: 'tell viewers', value: metadata.description },
    ];
    for (const field of textFields) {
        if (!field.value) continue;
        const focused = await evaluate(`
            (() => {
                ${FIELD_JS}
                const el = field(${JSON.stringify(field.needle)});
                if (!el) return { ok: false, why: 'no field' };
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = getSelection();
                sel.removeAllRanges(); sel.addRange(range);
                return { ok: true, before: el.textContent };
            })()
        `);
        if (!focused?.ok) {
            warn(`${field.key} NOT set (${focused?.why || 'no field'})`);
            continue;
        }
        // Typing beats assigning: a contenteditable that is bound to a
        // model ignores a value that was never typed into.
        await CDP.Input.insertText({ text: String(field.value) });
        await sleep(500);
        const after = await evaluate(`
            (() => {
                ${FIELD_JS}
                const el = field(${JSON.stringify(field.needle)});
                return { text: el ? el.textContent : null };
            })()
        `);
        report[field.key] = String(after?.text || '').trim() === String(field.value).trim();
        log(report[field.key]
            ? `${field.key} set`
            : `${field.key} NOT set (the field did not take the text)`);
    }

    // --- tags -------------------------------------------------------
    if (Array.isArray(metadata.tags) && metadata.tags.length) {
        // The tag box lives behind "Show more".
        await evaluate(`
            (() => {
                const more = Array.from(document.querySelectorAll('button, ytcp-button, tp-yt-paper-button, div[role=button]'))
                    .find(e => /show more/i.test((e.innerText || '').trim()) && e.children.length < 3);
                if (more) { more.click(); return { clicked: true }; }
                return { clicked: false };
            })()
        `);
        await sleep(1200);

        // The tag box is a CHIP editor: typed text stays in the input
        // until Enter commits it as a chip. Typing the whole list and
        // saving loses every tag — which is exactly what an earlier
        // version of this tool did, and why the video kept the tags it
        // already had.
        const CHIPS_JS = `
            (() => {
                const list = Array.from(document.querySelectorAll('ytcp-chip, .ytcp-chip, [class*=chip]'))
                    .map(c => (c.innerText || '').trim().replace(/\\s+/g, ' '))
                    .filter(Boolean);
                return { chips: [...new Set(list)] };
            })()
        `;
        const before = await evaluate(CHIPS_JS);
        const existing = (before?.chips || []).map(c => c.toLowerCase());
        for (const tag of metadata.tags) {
            // Re-running the tool must not double the tags.
            if (existing.includes(String(tag).toLowerCase())) continue;
            const focused = await evaluate(`
                (() => {
                    const i = document.querySelector('input[aria-label="Tags"]') ||
                              Array.from(document.querySelectorAll('input'))
                                  .find(x => /tag/i.test(x.getAttribute('aria-label') || ''));
                    if (!i) return { ok: false, why: 'no tags field' };
                    i.focus(); i.select();
                    return { ok: true };
                })()
            `);
            if (!focused?.ok) {
                warn(`tags NOT set (${focused?.why || 'no tags field'})`);
                break;
            }
            await CDP.Input.insertText({ text: String(tag) });
            await sleep(300);
            await pressEnter(CDP);
            await sleep(500);
        }

        // Read the chips back — the input is empty once a tag is
        // committed, so the input is not the evidence.
        const chips = await evaluate(CHIPS_JS);
        const have = (chips?.chips || []).map(c => c.toLowerCase());
        report.tags = metadata.tags.every(t => have.includes(String(t).toLowerCase()));
        log(report.tags
            ? `tags set (${metadata.tags.length})`
            : `tags NOT set (the box holds: ${JSON.stringify(chips?.chips || [])})`);
    }

    // --- visibility -------------------------------------------------
    //
    // The control's own class is the honest signal: the container
    // carries "privacy-public-icon" when the video is public. Reading
    // the class beats trusting a click.
    const wanted = String(opts.visibility || 'public').toLowerCase();
    const readVisibility = async () => evaluate(`
        (() => {
            const c = document.querySelector('ytcp-video-metadata-visibility #container');
            const t = document.querySelector('ytcp-video-metadata-visibility #visibility-text');
            return { cls: c ? c.className : '', text: t ? (t.textContent || '').trim() : '' };
        })()
    `);
    let vis = await readVisibility();
    const isWanted = (v) => new RegExp('privacy-' + wanted + '-icon').test(v?.cls || '');
    if (!isWanted(vis)) {
        await evaluate(`
            (() => {
                const b = document.querySelector('ytcp-video-metadata-visibility #select-button');
                if (!b) return { clicked: false };
                b.click(); return { clicked: true };
            })()
        `);
        await sleep(1200);
        await evaluate(`
            (() => {
                const wanted = ${JSON.stringify(wanted)};
                const label = (e) => ((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
                const scopes = Array.from(document.querySelectorAll('ytcp-menu-popup, tp-yt-paper-menu, [role=menu], ytcp-popup-container'))
                    .filter(s => s.getBoundingClientRect().width);
                for (const scope of scopes) {
                    const items = Array.from(scope.querySelectorAll('tp-yt-paper-item, [role=menuitem], [role=option], yt-formatted-string, li, button, div[role=button]'));
                    const hit = items.find(e => label(e) === wanted && e.getBoundingClientRect().width);
                    if (hit) { hit.click(); return { picked: true }; }
                }
                return { picked: false };
            })()
        `);
        await sleep(1000);
        vis = await readVisibility();
    }
    report.visibility = isWanted(vis);
    log(report.visibility
        ? `visibility is ${wanted}`
        : `visibility NOT set (the control reads "${vis?.text || 'unknown'}")`);

    // --- save --------------------------------------------------------
    await evaluate(`
        (() => {
            const b = document.querySelector('ytcp-button#save');
            if (!b) return { clicked: false };
            b.click(); return { clicked: true };
        })()
    `);
    // The confirmation toast takes a few seconds to appear, and it
    // does not appear at all when there was nothing to save — so the
    // save button going quiet is the second signal.
    let toast = false;
    for (let i = 0; i < 12 && !toast; i++) {
        await sleep(1000);
        const s = await evaluate(`
            (() => ({ saved: /all changes saved/i.test(document.body.innerText || '') }))
        `);
        toast = !!s?.saved;
    }
    const pending = await evaluate(`
        (() => {
            const b = document.querySelector('ytcp-button#save');
            if (!b) return { state: 'gone' };
            return { state: b.getAttribute('aria-disabled') === 'true' ? 'idle' : 'pending' };
        })()
    `);
    report.saved = toast || pending?.state === 'idle';
    report.saveToast = toast;
    log(report.saved
        ? (toast ? 'details saved' : 'details saved (the button went idle)')
        : 'the save did not confirm');

    return report;
}

/**
 * Find the id of a video in the channel's content list.
 *
 * The list is sorted newest first and every row's title link carries
 * the id ("/video/<id>/edit"). Reading a watch link off the page
 * instead is how this tool once reported somebody else's video as
 * the upload — a page full of watch links has a dozen of them and
 * only one of them is the video that was just uploaded.
 */
async function resolveVideoId(client, CDP, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const wanted = String(opts.title || '').trim().toLowerCase();
    const alt = String(opts.fileBaseName || '').trim().toLowerCase().replace(/[-_]+/g, ' ');

    const found = await CDP.Runtime.evaluate({
        expression: `
            (() => {
                const wanted = ${JSON.stringify(wanted)};
                const alt = ${JSON.stringify(alt)};
                const label = (a) => ((a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '')).trim();
                const links = Array.from(document.querySelectorAll('a#video-title[href*="/video/"], a[href*="/video/"]'));
                const hit = links.find(a => {
                    const l = label(a).toLowerCase();
                    if (!l) return false;
                    return l === wanted || l === alt || (wanted && l.includes(wanted)) || (alt && l.includes(alt));
                });
                if (!hit) return { found: false, seen: links.map(label).filter(Boolean).slice(0, 10) };
                const m = (hit.getAttribute('href') || '').match(/\\/video\\/([\\w-]+)/);
                return { found: true, id: m ? m[1] : null, label: label(hit) };
            })()
        `,
        returnByValue: true,
    });
    const value = found?.result?.value;
    if (!value?.found || !value?.id) {
        const seen = JSON.stringify(value?.seen || []);
        throw new Error(`the uploaded video is not in the channel list (saw: ${seen})`);
    }
    return value.id;
}

/**
 * The channel the browser is currently signed in to.
 */
async function currentChannelId(client) {
    const res = await client.js(`(() => {
        const m = (location.pathname || '').match(/\\/channel\\/([\\w-]+)/);
        return m ? m[1] : null;
    })()`);
    return res || null;
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
    
    // The details do not live in the upload dialog.
    //
    // They live on the video's own edit page, where the fields are
    // contenteditable divs, the tag box is behind "Show more", and the
    // visibility control is a dropdown whose container class is the
    // only honest signal. So the flow is: upload, find the video,
    // edit it.
    log('Filling in video details...');
    const visibility = String(opts.visibility || CONFIG.upload?.visibility || 'public').toLowerCase();

    const channelId = await currentChannelId(client);
    if (channelId) {
        await CDP.Page.navigate({ url: `https://studio.youtube.com/channel/${channelId}/videos/upload` });
        await waitForDocument(client);
        await sleep(4000);
    }

    const videoId = await resolveVideoId(client, CDP, {
        title: metadata.title,
        fileBaseName: path.basename(videoPath, path.extname(videoPath)),
    });
    log(`uploaded video id: ${videoId}`);

    await CDP.Page.navigate({ url: `https://studio.youtube.com/video/${videoId}/edit` });
    await waitForDocument(client);
    await sleep(4000);

    const details = await applyVideoDetails(client, CDP, metadata, { visibility, sleep });

    return {
        success: true,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        visibilitySet: details.visibility,
        details,
    };
}

// ---------- Main ----------

async function main() {
    if (!VIDEO_FILE && !RESUME_ID) {
        console.error('Usage: node youtube-poster.js <video-file> [--title "..."] [--description "..."] [--tags "a,b,c"] [--visibility public|unlisted|private] [--dry-run]');
        console.error('   or: node youtube-poster.js --resume <videoId> --title "..." [--description "..."] [--tags "a,b,c"]');
        process.exit(1);
    }
    
    if (!fs.existsSync(VIDEO_FILE) && !RESUME_ID) {
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
    let videoInfo = null;
    if (!RESUME_ID) {
        videoInfo = parseVideoFile(VIDEO_FILE);
        log(`Video: ${videoInfo.basename} (${(videoInfo.size / 1024 / 1024).toFixed(1)} MB)`);
        log(`Mood: ${videoInfo.mood}${videoInfo.date ? `, Date: ${videoInfo.date.toISOString()}` : ''}`);
    }

    // Generate metadata
    const metadata = RESUME_ID
        // Resuming an uploaded video: there is no file to read a mood
        // or a date from, so the command line is the only source.
        ? {
            title: CLI_TITLE || '',
            description: CLI_DESCRIPTION || '',
            tags: (CLI_TAGS || '').split(',').map(t => t.trim()).filter(Boolean),
        }
        : generateMetadata(videoInfo, {
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
        let result;
        if (RESUME_ID) {
            // The video is already uploaded: set the details and stop.
            log(`Resuming: setting the details of ${RESUME_ID}`);
            const client = await makeClient(`http://127.0.0.1:${PORT}`);
            const CDP = cdpDomains(client);
            await CDP.Page.navigate({ url: `https://studio.youtube.com/video/${RESUME_ID}/edit` });
            await waitForDocument(client);
            await new Promise(r => setTimeout(r, 4000));
            const details = await applyVideoDetails(client, CDP, metadata, { visibility: CLI_VISIBILITY });
            result = {
                success: true,
                url: `https://www.youtube.com/watch?v=${RESUME_ID}`,
                videoId: RESUME_ID,
                visibilitySet: details.visibility,
                details,
            };
            log(`Details set. URL: ${result.url}`);
        } else {
            result = await uploadToYouTube(VIDEO_FILE, metadata, { visibility: CLI_VISIBILITY });
            if (result.url) {
                log(`Uploaded! URL: ${result.url}`);
            } else {
                log('Uploaded! (URL not captured)');
            }
        }
        if (result.visibilitySet === false) {
            warn('the visibility was NOT set — check the video in YouTube Studio');
        }

        // Move to uploaded directory
        if (OUTPUT_DIR && !RESUME_ID) {
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
