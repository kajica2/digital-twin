#!/usr/bin/env node
'use strict';
// lib/mj-web.js
//
// Sprint 0.25 — Midjourney **web app** submitter.
//
// The Discord submitter (lib/mj-submitter.js) needs a logged-in Discord
// session inside the automation profile. That is a second account/UI to
// keep alive, and when it lapses the failure looks like a generic 45s
// "textarea not found" timeout.
//
// The web app needs no Discord at all: midjourney.com/imagine has its
// own prompt bar. This backend drives that instead, using a cookie jar
// exported from a logged-in browser.
//
// Two hard-won constraints are encoded here:
//
//   1. **The browser must be HEADED.** Cloudflare fingerprints
//      headless Chromium: the first couple of submissions land, then
//      `/api/submit-jobs` starts returning 403 and the page becomes the
//      "Just a moment..." interstitial. A visible window passes.
//
//   2. **`__Host-` cookies must not carry a Domain.** See
//      lib/mj-cookies.js. Get this wrong and the site just shows
//      "Log in" with no error at all.
//
// CLI mirrors lib/mj-submitter.js so the watcher can swap backends:
//   node lib/mj-web.js --prompt-file <path> --all-prompts [--skip-done]
//                      [--output <dir>] [--cookies <file>] [--dry-run]
//
// Exit: 0 all submitted · 1 fatal · 2 some prompts failed

const fs = require('node:fs');
const path = require('node:path');

const {
    extractPrompts,
    buildFullPrompt,
    readDoneIndices,
    writeDoneMarker,
    slugify,
    checkChromeOnPort,
    launchChrome,
    cdpConnect,
    CDPClient,
} = require('./mj-submitter.js');

const {
    parseCookieFile,
    toBrowserCookies,
    describe: describeCookies,
    defaultCookiePath,
} = require('./mj-cookies.js');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mj-config.json'), 'utf8'));
const WEB = CONFIG.web || {};

function log(msg) { process.stdout.write(`[mj-web] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[mj-web] ${msg}\n`); }

// ---------- args ----------
const ARGV = process.argv.slice(2);
function argVal(name, fallback) {
    const i = ARGV.indexOf(name);
    return (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) ? ARGV[i + 1] : fallback;
}
// Config values are written for humans ("~/.midjourney-cookies.txt"),
// so expand a leading ~ before treating them as paths. Without this the
// shell-less execFileSync path resolves "~" literally and every run
// fails with "cookie file not found".
function expandHome(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return p;
}
const PROMPT_FILE   = argVal('--prompt-file', null);
const OUTPUT_DIR    = path.resolve(argVal('--output', path.join(REPO, CONFIG.mj?.outputDir || 'mj-output')));
const COOKIES_FILE  = expandHome(argVal('--cookies', WEB.cookiesFile || defaultCookiePath()));
const PORT          = parseInt(argVal('--port', String(CONFIG.chrome?.debugPort || 9444)), 10);
const USER_DATA_DIR = expandHome(argVal('--user-data-dir', WEB.userDataDir || '/tmp/mj-web-profile'));
const BROWSER_BIN   = expandHome(argVal('--browser', CONFIG.paths?.webBrowserBin || CONFIG.paths?.chromeBin));
const ALL_PROMPTS   = ARGV.includes('--all-prompts');
const SKIP_DONE     = ARGV.includes('--skip-done');
const DRY_RUN       = ARGV.includes('--dry-run');
const PREFLIGHT     = ARGV.includes('--preflight');
const HELP          = ARGV.includes('--help') || ARGV.includes('-h');
const IMAGINE_URL   = WEB.imagineUrl || 'https://www.midjourney.com/imagine';
const GEN_TIMEOUT   = Number(WEB.generationTimeoutMs || CONFIG.mj?.generationTimeoutMs || 120000);
const ACCEPT_TIMEOUT = Number(WEB.acceptTimeoutMs || 60000);

const DEFAULT_ARGS = CONFIG.mj?.defaultArgs || '';

