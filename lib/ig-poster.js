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
    // Exported for the test harness: these take a CDP client as an
    // argument, so they can be driven without a browser.
    uploadMedia,
    clickNextThroughCrop,
    clickShare,
    setCaption,
    clickCreateTab,
    readCaption,
    // The reel editor: repair a published caption without deleting
    // the post.
    openReelEditor,
    replaceEditorCaption,
    saveEditor,
    readPublishedCaption,
    editReelCaption,
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
// `--edit-caption <reel-url>` repairs the caption of a reel that is
// already published, without deleting it and posting it again.
const EDIT_URL = argVal('--edit-caption', null);
const EDIT_CAPTION = argVal('--caption', null);
// The caption can also be read out of a posted reel's POST.md, which
// is where the intended caption was written down in the first place.
const EDIT_DIR = argVal('--reel-dir', null) ? path.resolve(expandHome(argVal('--reel-dir'))) : null;
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

    // The caption is the body of the "## Caption" section — and ONLY
    // that. The sections after it (Files, Source, Published) are
    // notes about the reel, and a caption that swallowed them would
    // post the reel's file list to Instagram.
    const sections = {};
    let title = '';
    let current = null;
    for (const line of content.split('\n')) {
        if (line.startsWith('# ') && !title) {
            title = line.slice(2).trim();
            continue;
        }
        const heading = line.match(/^##\s+(.*)$/);
        if (heading) {
            // "## Hashtags: #one #two" is a section called "hashtags"
            // whose content sits on the heading line.
            const raw = heading[1].trim();
            const key = raw.toLowerCase().split(':')[0].trim();
            current = key;
            if (!sections[current]) sections[current] = [];
            const rest = raw.slice(key.length).replace(/^:\s*/, '').trim();
            if (rest) sections[current].push(rest);
            continue;
        }
        if (current) sections[current].push(line);
    }

    const body = (sections['caption'] || []).join('\n').trim();
    const text = body || title;

    // Hashtags: the ones the caption itself carries, plus a separate
    // "## Hashtags" section when the file has one. The rest of the
    // file's hashtags are not the caption's — the notes mention
    // hashtags too.
    const hashtagRegex = /#[a-zA-Z0-9_]+/g;
    const fromText = (text.match(hashtagRegex) || []);
    const fromSection = (sections['hashtags'] || []).join('\n').match(hashtagRegex) || [];
    const hashtags = [...new Set([...fromText, ...fromSection])].join(' ');

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
    // A caption that already carries its hashtags inline (the reel
    // watcher's format) must not get a second set appended.
    const inlineHashtags = /#[a-zA-Z0-9_]+/.test(caption);
    const fullCaption = (hashtags && !inlineHashtags) ? caption + '\n\n' + hashtags : caption;
    
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

    // Keep the page "focused" even when the browser window is in the
    // background.
    //
    // Instagram renders the post-publish modal itself, and a background
    // tab throttles that render: the modal sits on a spinner forever
    // and the post never appears. Focus emulation keeps the page
    // active without stealing the user's window.
    await enableFocusEmulation(cdp);

    try {
        // Set cookies
        await cdp.send('Network.setCookies', { cookies: toBrowserCookies(cookies) });
        log('Cookies set');

        // Navigate to Instagram
        await cdp.send('Page.navigate', { url: 'https://www.instagram.com/' });
        await new Promise(r => setTimeout(r, 5000));

        // Is this the logged-in shell?
        //
        // The landmarks are the LEFT NAV's icons and the nav is
        // icon-only, so the labels live in aria-label on the svg. The
        // old check read innerText for "Home" and reported "not logged
        // in" on a page that was plainly logged in.
        let s = null;
        for (let i = 0; i < 8; i++) {
            s = (await cdp.js(LOGGED_IN_LANDMARKS, true)) || {};
            if (s.hasFeed || s.onWall || s.onPicker) break;
            await new Promise(r => setTimeout(r, 2500));
        }
        const stale = 'the cookie jar is expired — Instagram revoked the session server-side. '
            + 'Log into instagram.com in a browser and export a fresh jar to the path in lib/ig-config.json.';
        if (s.onWall) throw new Error('Instagram wants a password — ' + stale);
        if (s.onPicker) throw new Error('Instagram showed the account picker, not the feed — ' + stale);
        if (!s.hasFeed) {
            const shot = await cdp.screenshot();
            const shotPath = '/tmp/ig-reel-failure.png';
            try { fs.writeFileSync(shotPath, Buffer.from(shot, 'base64')); } catch {}
            throw new Error('not logged in — the feed never rendered at ' + (s.body || 'instagram.com')
                + '. ' + stale + ' (screenshot: ' + shotPath + ')');
        }
        log('Logged in to Instagram');

        // Open the create panel. The control is svg[aria-label="New post"]
        // in the current build — there is no /compose/ link at all.
        const opened = await cdp.js(`(() => { const c = ${CREATE_CONTROL}; if (!c.found) return { clicked: false }; c.target.click(); return { clicked: true, how: c.how }; })()`, true) || {};
        if (!opened.clicked) {
            throw new Error('the create control was not found on the page — the web shell has changed again');
        }
        log(`create panel opened (${opened.how})`);
        await new Promise(r => setTimeout(r, 3000));

        // Pick the tab.
        //
        // Instagram's web create menu carries exactly three entries:
        // Post, Live video and Ad. There is no "Reel" entry, so a video
        // uploaded here is published as a FEED POST.
        //
        // That is the right target anyway: a feed post accepts a video
        // of any length up to 60 minutes, where a Reel is capped at 3.
        // The Reel tab is still tried first, in case the build has it.
        let asReel = false;
        if (await clickCreateTab(cdp, 'Reel')) {
            asReel = true;
            log('Reel tab selected');
        } else {
            if (!await clickCreateTab(cdp, 'Post')) {
                throw new Error('neither a "Reel" nor a "Post" option was found in the create menu');
            }
            log('Post option selected — the video publishes as a feed post');
        }
        await new Promise(r => setTimeout(r, 2000));

        // Hand the video to the composer.
        //
        // `input.files` is read-only in current Chrome, so the old
        // DataTransfer → input.files = dt.files dance threw and the
        // upload silently did nothing. DOM.setFileInputFiles sets the
        // file natively — the same call puppeteer's uploadFile() makes,
        // and it needs no native file dialog to be dismissed.
        if (!await uploadMedia(cdp, mp4Path, 'video/mp4')) {
            throw new Error('the video could not be handed to the composer');
        }
        log('video uploaded — waiting for the preview');
        await new Promise(r => setTimeout(r, 15000));

        // The upload lands on a CROP screen, not the caption screen.
        await clickNextThroughCrop(cdp, 5, 5000);

        // The caption.
        if (fullCaption) {
            const cap = await setCaption(cdp, fullCaption);
            if (cap.set) {
                log(`Caption set ("${(cap.landed || '').slice(0, 60)}")`);
            } else {
                warn('the caption field did not take the text (' + (cap.reason || 'unknown') + ')');
            }
        }

        // Publish.
        await clickShare(cdp);

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
            return { ok: true, url: successCheck.result.value.url, asReel };
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

// The create affordance on instagram.com's web shell.
//
// Instagram renames it. It was `a[href="/compose/"]` and
// `svg[aria-label="Create"]`; in the current build the sidebar carries
// `svg[aria-label="New post"]` and NO /compose/ link at all — which is
// why the old selectors reported "not logged in" on a page that was
// plainly logged in (the feed was right there).
//
// The check is therefore: a logged-in page has the feed's own
// landmarks, and the create control is one of several spellings.
const CREATE_CONTROL = `(() => {
    const byLabel = ['Create', 'New post', 'New Post'];
    for (const label of byLabel) {
        const svg = document.querySelector('svg[aria-label="' + label + '"]');
        if (svg) {
            const target = svg.closest('a') || svg.closest('button') || svg;
            return { found: true, how: 'svg:' + label, target };
        }
    }
    const link = document.querySelector('a[href="/compose/"]');
    if (link) return { found: true, how: 'link:/compose/', target: link };
    for (const el of Array.from(document.querySelectorAll('a,button,[role=button]'))) {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (t === 'create' || t === 'new post') return { found: true, how: 'text', target: el };
    }
    return { found: false };
})()`;

// Is the page the logged-in shell?
//
// The landmarks are the LEFT NAV's icons, and the nav is icon-only —
// the labels live in `aria-label` on the svg, NOT in the text. Looking
// for "Home" or "Messages" in `innerText` finds nothing on a perfectly
// logged-in page, which is how "not logged in" was reported for a
// session that was working.
const LOGGED_IN_LANDMARKS = `(() => {
    const body = document.body.innerText || '';
    const label = (l) => !!document.querySelector('svg[aria-label="' + l + '"]');
    return {
        hasFeed: label('Home') && label('Reels') && label('Messages'),
        hasProfileMenu: label('Settings') || label('Professional dashboard'),
        onWall: location.pathname.indexOf('/accounts/') === 0,
        onPicker: /use another profile|create new account|close friends/i.test(body),
        body: body.replace(/\\s+/g, ' ').slice(0, 160)
    };
})()`;

/**
 * Keep the driven page active even when the browser window is in the
 * background.
 *
 * Instagram renders the post-publish modal itself, and a backgrounded
 * tab throttles that render to a crawl: the modal sits on a spinner
 * indefinitely and the post never lands. Chrome's focus emulation
 * tells the renderer the page is visible and focused, so the modal
 * completes — without stealing the user's window, which is what
 * raising the browser would do.
 */
async function enableFocusEmulation(cdp) {
    try {
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        log('focus emulation on — the publish modal renders even in the background');
    } catch (e) {
        warn(`focus emulation unavailable (${e.message}) — the publish modal may hang if the window is in the background`);
    }
}

// Click a labelled control in the create panel. Instagram's tab labels
// have changed across revisions, so the match is on the visible text
// with a couple of fallbacks.
async function clickCreateTab(cdp, label) {
    const r = await cdp.js(`(() => {
        const wanted = ${JSON.stringify(label)}.toLowerCase();
        const pick = (scope) => {
            const els = Array.from(scope.querySelectorAll('button,[role=tab],[role=radio],div[role=button],span,div'));
            return els.find(e => {
                const t = (e.innerText||e.textContent||'').trim().toLowerCase();
                return t === wanted && e.getBoundingClientRect().width > 0;
            });
        };
        // The create panel is searched FIRST. The left nav carries a
        // "Reels" entry of its own, and an unscoped search for a "Reel"
        // tab can land on that and walk away from the composer. The
        // unscoped search stays as the fallback for builds where the
        // panel is not a dialog.
        const panel = document.querySelector('[role="dialog"]')
            || Array.from(document.querySelectorAll('div')).reverse().find(d => {
                const q = d.getBoundingClientRect();
                return q.width > 300 && q.height > 200 && /create|post|reel|live/i.test(d.innerText || '');
            });
        const hit = (panel && pick(panel)) || pick(document);
        if (!hit) return { clicked: false };
        const target = hit.closest('button') || hit.closest('[role=tab]') || hit;
        target.click();
        return { clicked: true };
    })()`, true);
    return r && r.clicked;
}

// Put a still into the panel's file input.
//
// Via CDP's DOM domain, not the JavaScript file trick. `input.files` is
// read-only in current Chrome, so the old
// `DataTransfer → input.files = dt.files` dance throws and the upload
// silently does nothing. `DOM.setFileInputFiles` sets the files
// natively — it is the same call puppeteer's uploadFile() makes, and it
// needs no native file dialog to be dismissed.
//
// The input has to exist first. Instagram's media picker creates it
// when "Select from computer" is pressed; if it is not there yet, one
// is created and given the right accept type.
async function uploadMedia(cdp, filePath, accept) {
    await cdp.send('DOM.enable');
    // Make sure an input exists.
    await cdp.js(`(() => {
        let input = document.querySelector('input[type="file"]');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.accept = ${JSON.stringify(accept)};
            input.style.display = 'none';
            document.body.appendChild(input);
        }
        input.accept = ${JSON.stringify(accept)};
        return true;
    })()`, true);

    const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[type="file"]',
    });
    if (!nodeId) throw new Error('no file input to hand the media to');
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    return true;
}

