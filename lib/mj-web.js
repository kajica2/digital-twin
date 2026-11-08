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
    needsRefresh: tokenNeedsRefresh,
    refreshSession,
    sessionRejected,
    staleTokenMessage,
    tokenExpired,
    idToken: idTokenOf,
} = require('./mj-token-refresh.js');

const {
    DISCOVER_USER_ID,
    FETCH_FEED,
    PROBE_URLS,
    gridUrls,
    findJob,
    matchJob,
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
// Accept a job on the submission's own job id when the feed has not
// caught up. See the --accept-on-submit note in the usage text.
const TRUST_SUBMIT = ARGV.includes('--accept-on-submit');
// Clear the account's personalization (profile + moodboards) before
// submitting. Those apply to EVERY generation whatever the prompt says,
// and there is no flag for "no moodboards" — only this toggle.
const NO_PERSONALIZE = ARGV.includes('--no-personalize');
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
  --accept-on-submit     trust the submission's own job id when the feed
                         has not shown the job yet (relaxed queues can lag
                         past the acceptance window). The job IS paid for
                         either way; this decides whether its metadata is
                         written or thrown away as a failure.
  --preflight            launch the browser and verify the session
                         (cookies accepted, page loaded, prompt bar found)
                         WITHOUT submitting anything. Costs no generations.
  --no-personalize       REQUIRE that the account's personalization
                         (profile + moodboards) is not applied. The
                         composer's Personalize toggle does not stop the
                         app injecting a --profile into the payload, so
                         this checks the accepted job's own command and
                         FAILS the prompt if one is there. Clear the
                         account's selections at midjourney.com/moodboards.
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
    // A TRANSIENT PAGE FAILURE MUST NOT KILL THE BATCH.
    //
    // MEASURED 2026-11-06: the imagine page navigated (or the tab was
    // reloaded) while the feed was being read, and the in-page fetch
    // raised "TypeError: Failed to fetch". `cdp.js` turns that into a
    // thrown Error, and the throw propagated all the way out of the
    // batch loop — so the run DIED at prompt 4 of 30 and the remaining
    // 26 prompts were never submitted.
    //
    // The feed is a POLLING source: a failed read is not a failure, it
    // is "not right now". So a read that throws is treated exactly like
    // a read that returned nothing — the caller retries.
    let res;
    try {
        res = await cdp.js(FETCH_FEED(userId, pageSize), true);
    } catch (e) {
        return null;
    }
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

// Wait for the feed to show a SPECIFIC job id, and verify its flags.
//
// This exists because a successful submission already returns the job id,
// so the id — not a prose search — is the authoritative handle on the
// generation that was just paid for. MEASURED 2026-10-25: the prose
// matcher could not recognise v6.1 / Niji job types, so a 10-prompt batch
// re-submitted every prompt and billed twice for each. A known id cannot
// be misattributed: the only question left is whether the feed has
// caught up yet.
async function awaitJobById(cdp, userId, jobId, promptText, opts, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = await fetchFeed(cdp, userId, 200);
        if (items) {
            const hit = items.find(j => j && j.id === jobId);
            if (hit) {
                const check = matchJob(hit, promptText, opts);
                if (check.ok) return hit;
                // Present, but not what we asked for — say so rather than
                // waiting for a second job that will never come.
                return null;
            }
        }
        await sleep(2000);
    }
    return null;
}