function usage() {
    process.stdout.write(`Midjourney web submitter (midjourney.com/imagine)

Usage:
  node lib/mj-web.js --prompt-file <path> [options]

Options:
  --prompt-file <path>   .md prompt file (one top-level bullet per prompt)
  --all-prompts          submit every prompt in the file (default when a file is given)
  --skip-done            skip prompts whose .mj-done-<N> markers exist
  --output <dir>         output directory (default: ${OUTPUT_DIR})
  --cookies <file>       cookie jar exported from a logged-in browser
                         (Netscape or JSON; default: ${defaultCookiePath()})
  --port <n>             browser debug port (default: ${PORT})
  --user-data-dir <dir>  browser profile dir (default: ${USER_DATA_DIR})
  --browser <path>       browser binary (default: ${BROWSER_BIN})
  --dry-run              print what would be submitted, launch nothing
  --preflight            launch the browser and verify the session
                         (cookies accepted, page loaded, prompt bar found)
                         WITHOUT submitting anything. Costs no generations.
  --help, -h

The browser MUST be headed — Cloudflare blocks headless Chromium after
a couple of submissions.
`);
}

// ---------- page helpers (run in the page) ----------

// Cloudflare's interstitial replaces the whole document.
const CF_DETECT = `(() => {
  const t = document.title || '';
  const b = (document.body && document.body.innerText) || '';
  return /Just a moment|Attention Required|Verify you are human/i.test(t + ' ' + b);
})()`;

// The composer textarea. MJ labels it with this placeholder.
const TEXTAREA_SEL = 'textarea[placeholder="What would you like to imagine?"], textarea';

// Task ids in DOCUMENT ORDER.
//
// The feed is virtualized: only the tasks near the viewport are mounted.
// "An id I haven't seen before" is therefore NOT proof of a new task — a
// pre-existing task that happens to scroll into view after submitting
// looks identical to one that was just created. That produced a real
// misattribution (one task id recorded against two different prompts).
//
// "Today" renders newest-first, so the task at document position 0 is
// the one just submitted. Requiring position 0 to be an id that was not
// at position 0 before closes the hole.
// Find the task whose card contains a given prompt excerpt.
//
// This is the reliable acceptance test. Novelty alone is not: the feed is
// virtualized, so a pre-existing task that was simply unmounted at snapshot
// time looks "new" when it later scrolls into view. That produced a real
// misattribution — one task id recorded against two different prompts, which
// viewing the image confirmed.
//
// A prompt is accepted when the media of a task (its `/jobs/<id>` link or its
// CDN image) has a NEAREST TEXT-BEARING ANCESTOR whose text contains the
// excerpt. The walk stops at that ancestor. Climbing past it reaches the feed
// container, whose innerText concatenates every card's prompt — matching that
// attributed four prompts to the first card's task (the container measured
// 2469 chars / 7 task ids against a card's 347 chars / 1 id).
//
// Candidates are job links first (their href carries the id even while images
// are placeholders), then images — some cards lose their job link entirely
// (e.g. once animated), so the image path is not just a fallback.
//
// Note innerText concatenates the UI's own label, so the card reads
// "Loop<the prompt>…" — hence `includes`, not an anchored match, which is
// what made an earlier attempt at this find nothing.
//
// `seen` is the set of task ids already recorded THIS run. Accepting one
// of them for a later prompt is the misattribution bug from 2026-09-30
// (an 8-image task was recorded against two different prompts) — a card
// can only match the prompt actually typed, so an already-consumed id is
// never a valid acceptance.
function findTaskByPromptExpr(excerpt, seen = []) {
    return `(() => {
      const want = ${JSON.stringify(excerpt)};
      const seen = new Set(${JSON.stringify(seen)});
      const norm = (s) => (s || '').replace(/\\s+/g, ' ');
      const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
      const idFromHref = (s) => { const m = (s || '').match(/\\/jobs\\//) && (s || '').match(uuid); return m ? m[1] : null; };
      const idFromSrc  = (s) => { const m = (s || '').match(/cdn\\.midjourney\\.com\\//) && (s || '').match(uuid); return m ? m[1] : null; };
      const seeds = [];
      for (const a of document.querySelectorAll('a[href*="/jobs/"]')) { const id = idFromHref(a.getAttribute('href')); if (id) seeds.push({ node: a, id }); }
      for (const im of document.querySelectorAll('img')) { const id = idFromSrc(im.src); if (id) seeds.push({ node: im, id }); }
      for (const seed of seeds) {
        if (seen.has(seed.id)) continue;
        let el = seed.node;
        while (el && !norm(el.innerText).trim()) el = el.parentElement;
        if (el && norm(el.innerText).includes(want)) return seed.id;
      }
      return null;
    })()`;
}