/** A still goes in as an image; a reel goes in as a video. */
async function uploadStill(cdp, filePath) {
    return uploadMedia(cdp, filePath, 'image/*');
}

/**
 * Click through the crop / zoom screens the upload lands on.
 *
 * "back", "next", "select crop", "select zoom" — "next" is the way
 * forward, and it may be more than one screen (crop → zoom → caption).
 */
async function clickNextThroughCrop(cdp, steps = 4, waitMs = 4000) {
    const clickNext = () => cdp.js(`(() => {
        const scope = document.querySelector('[role="dialog"]') || document;
        const els = Array.from(scope.querySelectorAll('button,div[role=button],[role=button]'));
        const label = (b) => ((b.innerText || b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase();
        const next = els.find(b => label(b) === 'next' && b.getBoundingClientRect().width);
        if (!next) return { clicked: false, labels: els.map(b => label(b)).filter(Boolean).slice(0, 24) };
        next.click();
        return { clicked: true };
    })()`, true);

    let clicked = 0;
    for (let step = 0; step < steps; step++) {
        const next = await clickNext();
        if (!next || !next.clicked) break;
        clicked++;
        log('clicked "next" on the crop screen');
        await new Promise((r) => setTimeout(r, waitMs));
    }
    await new Promise((r) => setTimeout(r, 3000));
    return clicked;
}

