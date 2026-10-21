#!/usr/bin/env node
// lib/mj-revise.js — re-evolve a Midjourney EDIT job's prompt while
// keeping the job's own attachments, style reference, profile and flags.
//
// The problem it solves
// --------------------
// You have a job that was made by attaching two images (a face photo +
// a scene photo) and you want new generations that keep those same
// attachments but say something different. Doing that by hand means
// re-attaching the files and re-typing a long flag string every time —
// and the flag string is easy to get subtly wrong (a missing --stylize,
// a lost moodboard code, a different --ar).
//
// This tool takes the SOURCE job and does it from the source's own
// record:
//
//   1. read the source job's `full_command` from the live feed
//   2. split it into the prose and the flag segments
//   3. for each new prompt: compose `<new prose> <the source's flags>`
//      — including the source's own `--edit <url> …` attachments
//   4. type it into the composer and submit
//   5. wait for the new task in the feed, then write its 4-up + meta.json
//
// The flags are NEVER transcribed by hand. They come from the source
// job, so "the same settings" is true by construction.
//
// Why `--edit` travels in the TEXT
// -------------------------------
// Midjourney's web composer has an "Attach to prompt" slot, and driving
// it through CDP means fighting a file input that is hidden behind a
// React portal, that toggles open and closed, and that MJ DEDUPES
// (re-uploading the same bytes returns the same s.mj.run id and renders
// no new chip at all). Every one of those behaviours is a silent
// failure: the submission lands as a PLAIN generation with no reference
// image, and nothing says so.
//
// Typing the source's own `--edit <url> …` into the prompt text does
// the same thing with none of that. Verified: the resulting job comes
// back as `v8-2_edit_diffusion` / `edit_ref_diffusion` with the
// EXACT source URLs in its command. One submission took 8.5s.
//
// Usage
// -----
//   node lib/mj-revise.js --source <jobId> --prompt-file <file.md> \
//        [--limit N] [--output <dir>] [--port 9445] [--no-reuse]
//
// The prompt file follows the repo's pack convention (see
// assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md): one top-level
// bullet per prompt.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    CDPClient, cdpConnect, checkChromeOnPort, launchChrome, extractPrompts,
} = require('./mj-submitter.js');
const {
    DISCOVER_USER_ID, FETCH_FEED, gridUrls,
} = require('./mj-feed.js');

const REPO = path.resolve(__dirname, '..');