// A short, whitespace-normalised excerpt distinctive enough to identify the
// prompt in a task card. Params are stripped so MJ's own truncation of the
// trailing text can't break the match.
//
// 64 chars, not 40: prompt packs that open with a shared style clause
// ("Cinematic film still, anamorphic widescreen: …") otherwise produce the
// SAME excerpt for every prompt in the pack, and the acceptance check then
// attributes them all to the first matching card (seen 2026-09-29: an
// 8-prompt pack collapsed onto 3 task ids). Keep prompt packs leading with
// their subject so the first clause is per-prompt unique.
//
// Em/en dashes are normalised to spaces because MJ's rendered card text
// drops them — a prompt containing " — " never matched its own card until
// this was stripped (seen the same day).
function promptExcerpt(text, n = 64) {
    const bare = text
        .replace(/\s*--[\w-]+(\s+\S+)?/g, ' ')
        .replace(/[\u2014\u2013]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return bare.slice(0, n);
}

const READ_TASK_IDS = `(() => {
  const ids = [];
  for (const img of document.querySelectorAll('img')) {
    const m = (img.src || '').match(/\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\//i);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
})()`;

const READ_TASK_IMAGES = (id) => `(() => {
  const out = [];
  for (const img of document.querySelectorAll('img')) {
    const s = img.src || '';
    if (s.includes('${id}')) out.push(s);
  }
  return [...new Set(out)];
})()`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(cdp, expr, timeoutMs, everyMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const v = await cdp.js(expr);
            if (v) return v;
        } catch { /* page may be mid-navigation */ }
        await sleep(everyMs);
    }
    return null;
}