/**
 * Press publish.
 *
 * Instagram's web UI is div[role=button] all the way down — looking for
 * a <button> finds nothing.
 *
 * AND the search must be SCOPED to the create dialog. The feed behind
 * the modal has its own "Share" button on every post, and an unscoped
 * search finds THAT one first: the click opens a share sheet for
 * somebody else's post and nothing is published.
 */
async function clickShare(cdp) {
    const shared = await cdp.js(`(() => {
        const dialog = document.querySelector('[role="dialog"]')
            || Array.from(document.querySelectorAll('div')).reverse().find(d => {
                const q = d.getBoundingClientRect();
                return q.width > 500 && q.height > 400 && d.querySelector('textarea, [role="textbox"]');
            });
        const scope = dialog || document;
        const btns = Array.from(scope.querySelectorAll('button,div[role=button],[role=button],a'));
        const wanted = ['share to your story', 'share', 'post'];
        const label = (b) => ((b.innerText || b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase();
        for (const w of wanted) {
            // An exact match first, then a contains match.
            const hit = btns.find(b => label(b) === w && b.getBoundingClientRect().width)
                || btns.find(b => label(b).indexOf(w) >= 0 && b.getBoundingClientRect().width);
            if (hit) { hit.click(); return { clicked: true, which: w, scoped: !!dialog }; }
        }
        return { clicked: false, scoped: !!dialog, buttons: btns.map(b => label(b)).filter(Boolean).slice(0, 30) };
    })()`, true);
    if (!shared || !shared.clicked) {
        const shot = await cdp.screenshot();
        try { fs.writeFileSync('/tmp/ig-share-failure.png', Buffer.from(shot, 'base64')); } catch {}
        throw new Error('could not find the share button — the panel showed: '
            + JSON.stringify((shared && shared.buttons) || []) + ' (screenshot: /tmp/ig-share-failure.png)');
    }
    log(`share clicked (${shared.which}) — waiting for Instagram to confirm`);
    const confirmation = await waitForPublish(cdp);
    if (!confirmation.ok) {
        const shot = await cdp.screenshot();
        try { fs.writeFileSync('/tmp/ig-publish-failure.png', Buffer.from(shot, 'base64')); } catch {}
        warn(`Instagram did not confirm the publish: ${confirmation.reason} (screenshot: /tmp/ig-publish-failure.png)`);
    }
    return Object.assign({}, shared, { confirmation });
}

