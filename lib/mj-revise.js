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
// The composer's submit path lives in mj-web.js, together with the
// evidence that a submission was accepted. Two copies of that logic
// meant two chances to get it wrong — and the copy that WAS here was
// wrong: it took the first unlabelled icon button, which is
// "parameters", not "send". The click opened a panel, nothing was
// submitted, and the log said it had been.
const {
    submitViaComposer,
} = require('./mj-web.js');

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
// Spending levers. Both were missing, and the gap cost a generation:
// `--dry-run` was not a real flag, so it was ignored and the run
// submitted; and asking for "just the source record" meant passing a file
// with no bullets, which fell through to the legacy single-prompt parser
// and submitted the note itself (job ef28b581, 2026-10-30).
//   --inspect   read and print the source job, then stop. No prompt is
//               composed and nothing is submitted.
//   --dry-run   compose every prompt and print the exact command, then
//               stop. Nothing is submitted.
const INSPECT = process.argv.includes('--inspect');
const DRY_RUN = process.argv.includes('--dry-run');

// Flags to drop from the source job, e.g. `--drop-flag sref`.
//
// The use case: re-pose a shot while keeping its reference image. The
// reference IMAGE travels as `--edit` and stays; the reference STYLE
// travels as `--sref` and goes. Both live in the source's command, so
// dropping one means naming it.
//
// This is a pure function on purpose. The first version parsed argv
// with filter+flatMap, where the callback's index is the index in the
// FILTERED array — so `--drop-flag sref` picked up the script's own
// path instead of `sref`, and the drop silently did nothing while the
// log cheerfully said it had dropped something.
function parseDropFlags(argv) {
    const out = [];
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--drop-flag' || !args[i + 1]) continue;
        for (const name of String(args[i + 1]).split(',')) {
            const n = name.trim();
            if (n) out.push(n.startsWith('--') ? n : `--${n}`);
        }
    }
    return new Set(out);
}

// Parse `--replace-flag <name>=<value>` (repeatable).
//
// A replacement retires the source's spelling of that flag and emits
// the caller's value in its place, AFTER the source's other flags —
// MJ resolves a doubled flag by taking the last, so this is what
// makes the caller's value the one that applies.
function parseReplaceFlags(argv) {
    const out = [];
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--replace-flag' || !args[i + 1]) continue;
        const raw = String(args[i + 1]);
        const eq = raw.indexOf('=');
        if (eq < 1) continue;
        const name = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        if (!name || !value) continue;
        out.push({ name: name.startsWith('--') ? name : `--${name}`, value });
    }
    return out;
}

const DROP_FLAGS = parseDropFlags(process.argv);
const REPLACE_FLAGS = parseReplaceFlags(process.argv);
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

// ---------- composing one prompt ---------------------------------------
//
// The flags inherited from the source job and the flags written in the
// NEW prompt can collide. Midjourney resolves a doubled flag by taking
// the LAST one, so a collision does not error — it silently picks the
// wrong value, and the artist never finds out.
//
// The concrete failure this guards: the source job was made with
// `--style raw --s 21`, and the new pack prompt says `--style niji`.
// Appending the source's flags produced
//
//     … --style niji --style raw --s 21 --edit … --ar 16:9
//
// MJ takes the LAST `--style`, so the source's `raw` won and the
// prompt's `niji` was discarded — the exact failure class of the
// duplicated `--ar` and `--sref` (PM-2026-09-24-dup-flags).
//
// The rule, one flag at a time:
//
//   --style / --raw   the NEW prompt owns the style if it names one
//   --s               the NEW prompt owns the stylize if it names one,
//                     or if it names a style (the source's --s is
//                     coupled to the source's --style)
//   --ar              the SOURCE owns the ratio, deliberately: this
//                     tool re-evolves a job, so it keeps the job's
//                     shape. The ratio is emitted LAST so it wins.
//   --edit            the source's attachments, emitted before --ar
//
// Every flag is resolved EXACTLY once. The output never contains two
// of the same flag.
// Which of the source's flags survive, given what the new prompt
// already names. Split out so the pack-level manifest and the
// per-prompt meta can report the same thing the composer used.
// Midjourney spells the same concept more than one way, and the two
// spellings turn up on DIFFERENT SIDES of a revision:
//
//   style    `--style <name>`   (hand-written prompts)
//            `--raw`             (the web UI's spelling of the Raw style)
//   stylize  `--s <n>`          (hand-written prompts)
//            `--stylize <n>`     (the web UI's spelling)
//
// `mj-feed.js` already carries the alias table (`s` → `stylize`). An
// omit set built from ONE spelling therefore failed to match a source
// job written in the other spelling, and the source's style survived
// and was appended AFTER the new prompt's — so MJ took the LAST one
// and the new prompt's style was silently discarded. That is the bug
// this file's own header describes, still happening.
//
// The rule is therefore about CONCEPTS: if the new prompt names a
// style, the source's style goes — in every spelling — and the
// source's stylize goes with it, because a stylize value is coupled
// to the style it was chosen for.
const FLAG_GROUPS = {
    style: ['--style', '--raw'],
    stylize: ['--s', '--stylize'],
    // `--p` is the current spelling of the personalization flag and
    // `--profile` the older one. They are the SAME concept, so a
    // prompt (or a replacement) that owns one owns the other.
    personalize: ['--p', '--profile'],
};