// Focus the composer, paste the full composed prompt, submit.
//
// The submit itself clicks MJ web's send button rather than betting on
// Enter: under CDP, Enter degrades after the first submission of a
// session — batches landed the first prompt then dropped the rest
// (2026-09-30, verified across profiles). The send button (the svg icon
// next to "Add images" that only exists when text is present) clears
// the composer reliably. Enter stays as a fallback should the button be
// missing from a future DOM.
async function submitComposed(cdp, text) {
    await cdp.js(`(() => {
      const ta = document.querySelector('${TEXTAREA_SEL}');
      if (ta) { ta.focus(); }
      return !!ta;
    })()`);
    await cdp.send('Input.insertText', { text });
    await sleep(300);
    const viaClick = await cdp.js(`(() => {
      const t = document.querySelector('${TEXTAREA_SEL}');
      if (!t) return false;
      let c = t;
      for (let i = 0; i < 5 && c; i++) c = c.parentElement;
      const cand = Array.from(c.querySelectorAll('button')).find(
        (b) => b.querySelector('svg') && b.getAttribute('aria-label') !== 'Add images');
      if (!cand) return false;
      cand.click();
      return true;
    })()`);
    if (!viaClick) {
        for (const type of ['keyDown', 'keyUp']) {
            await cdp.send('Input.dispatchKeyEvent', {
                type, key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
        }
    }
}

// A FAIL from the poll is not proof of absence — the feed is virtualized,
// so a landed task can sit off-window (sprint 0.30a) or the composer may
// never have delivered the text (2026-09-30: the lyric-page prompt failed
// three submissions in a row while others succeeded in the same session).
// Newest jobs render at the top-left: scroll home and re-scan before
// declaring FAIL, so the only failures left are genuine.
async function reconcileFeed(cdp, excerpt, seen) {
    await cdp.js('window.scrollTo(0, 0)');
    await sleep(1500);
    return waitFor(cdp, findTaskByPromptExpr(excerpt, seen), 15000, 1200);
}

// ---------- main ----------

async function main() {
    if (HELP) { usage(); process.exit(0); }
    if (!PROMPT_FILE) { warn('--prompt-file is required'); usage(); process.exit(1); }

    const promptFileAbs = path.resolve(PROMPT_FILE);
    if (!fs.existsSync(promptFileAbs)) { warn(`no such prompt file: ${promptFileAbs}`); process.exit(2); }

    const all = extractPrompts(promptFileAbs);
    if (all.length === 0) { warn('no prompts found in file'); process.exit(2); }

    const done = SKIP_DONE ? readDoneIndices(promptFileAbs) : [];
    const todo = all.map((p, i) => ({ p, i })).filter(({ i }) => !done.includes(i));

    log(`${all.length} prompt(s) in ${path.basename(promptFileAbs)}` +
        (done.length ? ` · ${done.length} already done · ${todo.length} to submit` : ''));

    // Compose the exact text once, so --dry-run shows the truth.
    const composed = todo.map(({ p, i }) => ({ i, text: buildFullPrompt(p.text, p.ar, DEFAULT_ARGS) }));

    if (DRY_RUN) {
        for (const c of composed) log(`  ${c.i + 1}. ${c.text}`);
        log('dry run — nothing submitted');
        process.exit(0);
    }
    if (todo.length === 0) { log('nothing to do'); process.exit(0); }

    // ---- cookies ----------------------------------------------------
    if (!fs.existsSync(COOKIES_FILE)) {
        warn(`cookie file not found: ${COOKIES_FILE}`);
        warn('Export cookies for midjourney.com from a logged-in browser (Netscape or JSON).');
        process.exit(2);
    }
    const rawCookies = parseCookieFile(COOKIES_FILE);
    const info = describeCookies(rawCookies);
    if (!info.hasAuthI || !info.hasAuthR) {
        warn(`cookie jar is missing the Midjourney auth tokens (found ${info.count} cookies, none matching AuthUserTokenV3).`);
        warn('Re-export from a browser that is actually logged into midjourney.com.');
        process.exit(2);
    }
    log(`cookies: ${info.count} loaded (${info.hostPrefixed} __Host-), auth tokens present`);

    // ---- browser ----------------------------------------------------
    let proc = null;
    let browserInfo = await checkChromeOnPort(PORT);
    if (!browserInfo) {
        log(`launching ${BROWSER_BIN} (headed) on :${PORT}`);
        proc = await launchChrome(PORT, USER_DATA_DIR, BROWSER_BIN);
        browserInfo = await checkChromeOnPort(PORT);
        if (!browserInfo) { warn('browser did not bind the debug port'); process.exit(1); }
    } else {
        log(`attaching to existing browser on :${PORT}`);
    }

    const wsUrl = await cdpConnect(`http://127.0.0.1:${PORT}`);
    const cdp = new CDPClient(wsUrl);
    await cdp.connect();

    let okCount = 0;
    const failures = [];
    try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

        // `__Host-` handling lives in mj-cookies.js.
        const origin = new URL(IMAGINE_URL).origin;
        const cookies = toBrowserCookies(rawCookies, origin);
        await cdp.send('Network.setCookies', { cookies });

        log(`navigating to ${IMAGINE_URL}`);
        await cdp.navigate(IMAGINE_URL);
        await sleep(5000);

        if (await cdp.js(CF_DETECT)) {
            warn('Cloudflare challenge detected ("Just a moment...").');
            warn('The browser is being fingerprinted. Ensure this run is HEADED (it is by default),');
            warn(`or refresh the profile at ${USER_DATA_DIR} by visiting midjourney.com manually once.`);
            process.exit(1);
        }

        const haveTa = await waitFor(cdp, `!!document.querySelector('${TEXTAREA_SEL}')`, 30000);
        if (!haveTa) {
            warn('prompt textarea never appeared. Verify the cookie jar is from a logged-in session.');
            const shot = await cdp.screenshot();
            const p = path.join(OUTPUT_DIR, '_login-failure.png');
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            fs.writeFileSync(p, Buffer.from(shot, 'base64'));
            warn(`diagnostic screenshot: ${p}`);
            process.exit(1);
        }
        if (await cdp.js(`/creatorium|account|My account/i.test(document.body.innerText)`)) {
            log('session looks authenticated');
        }

        if (PREFLIGHT) {
            const gridCount = await cdp.js(`(() => document.querySelectorAll('img').length)()`);
            log('PREFLIGHT OK — cookie jar accepted, page loaded, prompt bar present.');
            log(`  browser   : :${PORT} (headed)`);
            log(`  cookies   : ${info.count} loaded, ${info.hostPrefixed} __Host-`);
            log(`  imagine   : ${IMAGINE_URL}`);
            log(`  dom images: ${gridCount}`);
            log(`  ${composed.length} prompt(s) ready to submit`);
            process.exit(0);
        }

        // ---- submit each prompt -------------------------------------
        const seenTaskIds = new Set();
        for (const { i, text } of composed) {
            const base = path.join(OUTPUT_DIR, slugify(path.basename(promptFileAbs, '.md')), `prompt-${String(i + 1).padStart(2, '0')}`);
            fs.mkdirSync(base, { recursive: true });
            fs.writeFileSync(path.join(base, 'prompt.md'), `# Prompt ${i + 1}\n\n${text}\n`);
            log(`(${i + 1}/${all.length}) submitting…`);

            await submitComposed(cdp, text);

            // ------ acceptance ------
            //
            // Primary: find the task card whose text contains OUR prompt.
            // That is the only check that cannot misattribute, because a
            // card can only match the prompt we actually typed. Novelty
            // of a task id was the original approach and it was wrong
            // (virtualized feed — see sprint 0.30a).
            //
            // The `seen` set makes it airtight: a task id recorded for an
            // earlier prompt in THIS run can never be accepted again.
            const excerpt = promptExcerpt(text);
            let taskId = await waitFor(cdp, findTaskByPromptExpr(excerpt, [...seenTaskIds]), ACCEPT_TIMEOUT, 1200);

            if (!taskId) taskId = await reconcileFeed(cdp, excerpt, [...seenTaskIds]);
            if (!taskId) {
                // Genuine miss, or the composer never delivered the text —
                // retry the submission once before giving up.
                log(`(${i + 1}/${all.length}) no card yet — retrying submission`);
                await submitComposed(cdp, text);
                taskId = await waitFor(cdp, findTaskByPromptExpr(excerpt, [...seenTaskIds]), ACCEPT_TIMEOUT, 1200);
                if (!taskId) taskId = await reconcileFeed(cdp, excerpt, [...seenTaskIds]);
            }

            if (!taskId) {
                failures.push({
                    index: i + 1,
                    reason: `no task card carrying this prompt appeared within ${ACCEPT_TIMEOUT / 1000}s (after reconciliation + 1 retry)`,
                });
                warn(`(${i + 1}/${all.length}) FAIL — no task card matched the prompt`);
                continue;
            }
            seenTaskIds.add(taskId);

            // Cross-check (recorded, not enforced): the newest task should
            // also be at document position 0. A false here means the feed
            // rendered the card somewhere unexpected — worth seeing in the
            // metadata rather than silently trusting either signal.
            const topNow = (await cdp.js(READ_TASK_IDS) || [])[0] || null;

            // wait for that task's images (best effort; a job can still
            // be queued in relax mode when the timeout expires)
            const deadline = Date.now() + GEN_TIMEOUT;
            let images = [];
            while (Date.now() < deadline) {
                images = (await cdp.js(READ_TASK_IMAGES(taskId))) || [];
                if (images.length >= 4) break;
                await sleep(2500);
            }

            const meta = {
                index: i + 1,
                prompt: text,
                taskId,
                matchedBy: 'prompt-text',
                isNewestTask: topNow === taskId,
                imageUrls: images,
                imageCount: images.length,
                submittedAt: new Date().toISOString(),
                complete: images.length >= 4,
            };
            fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2));
            writeDoneMarker(promptFileAbs, i, base);
            okCount += 1;
            log(`(${i + 1}/${all.length}) ok — task ${taskId.slice(0, 8)}, ${images.length} image(s)` +
                (meta.isNewestTask ? '' : ' (not the newest card)'));
        }
    } finally {
        try { cdp.close(); } catch {}
        // Leave the browser running: it is headed, reusable, and it may
        // still be rendering queued jobs from this run.
    }

    log(`DONE. ${okCount}/${composed.length} submitted.`);
    if (failures.length) {
        for (const f of failures) warn(`  prompt ${f.index}: ${f.reason}`);
        process.exit(2);
    }
    process.exit(0);
}