/**
 * Wait for Instagram to confirm the publish.
 *
 * Clicking "Share" opens a modal that Instagram renders itself, and
 * the confirmation arrives in one of three shapes: the URL changes to
 * the new post, the modal says the reel was shared, or an alert
 * appears. A fixed wait cannot tell those apart from "it hung" — and
 * it hung for real: the modal's content only renders while the tab is
 * foregrounded, so a backgrounded Chrome leaves the modal on a spinner
 * forever.
 */
async function waitForPublish(cdp, timeoutMs = 120000, pollMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const st = await cdp.js(`(() => {
            const dialog = document.querySelector('[role="dialog"]');
            const dtext = dialog ? (dialog.innerText || '').replace(/\\s+/g, ' ') : '';
            const alert = (document.querySelector('[role="alert"]') || {}).innerText || '';
            return { url: location.href, dialog: dtext.slice(0, 200), alert: String(alert).slice(0, 160) };
        })()`, true);
        if (!st) continue;
        const dialogText = st.dialog || '';
        const alertText = st.alert || '';
        const blob = `${st.url || ''} ${dialogText} ${alertText}`;
        if (/\/(p|reel)\/[A-Za-z0-9_-]+/.test(st.url || '')) {
            return { ok: true, via: 'url', url: st.url };
        }
        if (/has been shared|shared reel|your (post|reel) (is|has) been published|published successfully/i.test(blob)) {
            return { ok: true, via: 'dialog', url: st.url, message: dialogText || alertText };
        }
        if (/error|try again|something went wrong|too long|maximum/i.test(blob)) {
            return { ok: false, reason: `Instagram reported an error: ${(alertText || dialogText).slice(0, 160)}` };
        }
        if (dialogText !== last) {
            last = dialogText;
            log(`waiting for Instagram to confirm — modal says: ${last.slice(0, 90) || '(empty)'}`);
        }
    }
    return { ok: false, reason: `no confirmation within ${Math.round(timeoutMs / 1000)}s` };
}

/**
 * Put the caption into Instagram's caption field.
 *
 * The field is a rich-text editor, so only a real text INSERTION
 * reaches Instagram's own state listener.
 *
 * `document.execCommand('insertText')` looks like the insertion but is
 * not one: on Instagram's caption box it returns TRUE and inserts
 * nothing, and the caption then publishes blank. The editor's own
 * counter ("124/2,200") is the honest test of what Instagram received.
 *
 * CDP's `Input.insertText` is the insertion that works — it arrives as
 * a real text input event, the counter moves, and the text lands. The
 * in-page path stays as the fallback for a browser that refuses it.
 */
