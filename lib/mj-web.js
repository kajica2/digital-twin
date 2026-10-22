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

const {
    DISCOVER_USER_ID,
    FETCH_FEED,
    PROBE_URLS,
    gridUrls,
    findJob,
    commandAspect,
} = require('./mj-feed.js');

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

// Upload a local file to uguu.se (anonymous, no auth, returns a public
// URL). `--cref` / `--sref` / `--oref` require public URLs as arguments;
// the user has the local file but MJ needs a URL. uguu.se is the standard
// anonymous host used by open-source MJ tools; 0x0.st has been spamming-
// disabled and catbox.moe's anonymous API now 404s.
//
// uguu returns: {"success":true,"files":[{"url":"https://...","size":...}]}
// On any failure, throw with the upstream HTTP status (or response body)
// so the user can spot CDN outages.
async function uploadToUguu(filePath) {
    const buf = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const fd = new FormData();
    fd.append('files[]', new Blob([buf], { type: 'image/jpeg' }), name);
    const res = await fetch('https://uguu.se/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`uguu.se HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    if (!j.success || !j.files?.[0]?.url) throw new Error(`uguu.se: ${JSON.stringify(j)}`);
    return j.files[0].url;
}

// Resolve all --cref-file / --sref-file / --oref-file arguments to URLs.
// Runs only when those flags were passed; exits cleanly otherwise.
async function resolveRefUrls(label, paths) {
    const urls = [];
    for (const p of paths) {
        if (!fs.existsSync(p)) { warn(`${label} file not found: ${p}`); process.exit(2); }
        log(`uploading ${label}: ${path.basename(p)} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
        const u = await uploadToUguu(p);
        log(`  -> ${u}`);
        urls.push(u);
    }
    return urls;
}

// --cref / --sref / --oref are MJ flags that take URLs as arguments.
// `--cref-file <local>` is a one-step way to pass a local file: it
// uploads to a public CDN (uguu.se — anonymous, no auth) and inserts
// the resulting URL into `--cref`. Repeatable; multiple URLs are
// space-separated in the flag (MJ's own behaviour).
function argList(name) {
    const out = [];
    for (let i = 0; i < ARGV.length; i++) {
        if (ARGV[i] === name && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) {
            out.push(ARGV[i + 1]);
            i++;
        }
    }
    return out;
}
const CREF_FILES  = argList('--cref-file');
const SREF_FILES  = argList('--sref-file');
const OREF_FILES  = argList('--oref-file');
const CREF_URLS   = argList('--cref-url');
const SREF_URLS   = argList('--sref-url');
const OREF_URLS   = argList('--oref-url');
const CREF_WEIGHT = parseFloat(argVal('--cw', '') || 'NaN');
const SREF_WEIGHT = parseFloat(argVal('--sw', '') || 'NaN');

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
  --cref-file <path>     upload a local image to a public CDN (uguu.se)
                         and use the URL as Midjourney's --cref argument.
                         Repeatable; multiple URLs are blended into one
                         identity signal (3-5 is MJ's sweet spot).
  --sref-file <path>     same idea, for style (--sref). Repeatable.
  --oref-file <path>     same idea, for object (--oref). Repeatable.
  --cref-url <url>       pass a public image URL directly as --cref.
                         Repeatable; skips the uguu upload step. Use this
                         when you already have hosted refs (CDN, prior
                         run, Discord upload, etc.).
  --sref-url <url>       same idea, --sref. Repeatable.
  --oref-url <url>       same idea, --oref. Repeatable.
  --cw <0-100>           character weight for --cref (default MJ=100).
  --sw <0-1000>          style weight for --sref (default MJ=100).
  --help, -h

The browser MUST be headed — Cloudflare blocks headless Chromium after
a couple of submissions.

MJ parameters (--ar, --style, --s, --q, --v, --niji) are NOT exposed as
CLI flags. They live in lib/mj-config.json's mj.defaultArgs. If a brief
calls for different style, edit the config OR put the instruction in
the prompt text (e.g. 'realistic photograph, no stylization' as part
of the prompt). This keeps the project's MJ config as the single
source of truth for the user's preferred style.
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

// ---------- feed gate ----------
//
// Acceptance is decided by the FEED API (see lib/mj-feed.js for the full
// post-mortem: 6 of 12 task ids were attributed to the wrong cards
// because the account owner's own concurrent jobs sit in the same
// virtualized feed).
//
// The DOM matcher that used to live here is GONE — deleted, not demoted
// to a fallback. Keeping an unsound matcher around "just in case" is how
// it came back and misattributed a second time. lib/mj-web.test.js
// asserts it is not exported.
//
// The feed's `full_command` is the string the job actually ran with, so
// it answers both "did my prompt land?" and "did it land AS I wrote
// it?" — the DOM never could.

// Fetch the account's job feed. Returns the raw items (newest first).
async function fetchFeed(cdp, userId, pageSize = 200) {
    const res = await cdp.js(FETCH_FEED(userId, pageSize), true);
    if (!res || res.status !== 200 || !Array.isArray(res.items)) return null;
    return res.items;
}

// Discover the account user_id from the live page.
async function discoverUserId(cdp) {
    const id = await cdp.js(DISCOVER_USER_ID, true);
    return id || null;
}

// Wait for the feed to contain a job that matches the prompt exactly:
// same prose, plain generation type, and the flags we asked for.
async function awaitFeedMatch(cdp, userId, promptText, opts, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = await fetchFeed(cdp, userId, 200);
        if (items) {
            const hit = findJob(items, promptText, opts);
            if (hit) return hit;
        }
        await sleep(2000);
    }
    return null;
}

// Probe CDN urls from inside the headed browser. The CDN answers curl
// and headless clients with a Cloudflare 403; a real browser gets 200.
// Returns [{ url, status }].
async function probeCdn(cdp, urls) {
    const res = await cdp.js(PROBE_URLS(urls), true);
    return Array.isArray(res) ? res : [];
}

// The aspect ratio the composed prompt asks for, or null.
//
// This uses the feed module's own parser rather than a second regex, so
// there is exactly ONE definition of "which --ar won". That definition
// matters: Midjourney resolves a doubled flag by taking the LAST one,
// so a naive "first match" regex would demand the wrong ratio and the
// gate would reject a perfectly good job.
function expectedAspect(promptText) {
    return commandAspect(promptText);
}

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

// Does the composer currently carry an attached image?
//
// MJ's composer keeps the account owner's last upload attached until it
// is explicitly removed. A submission made in that state becomes an
// EDIT job (`--edit https://s.mj.run/…`) that renders the OWNER's image
// instead of our prompt — a completely different picture.
//
// The probe scopes to the COMPOSER's own container (the input row that
// holds the textarea), not the whole page: the imagine page's right
// sidebar is full of `s.mj.run` thumbnails belonging to other cards,
// and those are not attachments.
//
// Measured 2026-10-21: the composer's container is `imgTotal: 0` when
// clean, and the sidebar's 8 `s.mj.run` thumbs sit in a different
// subtree entirely.
const COMPOSER_ATTACHMENT_PROBE = `(() => {
  const ta = document.querySelector('${TEXTAREA_SEL}');
  if (!ta) return { scope: 'no-textarea', count: 0, urls: [] };
  // Walk up to the composer container: the nearest ancestor that also
  // holds the "Add images" button.
  let scope = ta;
  for (let i = 0; i < 6 && scope; i++) {
    const hasAdd = Array.from(scope.querySelectorAll('button'))
      .some(b => /add image|upload|paperclip/i.test(b.getAttribute('aria-label') || b.title || ''));
    if (hasAdd) break;
    scope = scope.parentElement;
  }
  if (!scope) scope = ta.parentElement || ta;
  const urls = Array.from(scope.querySelectorAll('img'))
    .map(i => i.src || '')
    .filter(s => s.includes('s.mj.run') || s.includes('cdn.midjourney.com'));
  return { scope: 'composer', count: urls.length, urls: urls.slice(0, 3) };
})()`;

// Remove an attachment from the composer, if one is there.
//
// MJ renders the attachment as a thumbnail inside the composer with a
// remove control. The control's label is not stable across MJ's own UI
// revisions, so the probe looks for any small dismiss button sitting in
// the same chip as the image and clicks it. When no such control is
// found the caller refuses to submit rather than sending an edit job.
const COMPOSER_ATTACHMENT_CLEAR = `(() => {
  const ta = document.querySelector('${TEXTAREA_SEL}');
  if (!ta) return { cleared: 0 };
  let scope = ta;
  for (let i = 0; i < 6 && scope; i++) {
    const hasAdd = Array.from(scope.querySelectorAll('button'))
      .some(b => /add image|upload|paperclip/i.test(b.getAttribute('aria-label') || b.title || ''));
    if (hasAdd) break;
    scope = scope.parentElement;
  }
  if (!scope) return { cleared: 0 };
  let cleared = 0;
  for (const img of Array.from(scope.querySelectorAll('img'))) {
    const src = img.src || '';
    if (!/s\\.mj\\.run|cdn\\.midjourney\\.com/.test(src)) continue;
    // The chip that holds the image usually also holds its dismiss button.
    let chip = img.parentElement;
    for (let i = 0; i < 4 && chip; i++) {
      const btn = Array.from(chip.querySelectorAll('button')).find(b =>
        /remove|delete|close|clear|dismiss|x/i.test(
          (b.getAttribute('aria-label') || '') + ' ' + (b.title || '')));
      if (btn) { btn.click(); cleared++; break; }
      chip = chip.parentElement;
    }
  }
  return { cleared };
})()`;

// Focus the composer, paste the full composed prompt, submit.
//
// The submit itself clicks MJ web's send button rather than betting on
// Enter: under CDP, Enter degrades after the first submission of a
// session — batches landed the first prompt then dropped the rest
// (2026-09-30, verified across profiles). The send button (the svg icon
// next to "Add images" that only exists when text is present) clears
// the composer reliably. Enter stays as a fallback should the button be
// missing from a future DOM.
//
// The attachment guard runs FIRST. A submission with a stale attachment
// becomes an edit job that renders someone else's image, and the feed
// gate would (correctly) reject it — but rejecting is a wasted
// generation, so the attachment is cleared before it can happen.
async function submitComposed(cdp, text) {
    const attach = await cdp.js(COMPOSER_ATTACHMENT_PROBE, true);
    if (attach && attach.count > 0) {
        log(`composer carries ${attach.count} attached image(s) — clearing before submit`);
        const res = await cdp.js(COMPOSER_ATTACHMENT_CLEAR, true);
        await sleep(800);
        const after = await cdp.js(COMPOSER_ATTACHMENT_PROBE, true);
        if (after && after.count > 0) {
            throw new Error(
                `composer still holds ${after.count} attached image(s) after clearing ` +
                `(${after.urls.join(', ')}) — submitting would create an EDIT job that renders ` +
                `the attached image instead of the prompt. Open the imagine page by hand and ` +
                `remove the attachment, then re-run.`);
        }
        log(`cleared ${(res && res.cleared) || 0} attachment(s)`);
    }

    let job = null;
    try {
        job = await submitViaComposer(cdp, text);
    } catch (e) {
        // A refused prompt is a fact about ONE prompt, not a reason to
        // abandon the pack. The reason is carried into the failure
        // record so the artist sees WHICH parameter to fix.
        warn(`Midjourney refused the prompt — ${e.message}`);
        return { refused: true, reason: e.message };
    }
    if (!job) {
        // Not fatal for a pack: the caller records the miss and moves on.
        warn('Midjourney did not accept the prompt — nothing was submitted');
        return null;
    }
    log(`submitted: job ${job.jobId} (${job.jobType})`);
    return job;
}

// ---------- the composer's submit path ----------
//
// MEASURED against the live page (2026-10-22, midjourney.com/imagine):
//
//   * Clicking the composer's send button does NOT submit, however the
//     click is delivered. Four mechanisms were tried against the live
//     page: `element.click()`, a full CDP mouse sequence
//     (mouseMoved / mousePressed / mouseReleased with buttons:1), a
//     pointer+mouse+click event sequence, and the same CDP sequence with
//     `document.hasFocus()` confirmed true at click time.
//     `elementFromPoint` at the button's centre resolves to the
//     button's own SVG path, so the coordinates are right. The prompt
//     stayed in the composer and no /api/submit-jobs request was made.
//
//     The old code believed it worked because MJ renders "parameters"
//     and "send" as two UNLABELLED icon buttons, and it took the FIRST
//     unlabelled one — the parameters button. It never clicked send at
//     all, and the "submitted via send-button" log line was a lie.
//
//   * Pressing ENTER in the composer DOES submit. The response carries
//     the new job id.
//
// ENTER was previously considered unreliable — "Enter degrades after the
// first submission of a session" (2026-09-30). The cause was FOCUS,
// not ENTER: after a submit the composer loses focus, so the next
// ENTER went to the page body. Refocusing the textarea before every
// ENTER submits three prompts in a row without a miss.
//
// So: ENTER is the submit, and the SUBMIT RESPONSE is the proof. The
// response is the only authoritative acceptance signal Midjourney
// offers — the feed lags behind it, and the composer merely emptying
// out does not prove the prompt was accepted.

const SUBMIT_CAPTURE = `(() => {
  window.__mjSubmit = null;
  window.__mjApi = [];
  if (window.__mjSubmitHooked) return true;
  window.__mjSubmitHooked = true;
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    const method = (init && init.method) || (input && input.method) || 'GET';
    return of.apply(this, arguments).then(async (r) => {
      if (/\\/api\\//.test(String(url))) {
        window.__mjApi.push({ method, url: String(url), status: r.status });
        if (/\\/api\\/submit-jobs/.test(String(url))) {
          let body = '';
          try { body = await r.clone().text(); } catch (_) {}
          window.__mjSubmit = { status: r.status, body };
        }
      }
      return r;
    });
  };
  return true;
})()`;

const SUBMIT_RESULT = `(() => (window.__mjSubmit || null))()`;

// What the composer did with our prompt. `submitted` is the load-bearing
// bit: MJ POSTs /api/submit-jobs when it ACCEPTS a prompt, and does not
// when it refuses one. The refusal is silent — no error, no toast, the
// prompt just stays in the composer.
const SUBMIT_STATE = `(() => {
  const api = window.__mjApi || [];
  return {
    submitted: api.some(a => /\\/api\\/submit-jobs/.test(a.url)),
    calls: api.map(a => a.method + ' ' + a.url.replace('https://www.midjourney.com', '') + ' ' + a.status),
  };
})()`;

// Midjourney's own queue readout ("2 queued jobs"). It is the visible
// explanation for a refusal: the account is in RELAXED mode, the queue
// holds a couple of jobs at a time, and a third submission is turned
// away without a word.
//
// The tightest matching element wins: a container's textContent
// includes every descendant, so the shortest match is the badge itself.
const QUEUE_READOUT = `(() => {
  const re = /\\d+\\s+queued\\s+jobs?/i;
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    const t = el.textContent || '';
    if (!re.test(t)) continue;
    if (best === null || t.length < best.length) best = t.trim();
  }
  return best;
})()`;

// The shape of Midjourney's answer to a submission:
//   { success: [ { job_id, prompt, job_type, is_queued, softban,
//                  meta: { batch_size } } ] }
// Parsed into a flat record. Returns null when the body is not an
// accepted submission.
function parseSubmitResponse(body) {
    let payload = body;
    if (typeof body === 'string') {
        try { payload = JSON.parse(body); } catch (_) { return null; }
    }
    const first = payload && Array.isArray(payload.success) ? payload.success[0] : null;
    if (!first || !first.job_id) return null;
    const meta = first.meta || {};
    return {
        jobId: String(first.job_id),
        prompt: String(first.prompt || ''),
        jobType: String(first.job_type || ''),
        eventType: String(first.event_type || ''),
        parentId: first.parent_id == null ? null : String(first.parent_id),
        queued: !!first.is_queued,
        softban: !!first.softban,
        batchSize: meta.batch_size || 4,
        width: meta.width || null,
        height: meta.height || null,
    };
}

// Type the prompt into the composer and submit it, then wait for
// Midjourney's own answer. Returns the accepted job, or null.
//
// Midjourney REFUSES prompts when the account's job queue is full, and
// it refuses them SILENTLY: the composer logs the prompt
// (/api/prompt-session-log), never asks for a submission
// (/api/submit-jobs), and shows no error. A tool that only watches for
// the submit response therefore reads the refusal as "nothing
// happened" — which is exactly what the first live run of this code
// reported.
//
// So the refusal is detected (the submit endpoint was never called),
// the queue is read, and the submission is retried once there is room.
async function submitViaComposer(cdp, text, {
    timeoutMs = 25000,
    retries = 8,
    queueWaitMs = 120000,
} = {}) {
    const focus = () => cdp.js(`(() => {
      const ta = document.querySelector('${TEXTAREA_SEL}');
      if (!ta) return false;
      ta.focus();
      return true;
    })()`, true);

    const typeIn = async () => {
        await cdp.send('Input.insertText', { text });
        await cdp.js(`(() => {
          try {
            const ta = document.querySelector('${TEXTAREA_SEL}');
            if (!ta) return;
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (set) set.call(ta, ${JSON.stringify(text)});
            else ta.value = ${JSON.stringify(text)};
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_) {}
        })()`, true);
        await sleep(350);
    };

    let typed = false;
    let lastQueue = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        await cdp.js(SUBMIT_CAPTURE, true);

        if (!typed) {
            if (!await focus()) throw new Error('the composer textarea is not on the page');
            await typeIn();
            typed = true;
        }

        // Refocus every time: the composer re-renders after the text
        // lands and takes the focus with it, and the composer steals
        // it back after a refusal. Without this the ENTER goes to the
        // page body and nothing is submitted.
        await focus();
        await sleep(150);

        for (const type of ['keyDown', 'keyUp']) {
            await cdp.send('Input.dispatchKeyEvent', {
                type, key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const res = await cdp.js(SUBMIT_RESULT, true);
            if (res && res.body) {
                const job = parseSubmitResponse(res.body);
                if (job) return job;
                break;
            }
            await sleep(300);
        }

        const state = await cdp.js(SUBMIT_STATE, true);
        if (state && state.submitted) {
            throw new Error('Midjourney answered the submission but the response could not be read');
        }

        lastQueue = await cdp.js(QUEUE_READOUT, true);

        // Did the prompt survive in the composer? If not, MJ consumed
        // it — so the next attempt has to type it again.
        const stillThere = await cdp.js(`(() => {
          const ta = document.querySelector('${TEXTAREA_SEL}');
          return !!(ta && ta.value && ta.value.trim().length);
        })()`, true);
        if (!stillThere) typed = false;

        if (attempt === retries) break;

        if (refusalAction(lastQueue) === 'fail') {
            // The queue had room, so the PROMPT is what Midjourney
            // refused. Waiting will not help — say what to look at.
            throw new Error(
                'Midjourney refused the prompt: it logged the text but never asked for a '
                + 'submission, and the job queue has room — so the PARAMETERS are the cause. '
                + 'Check any --style value (v8 has no style presets, only --raw — --style niji, '
                + '--style fire and --style neon are all refused), any --sref/--profile id, and '
                + 'any --edit image url.');
        }

        const room = await waitForQueueRoom(cdp, { maxWaitMs: queueWaitMs });
        log(`  Midjourney did not accept the prompt${lastQueue ? ` (${lastQueue})` : ''}`
            + `${room ? '' : ' — the queue never cleared'} — retrying (${attempt + 1}/${retries})`);
    }

    return null;
}

// Wait until the account's queue has room for another job.
//
// Midjourney's relaxed mode holds a couple of jobs at a time. Observed
// live: a submission is accepted with one job queued and silently
// refused with two.
const MJ_QUEUE_ROOM = 1;

// Pure: does the queue readout leave room for another job?
//
// A missing readout means the queue is not shown (the page changed, or
// the queue is empty and MJ hides the badge). That is treated as room
// — waiting on a reading that will never arrive would hang.
function queueHasRoom(readout) {
    if (readout == null) return true;
    const text = String(readout).trim();
    if (!text) return true;
    const n = parseInt((text.match(/(\d+)/) || [])[1] || '0', 10);
    return n <= MJ_QUEUE_ROOM;
}

// Pure: what to do about a submission Midjourney refused.
//
// A refusal is SILENT — the composer logs the prompt and never asks
// for a submission. Two causes, and they need opposite responses:
//
//   * the queue is full → transient → wait and retry;
//   * the queue has room → the PROMPT was refused → retrying is
//     pointless, and the artist needs to be told WHICH parameter is
//     wrong.
//
// The second case is not hypothetical: `--style niji` (a model name,
// not a style — v8 has no style presets, only `--raw`) is refused
// silently, as is `--style fire` and `--style neon`. Measured live on
// 2026-10-22 with an empty queue: all three were refused, `--style
// raw` was accepted.
function refusalAction(readout) {
    return queueHasRoom(readout) ? 'fail' : 'wait';
}

async function waitForQueueRoom(cdp, { maxWaitMs = 240000, pollMs = 20000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const q = await cdp.js(QUEUE_READOUT, true);
        if (queueHasRoom(q)) return true;
        await sleep(pollMs);
    }
    return false;
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
    //
    // --cref / --sref / --oref need public URLs, not local files. If
    // --{cref,sref,oref}-file is passed, upload the file(s) to uguu.se
    // and append --cref URL1 URL2 ... --cw N (etc.) to the composed
    // defaults. --{cref,sref,oref}-url lets callers skip the upload step
    // when they already have hosted refs. The resulting DEFAULT_ARGS_EFF
    // is per-run; the config value is left alone so other tools using
    // the config see no change.
    let DEFAULT_ARGS_EFF = DEFAULT_ARGS;
    const hasRefs = CREF_FILES.length || SREF_FILES.length || OREF_FILES.length
                 || CREF_URLS.length  || SREF_URLS.length  || OREF_URLS.length;
    if (hasRefs) {
        const [crefFileUrls, srefFileUrls, orefFileUrls] = await Promise.all([
            resolveRefUrls('cref',  CREF_FILES),
            resolveRefUrls('sref',  SREF_FILES),
            resolveRefUrls('oref',  OREF_FILES),
        ]);
        const crefUrls  = [...crefFileUrls,  ...CREF_URLS];
        const srefUrls  = [...srefFileUrls,  ...SREF_URLS];
        const orefUrls  = [...orefFileUrls,  ...OREF_URLS];
        const fragments = [DEFAULT_ARGS];
        if (crefUrls.length) {
            fragments.push(`--cref ${crefUrls.join(' ')}`);
            if (Number.isFinite(CREF_WEIGHT)) fragments.push(`--cw ${CREF_WEIGHT}`);
        }
        if (srefUrls.length) {
            fragments.push(`--sref ${srefUrls.join(' ')}`);
            if (Number.isFinite(SREF_WEIGHT)) fragments.push(`--sw ${SREF_WEIGHT}`);
        }
        if (orefUrls.length) {
            fragments.push(`--oref ${orefUrls.join(' ')}`);
        }
        DEFAULT_ARGS_EFF = fragments.filter(Boolean).join(' ').trim();
        log(`refs: ${crefUrls.length} cref${crefUrls.length === 1 ? '' : 's'}` +
            (srefUrls.length ? ` · ${srefUrls.length} sref` : '') +
            (orefUrls.length ? ` · ${orefUrls.length} oref` : ''));
    }

    const composed = todo.map(({ p, i }) => ({ i, text: buildFullPrompt(p.text, p.ar, DEFAULT_ARGS_EFF) }));

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
            log(`  refs      : ${CREF_FILES.length} cref-file, ${SREF_FILES.length} sref-file, ${OREF_FILES.length} oref-file`);
            log(`  ${composed.length} prompt(s) ready to submit`);
            process.exit(0);
        }

        // Snapshot the feed ONCE before any submission. Cards already
        // in the feed when the run starts are pre-existing (yesterday's
        // jobs, last run's leftovers) — we never want to accept them as
        // a match for a new submission, even if their text happens to
        // contain the prompt's excerpt (re-running a prompt file that
        // already shipped is a common case: 8 cards from the previous
        // run sit in the feed, the new 8 land at the top, the matcher
        // without this snapshot matched the new prompt to the OLD
        // card because both contain the same shared-prefix excerpt).
        //
        // ---- the FEED is the authority -------------------------------
        //
        // The imagine feed is a SHARED timeline: the account owner can be
        // running their own Midjourney jobs at the same time as this
        // automation. Their cards sit in the same feed, carry their own
        // text, and the old DOM matcher eventually attributed one of
        // THEIR cards to OUR prompt — 6 of 12 task ids were wrong in
        // measured runs, and the contact sheet showed the owner's
        // portrait in half the tiles.
        //
        // The feed API returns every job with the `full_command` it
        // actually ran with. That is the only source that can answer
        // "did MY prompt become a job, and did it become the job I
        // asked for?". See lib/mj-feed.js.
        const userId = await discoverUserId(cdp);
        if (!userId) {
            warn('could not discover the account user_id — is the page actually on midjourney.com?');
            process.exit(1);
        }
        log(`feed account: ${userId}`);

        // Snapshot the feed ONCE before any submission. Jobs already in
        // the feed when the run starts are pre-existing (yesterday's
        // jobs, the owner's own work) — never accept one as this run's
        // result, even if its text carries our prompt. A re-run of an
        // already-shipped prompt file is the common case here.
        const beforeItems = await fetchFeed(cdp, userId, 400);
        const beforeSnapshot = new Set((beforeItems || []).map(j => j.id));
        log(`beforeSnapshot: ${beforeSnapshot.size} pre-existing job(s) excluded from matching`);

        // ---- submit each prompt -------------------------------------
        const seenTaskIds = new Set();
        for (const { i, text } of composed) {
            const base = path.join(OUTPUT_DIR, slugify(path.basename(promptFileAbs, '.md')), `prompt-${String(i + 1).padStart(2, '0')}`);
            fs.mkdirSync(base, { recursive: true });
            fs.writeFileSync(path.join(base, 'prompt.md'), `# Prompt ${i + 1}\n\n${text}\n`);
            log(`(${i + 1}/${all.length}) submitting…`);

            // The aspect ratio we asked for. The feed gate checks the
            // ENQUEUED command carried it — Midjourney's web UI
            // silently overrides typed flags with its own button state,
            // and only `full_command` reveals that it happened.
            const ar = expectedAspect(text);
            const matchOpts = {
                expect: ar ? { ar } : {},
                expectStrict: ar ? ['ar'] : [],
                forbid: ['edit', 'cref', 'oref'],
                excludeIds: [...seenTaskIds, ...beforeSnapshot],
            };

            const submitted = await submitComposed(cdp, text);
            if (!submitted) {
                failures.push({ index: i + 1, reason: 'Midjourney did not accept the prompt' });
                warn(`(${i + 1}/${all.length}) FAIL — the submission was refused`);
                continue;
            }
            if (submitted.refused) {
                failures.push({ index: i + 1, reason: submitted.reason });
                warn(`(${i + 1}/${all.length}) FAIL — the prompt was refused`);
                continue;
            }

            // ------ acceptance ------
            //
            // A job is accepted only when the feed shows a PLAIN
            // generation whose `full_command` carries our prose AND our
            // flags. That rules out, in one place:
            //   - the owner's concurrent card (wrong prose),
            //   - an `--edit` job (renders the owner's image),
            //   - a drifted job (UI's `--ar 4:3` instead of our 16:9),
            //   - a video job (an animation, not a still).
            let job = await awaitFeedMatch(cdp, userId, text, matchOpts, ACCEPT_TIMEOUT);

            if (!job) {
                // Genuine miss, or the composer never delivered the text —
                // retry the submission once before giving up.
                log(`(${i + 1}/${all.length}) no matching job yet — retrying submission`);
                const retried = await submitComposed(cdp, text);
                if (!retried || retried.refused) {
                    failures.push({
                        index: i + 1,
                        reason: retried && retried.reason
                            ? retried.reason
                            : 'the retry submission was refused',
                    });
                    warn(`(${i + 1}/${all.length}) FAIL — the retry was refused`);
                    continue;
                }
                job = await awaitFeedMatch(cdp, userId, text, matchOpts, ACCEPT_TIMEOUT);
            }

            if (!job) {
                // Report WHY the feed had nothing, so the failure names
                // its own cause instead of reading as a timeout.
                const items = (await fetchFeed(cdp, userId, 200)) || [];
                const near = items
                    .filter(j => !beforeSnapshot.has(j.id))
                    .slice(0, 3)
                    .map(j => `${j.id.slice(0, 8)} ${j.job_type} ar=${commandAspect(j.full_command) || '—'}`);
                failures.push({
                    index: i + 1,
                    reason: `no plain job carrying this prompt (and ${ar || 'its'} aspect) appeared within ${ACCEPT_TIMEOUT / 1000}s` +
                            (near.length ? ` — recent jobs: ${near.join(', ')}` : ''),
                });
                warn(`(${i + 1}/${all.length}) FAIL — no matching job in the feed`);
                continue;
            }
            seenTaskIds.add(job.id);
            const taskId = job.id;

            // The image urls are DETERMINISTIC from the job id — the CDN
            // path shape is `cdn.midjourney.com/<jobid>/0_<slot>_640_N.webp`.
            // Scraping them from the DOM was unreliable: the feed is
            // virtualized, so the card may not even be mounted, and the
            // DOM carried whatever the owner's cards happened to show.
            //
            // The urls still have to be VERIFIED, not merely constructed:
            // the CDN answers curl and headless clients with a
            // Cloudflare 403, so the probe runs inside the headed browser.
            const candidates = gridUrls(taskId, job.batch_size || 4);
            const deadline = Date.now() + GEN_TIMEOUT;
            let images = [];
            while (Date.now() < deadline) {
                const probed = await probeCdn(cdp, candidates);
                images = probed.filter(p => p.status === 200).map(p => p.url);
                if (images.length >= 4) break;
                await sleep(2500);
            }

            const meta = {
                index: i + 1,
                prompt: text,
                taskId,
                matchedBy: 'feed-command',
                jobType: job.job_type,
                aspect: commandAspect(job.full_command),
                imageUrls: images,
                imageCount: images.length,
                submittedAt: new Date().toISOString(),
                complete: images.length >= 4,
            };
            fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2));
            writeDoneMarker(promptFileAbs, i, base);
            okCount += 1;
            log(`(${i + 1}/${all.length}) ok — task ${taskId.slice(0, 8)}, ${meta.aspect || 'ar?'} ` +
                `${job.job_type}, ${images.length} image(s)`);
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

module.exports = {
    CF_DETECT,
    TEXTAREA_SEL,
    COMPOSER_ATTACHMENT_PROBE,
    COMPOSER_ATTACHMENT_CLEAR,
    SUBMIT_CAPTURE,
    SUBMIT_RESULT,
    SUBMIT_STATE,
    QUEUE_READOUT,
    submitViaComposer,
    waitForQueueRoom,
    queueHasRoom,
    refusalAction,
    parseSubmitResponse,
    submitComposed,
    ACCEPT_TIMEOUT,
    expectedAspect,
    gridUrls,
};