// ---------- args --------------------------------------------------------
function argVal(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SOURCE_JOB = argVal('--source', null);
const PROMPT_FILE = argVal('--prompt-file', null);
const LIMIT = parseInt(argVal('--limit', '0'), 10);
const OUTPUT_DIR = path.resolve(argVal('--output', path.join(REPO, 'mj-output', 'revise')));
const PORT = parseInt(argVal('--port', '9445'), 10);
const USER_DATA_DIR = argVal('--user-data-dir', '/tmp/mj-revise-profile');
const BROWSER_BIN = argVal('--browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const REUSE = !process.argv.includes('--no-reuse');
const IMAGINE_URL = 'https://www.midjourney.com/imagine';
const TEXTAREA_SEL = 'textarea';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { process.stdout.write(`[mj-revise] ${m}\n`); }
function warn(m) { process.stderr.write(`[mj-revise] ${m}\n`); }

// Fold the text the way the feed matcher does: dashes normalised,
// whitespace collapsed, case folded. Em dashes and en dashes are
// different characters but the same word-boundary to the eye, and MJ
// re-serialises them.
const fold = (s) => String(s || '').replace(/[—–]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// ---------- source command parsing --------------------------------------
//
// A flag starts with `--` and owns every token up to the next flag. The
// prose is whatever comes before the first flag.
const FLAG_RE = /(^|\s)(--[a-zA-Z][\w-]*)(?=\s|$)/g;

function splitCommand(text) {
    const s = String(text || '').trim();
    const marks = [];
    let m;
    while ((m = FLAG_RE.exec(s)) !== null) {
        marks.push({ idx: m.index + m[1].length, flag: m[2] });
    }
    FLAG_RE.lastIndex = 0;
    if (!marks.length) return { prose: s, flags: [] };
    const flags = marks.map((mark, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].idx : s.length;
        const values = s.slice(mark.idx + mark.flag.length, end).trim().split(/\s+/).filter(Boolean);
        return { flag: mark.flag, values };
    });
    return { prose: s.slice(0, marks[0].idx).trim(), flags };
}

// The flags carried over verbatim from the source job.
//
// `--edit` is INCLUDED: the attachments travel in the text, which is
// the whole mechanism (see the header).
//
// `--ar` is included but the composed prompt puts it LAST, the way
// Midjourney itself serialises it and the way the repo's own
// buildFullPrompt does — MJ resolves a doubled flag by taking the LAST
// one, so the source's ratio must not be shadowed.
const CARRY = new Set(['--ar', '--raw', '--style', '--s', '--stylize', '--v', '--hd',
    '--sref', '--cref', '--oref', '--profile', '--edit', '--niji', '--no', '--q']);

// The bare personalization codes (moodboards) sit between `--profile <id>`
// and the next flag. They are carried over as text, exactly as MJ's own
// command line shows them.
function flagString(flags, { omit = new Set(), omitValues = new Set() } = {}) {
    const out = [];
    for (const f of flags) {
        if (!CARRY.has(f.flag)) continue;
        if (omit.has(f.flag)) continue;
        if (omitValues.has(f.flag)) continue;
        out.push(f.values.length ? `${f.flag} ${f.values.join(' ')}` : f.flag);
    }
    return out.join(' ');
}

// The attachment URLs of the source job (its `--edit` segment).
function editUrls(flags) {
    const seg = flags.find((f) => f.flag === '--edit');
    return seg ? seg.values.slice() : [];
}

// ---------- composer helpers --------------------------------------------

async function setPromptText(cdp, text) {
    await cdp.js(`(() => { const ta = document.querySelector('${TEXTAREA_SEL}'); if (ta) ta.focus(); return !!ta; })()`);
    await cdp.send('Input.insertText', { text });
    // React-controlled inputs need the native setter + an input event,
    // or the state never sees the text.
    await cdp.js(`(() => {
      const ta = document.querySelector('${TEXTAREA_SEL}');
      if (!ta) return;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (set) set.call(ta, ${JSON.stringify(text)});
      else ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
}

async function clickSend(cdp) {
    // The send BUTTON, not Enter: under CDP, Enter degrades after the
    // first submission of a session (batches landed the first prompt
    // then dropped the rest — verified 2026-09-30).
    const viaClick = await cdp.js(`(() => {
      const t = document.querySelector('${TEXTAREA_SEL}');
      if (!t) return false;
      let c = t;
      for (let i = 0; i < 5 && c; i++) c = c.parentElement;
      const buttons = Array.from(c.querySelectorAll('button'));
      const cand = buttons.find(b => {
        if (b.disabled) return false;
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('add image') || label.includes('upload') || label.includes('paperclip')) return false;
        return b.querySelector('svg') && (label.includes('send') || label.includes('submit') || label.includes('generate') || !label);
      });
      if (!cand) return false;
      cand.click();
      return true;
    })()`, true);
    if (viaClick) { log('submitted via send-button'); return true; }
    log('submitted via enter-fallback');
    for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
            type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
    }
    return false;
}

// ---------- feed helpers ------------------------------------------------
async function fetchFeed(cdp, userId) {
    const res = await cdp.js(FETCH_FEED(userId, 400), true);
    return (res && Array.isArray(res.items)) ? res.items : null;
}

// A job whose recorded command contains the distinctive opening of our
// prompt AND carries the source's attachment URLs.
//
// Matching on a PREFIX survives MJ re-ordering the parameters, which
// it does. The `--edit` check is what makes this unambiguous: two
// variants of the same scene differ by only a few words, but no other
// job carries THIS job's attachments.
//
// A marker token would be simpler but is not acceptable: the marker
// would be part of the prose, and MJ renders prose — "rev1" can turn
// into a painted word.
async function awaitJob(cdp, userId, proseKey, editUrls_, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = await fetchFeed(cdp, userId);
        if (items) {
            const hit = items.find((i) => {
                if (typeof i.full_command !== 'string') return false;
                const cmd = fold(i.full_command);
                if (!cmd.includes(proseKey)) return false;
                return editUrls_.every((u) => cmd.includes(fold(u)));
            });
            if (hit) return hit;
        }
        await sleep(2000);
    }
    return null;
}

// Download a URL THROUGH the browser — the CDN 403s plain clients.
async function fetchImage(cdp, url, dest) {
    const b64 = await cdp.js(`(async () => {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) return 'ERR:' + r.status;
        const buf = await r.arrayBuffer();
        let s = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    })()`, true);
    if (typeof b64 === 'string' && b64.startsWith('ERR:')) throw new Error(`fetch ${url} → ${b64}`);
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    return dest;
}

// ---------- main --------------------------------------------------------
(async () => {
    if (!SOURCE_JOB) { warn('--source <jobId> is required'); process.exit(2); }
    if (!PROMPT_FILE) { warn('--prompt-file <file.md> is required'); process.exit(2); }
    const packAbs = path.resolve(PROMPT_FILE);
    if (!fs.existsSync(packAbs)) { warn(`no such prompt file: ${packAbs}`); process.exit(2); }

    const prompts = extractPrompts(packAbs);
    if (!prompts.length) { warn('no prompts found in the file'); process.exit(2); }
    const todo = LIMIT > 0 ? prompts.slice(0, LIMIT) : prompts;
    log(`${todo.length} prompt(s) from ${path.basename(packAbs)}`);

    // Our OWN browser instance.
    //
    // The MJ web profile is a single mutable resource: one page, one
    // composer, one file input. A second agent driving the same
    // instance fights over the panel state. This tool runs on its own
    // port with its own copy of the profile.
    let proc = null;
    let info = await checkChromeOnPort(PORT);
    if (!info) {
        // A copied profile keeps Chrome's singleton lock, and Chrome
        // then refuses to start ("Opening in existing browser session").
        // The lock is three symlinks; clear them before launching.
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            try { fs.rmSync(path.join(USER_DATA_DIR, f), { force: true }); } catch { /* not there */ }
        }
        log(`launching a dedicated Chrome on :${PORT} (profile ${USER_DATA_DIR})`);
        proc = await launchChrome(PORT, USER_DATA_DIR, BROWSER_BIN);
        info = await checkChromeOnPort(PORT);
        if (!info) { warn('Chrome launched but CDP is not reachable'); process.exit(1); }
    } else {
        log(`attaching to the Chrome already on :${PORT}`);
    }

    const ws = await cdpConnect(`http://127.0.0.1:${PORT}`);
    const cdp = new CDPClient(ws);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    // Navigate FIRST: the user_id is discovered from the imagine page's
    // own resource timings (and its localStorage fallback), so a fresh
    // instance on about:blank cannot answer it.
    log(`navigating to ${IMAGINE_URL}`);
    await cdp.navigate(IMAGINE_URL);
    await sleep(7000);
    if (/just a moment/i.test(String(await cdp.js('document.title')))) {
        warn('Cloudflare challenge — the profile needs a manual visit');
        process.exit(1);
    }
    if (!(await cdp.js(`!!document.querySelector('${TEXTAREA_SEL}')`))) {
        warn('the prompt textarea never appeared'); process.exit(1);
    }

    const userId = await cdp.js(DISCOVER_USER_ID, true);
    if (!userId) { warn('could not discover the account user_id'); process.exit(1); }
    log('account: ' + userId);

    // ---- the source job -------------------------------------------------
    const items = await fetchFeed(cdp, userId);
    if (!items) { warn('feed fetch failed'); process.exit(1); }
    const src = items.find((i) => (i.id || '').startsWith(SOURCE_JOB));
    if (!src) { warn(`source job ${SOURCE_JOB} not found in the last ${items.length} feed items`); process.exit(1); }
    const { prose: srcProse, flags } = splitCommand(src.full_command);
    const attach = editUrls(flags);
    log(`source ${src.id}  (${src.event_type} / ${src.job_type})`);
    log(`  prose : ${srcProse}`);
    log(`  attach: ${attach.length} image(s) — ${attach.join(' ')}`);
    if (!attach.length) { warn('the source job has no --edit attachments — nothing to keep'); process.exit(2); }

    // The flags we carry, minus --ar (we emit it last ourselves) and
    // minus --edit (we emit it ourselves, after the prose).
    const carried = flagString(flags, { omit: new Set(['--ar', '--edit']) });
    const arSeg = flags.find((f) => f.flag === '--ar');
    const ar = (arSeg && arSeg.values[0]) || '3:4';
    log(`  flags : ${carried} --ar ${ar}`);

    // ---- one generation per prompt -------------------------------------
    const outDir = path.join(OUTPUT_DIR, path.basename(packAbs).replace(/\.md$/, ''));
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];

    for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const text = String(p.text || '').trim();
        const proseKey = fold(text).slice(0, 60);
        // The prose, then the source's flags, then the attachments, then
        // the ratio LAST — MJ resolves a doubled flag by taking the last.
        const composed = `${text} ${carried} --edit ${attach.join(' ')} --ar ${ar}`
            .replace(/\s{2,}/g, ' ').trim();

        log(`\n[${i + 1}/${todo.length}] ${text.slice(0, 72)}…`);

        // Reuse: if this exact prose + these attachments already exist in
        // the feed, take that job instead of paying for another
        // generation.
        let job = null;
        if (REUSE) {
            const found = await awaitJob(cdp, userId, proseKey, attach, 5000);
            if (found) {
                log(`  reusing the existing job ${found.id}`);
                job = found;
            }
        }

        if (!job) {
            await setPromptText(cdp, composed);
            await clickSend(cdp);
            job = await awaitJob(cdp, userId, proseKey, attach, 300000);
            if (!job) {
                warn('no matching job appeared within 5 minutes');
                results.push({ index: i + 1, ok: false, error: 'no job in feed' });
                continue;
            }
        }

        const urls = gridUrls(job.id, job.batch_size || 4);

        // OUTCOME CHECK. The whole point of this tool is that the new
        // job is conditioned on the source's images. MJ records that in
        // the command as `--edit <url> …` and in the job type as
        // `…_edit_diffusion`. A plain `diffusion` job means the
        // attachment did not take, and the image is NOT what was asked
        // for — so say so loudly rather than shipping it as a success.
        const cmd = fold(job.full_command);
        const hasEdit = attach.every((u) => cmd.includes(fold(u)));
        const isEdit = /edit/i.test(job.job_type || '');
        if (!hasEdit || !isEdit) {
            warn(`the job is NOT an edit job (${job.job_type}, ${hasEdit ? 'has the attachments' : 'MISSING the attachments'}) — `
                + 'the image is not conditioned on the source');
        } else {
            log(`  edit job confirmed: ${job.job_type}`);
        }

        const slug = `prompt-${String(i + 1).padStart(2, '0')}`;
        const dir = path.join(outDir, slug);
        fs.mkdirSync(dir, { recursive: true });
        for (let s = 0; s < urls.length; s++) {
            try {
                await fetchImage(cdp, urls[s], path.join(dir, `0_${s}.png`));
            } catch (e) {
                warn(`grid slot ${s}: ${e.message}`);
            }
        }
        const meta = {
            index: i + 1,
            prompt: text,
            composed,
            taskId: job.id,
            jobType: job.job_type,
            eventType: job.event_type,
            parentId: job.parent_id,
            command: job.full_command,
            isEditJob: hasEdit && isEdit,
            attachments: attach,
            // `imageUrls` is the key the repo's other tools read (the
            // dashboard index, the contact sheet). `gridUrls` is kept as
            // an alias so neither tool has to know which script wrote
            // the pack.
            imageUrls: urls,
            gridUrls: urls,
            size: `${job.width}x${job.height}`,
        };
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        log(`  → ${job.id}  ${job.width}x${job.height}  (${job.job_type})`);
        results.push({ index: i + 1, ok: hasEdit && isEdit, taskId: job.id, dir, isEditJob: hasEdit && isEdit });
    }

    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
        sourceJob: src.id,
        sourceCommand: src.full_command,
        carriedFlags: `${carried} --ar ${ar}`,
        attachments: attach,
        results,
    }, null, 2));

    const ok = results.filter((r) => r.ok).length;
    log(`\ndone — ${ok}/${results.length} generated as edit jobs`);
    log(`output: ${outDir}`);
    process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { warn(`ERR ${e.message}`); process.exit(1); });