async function setCaption(cdp, text) {
    // Focus the field first: Input.insertText types into the focused
    // element, so without focus it goes nowhere.
    const focused = await cdp.js(`(() => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        const fields = Array.from(dialog.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'));
        // Instagram's caption box announces itself ("Add a caption...");
        // a text field is the next best guess. Picking the first
        // contenteditable would happily land on the location or
        // accessibility field instead.
        const field = fields.find(f => /caption/i.test((f.getAttribute('aria-label') || '') + ' ' + (f.getAttribute('placeholder') || '')))
            || fields.find(f => f.tagName === 'TEXTAREA')
            || fields[0];
        if (!field) return { found: false };
        field.focus();
        return { found: true, focused: document.activeElement === field };
    })()`, true);
    if (!focused || !focused.found) {
        return { set: false, reason: 'no caption field on the screen' };
    }
    if (!focused.focused) {
        return { set: false, reason: 'the caption field would not take focus' };
    }

    const readBack = `(() => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        const fields = Array.from(dialog.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'));
        const field = fields.find(f => /caption/i.test((f.getAttribute('aria-label') || '') + ' ' + (f.getAttribute('placeholder') || '')))
            || fields.find(f => f.tagName === 'TEXTAREA')
            || fields[0];
        const landed = field ? (field.innerText || field.value || '').trim() : '';
        // Instagram's own counter is the authority: it counts what
        // Instagram received, not what the DOM holds.
        const counter = Array.from(dialog.querySelectorAll('div[role="button"]'))
            .map(b => (b.innerText || '').trim())
            .find(t => /\\d+\\s*\\/\\s*2,?200/.test(t)) || null;
        return { landed: landed.slice(0, 100), counter };
    })()`;

    try {
        await cdp.send('Input.insertText', { text });
    } catch (e) {
        warn(`CDP Input.insertText failed (${e.message}) — using the in-page fallback`);
    }
    let after = await cdp.js(readBack, true);
    if (after && after.landed) {
        await blurCaptionField(cdp);
        return { set: true, method: 'cdp', landed: after.landed, counter: after.counter };
    }

    // Fallback: the in-page insertion, kept because it is all that is
    // left if CDP input is refused. It must verify that the text
    // actually landed — execCommand reporting success is not proof.
    const fallback = await cdp.js(`(() => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        const fields = Array.from(dialog.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'));
        const field = fields.find(f => /caption/i.test((f.getAttribute('aria-label') || '') + ' ' + (f.getAttribute('placeholder') || '')))
            || fields.find(f => f.tagName === 'TEXTAREA')
            || fields[0];
        if (!field) return { set: false, reason: 'no caption field on the screen' };
        field.focus();
        let ok = false;
        if (document.activeElement === field) {
            try {
                document.execCommand('selectAll', false, null);
                ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
            } catch (e) { ok = false; }
        }
        const landed0 = (field.innerText || field.value || '').trim();
        if (!landed0) field.innerText = ${JSON.stringify(text)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        const landed = (field.innerText || field.value || '').trim();
        return { set: landed.length > 0, ok, landed: landed.slice(0, 100) };
    })()`, true);
    if (fallback && fallback.set) await blurCaptionField(cdp);
    return fallback || { set: false, reason: 'no result' };
}

/**
 * Take the focus off the caption field.
 *
 * Instagram's caption editor commits its value when it loses focus,
 * and the publish reads the committed value. Clicking "Share" while
 * the field still has focus publishes the PREVIOUS caption — the
 * empty one — no matter how the text got into the field: the editor's
 * own counter reads the new text ("124/2,200") while the post goes up
 * with no caption at all.
 *
 * So the field is blurred explicitly, before the publish button is
 * pressed.
 */
async function blurCaptionField(cdp) {
    return cdp.js(`(() => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        const fields = Array.from(dialog.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'));
        const field = fields.find(f => /caption/i.test((f.getAttribute('aria-label') || '') + ' ' + (f.getAttribute('placeholder') || '')))
            || fields.find(f => f.tagName === 'TEXTAREA')
            || fields[0];
        if (!field) return false;
        field.blur();
        field.dispatchEvent(new Event('blur'));
        field.dispatchEvent(new Event('focusout', { bubbles: true }));
        return true;
    })()`, true);
}

// ---------- Editing a published reel ----------

/**
 * Instagram's own editor for a published reel.
 *
 * The reel's options menu ("More options" → "Edit") opens the same
 * composer the poster publishes with. The caption field is a
 * contenteditable div with the aria-label "Add a caption...", and it
 * commits on blur — the same rule the publish path has, which is why
 * the caption of the first "seemingly so" reel carried the audio
 * track's own name: Instagram auto-fills a reel's caption with the
 * attached track's title, and the field still held it when the post
 * went up.
 */
