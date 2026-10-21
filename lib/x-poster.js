#!/usr/bin/env node
'use strict';
// lib/x-poster.js
//
// Post to X (Twitter) through the web composer.
//
// Usage:
//   node lib/x-poster.js --text "hello world" [--media <file>] [--dry-run]
//   node lib/x-poster.js <package-dir> [--dry-run]
//
// The API endpoints reject this session with a 401 even when the cookie
// is perfectly valid — the public web bearer is not enough. So the
// poster drives the web UI in a headed browser, the same shape as
// lib/ig-poster.js. The session check is therefore a PAGE check: the
// composer has to be there and the login wall must not be.
//
// Exit: 0 posted · 1 fatal · 2 posted but claim failed

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
    parseCookieFile,
    toBrowserCookies,
    describe: describeCookies,
    validate,
    defaultCookiePath,
} = require('./x-cookies.js');

const xtext = require('./x-text.js');

// Reuse the CDP helpers — they are the repo's, and they work.
const {
    CDPClient: CDPClientOrig,
    checkChromeOnPort,
    launchChrome,
    killChrome,
} = require('./mj-submitter.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'x-config.json'), 'utf8'));

function log(msg) { process.stdout.write(`[x-poster] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[x-poster] ${msg}\n`); }

module.exports = {
    CDPClient: CDPClientOrig,
    checkChromeOnPort,
    fitCaption,
    mediaInDir,
    parseArgs,
    readPackage,
    resolveMedia,
    MAX_MEDIA: 4,
};

// ---------------------------------------------------------------------------
// pure: what gets posted
// ---------------------------------------------------------------------------

/**
 * Bring a caption inside X's 280 weighted characters.
 *
 * The body wins; the hashtags fill what is left, in priority order.
 * Whatever does not fit is reported rather than silently dropped.
 *
 * @param {string} caption
 * @returns {object} { text, body, hashtags, dropped, truncated, length }
 */
function fitCaption(caption) {
    const split = xtext.splitCaption(caption);
    const fitted = xtext.fit({ body: split.body, hashtags: split.hashtags });
    return Object.assign({}, fitted, { body: split.body });
}

/**
 * Parse the command line.
 *
 * @param {Array<string>} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const args = argv || [];
    const out = { media: [] };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--text') out.text = args[++i];
        else if (a === '--media') out.media.push(args[++i]);
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--cookies') out.cookies = args[++i];
        else if (a === '--port') out.port = args[++i];
        else if (a === '--browser') out.browser = args[++i];
        else if (a === '--user-data-dir') out.userDataDir = args[++i];
        else if (a.startsWith('--')) out[a.replace(/^--/, '')] = true;
        else if (!out.dir) out.dir = a;
    }
    return out;
}

/**
 * The media extensions X's composer accepts.
 */
const MEDIA_EXTS = {
    video: ['.mp4', '.mov', '.m4v'],
    image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
};

/**
 * Resolve the media paths given on the command line.
 *
 * A path that does not exist is reported, NOT skipped. Skipping it
 * publishes a different post than the one that was asked for — the
 * caption without its picture — and nothing on the timeline says so.
 *
 * @param {Array<string>} paths
 * @returns {object} { media: Array<string>, missing: Array<string> }
 */
function resolveMedia(paths) {
    const media = [];
    const missing = [];
    for (const p of paths || []) {
        const abs = path.resolve(p);
        if (fs.existsSync(abs)) media.push(abs);
        else missing.push(p);
    }
    return { media, missing };
}

/**
 * The media sitting in a package directory.
 *
 * The engine links an item's media into its package as symlinks, so
 * the package directory IS the media list. Resolving it here — rather
 * than reading an absolute path out of post.json — is what keeps the
 * poster working when the package is moved, and keeps the shipped
 * package free of machine-specific paths.
 *
 * X takes one video or up to four images, never both.
 *
 * @param {string} dir
 * @returns {Array<string>} absolute paths
 */
function mediaInDir(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const ext = n => path.extname(n).toLowerCase();
    const video = names.filter(n => MEDIA_EXTS.video.includes(ext(n))).sort();
    if (video.length) return video.slice(0, 1).map(n => path.join(dir, n));
    const images = names.filter(n => MEDIA_EXTS.image.includes(ext(n))).sort();
    return images.slice(0, 4).map(n => path.join(dir, n));
}

/**
 * Read the caption and the media out of a package directory.
 *
 * @param {string} dir
 * @returns {object} { caption, files, media }
 */
function readPackage(dir) {
    const postJson = path.join(dir, 'post.json');
    if (!fs.existsSync(postJson)) {
        throw new Error(`no post.json in ${dir}`);
    }
    const pkg = JSON.parse(fs.readFileSync(postJson, 'utf8'));
    const caption = pkg.platforms && pkg.platforms.twitter
        ? pkg.platforms.twitter.caption
        : '';
    return {
        caption: String(caption || ''),
        files: pkg.files || {},
        media: mediaInDir(dir),
        pkg,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return p;
}

const ARGS = parseArgs(process.argv.slice(2));
const COOKIES_FILE = expandHome(ARGS.cookies || CONFIG.cookiesFile || defaultCookiePath());
const USER_DATA_DIR = expandHome(ARGS.userDataDir || CONFIG.userDataDir);
const BROWSER_BIN = expandHome(ARGS.browser || CONFIG.browserBin);
const PORT = parseInt(ARGS.port || String(CONFIG.chrome?.debugPort || 9447), 10);
const DRY_RUN = !!ARGS.dryRun;

// ---------------------------------------------------------------------------
// the DOM contract
// ---------------------------------------------------------------------------

const COMPOSER = 'div[data-testid="tweetTextarea_0"]';
const POST_BTN = 'button[data-testid="tweetButton"]';
const FILE_INPUT = 'input[data-testid="fileInput"]';
const COMPOSE_URL = 'https://x.com/compose/post';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Open a FRESH tab and return its debugger URL.
 *
 * The repo's cdpConnect() picks the first page target it finds, which
 * is fine for a one-shot script but wrong for the poster: a tab left
 * over from an earlier run — holding unsent text — raises a
 * beforeunload dialog, and that dialog blocks every CDP command on
 * that renderer forever. The symptom is a hang after "cookies set",
 * with no error at all.
 *
 * So the poster never reuses a tab. It opens its own, drives it, and
 * closes it.
 *
 * @param {number} port
 * @param {string} url
 * @returns {Promise<string>} the debugger URL
 */
function openTab(port, url) {
    return new Promise((resolve, reject) => {
        // Chrome 111+ requires PUT on /json/new; older builds want GET.
        const req = http.request({
            host: '127.0.0.1', port, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT',
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d).webSocketDebuggerUrl); }
                catch (e) { reject(new Error(`could not open a tab: ${d.slice(0, 120)}`)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/** Close a tab by its debugger URL. Best effort. */
function closeTab(port, wsUrl) {
    return new Promise(resolve => {
        if (!wsUrl) { resolve(); return; }
        const m = /devtools\/page\/([A-Za-z0-9-]+)/.exec(wsUrl);
        if (!m) { resolve(); return; }
        const req = http.request({
            host: '127.0.0.1', port, path: `/json/close/${m[1]}`, method: 'PUT',
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', () => resolve());
        req.end();
    });
}

/** Poll a JS expression until it is truthy. */
async function waitFor(cdp, expr, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
        let v = false;
        try { v = await cdp.js(expr); } catch { /* the page is mid-navigation */ }
        if (v) return true;
        await sleep(400);
    }
    throw new Error(`timed out waiting for ${label || expr}`);
}

/**
 * Attach media through the file input.
 *
 * The input is a real DOM node, so CDP can hand it absolute paths
 * directly — no base64 round-trip through the page.
 */
async function attachMedia(cdp, media) {
    if (!media.length) return [];
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const found = await cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: FILE_INPUT,
    });
    if (!found.nodeId) throw new Error('the composer has no file input — cannot attach media');
    await cdp.send('DOM.setFileInputFiles', { files: media, nodeId: found.nodeId });
    // Wait for the preview to mount. The preview lives INSIDE the
    // composer modal — the image attach does not open a separate
    // dialog — so the wait is scoped to the dialog too, otherwise the
    // page behind the modal can satisfy it.
    await waitFor(
        cdp,
        `(() => {
            const dlg = [...document.querySelectorAll('[role="dialog"]')]
                .find(d => d.querySelector('div[data-testid="tweetTextarea_0"]'));
            if (!dlg) return false;
            return !!dlg.querySelector('[aria-label="Remove media"]')
                || !!dlg.querySelector('img[src^="blob:"]');
        })()`,
        45000,
        'the media preview'
    );
    return media;
}

/**
 * Close an overlay that is sitting on top of the composer.
 *
 * The dangerous thing here is Escape. Escape on the COMPOSER MODAL
 * closes the whole composer — media and all — and the Post button
 * (`button[data-testid="tweetButton"]`) disappears with it, so
 * everything downstream waits for a button that can never arrive.
 *
 * The image attach does NOT open a separate dialog: the media preview
 * mounts inline in the composer modal, with "Edit" and "Add
 * descriptions" controls on each thumbnail. So the usual case is that
 * there is nothing to dismiss at all.
 *
 * When there IS an extra overlay, it is closed by clicking its own
 * close control, and only as a last resort by Escape — and never
 * while the composer dialog is the thing under the cursor.
 *
 * @param {object} cdp
 * @returns {Promise<boolean>} true if the composer dialog survived
 */
async function dismissDialogs(cdp) {
    const composerAlive = `(() => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')]
            .find(d => d.querySelector('div[data-testid="tweetTextarea_0"]'));
        return !!dlg;
    })()`;

    const extra = await cdp.js(`(() => {
        const composerDlg = [...document.querySelectorAll('[role="dialog"]')]
            .find(d => d.querySelector('div[data-testid="tweetTextarea_0"]'));
        if (!composerDlg) return false;
        return [...document.querySelectorAll('[role="dialog"]')].some(d =>
            d !== composerDlg && !composerDlg.contains(d) && !d.contains(composerDlg));
    })()`);

    if (extra) {
        log('an overlay is open over the composer — closing it');
        await cdp.js(`(() => {
            const composerDlg = [...document.querySelectorAll('[role="dialog"]')]
                .find(d => d.querySelector('div[data-testid="tweetTextarea_0"]'));
            const over = [...document.querySelectorAll('[role="dialog"]')].find(d =>
                d !== composerDlg && !composerDlg.contains(d) && !d.contains(composerDlg));
            if (!over) return false;
            const btn = over.querySelector('[aria-label="Close"], [data-testid="app-bar-close"]');
            if (btn) { btn.click(); return true; }
            return false;
        })()`);
        await sleep(600);
    }

    return await cdp.js(composerAlive);
}

// ---------------------------------------------------------------------------
// the post
// ---------------------------------------------------------------------------

/**
 * Type the caption and publish it.
 *
 * The composer is a React-controlled contenteditable DIV, so assigning
 * innerText does nothing the page can see — the Post button stays
 * disabled. Input.insertText types the way a person does and the
 * button comes alive.
 */
async function composeAndPost(cdp, caption) {
    // The composer DIALOG, not just any composer: the page behind the
    // modal has its own inline composer, and typing into the wrong one
    // types into a form that will never be posted.
    const COMPOSER_IN_DIALOG = `(() => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')]
            .find(d => d.querySelector('${COMPOSER}'));
        return dlg ? dlg.querySelector('${COMPOSER}') : null;
    })()`;

    await waitFor(cdp, `!!(${COMPOSER_IN_DIALOG})`, 30000, 'the composer');

    const loggedIn = await cdp.js(`(() => ({
        composer: !!(${COMPOSER_IN_DIALOG}),
        loginWall: /Log in|Sign up/i.test(document.body.innerText.slice(0, 600)),
    }))()`);
    if (!loggedIn.composer || loggedIn.loginWall) {
        throw new Error('not logged in — the composer is missing or the login wall is up');
    }
    log('session looks authenticated');

    await cdp.js(`(${COMPOSER_IN_DIALOG}).focus()`);
    await cdp.send('Input.insertText', { text: caption });
    await sleep(600);

    // The inline button stays disabled in the composer; the real one is
    // the plain tweetButton. Wait for THAT to come alive.
    await waitFor(
        cdp,
        `(() => { const b = document.querySelector('${POST_BTN}'); return !!b && !b.disabled; })()`,
        20000,
        'the Post button to enable'
    );
    log('composer accepted the text');

    await cdp.js(`document.querySelector('${POST_BTN}').click()`);
    log('clicked Post');

    // Success is a NEW status link in the timeline. The composer clears
    // either way, so the cleared textbox is not a signal.
    await waitFor(
        cdp,
        `(() => { const t = document.body.innerText; return /Your post was sent\\./.test(t); })()`,
        30000,
        'the confirmation'
    );

    const result = await cdp.js(`(() => {
        const links = [...document.querySelectorAll('a[href*="/status/"]')].map(a => a.getAttribute('href'));
        const toast = (document.querySelector('[data-testid="toast"]') || {}).innerText || null;
        return { statusHref: links[0] || null, toast: toast ? toast.slice(0, 120) : null };
    })()`);
    return result;
}

// ---------------------------------------------------------------------------

async function main() {
    // ---- what to post ------------------------------------------------
    let caption = ARGS.text || '';
    // A media path that does not exist is an error, not a silent skip.
    // Skipping it publishes a DIFFERENT post than the one that was
    // asked for — the caption without its picture — and nothing says
    // so. A missing file must stop the run.
    const resolved = resolveMedia(ARGS.media);
    if (resolved.missing.length) {
        warn(`media file(s) not found: ${resolved.missing.join(' ')}`);
        process.exit(2);
    }
    let media = resolved.media;

    if (!caption && ARGS.dir) {
        const pkg = readPackage(path.resolve(ARGS.dir));
        caption = pkg.caption;
        if (!media.length) media = pkg.media;
    }
    if (!caption) {
        warn('nothing to post — pass --text or point at a package directory');
        process.exit(1);
    }

    const fitted = fitCaption(caption);
    if (fitted.dropped.length) {
        warn(`${fitted.dropped.length} hashtag(s) did not fit X's ${xtext.MAX_LENGTH}-character limit: ${fitted.dropped.join(' ')}`);
    }
    if (fitted.truncated) warn('the caption body was shortened to fit');
    caption = fitted.text;
    log(`caption: ${xtext.countLength(caption)}/${xtext.MAX_LENGTH} characters`);

    if (DRY_RUN) {
        log('[dry-run] would post to X');
        log(caption);
        process.exit(0);
    }

    // ---- cookies -----------------------------------------------------
    if (!fs.existsSync(COOKIES_FILE)) {
        warn(`cookie file not found: ${COOKIES_FILE}`);
        warn('Capture one with: node lib/x-cookie-capture.js');
        process.exit(2);
    }
    const cookies = parseCookieFile(COOKIES_FILE);
    const info = describeCookies(cookies);
    const check = validate(cookies);
    if (!check.valid) {
        warn(`cookie jar is missing ${check.missing.join(', ')} — the session will not authenticate`);
        process.exit(2);
    }
    log(`cookies: ${info.count} loaded (${info.hostPrefixed} __Host-), session complete`);

    // ---- browser -----------------------------------------------------
    let proc = null;
    if (!await checkChromeOnPort(PORT)) {
        log(`launching ${BROWSER_BIN} (headed) on :${PORT}`);
        proc = await launchChrome(PORT, USER_DATA_DIR, BROWSER_BIN);
    } else {
        log(`attaching to the browser already on :${PORT}`);
    }

    // A tab of its own, always. Reusing whatever tab happens to be
    // open is how the poster hangs on a stale beforeunload dialog.
    const wsUrl = await openTab(PORT, 'about:blank');
    const cdp = new CDPClientOrig(wsUrl);
    await cdp.connect();

    try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');
        await cdp.send('DOM.enable');
        await cdp.send('Network.setCookies', {
            cookies: toBrowserCookies(cookies, 'https://x.com'),
        });
        log('cookies set');

        await cdp.navigate(COMPOSE_URL);
        await sleep(5000);

        if (media.length) {
            log(`attaching ${media.length} media file(s)`);
            await attachMedia(cdp, media);
            const alive = await dismissDialogs(cdp);
            if (!alive) throw new Error('the composer dialog was closed while attaching media');
        }

        const result = await composeAndPost(cdp, caption);
        log(`posted${result.statusHref ? ' — ' + result.statusHref : ''}`);
        if (result.toast) log(`confirmation: ${result.toast.replace(/\n/g, ' ')}`);
        process.exit(0);
    } catch (e) {
        warn(`posting failed: ${e.message}`);
        if (process.env.X_POSTER_DEBUG) {
            // A deliberate debug lever, off unless the env var is set.
            // The browser is a black box: a failure can be a closed
            // dialog, a changed test id, or a session that expired, and
            // the message alone rarely says which. The file carries the
            // error and the stack — never a cookie value.
            const dest = process.env.X_POSTER_DEBUG === '1'
                ? path.join(os.tmpdir(), 'x-poster-error.json')
                : process.env.X_POSTER_DEBUG;
            try {
                fs.writeFileSync(dest, JSON.stringify({
                    message: e.message,
                    stack: e.stack,
                }, null, 2));
                warn(`details written to ${dest}`);
            } catch { /* debugging only */ }
        }
        process.exit(1);
    } finally {
        try { await cdp.close(); } catch { /* the browser may already be gone */ }
        await closeTab(PORT, wsUrl);
        if (proc) killChrome(proc);
    }
}

if (require.main === module) main();

module.exports.main = main;