// Does the text name this flag, in ANY of its spellings?
//
// The boundaries matter: `--s` must not match `--stylize` or `--sref`,
// and `--style` must not match `--styles`. The lookbehind stops a
// match inside a longer word (`xx--s`).
function namesFlag(text, names) {
    return names.some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
    });
}

// Every spelling of a flag name, so a replacement for `--p` also
// retires the source's `--profile`.
function aliasNames(name) {
    const n = String(name || '').trim();
    const group = Object.keys(FLAG_GROUPS).find((k) => FLAG_GROUPS[k].includes(n));
    return group ? FLAG_GROUPS[group].slice() : [n];
}

function carriedFor(text, flags, drop = new Set(), replace = []) {
    const promptText = String(text || '').trim();

    // The guards match the FLAG, not a value: a prompt carrying a bare
    // `--style` still means the prompt owns that flag.
    const promptHasStyle = namesFlag(promptText, FLAG_GROUPS.style);
    const promptHasStylize = namesFlag(promptText, FLAG_GROUPS.stylize);

    const omit = new Set(['--ar', '--edit']);
    // An explicitly dropped flag never travels, whatever the prompt says.
    for (const f of drop) omit.add(f);
    if (promptHasStyle) {
        FLAG_GROUPS.style.forEach((f) => omit.add(f));
        // The source's stylize value belongs to the source's style. If
        // the new prompt supplies its own style, the old stylize goes
        // with it — carrying `--stylize 21` next to a new `--style`
        // would apply the old style's tuning to the new style.
        FLAG_GROUPS.stylize.forEach((f) => omit.add(f));
    }
    if (promptHasStylize) {
        FLAG_GROUPS.stylize.forEach((f) => omit.add(f));
    }
    // A REPLACED flag never travels in the source's form: the caller
    // is asking for a different value, and MJ takes the last of a
    // doubled flag — so the source's spelling would silently win.
    for (const r of replace) {
        for (const name of aliasNames(r.name)) omit.add(name);
    }

    return flagString(flags, { omit });
}

// Pure: the aspect ratio this prompt will actually be submitted with.
//
// The PROMPT owns --ar when it carries one — the same rule the web
// backend's buildFullPrompt uses. Two --ar flags is the failure class
// PM-2026-09-24-dup-flags exists for: MJ resolves a doubled flag by
// taking the LAST one, so emitting both hides which value actually won.
// The pack convention puts `--ar 16:9` on every bullet, so without this
// the composed prompt carried the ratio twice.
function resolveRatio(text, ar) {
    const own = (String(text || '').match(/(?<![\w-])--ar(?=\s|$)\s+(\S+)/) || [])[1] || null;
    return own || ar;
}