const IG_MORE_OPTIONS = `
    (() => {
        const label = (e) => ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).trim();
        const all = Array.from(document.querySelectorAll('button, [role=button], svg, [aria-label]'));
        const hit = all.find(e => /more options/i.test(label(e)));
        if (!hit) return { clicked: false, why: 'no options button' };
        const target = hit.closest('button, [role=button]') || hit.parentElement || hit;
        target.click();
        return { clicked: true };
    })()
`;

const IG_OPEN_EDIT = `
    (() => {
        const spans = Array.from(document.querySelectorAll('span'))
            .filter(e => (e.innerText || '').trim() === 'Edit' && e.children.length === 0);
        if (!spans.length) return { clicked: false, why: 'no Edit entry' };
        const span = spans[spans.length - 1];
        const target = span.closest('div[role=button], button, [role=menuitem]') || span.parentElement;
        target.click();
        return { clicked: true };
    })()
`;

const IG_CAPTION_FIELD = `
    (() => {
        const dlgs = Array.from(document.querySelectorAll('[role=dialog]'));
        const dlg = dlgs[dlgs.length - 1];
        if (!dlg) return { found: false, why: 'no editor on the screen' };
        const field = dlg.querySelector('div[contenteditable="true"][aria-label*="caption" i]')
            || dlg.querySelector('div[contenteditable="true"]');
        if (!field) return { found: false, why: 'no caption field' };
        return { found: true, value: (field.innerText || '').trim() };
    })()
`;

/**
 * Open a published reel's editor.
 *
 * Returns the caption the post currently carries, so a caller can
 * tell a repair from a no-op.
 */
async function openReelEditor(cdp, reelUrl, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    await cdp.send('Page.navigate', { url: reelUrl });
    for (let i = 0; i < 40; i++) {
        const state = await cdp.js('document.readyState');
        if (state === 'complete' || state === 'interactive') break;
        await sleep(500);
    }
    await sleep(5000);

    const menu = await cdp.js(IG_MORE_OPTIONS, true);
    if (!menu?.clicked) {
        return { ok: false, reason: menu?.why || 'the options menu did not open' };
    }
    await sleep(2500);

    const edit = await cdp.js(IG_OPEN_EDIT, true);
    if (!edit?.clicked) {
        return { ok: false, reason: edit?.why || 'the Edit entry was not in the menu' };
    }
    await sleep(4000);

    const field = await cdp.js(IG_CAPTION_FIELD, true);
    if (!field?.found) {
        return { ok: false, reason: field?.why || 'the caption field was not there' };
    }
    return { ok: true, before: field.value };
}

/**
 * Replace the caption in the open editor.
 *
 * The old text is selected first: appending would leave the
 * auto-filled track title in place, which is the defect this path
 * exists to fix.
 */
async function replaceEditorCaption(cdp, text, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const focused = await cdp.js(`
        (() => {
            const dlgs = Array.from(document.querySelectorAll('[role=dialog]'));
            const dlg = dlgs[dlgs.length - 1];
            if (!dlg) return { ok: false, why: 'no editor on the screen' };
            const field = dlg.querySelector('div[contenteditable="true"][aria-label*="caption" i]')
                || dlg.querySelector('div[contenteditable="true"]');
            if (!field) return { ok: false, why: 'no caption field' };
            field.focus();
            const range = document.createRange();
            range.selectNodeContents(field);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return { ok: document.activeElement === field };
        })()
    `, true);
    if (!focused?.ok) {
        return { set: false, reason: focused?.why || 'the caption field would not take focus' };
    }
    await cdp.send('Input.insertText', { text });
    await sleep(600);
    // The caption commits on blur, so the field is blurred before the
    // value is read — an unblurred field still holds the OLD value.
    await blurCaptionField(cdp);
    await sleep(800);
    const after = await cdp.js(`
        (() => {
            const dlgs = Array.from(document.querySelectorAll('[role=dialog]'));
            const dlg = dlgs[dlgs.length - 1];
            const field = dlg && dlg.querySelector('div[contenteditable="true"][aria-label*="caption" i]');
            return { value: field ? (field.innerText || '').trim() : null };
        })()
    `, true);
    const landed = String(after?.value || '').trim();
    return { set: landed === String(text).trim(), landed };
}

/**
 * Click Done in the reel editor.
 */