// Probe CDN urls from inside the headed browser. The CDN answers curl
// and headless clients with a Cloudflare 403; a real browser gets 200.
// Returns [{ url, status }].
async function probeCdn(cdp, urls) {
    // The same page-failure tolerance as `fetchFeed`: a probe that
    // throws is "not servable right now", not "the whole batch dies".
    // MEASURED 2026-11-06: the imagine page navigated mid-probe and the
    // in-page fetch threw "TypeError: Failed to fetch", which killed a
    // 30-prompt run at prompt 4.
    let res;
    try {
        res = await cdp.js(PROBE_URLS(urls), true);
    } catch (e) {
        return [];
    }
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

// The reference flags the acceptance gate must NOT reject.
//
// The gate rejects `--edit`, `--cref` and `--oref` so the account owner's
// concurrent edit/random-reference job can never be mistaken for ours.
// But when the caller asked for one of them — `--oref-url`, or the flag
// typed in the prompt — rejecting it makes our own job unattributable.
// Read from the composed text, so both paths agree.
const REFERENCE_FLAGS = ['edit', 'cref', 'oref'];

function forbiddenFlags(promptText) {
    const t = String(promptText || '');
    return REFERENCE_FLAGS.filter((f) => !new RegExp(`--${f}(?:\\s|$)`).test(t));
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

// ---------------------------------------------------------------------------
// Personalization reset
// ---------------------------------------------------------------------------
//
// The composer's "Personalize" toggle applies the ACCOUNT's profile and
// moodboards to every submission, whatever the prompt says. There is no
// flag for "no moodboards" — the text cannot express it — so the only way
// to a clean generation is the UI toggle.
//
// Measured 2026-10-22: the account carried profile #8 plus four moodboards
// (#92, popart, yellow taxi, kowloon city). Every generation inherited
// them until the toggle was cleared.
//
// Two things make this non-obvious:
//
//   * A React `element.click()` does NOT flip the control. Verified: the
//     click landed and the state did not change. It needs a real mouse
//     event at the button's coordinates.
//   * The state has no attribute to read. The SELECTED option is painted
//     a saturated coral and the unselected one a neutral grey; in oklab
//     that is a chroma of ~0.23 against ~0.02, so the chroma separates
//     them cleanly.
const PERSONALIZE_STATE = `(() => {
  const heads = Array.from(document.querySelectorAll('*'))
    .filter(e => e.children.length === 0 && (e.textContent || '').trim() === 'Personalize');
  for (const h of heads) {
    let n = h.parentElement;
    for (let d = 0; d < 4 && n; d++, n = n.parentElement) {
      const opts = Array.from(n.querySelectorAll('button'))
        .filter(b => /^(On|Off)$/.test((b.innerText || '').trim()));
      if (opts.length !== 2) continue;
      // The SELECTED option is painted a saturated coral and the
      // unselected one a neutral grey; in oklab that is a chroma of
      // ~0.23 against ~0.02.
      const read = (b) => {
        const m = /oklab\\(([-0-9.]+) ([-0-9.]+) ([-0-9.]+)/.exec(getComputedStyle(b).backgroundColor || '');
        return {
          text: (b.innerText || '').trim(),
          chroma: m ? Math.hypot(Number(m[2]), Number(m[3])) : 0,
          rect: b.getBoundingClientRect(),
        };
      };
      const on = opts.map(read);
      const selected = on.find(o => o.chroma > 0.08);
      const off = on.find(o => o.text === 'Off');
      return {
        found: true,
        selected: selected ? selected.text : null,
        offRect: off && off.rect && off.rect.width
          ? { x: Math.round(off.rect.left + off.rect.width / 2), y: Math.round(off.rect.top + off.rect.height / 2) }
          : null
      };
    }
  }
  return { found: false };
})()`;

// Open the composer's Personalize panel and set the toggle to Off.
//
// Returns the state AFTER the change, so the caller can prove it worked
// rather than assume it.
async function disablePersonalization(cdp) {
    const clickP = () => cdp.js(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => {
        const q = x.getBoundingClientRect();
        return (x.innerText || '').trim() === 'P' && q.top < 70 && q.width > 10;
      });
      if (!b) return false;
      b.click();
      return true;
    })()`, true);

    // The panel TOGGLES, so "click P" can close it. Keep clicking until
    // the Personalize group is laid out. The control we may need to
    // click is the "Off" option — but when "Off" is ALREADY selected it
    // carries no width, so the read must not require a rect.
    let state = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (!(await clickP())) throw new Error('the composer\'s Personalize button ("P") was not found');
        for (let t = 0; t < 8; t++) {
            await sleep(900);
            state = await cdp.js(PERSONALIZE_STATE, true);
            if (state && state.found) break;
            state = null;
        }
        if (state) break;
    }
    if (!state) throw new Error('the Personalize panel would not open');

    if (state.selected === 'Off') {
        log('personalization is already off');
    } else {
        log(`personalization is "${state.selected}" — switching it off`);
        const r = state.offRect;
        for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', {
                type, x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
            });
            await sleep(60);
        }
        await sleep(2000);
        state = await cdp.js(PERSONALIZE_STATE, true);
        if (!state || state.selected !== 'Off') {
            throw new Error(`the Personalize toggle did not turn off (still "${state && state.selected}")`);
        }
        log('personalization is off');
    }

    // Close the panel again.
    await clickP();
    await sleep(600);
    return state;
}

// Is the composer in DRAFT mode?
//
// A draft job comes back as `v8-2_draft_bs24_diffusion` and carries a
// `--draft` flag. It is not a still we asked for, and the feed gate
// (which requires a plain job) rejects it — after the generation has
// already been paid for. The composer has a "Draft Mode" toggle; the
// SELECTED option is painted a saturated coral, the unselected one a
// neutral grey, so the same chroma test as the Personalize toggle reads
// it. Draft mode is a per-account setting, so it survives a reload.
const DRAFT_MODE_STATE = `(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x =>
    (x.innerText || '').trim().split('\\n')[0].trim() === 'Draft Mode'
    && x.getBoundingClientRect().width > 10);
  if (!b) return { found: false };
  const wrap = b.parentElement;
  const m = /oklab\\(([-0-9.]+) ([-0-9.]+) ([-0-9.]+)/.exec(getComputedStyle(wrap || b).backgroundColor || '');
  const q = b.getBoundingClientRect();
  return {
    found: true,
    active: m ? Math.hypot(Number(m[2]), Number(m[3])) > 0.08 : false,
    rect: { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }
  };
})()`;

// Turn Draft Mode off if it is on.
async function ensurePromptMode(cdp) {
    const st = await cdp.js(DRAFT_MODE_STATE, true);
    if (!st || !st.found) return false;
    if (!st.active) return false;
    log('the composer is in Draft Mode — turning it off');
    for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
            type, x: st.rect.x, y: st.rect.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
        });
        await sleep(120);
    }
    await sleep(1500);
    const after = await cdp.js(DRAFT_MODE_STATE, true);
    if (after && after.active) throw new Error('the composer would not leave Draft Mode');
    log('draft mode is off');
    return true;
}

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------
//
// The composer's "Personalize" toggle does NOT stop the web app from
// applying the account's personalization. Measured 2026-10-22 by
// capturing the outgoing request: the app POSTs to /api/submit-jobs with
//
//   "prompt": "… --ar 16:9 --raw --profile p7486486688810663962 --stylize 50 …"
//
// and the `--profile <id>` is NOT in the text that was typed — the client
// injects it from the account's active moodboard selections. The toggle
// in the composer can read "Off" while the profile is still injected.
//
// Two things were tried against that:
//
//   * Stripping the flag from the payload. It is NOT viable: Midjourney
//     REFUSES a submit-jobs payload without the profile token — the
//     request comes back unanswered and no job is created.
//   * Clearing the account's selections. This works: on
//     midjourney.com/moodboards the selected moodboards carry a
//     "Selected Select" button, and clicking it deselects them. After
//     deselecting, the recorded command has no `--profile` at all and the
//     prose comes back verbatim.
//
// So the tool does not try to rewrite the payload. It VERIFIES: the
// accepted job's own command is the record of what Midjourney actually
// ran, and if it carries a `--profile`, the generation was conditioned on
// the account's moodboards after all. With `--no-personalize` that is a
// failure of the prompt, not a warning.
// The profile ids are the codes between `--profile` and the next flag.
//
// The ids are NOT a free-text run to the end of the command. MEASURED
// 2026-11-02: the greedy form `(?:\s+\S+)*` swallowed every flag that
// followed the codes, so a command carrying
//
//   --profile brvazka mhw6dpq xr39csb det21e6 67lkfw3 --stylize 755 --ar 16:9
//
// reported `--stylize`, `755`, `--ar` and `16:9` as though they were
// moodboard ids.
//
// That is not a cosmetic slip. The ids are what the personalization
// check compares, so with `--no-personalize` a prompt carrying the
// artist's OWN `--profile` (the house grade — see
// `assets/mural-prompts/named-not-owned-anchors.md`) would be rejected
// as "the account's personalization was applied" — a false failure
// against the account for the account's own grade.
function profileIdsIn(command) {
    const cmd = String(command || '');
    // EVERY --profile group, not just the first.
    //
    // MEASURED 2026-11-05: the SRCE KUCA pack carries FIVE separate
    // --profile flags (one per moodboard). The old regex matched the
    // first group only, so it reported ONE id — which is why every one
    // of that pack's jobs warned about "--profile brvazka" and nothing
    // else, and why the artist's own grade looked like the app's
    // injection.
    //
    // The value run stops at the next flag: a token beginning with `--`
    // ends the list. MEASURED 2026-11-02: the greedy form
    // `(?:\s+\S+)*` swallowed every flag that followed the codes, so a
    // command carrying
    //
    //   --profile brvazka mhw6dpq xr39csb det21e6 67lkfw3 --stylize 755 --ar 16:9
    //
    // reported `--stylize`, `755`, `--ar` and `16:9` as though they
    // were moodboard ids.
    const out = [];
    const re = /--profile((?:\s+[^\s-][^\s]*)*)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
        for (const tok of m[1].trim().split(/\s+/)) {
            if (tok && !tok.startsWith('--')) out.push(tok);
        }
    }
    return out;
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
async function submitComposed(cdp, text, opts = {}) {
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
    // A SOFTBAN is Midjourney accepting the request and then never
    // queuing it: `success[0]` carries a job_id, `softban: true`, and the
    // job is never rendered — no feed entry, and the CDN 404s forever.
    // Measured 2026-10-26: two submissions on a retired engine (
    // `--v 7`) came back this way, and the tool reported "submitted"
    // both times, then spent its whole acceptance window hunting a job
    // that does not exist.
    //
    // BUT the submit response's `softban` flag is NOT the authority —
    // MEASURED 2026-11-05: two jobs reported soft-banned (0ea9a30f and
    // e40d76ac, both for the same shot) were IN THE FEED as
    // v8-2_hd_diffusion and had rendered perfectly. The flag is also
    // set on ordinary submissions.
    //
    // A softban is DEFINED by the absence of a FEED ENTRY, so the feed
    // decides — BUT THE FEED CANNOT BE THE ONLY WITNESS.
    //
    // MEASURED 2026-11-06, on the 30-look preset pack: nine jobs were
    // reported "soft-banned" and SEVEN of them had rendered. The feed
    // DID list every one of them (as `v8-2_diffusion`, with the right
    // prose) — but `findJobInFeed` had already given up after its 30 s
    // window, because the render takes minutes and the feed publishes
    // the card only when the job is QUEUED.
    //
    // So the old code had the CDN check (the only real authority on
    // "are the pixels there") NESTED INSIDE the feed check — so a job
    // that had not yet reached the feed never got its cells checked,
    // and the tool reported a softban for a frame that existed.
    //
    // THE FIX: ask the CDN DIRECTLY, unconditionally, before declaring
    // a softban. The feed becomes corroboration rather than a gate.
    //
    // A job that IS in the feed but has no cells is still a softban
    // (measured 2026-11-05), so the cell wait has to outlast the
    // render — the config's generationTimeoutMs (120 s) is the floor and
    // the cells get a generous multiple of it.
    const cellWaitMs = opts.cellWaitMs || (GEN_TIMEOUT * 4);
    let feedHit = null;
    if (job.softban && opts.userId) {
        feedHit = await findJobInFeed(cdp, opts.userId, job.jobId, opts.waitMs || 30000);
    }

    if (job.softban) {
        // THE CDN IS THE AUTHORITY. Ask it whether the pixels exist,
        // whatever the feed said — the feed may simply not have
        // published the card yet.
        const cells = await waitForCells(cdp, job.jobId, cellWaitMs);
        if (cells.length) {
            log(`job ${job.jobId.slice(0, 8)} was flagged soft-banned but its cells ARE served `
                + `(${cells.length} of 4) — it rendered; the flag was wrong`
                + (feedHit ? ` (the feed lists it as ${feedHit.job_type})` : ' (the feed had not published it yet)'));
            return { ...job, softban: false, feedConfirmed: !!feedHit, imageUrls: cells };
        }
        if (feedHit) {
            log(`job ${job.jobId.slice(0, 8)} was flagged soft-banned and is in the feed `
                + `(${feedHit.job_type}), but no cells are being served after ${Math.round(cellWaitMs / 1000)}s — `
                + 'it did not render');
        }
    }
    if (job.softban) {
        warn(`job ${job.jobId.slice(0, 8)} was soft-banned — Midjourney accepted the request `
            + 'but will not queue it (no feed entry, no image). Usually a retired engine '
            + 'version or a parameter the current engine no longer supports.');
        return { refused: true, softban: true, jobId: job.jobId, jobType: job.jobType,
            reason: `Midjourney soft-banned the prompt as ${job.jobId.slice(0, 8)} (${job.jobType || 'no job type'}) — it is never queued, so nothing renders. Name an engine version the account actually runs (--v 8.2 here) and check the parameters.` };
    }
    log(`submitted: job ${job.jobId} (${job.jobType})`);
    return job;
}

// Wait for a job's grid cells to be SERVED by the CDN.
//
// The feed says a job was QUEUED; the CDN says whether the pixels are
// there. A queued job's cells appear within a minute or two; a
// softbanned job's never do.
//
// MEASURED 2026-11-05: the CDN serves cells on a SHORT LIFETIME — job
// 640cb078's four cells were fetched (2 MB+ each) and the CDN answered
// 404 for every one of them minutes later. So a 404 is only meaningful
// when it persists for the whole window.
//
// MEASURED 2026-11-06: a job can be served PARTIALLY — one cell live
// while the rest are still rendering. The first version returned as soon
// as ANY cell answered 200, which reported a half-rendered job as
// whole. So the wait now returns the cells it found, and the caller
// gets the COUNT — but the wait also keeps going until the grid is
// complete or the window closes, because a partial grid is still a
// render in flight.
async function waitForCells(cdp, jobId, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    const candidates = gridUrls(jobId, 4);
    // The poll interval must fit INSIDE the window, or a short window
    // (the tests use 100 ms) cannot return on time — the sleep would
    // overshoot the deadline by its whole duration.
    const interval = Math.max(50, Math.min(3000, Math.floor(timeoutMs / 3)));
    let best = [];
    while (Date.now() < deadline) {
        const probed = await probeCdn(cdp, candidates);
        const ok = probed.filter(p => p.status === 200).map(p => p.url);
        if (ok.length > best.length) best = ok;
        // The grid is complete — every slot is served.
        if (ok.length >= candidates.length) return ok;
        const left = deadline - Date.now();
        if (left <= 0) break;
        await sleep(Math.min(interval, left));
    }
    // The window closed. Return whatever was served: a partial grid is
    // still real pixels, and the caller records the count so the
    // artist can see the job half-rendered rather than dead.
    return best;
}

// Look a job id up in the feed, briefly.
//
// The feed is a shared timeline and the entry can appear a moment after
// the submission is accepted, so this polls for a short while rather
// than reading once.
async function findJobInFeed(cdp, userId, jobId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = await fetchFeed(cdp, userId, 400);
        if (items) {
            const hit = items.find(j => j && j.id === jobId);
            if (hit) return hit;
        }
        await sleep(2000);
    }
    return null;
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

// Midjourney's own answer to a prompt it did not accept.
//
// The refusal body names the reason — "banned_prompt_detected", a
// moderation note, a queue message. A sentence about the TOOL ("the
// response could not be read") tells the operator nothing, and the
// operator cannot act on it: the only way to find out what MJ objected
// to is to read what MJ said.
//
// Kept as a pure function so the message is testable without a browser
// and without spending a generation.
function refusalMessage(body, status) {
    const said = String(body == null ? '' : body).replace(/\s+/g, ' ').trim();
    const head = said ? said.slice(0, 300) : '(empty body)';
    const where = status ? ` (HTTP ${status})` : '';
    return `Midjourney answered the submission but the response could not be read${where}: ${head}`;
}

// The message shown when Midjourney logs the prompt but never asks for
// a submission.
//
// Kept as a pure function so the message is testable without a browser
// and without spending a generation.
//
// MEASURED 2026-11-04, by bisection on ONE prompt against this account:
//   --cref <url> --cw 100   → REFUSED (job never asked for)
//   --cref <url>             → REFUSED (the FLAG, not the pairing)
//   (no reference flag)      → ACCEPTED (job 3367df72)
//   --edit <url>             → ACCEPTED (job 333bdfb0, v8-2_edit_diffusion)
//
// So `--cref` is a suspect and `--edit` is NOT. An earlier version of
// this message named --edit as a suspect, which sent the bisection the
// wrong way and cost two generations. The message must not drift back.
function parameterRefusalMessage() {
    return 'Midjourney refused the prompt: it logged the text but never asked for a '
        + 'submission, and the job queue has room. Look at the parameters first — '
        + 'any --style value (v8 has no style presets, only --raw — --style niji, '
        + '--style fire and --style neon are all refused), any --sref/--profile id, '
        + 'and any --cref url (measured refused on this account 2026-11-04; --edit '
        + 'is accepted). If the prompt itself is fine, the submission never '
        + 'reached Midjourney: check that the browser window was focused.';
}

// The shape of Midjourney's answer to an ACCEPTED submission:
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
    // The renderer has to believe it is the focused window, or the
    // composer swallows the ENTER and the prompt just sits there.
    //
    // Measured, same machine, same account, same command, one minute
    // apart: with focus emulation ON the command submitted (job
    // f9020375); with it OFF the composer kept the text, MJ never saw
    // a submission, and the tool read that as "Midjourney refused the
    // prompt". It was never a refusal — it was a key event delivered
    // into a backgrounded renderer.
    //
    // It belongs HERE, in the shared submit path, because that is where
    // the key is pressed. Two callers had their own setup and one of
    // them (mj-revise) never enabled it, so the omission was invisible
    // until a run went unattended.
    try {
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (_) {
        // A client that does not implement the domain still submits; the
        // call is a guard, not a requirement.
    }

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
                // MJ answered, and the answer is not a job. Say what it
                // said: "the response could not be read" is a sentence
                // about the tool, and the tool is not the thing that
                // needs fixing. A refusal body names the reason.
                throw new Error(refusalMessage(res.body, res.status));
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
            //
            // The message names the PARAMETERS because that is where a
            // refusal has been seen. It is a list of places to look, not
            // a diagnosis: this exact sentence was also produced by a
            // submission that never reached Midjourney at all (the
            // renderer was not focused, so the composer swallowed the
            // ENTER). The focus guard above is the fix for that case.
            throw new Error(parameterRefusalMessage());
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
    // --preflight verifies the session and spends nothing, so it must not
    // demand a prompt file: "is the jar still good?" is a question that
    // has no file attached to it.
    if (!PROMPT_FILE && !PREFLIGHT) { warn('--prompt-file is required'); usage(); process.exit(1); }

    const promptFileAbs = PROMPT_FILE ? path.resolve(PROMPT_FILE) : null;
    if (promptFileAbs && !fs.existsSync(promptFileAbs)) { warn(`no such prompt file: ${promptFileAbs}`); process.exit(2); }

    const all = promptFileAbs ? extractPrompts(promptFileAbs) : [];
    if (promptFileAbs && all.length === 0) { warn('no prompts found in file'); process.exit(2); }

    const done = SKIP_DONE && promptFileAbs ? readDoneIndices(promptFileAbs) : [];
    const todo = all.map((p, i) => ({ p, i })).filter(({ i }) => !done.includes(i));

    if (promptFileAbs) {
        log(`${all.length} prompt(s) in ${path.basename(promptFileAbs)}` +
            (done.length ? ` · ${done.length} already done · ${todo.length} to submit` : ''));
    }

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
    if (todo.length === 0 && !PREFLIGHT) { log('nothing to do'); process.exit(0); }

    // ---- cookies ----------------------------------------------------
    if (!fs.existsSync(COOKIES_FILE)) {
        warn(`cookie file not found: ${COOKIES_FILE}`);
        warn('Export cookies for midjourney.com from a logged-in browser (Netscape or JSON).');
        process.exit(2);
    }
    let rawCookies = parseCookieFile(COOKIES_FILE);
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

        // The session can be rejected by the server even when the jar's id
        // token is still inside its expiry window — MEASURED 2026-11-01:
        // the token was valid until 06:04 and was still cleared at 05:44.
        // The refresh token in the same jar is long-lived, so a rejected
        // session can be renewed without the user re-exporting anything.
        //
        // TWO triggers, because neither alone covers the failure:
        //
        //   1. PRE-EMPTIVE — the token is expired or nearly so. This is
        //      the normal hour-boundary case, and refreshing here means
        //      the run never has to fail once.
        //   2. ON REJECTION — the server redirected to /auth/signin and
        //      cleared the cookies. This is the case the token's expiry
        //      does NOT predict.
        //
        // The refresh needs the page loaded (the Firebase API key is read
        // from MJ's own bundle), so it happens after the first navigation
        // and the page is loaded again with the renewed cookies.
        const rejected = sessionRejected(await cdp.js('location.href'));
        if (rejected || tokenNeedsRefresh(rawCookies)) {
            log(rejected
                ? 'midjourney.com rejected the session — refreshing it'
                : 'the jar\'s id token has expired — refreshing the session');
            const refreshed = await refreshSession(rawCookies, cdp, { log, force: rejected });
            if (refreshed.refreshed) {
                rawCookies = refreshed.entries;
                await cdp.send('Network.setCookies', {
                    cookies: toBrowserCookies(rawCookies, origin),
                });
                log('navigating again with the refreshed session');
                await cdp.navigate(IMAGINE_URL);
                await sleep(5000);
            } else if (refreshed.reason) {
                warn(`the session could not be refreshed — ${refreshed.reason}`);
            }
        }

        const haveTa = await waitFor(cdp, `!!document.querySelector('${TEXTAREA_SEL}')`, 30000);
        if (!haveTa) {
            // Say WHICH half of the session is wrong. The old message
            // blamed the jar, and the jar is usually fine — the token
            // inside it is what the server refused.
            const stale = tokenExpired(idTokenOf(rawCookies));
            if (stale || sessionRejected(await cdp.js('location.href'))) {
                warn(staleTokenMessage(COOKIES_FILE));
            } else {
                warn('prompt textarea never appeared. Verify the cookie jar is from a logged-in session.');
            }
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
            if (composed.length) log(`  ${composed.length} prompt(s) ready to submit`);
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

        // Clean the composer FIRST, so every prompt in the batch goes out
        // under the same settings.
        //
        // Draft mode is a per-account setting and it makes every job a
        // draft — not a still. It is always cleared.
        try {
            await ensurePromptMode(cdp);
        } catch (e) {
            warn(`could not clear draft mode: ${e.message}`);
        }

        // The account's personalization (profile + moodboards) applies to
        // every generation whatever the prompt says. The composer's
        // toggle does not stop it — the web app injects `--profile <id>`
        // into the submit payload — so it is stripped from the request.
        if (NO_PERSONALIZE) {
            log('checking every accepted job for the account\'s personalization');
        }

        // The artist's own --profile grade, reported once per run rather
        // than once per job (see the personalization block below).
        let profileWarningShown = false;

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
            let matchedBy = 'feed-command';
            // A reference flag the caller deliberately asked for (via
            // --oref-url / --cref-url / --sref-url, or typed in the
            // prompt) must not be forbidden by the acceptance gate — the
            // gate exists to reject the account owner's concurrent
            // --edit job and an unasked-for reference, not our own.
            // Read from the composed text, so both paths agree.
            const matchOpts = {
                expect: ar ? { ar } : {},
                expectStrict: ar ? ['ar'] : [],
                forbid: forbiddenFlags(text),
                excludeIds: [...seenTaskIds, ...beforeSnapshot],
                // How long to wait for the cells when the feed is behind.
                // Short by default: the cells are the fast signal, and a
                // long window here would cost every slow prompt two
                // full waits.
                cellWaitMs: 60000,
            };

            const submitted = await submitComposed(cdp, text, { userId });
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
            // The submission's own answer carries the job id. When it
            // does, that id is what we wait for — a second submission can
            // only ever duplicate a generation that already exists.
            const acceptedId = submitted.jobId || null;

            // THE FAST SIGNAL FIRST: ARE THE CELLS ALREADY BEING SERVED?
            //
            // MEASURED 2026-11-06: the feed publishes a card when the job
            // is QUEUED, which can be minutes after the cells are
            // already rendering. Waiting the full acceptance window for
            // the feed before asking the CDN made every slow job cost
            // ACCEPT_TIMEOUT (240 s) plus the cell wait (720 s) — 16
            // minutes for one prompt.
            //
            // So the cells are asked FIRST, with a short window. If they
            // are served, the generation happened and the submission's
            // own command is the record — no feed wait needed. If they
            // are not, the feed gets its full window as before.
            let earlyCells = [];
            if (acceptedId) {
                earlyCells = await waitForCells(cdp, acceptedId, matchOpts.cellWaitMs);
            }

            let job = null;
            if (acceptedId && earlyCells.length) {
                // The cells are up. The feed is asked for the metadata
                // (the aspect, the type) but it is NOT allowed to veto
                // a job whose pixels exist.
                const hit = await findJobInFeed(cdp, userId, acceptedId, matchOpts.waitMs || 30000);
                job = {
                    id: acceptedId,
                    job_type: (hit && hit.job_type) || (submitted && submitted.jobType) || 'unknown',
                    event_type: (hit && hit.event_type) || (submitted && submitted.eventType) || 'diffusion',
                    batch_size: (hit && hit.batch_size) || (submitted && submitted.batchSize) || 4,
                    width: (hit && hit.width) || (submitted && submitted.width) || null,
                    height: (hit && hit.height) || (submitted && submitted.height) || null,
                    full_command: (hit && hit.full_command) || text,
                    imageUrls: earlyCells,
                    imageCount: earlyCells.length,
                };
                matchedBy = hit ? 'feed-command' : 'cdn-cells';
                log(`(${i + 1}/${all.length}) ${acceptedId.slice(0, 8)} — its cells are served `
                    + `(${earlyCells.length} of 4)`
                    + (hit ? ` and the feed lists it as ${hit.job_type}` : ' (the feed has not published it yet)'));
            } else {
                job = acceptedId
                    ? await awaitJobById(cdp, userId, acceptedId, text, matchOpts, ACCEPT_TIMEOUT)
                    : await awaitFeedMatch(cdp, userId, text, matchOpts, ACCEPT_TIMEOUT);
            }

            if (!job && acceptedId && TRUST_SUBMIT) {
                // Sprint 0.60's rule: a known job id is authoritative. The
                // POST /api/submit-jobs answer already named the job, so the
                // generation exists and has been paid for — waiting on a
                // relaxed queue that has not published it yet must not throw
                // the metadata away. `full_command` is what WE composed and
                // sent, which is the record this run can stand behind.
                job = {
                    id: acceptedId,
                    job_type: (submitted && submitted.jobType) || 'unknown',
                    event_type: (submitted && submitted.eventType) || 'diffusion',
                    batch_size: (submitted && submitted.batchSize) || 4,
                    width: (submitted && submitted.width) || null,
                    height: (submitted && submitted.height) || null,
                    full_command: text,
                };
                matchedBy = 'submit-response';
                warn(`(${i + 1}/${all.length}) the feed has not shown ${acceptedId.slice(0, 8)} yet — `
                    + 'accepted on the submission\'s own job id (--accept-on-submit)');
            }

            if (!job && acceptedId) {
                // Accepted by Midjourney, but the feed still does not show
                // it as the job we asked for. Do NOT re-submit: the
                // generation exists and has been paid for.
                //
                // BUT THE FEED IS NOT THE ONLY WITNESS — ASK THE CDN.
                //
                // MEASURED 2026-11-06: the same false failure as the
                // softban path, in a different doorway. The feed had not
                // published the card yet, so the acceptance gate reported
                // "the feed disagrees" — while the job's cells were
                // being served. The gate's job is to make sure the job
                // on the feed is OURS (and not the account owner's
                // concurrent edit), so a missing feed entry has always
                // been a reason to doubt. But a served cell set is
                // positive proof that the generation happened, and the
                // prose is on record in the submission's own command.
                //
                // So: if the cells are served, the job rendered and the
                // prompt's own command stands as the record. If they are
                // not, the disagreement stands.
                const cells = await waitForCells(cdp, acceptedId, matchOpts.cellWaitMs || (GEN_TIMEOUT * 4));
                if (cells.length) {
                    log(`(${i + 1}/${all.length}) the feed has not shown ${acceptedId.slice(0, 8)} yet, `
                        + `but its cells ARE served (${cells.length} of 4) — it rendered; the feed was behind`);
                    job = {
                        id: acceptedId,
                        job_type: (submitted && submitted.jobType) || 'unknown',
                        event_type: (submitted && submitted.eventType) || 'diffusion',
                        batch_size: (submitted && submitted.batchSize) || 4,
                        width: (submitted && submitted.width) || null,
                        height: (submitted && submitted.height) || null,
                        full_command: text,
                        imageUrls: cells,
                        imageCount: cells.length,
                        matchedBy: 'cdn-cells',
                    };
                    matchedBy = 'cdn-cells';
                } else {
                    failures.push({
                        index: i + 1,
                        reason: `accepted as ${acceptedId} but the feed does not show it as this prompt `
                                + `(within ${ACCEPT_TIMEOUT / 1000}s) and the CDN serves no cells — not re-submitting`,
                    });
                    warn(`(${i + 1}/${all.length}) FAIL — accepted as ${acceptedId.slice(0, 8)} but the feed disagrees`);
                    continue;
                }
            }

            if (!job) {
                // No id at all: the composer never delivered the text —
                // retry the submission once before giving up.
                log(`(${i + 1}/${all.length}) no job id from the submission — retrying submission`);
                const retried = await submitComposed(cdp, text, { userId });
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

            // The account's personalization, checked against the job's
            // OWN recorded command — the record of what Midjourney
            // actually ran. The composer's "Personalize" toggle can read
            // "Off" while the app still injects a `--profile` into the
            // payload, so the toggle is not evidence; this is.
            const profileIds = profileIdsIn(job.full_command);
            if (profileIds.length) {
                const where = `midjourney.com/moodboards → deselect the selected moodboards (the composer's Personalize toggle does not stop the injection)`;
                // The profile ids the PROMPT asked for are not the app's
                // personalization — they are the artist's own grade.
                //
                // MEASURED 2026-11-05: the SRCE KUCA pack carries FIVE
                // --profile flags the artist dictated, and every one of
                // its twelve jobs drew this warning — so the message was
                // pure noise, and under --no-personalize it would have
                // FAILED twelve jobs for using the grade the artist
                // asked for. The repo already names this false-failure
                // class for the strict mode; the warning path has it too.
                //
                // So: the ids that are NOT in the prompt are the app's
                // injection, and only those are reported.
                const asked = profileIdsIn(text);
                const injected = profileIds.filter(id => !asked.includes(id));
                if (injected.length) {
                    if (NO_PERSONALIZE) {
                        failures.push({
                            index: i + 1,
                            reason: `the generation carries the account's personalization (--profile ${injected.join(' ')}) — clear it at ${where}`,
                        });
                        warn(`(${i + 1}/${all.length}) FAIL — the account's personalization was applied (--profile ${injected.join(' ')})`);
                        continue;
                    }
                    warn(`(${i + 1}/${all.length}) the account's personalization was applied (--profile ${injected.join(' ')}) — clear it at ${where}`);
                } else if (asked.length) {
                    // The prompt asked for exactly these codes. Say so
                    // once, quietly — this is the artist's own grade, and
                    // repeating it per job buries the real warnings.
                    if (!profileWarningShown) {
                        profileWarningShown = true;
                        log(`the artist's own grade is applied (--profile ${asked.join(' ')}) — as requested`);
                    }
                }
            }
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
                matchedBy: matchedBy || 'feed-command',
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
    refusalMessage,
    parameterRefusalMessage,
    submitComposed,
    findJobInFeed,
    waitForCells,
    fetchFeed,
    probeCdn,
    awaitJobById,
    ACCEPT_TIMEOUT,
    expectedAspect,
    forbiddenFlags,
    REFERENCE_FLAGS,
    gridUrls,
    PERSONALIZE_STATE,
    disablePersonalization,
    profileIdsIn,
};