// Pure: the prompt's prose with its own --ar removed (the ratio is
// re-emitted exactly once, at the end).
function stripOwnAr(text) {
    const raw = String(text || '').trim();
    if (!/(?<![\w-])--ar(?=\s|$)/.test(raw)) return raw;
    return raw.replace(/(?<![\w-])--ar(?=\s|$)\s+\S+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Pure: the ratio ONE prompt of a pack is submitted with.
//
// The pack owns the ratio. The pack convention is one `--ar` per
// bullet, and the parser (lib/mj-submitter.js) strips the flag out of
// the prose and surfaces it as `ar` — so a pack that asks for 16:9
// arrives here with the ratio in a field, not in the text.
//
// That field was ignored, and the source's ratio won instead: a
// 16:9 pack rendered as the SOURCE's 4:3, every prompt, silently.
// The measured proof: a 16:9 pack submitted against a 4:3 source
// produced a 2544x1904 job and the meta recorded
// `--ar 4:3` in `carriedFlags`.
//
// The order is: the prompt's own `--ar` in its text, then the pack's
// `ar`, then the source's ratio as the fallback for a pack that asks
// for nothing.
function promptRatio(prompt, sourceAr) {
    const text = String((prompt && prompt.text) || '');
    const packAr = prompt && prompt.ar ? String(prompt.ar).trim() : '';
    return resolveRatio(text, packAr || sourceAr);
}

function composePrompt(text, flags, ar, attach, drop = new Set(), replace = []) {
    const raw = String(text || '').trim();
    const ratio = resolveRatio(raw, ar);
    const promptText = stripOwnAr(raw);

    const carried = carriedFor(promptText, flags, drop, replace);
    const parts = [promptText];
    if (carried) parts.push(carried);
    // The replacements come AFTER the carried flags: MJ resolves a
    // doubled flag by taking the last, so this is what makes the
    // caller's value the one that applies.
    for (const r of replace) parts.push(`${r.name} ${r.value}`.trim());
    if (attach && attach.length) parts.push(`--edit ${attach.join(' ')}`);
    parts.push(`--ar ${ratio}`);
    return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// ---------- composer helpers --------------------------------------------

// Submit the composed prompt and wait for Midjourney's own answer.
//
// The answer is the proof: it carries the new job id, the job type and
// the FULL command the job was created with — which is exactly what
// the flag-ownership rule needs to be checked against. Polling the
// feed for a matching job instead meant waiting five minutes to learn
// that nothing had been submitted at all.
async function submitComposed(cdp, composed) {
    let job = null;
    try {
        job = await submitViaComposer(cdp, composed);
    } catch (e) {
        // A refusal is a fact about this prompt, not a reason to abandon
        // the pack. The reason travels into the failure record.
        warn(`Midjourney refused the prompt — ${e.message}`);
        return { refused: true, reason: e.message };
    }
    if (!job) {
        warn('the composer accepted the prompt but Midjourney never answered the submission');
        return null;
    }
    log(`submitted: job ${job.jobId} (${job.jobType})`);
    return job;
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
async function awaitJob(cdp, userId, prose, ratio, editUrls_, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const items = await fetchFeed(cdp, userId);
        if (items) {
            const hit = items.find((i) => {
                if (!sameJob(i.full_command, prose, ratio)) return false;
                const cmd = fold(i.full_command);
                return editUrls_.every((u) => cmd.includes(fold(u)));
            });
            if (hit) return hit;
        }
        await sleep(2000);
    }
    return null;
}

// Pure: is an existing job THE SAME job we are about to submit?
//
// The key used to be the first 60 characters of the prompt prose, with
// the flags ignored. That silently reused the wrong job twice over:
// a prompt whose wording changed after its sixtieth character, and a
// prompt that changed only its `--ar` (a 16:9 pack then "reused" the
// 4:3 jobs and produced a fake widescreen set).
//
// The prose must now match IN FULL, and the aspect ratio must match
// too — a different ratio is a different picture.
function sameJob(cmd, prose, ratio) {
    if (typeof cmd !== 'string') return false;
    const c = fold(cmd);
    // The prompt's own --ar is re-emitted at the END of the command,
    // so the prose to look for is the prose WITHOUT it.
    const body = fold(stripOwnAr(prose));
    if (!body || !c.includes(body)) return false;
    if (ratio && !c.includes(`--ar ${fold(ratio)}`)) return false;
    return true;
}

// Downloading a job's images lives in lib/mj-download.js now — the same
// in-page fetch the contact-sheet builder needs, with one implementation
// instead of two. `gridFileName` is kept as this module's name for it
// because the pack layout it writes is part of mj-revise's contract.
const { fetchImage, imageFileName } = require('./mj-download.js');
const gridFileName = imageFileName;

// ---------- main --------------------------------------------------------
//
// Guarded so the module can be REQUIRED for its pure functions without
// launching a browser and driving the live account. `require`ing this
// file used to launch Chrome, connect to Midjourney and submit jobs —
// which made the flag composition untestable, and the flag composition
// is exactly where the bugs live.
if (require.main === module) {
    main().catch((e) => { warn(`ERR ${e.message}`); process.exit(1); });
}

async function main() {
    if (!SOURCE_JOB) { warn('--source <jobId> is required'); process.exit(2); }
    if (!PROMPT_FILE && !INSPECT) { warn('--prompt-file <file.md> is required'); process.exit(2); }
    const packAbs = PROMPT_FILE ? path.resolve(PROMPT_FILE) : null;
    if (packAbs && !fs.existsSync(packAbs)) { warn(`no such prompt file: ${packAbs}`); process.exit(2); }

    const prompts = PROMPT_FILE ? extractPrompts(packAbs) : [];
    if (PROMPT_FILE && !prompts.length) { warn('no prompts found in the file'); process.exit(2); }
    const todo = LIMIT > 0 ? prompts.slice(0, LIMIT) : prompts;
    if (PROMPT_FILE) log(`${todo.length} prompt(s) from ${path.basename(packAbs)}`);

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

    // The flags we carry, minus --ar (we emit it last ourselves), minus
    // --edit (we emit it ourselves, after the prose) and minus anything
    // the caller explicitly dropped.
    const carried = flagString(flags, {
        omit: new Set(['--ar', '--edit', ...DROP_FLAGS,
            ...REPLACE_FLAGS.flatMap((r) => aliasNames(r.name))]),
    });
    const arSeg = flags.find((f) => f.flag === '--ar');
    const ar = (arSeg && arSeg.values[0]) || '3:4';
    // The source's full carryable set. What any ONE prompt actually
    // carries can be smaller — a prompt that names its own --style
    // drops the source's --style and --s — so the per-prompt meta
    // records the real thing.
    log(`  source flags : ${carried} --ar ${ar}`);
    if (DROP_FLAGS.size) log(`  dropped     : ${[...DROP_FLAGS].join(' ')}`);
    if (REPLACE_FLAGS.length) {
        log(`  replaced    : ${REPLACE_FLAGS.map((r) => `${r.name} ${r.value}`).join(' · ')}`);
    }

    if (INSPECT) {
        // The whole point of this exit: read the recipe without spending a
        // generation. Everything above came from the feed, not a submit.
        log('inspect only — nothing submitted');
        process.exit(0);
    }

    // ---- one generation per prompt -------------------------------------
    const outDir = path.join(OUTPUT_DIR, packAbs ? path.basename(packAbs).replace(/\.md$/, '') : 'inspect');
    if (!DRY_RUN) fs.mkdirSync(outDir, { recursive: true });
    const results = [];

    for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const text = String(p.text || '').trim();
        // The ratio THIS prompt asks for — the pack's own `--ar` wins
        // over the source's (the pack is the instruction; the source is
        // the canvas), and a prompt that names its own ratio in its
        // text wins over both.
        const wantRatio = promptRatio(p, ar);
        // The prose, then the source's flags, then the attachments, then
        // the ratio LAST — MJ resolves a doubled flag by taking the last.
        //
        // Which of the source's flags are carried depends on the prompt
        // (a prompt that names its own --style must not have the
        // source's --style appended after it), so this is composed per
        // prompt, not once for the whole pack.
        const composed = composePrompt(text, flags, wantRatio, attach, DROP_FLAGS, REPLACE_FLAGS);

        log(`\n[${i + 1}/${todo.length}] ${text.slice(0, 72)}…`);

        // Reuse: if this exact prose + these attachments already exist in
        // the feed, take that job instead of paying for another
        // generation.
        let job = null;
        if (REUSE) {
            const found = await awaitJob(cdp, userId, text, wantRatio, attach, 5000);
            if (found) {
                log(`  reusing the existing job ${found.id}`);
                job = found;
            }
        }

        if (DRY_RUN) {
            // The composed command is the whole deliverable of a dry run —
            // it is the string Midjourney would receive, flags resolved
            // once each, ratio last.
            log(`  would submit: ${composed}`);
            results.push({ index: i + 1, ok: true, dryRun: true, composed });
            continue;
        }

        if (!job) {
            const submitted = await submitComposed(cdp, composed);
            if (!submitted) {
                warn('nothing was submitted');
                results.push({ index: i + 1, ok: false, error: 'not submitted' });
                continue;
            }
            if (submitted.refused) {
                results.push({ index: i + 1, ok: false, error: 'refused', reason: submitted.reason });
                continue;
            }
            // The submit response IS the job record: it carries the id,
            // the type and the full command. The feed is only needed
            // for the finished images, and it lags behind.
            job = {
                id: submitted.jobId,
                job_type: submitted.jobType,
                event_type: submitted.eventType,
                parent_id: submitted.parentId,
                full_command: submitted.prompt,
                batch_size: submitted.batchSize,
                width: submitted.width,
                height: submitted.height,
            };
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

        // The job exists the moment it is submitted; its images do not.
        // The CDN 404s until the grid has rendered, so the first slot
        // is the gate — the slots land together.
        const gridFiles = [];
        const firstName = gridFileName(urls[0], 0);
        const first = await fetchImage(cdp, urls[0], path.join(dir, firstName), { retries: 40, delayMs: 5000 });
        if (!first) {
            warn('the grid never rendered — no image was written');
            results.push({ index: i + 1, ok: false, error: 'no grid', taskId: job.id });
            continue;
        }
        gridFiles.push(firstName);
        for (let s = 1; s < urls.length; s++) {
            const name = gridFileName(urls[s], s);
            const got = await fetchImage(cdp, urls[s], path.join(dir, name), { retries: 6, delayMs: 4000 });
            if (!got) warn(`grid slot ${s}: not available`);
            else gridFiles.push(name);
        }
        // The JOB's native output size — the preview files written next
        // to this meta are the CDN's smaller variants, so the two
        // numbers are deliberately different.
        const nativeSize = job.width && job.height ? `${job.width}x${job.height}` : null;
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
            // The flags THIS prompt actually carried — not the source's
            // full set. A prompt that names its own --style drops the
            // source's --style and --s, so recording the source's set
            // here would misreport what was submitted.
            carriedFlags: `${carriedFor(text, flags, DROP_FLAGS, REPLACE_FLAGS)} --ar ${wantRatio}`.trim(),
            // The files actually written next to this meta. `size` is
            // the JOB's native output size; these are the CDN's
            // previews, so the two are not the same number.
            gridFiles,
            nativeSize,
            // `imageUrls` is the key the repo's other tools read (the
            // dashboard index, the contact sheet). `gridUrls` is kept as
            // an alias so neither tool has to know which script wrote
            // the pack.
            imageUrls: urls,
            gridUrls: urls,
            size: nativeSize,
        };
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        log(`  → ${job.id}  ${meta.size || 'size unknown'}  (${job.job_type})`);
        results.push({ index: i + 1, ok: hasEdit && isEdit, taskId: job.id, dir, isEditJob: hasEdit && isEdit });
    }

    if (!DRY_RUN) fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
        sourceJob: src.id,
        sourceCommand: src.full_command,
        // The source's FULL carryable set. What an individual prompt
        // carries can be smaller, so each prompt's own meta records the
        // real thing under `carriedFlags`.
        sourceCarriedFlags: `${carried} --ar ${ar}`,
        // The flags the caller dropped on purpose — recorded so a later
        // reader can tell "the source had no --sref" from "we removed
        // the source's --sref".
        droppedFlags: [...DROP_FLAGS],
        replacedFlags: REPLACE_FLAGS.map((r) => `${r.name} ${r.value}`),
        attachments: attach,
        results,
    }, null, 2));

    const ok = results.filter((r) => r.ok).length;
    log(DRY_RUN
        ? `\ndone (dry run) — ${results.length} prompt(s) composed, nothing submitted`
        : `\ndone — ${ok}/${results.length} generated as edit jobs`);
    if (!DRY_RUN) log(`output: ${outDir}`);
    process.exit(ok === results.length ? 0 : 1);
}

module.exports = { splitCommand, flagString, editUrls, carriedFor, composePrompt, resolveRatio, promptRatio, stripOwnAr, gridFileName, parseDropFlags, parseReplaceFlags, aliasNames, sameJob };