async function saveEditor(cdp, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const clicked = await cdp.js(`
        (() => {
            const dlgs = Array.from(document.querySelectorAll('[role=dialog]'));
            const dlg = dlgs[dlgs.length - 1];
            if (!dlg) return { clicked: false, why: 'no editor on the screen' };
            const buttons = Array.from(dlg.querySelectorAll('button, [role=button], span'))
                .filter(e => e.children.length === 0);
            const done = buttons.find(e => /^done$/i.test((e.innerText || '').trim()));
            if (!done) return { clicked: false, why: 'no Done button' };
            const target = done.closest('div[role=button], button') || done.parentElement;
            target.click();
            return { clicked: true };
        })()
    `, true);
    if (!clicked?.clicked) {
        return { saved: false, reason: clicked?.why || 'the Done button was not there' };
    }
    await sleep(5000);
    // The editor does NOT close when the save lands — Instagram keeps
    // the panel open — so the panel closing is not the signal. The
    // published caption is.
    return { saved: true };
}

/**
 * Read the caption a published reel actually carries.
 *
 * The reel's og:description holds the whole caption, newlines and
 * hashtags included, which makes it the one place that says what the
 * post says rather than what a field holds.
 */
async function readPublishedCaption(cdp, reelUrl, opts = {}) {
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    await cdp.send('Page.navigate', { url: reelUrl });
    for (let i = 0; i < 40; i++) {
        const state = await cdp.js('document.readyState');
        if (state === 'complete' || state === 'interactive') break;
        await sleep(500);
    }
    await sleep(5000);
    const og = await cdp.js(`
        (() => {
            const m = document.querySelector('meta[property="og:description"]');
            return m ? m.getAttribute('content') : null;
        })()
    `, true);
    if (!og) return { caption: null, reason: 'the reel has no og:description' };
    const first = og.indexOf('"');
    const last = og.lastIndexOf('"');
    const caption = (first !== -1 && last > first) ? og.slice(first + 1, last) : og;
    return { caption: caption.trim() };
}

/**
 * Repair the caption of a published reel.
 *
 * The whole point is to be able to fix a caption without deleting the
 * post and putting it up again: the reel keeps its URL, its views
 * and its timestamp.
 */