if (require.main === module) {
    main().catch(e => { warn(`fatal: ${e.message}`); process.exit(1); });
}

// Find the composer send button among a list of button-like objects.
function findSendButton(buttons) {
    if (!Array.isArray(buttons)) return null;
    const norm = b => {
        const label = (b.label || b.getAttribute?.('aria-label') || b.title || '').toLowerCase();
        const hasSvg = !!(b.hasSvg || b.querySelector?.('svg'));
        const disabled = !!(b.disabled);
        return { label, hasSvg, disabled };
    };
    let cand = buttons.find(b => {
        const n = norm(b);
        if (n.disabled) return false;
        if (n.label.includes('add image') || n.label.includes('add images') || n.label.includes('upload') || n.label.includes('paperclip')) return false;
        if (n.label.includes('send') || n.label.includes('submit') || n.label.includes('generate') || n.label.includes('imagine') || n.label.includes('create')) return true;
        if (n.hasSvg && !n.label) return true;
        return false;
    });
    if (cand) return cand;
    cand = buttons.find(b => {
        const n = norm(b);
        if (n.disabled) return false;
        if (!n.hasSvg) return false;
        if (n.label.includes('add') || n.label.includes('upload')) return false;
        return true;
    });
    return cand || null;
}

module.exports = { CF_DETECT, TEXTAREA_SEL, promptExcerpt, findTaskByPromptExpr, READ_TASK_IDS, submitComposed, reconcileFeed, ACCEPT_TIMEOUT, findSendButton };