async function editReelCaption(reelUrl, text, opts = {}) {
    const cdp = opts.cdp;
    if (!cdp) throw new Error('editReelCaption needs a CDP client');

    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const opened = await openReelEditor(cdp, reelUrl, { sleep });
    if (!opened.ok) {
        return { ok: false, reason: opened.reason };
    }
    log(`the reel currently reads: ${JSON.stringify(opened.before)}`);

    const set = await replaceEditorCaption(cdp, text, { sleep });
    if (!set.set) {
        return { ok: false, reason: 'the caption field did not take the text', landed: set.landed };
    }

    const saved = await saveEditor(cdp, { sleep });
    if (!saved.saved) {
        return { ok: false, reason: saved.reason || 'the Done button was not there' };
    }

    // What the post says, not what the field held.
    const published = await readPublishedCaption(cdp, reelUrl, { sleep });
    if (published.caption === null) {
        return { ok: false, reason: published.reason || 'the reel could not be read back' };
    }
    const landed = published.caption === String(text).trim();
    return {
        ok: landed,
        before: opened.before,
        after: set.landed,
        published: published.caption,
        reason: landed ? undefined : 'the published caption does not match',
    };
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
    await enableFocusEmulation(cdp);

    try {
        await cdp.send('Network.setCookies', { cookies: toBrowserCookies(cookies) });
        await cdp.send('Page.navigate', { url: 'https://www.instagram.com/' });
        await new Promise((r) => setTimeout(r, 5000));

        // Instagram is a single-page app: the feed arrives after the
        // shell, so the landmarks can be seconds late. Poll for them
        // rather than deciding on the first empty frame.
        let s = null;
        for (let i = 0; i < 8; i++) {
            s = (await cdp.js(LOGGED_IN_LANDMARKS, true)) || {};
            if (s.hasFeed || s.onWall || s.onPicker) break;
            await new Promise((r) => setTimeout(r, 2500));
        }
        const stale = 'the cookie jar is expired — Instagram revoked the session server-side. '
            + 'Log into instagram.com in a browser and export a fresh jar to the path in lib/ig-config.json.';
        if (s.onWall) throw new Error('Instagram wants a password — ' + stale);
        if (s.onPicker) throw new Error('Instagram showed the account picker, not the feed — ' + stale);
        if (!s.hasFeed) {
            // Screenshot the page: "not logged in" and "the shell is still
            // loading" look identical from here, and only the picture
            // tells them apart.
            const shot = await cdp.screenshot();
            const shotPath = '/tmp/ig-story-failure.png';
            try { fs.writeFileSync(shotPath, Buffer.from(shot, 'base64')); } catch {}
            throw new Error('not logged in — the feed never rendered at ' + (s.body || 'instagram.com')
                + '. ' + stale + ' (screenshot: ' + shotPath + ')');
        }
        log('Logged in to Instagram');

        // Open the create panel.
        const opened = await cdp.js(`(() => { const c = ${CREATE_CONTROL}; if (!c.found) return { clicked: false }; c.target.click(); return { clicked: true, how: c.how }; })()`, true) || {};
        if (!opened.clicked) {
            throw new Error('the create control was not found on the page — the web shell has changed again');
        }
        log(`create panel opened (${opened.how})`);
        await new Promise((r) => setTimeout(r, 3000));

        // Pick the Story tab — if the web composer has one.
        //
        // IT DOES NOT. Instagram's web create menu carries exactly three
        // entries: Post, Live video and Ad. Stories cannot be made from
        // the browser at all; that is a product limitation, not a
        // selector problem.
        //
        // So the fallback is the other thing the user asked for: a post
        // with NO caption. A feed post can carry an empty caption, which
        // is the web's closest equivalent of a captionless story — the
        // difference is that it is permanent and public where a story
        // lives for 24 hours, and the log says so out loud.
        let mode = 'story';
        if (await clickCreateTab(cdp, 'Story')) {
            log('Story tab selected');
        } else {
            mode = 'post';
            warn('the web composer has no "Story" option (it offers Post, Live video and Ad) — '
                + 'posting as a feed POST WITH NO CAPTION instead. A post is permanent and public; '
                + 'a story lives 24 hours. Delete it if that is not what you wanted.');
            if (!await clickCreateTab(cdp, 'Post')) {
                throw new Error('neither a Story nor a Post option was found in the create menu');
            }
            log('Post option selected — no caption will be set');
        }
        await new Promise((r) => setTimeout(r, 2000));

        if (!await uploadStill(cdp, imagePath)) {
            throw new Error('the still could not be handed to the composer');
        }
        log('still uploaded — waiting for the preview');
        await new Promise((r) => setTimeout(r, 7000));

        // The upload lands on a CROP screen, not the caption screen:
        // "back", "next", "select crop", "select zoom". "next" is the
        // way forward, and it may be more than one screen (crop → zoom →
        // caption).
        await clickNextThroughCrop(cdp, 4, 4000);

        // Publish. A story has no caption, and a post gets an EMPTY one:
        // the caption box is left untouched, which is what "no text" means.
        await clickShare(cdp);

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

/**
 * Repair a published reel's caption.
 *
 * The caption comes from `--caption`, or from the reel's own POST.md
 * when `--reel-dir` points at it — the file the caption was written
 * down in before the post went up.
 */
async function runEditCaption() {
    let caption = EDIT_CAPTION;
    if (!caption && EDIT_DIR && fs.existsSync(EDIT_DIR)) {
        const read = readCaption(EDIT_DIR);
        const inlineHashtags = /#[a-zA-Z0-9_]+/.test(read.text);
        caption = (read.hashtags && !inlineHashtags)
            ? read.text + '\n\n' + read.hashtags
            : read.text;
    }
    if (!caption) {
        throw new Error('no caption to set — pass --caption "..." or --reel-dir <dir>');
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
    log(`Setting the caption of ${EDIT_URL}`);
    log(`Caption: ${JSON.stringify(caption)}`);

    if (DRY_RUN) {
        log('[dry-run] Would open the reel editor and set the caption');
        return 0;
    }

    await launchInstagram();
    const wsUrl = await cdpConnectOrig(`http://127.0.0.1:${PORT}`);
    const cdp = new CDPClientOrig(wsUrl);
    await cdp.connect();
    log('Connected to Chrome via CDP');

    await cdp.send('Network.setCookies', { cookies: toBrowserCookies(cookies) });
    await cdp.send('Page.navigate', { url: 'https://www.instagram.com/' });
    await new Promise(r => setTimeout(r, 4000));

    const result = await editReelCaption(EDIT_URL, caption, { cdp });
    if (!result.ok) {
        warn(`the caption was NOT set (${result.reason})`);
        return 2;
    }
    log(`The caption now reads: ${JSON.stringify(result.after)}`);
    log(`The published reel reads: ${JSON.stringify(result.published)}`);
    return 0;
}

async function main() {
    if (!REEL_DIR && !STORY_IMAGE && !EDIT_URL) {
        console.error('Usage: node ig-poster.js <reel-dir> [--story <image>] [--cookies <file>] [--dry-run]');
        console.error('  <reel-dir>  Directory containing MP4, JPG cover, and POST.md');
        console.error('  --story    A single image, posted as a story. No caption — that is the point of a story.');
        console.error('  --edit-caption <reel-url> --caption "..."   repair a published reel\'s caption');
        process.exit(1);
    }

    if (EDIT_URL) {
        try {
            process.exit(await runEditCaption());
        } catch (e) {
            console.error(`Error: ${e.message}`);
            process.exit(1);
        }
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

if (require.main === module) main();
