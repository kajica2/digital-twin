#!/usr/bin/env node
// lib/mj-prompt-generator.js
//
// Sprint 0.18 — deterministic lyrics/idea → N MJ prompts.
// Fallback path for when the AI in chat isn't available. The
// AI-written prompts (chat) are richer; this one is mechanical
// but always produces a valid .md file in the format documented
// at assets/mural-prompts/PROMPT-EXPANSION-FORMAT.md.
//
// Output file matches what the watcher parses:
//   # <title> — <N> prompts (16:9)
//   > Source: <one-line summary>
//   - <prompt 1> --ar 16:9
//   - <prompt 2> --ar 16:9
//   ...
//
// Prompt count rules (heuristic, per the user's call):
//   * Default: 8 prompts.
//   * Range: 5–10 (clamped).
//   * Heuristic from lyrics/idea length:
//       - ≤4 lines    → 5 prompts
//       - 5–9 lines   → 6 prompts
//       - 10–14 lines → 7 prompts
//       - 15–19 lines → 8 prompts (default)
//       - 20–24 lines → 9 prompts
//       - 25+ lines   → 10 prompts (capped)
//
// Style: each prompt gets a different MJ style suffix, rotated
// across the four canonical mural families from
// assets/mural-prompts/south-america-street-graffiti.md:
//   A — asymmetric graphic B&W
//   B — sheet-music atop architectural drawing
//   C — cinematic dawn medium shot
//   D — golden-hour portrait (new, added for variety)
//
// Usage:
//   node lib/mj-prompt-generator.js --idea "soft lamp at the window" --out prompts-inbox/x.md
//   node lib/mj-prompt-generator.js --lyrics-file path/to/lyrics.txt --title "My Song" --out prompts-inbox/x.md
//   node lib/mj-prompt-generator.js --idea "..." --n 7 --ar 9:16
//
// Pure Node, no deps.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------- CLI parsing ----------
function parseCli(argv) {
    function arg(name) {
        const i = argv.indexOf(name);
        return (i >= 0 && argv[i + 1]) ? argv[i + 1] : null;
    }
    return {
        IDEA:        arg('--idea'),
        LYRICS_FILE: arg('--lyrics-file'),
        TITLE:       arg('--title'),
        OUT:         arg('--out'),
        AR:          arg('--ar') || '16:9',
        N_RAW:       arg('--n') ? parseInt(arg('--n'), 10) : null,
        HELP:        argv.includes('--help') || argv.includes('-h'),
    };
}

const HELP_TEXT = `Usage: node lib/mj-prompt-generator.js [options]

Options:
  --idea <text>           Idea / vibe to expand into prompts
  --lyrics-file <path>    Read lyrics from a file (line-by-line)
  --title <text>          Song / project title (defaults to "Untitled")
  --out <path>            Output .md path (default: prompts-inbox/<slug>.md)
  --ar <aspect>           Aspect ratio for every prompt (default: 16:9)
  --n <count>             Override the 5-10 heuristic with a fixed count
  --help                  Show this help`;

// ---------- Count heuristic ----------
function countFor(lineCount, nRaw = null) {
    if (nRaw != null && !Number.isNaN(nRaw)) {
        return Math.max(5, Math.min(10, nRaw));
    }
    if (lineCount <= 4)  return 5;
    if (lineCount <= 9)  return 6;
    if (lineCount <= 14) return 7;
    if (lineCount <= 19) return 8;
    if (lineCount <= 24) return 9;
    return 10;
}

// ---------- Prompt styles ----------
//
// Four style suffixes rotated across the prompts. Each is a
// distinct visual direction; the AI-written expansion has more
// variety per song, but this gives the deterministic version
// non-repetitive ground.
const STYLES = [
    // A — B&W graphic
    (title, snippet) => `asymmetrical graphic black-and-white logo composition of ${snippet}, hard contrast, no midtones, designed as a poster, urban decayed texture — in the style of ${title}`,
    // B — sheet-music atop blueprint
    (title, snippet) => `presented in the style of sheet music atop architectural drawing: ${snippet}, overlaid with translucent sheet-music staves carrying the contour of a melodic line, faded blueprint grid in the background, peeling plaster substrate, dense layered texture — in the style of ${title}`,
    // C — cinematic dawn medium shot
    (title, snippet) => `street-level medium shot of ${snippet} at first light, low warm dawn light raking across the surfaces, shot on 35mm, cinematic, gritty but tender — sunrise signaling the end of the night in ${title}`,
    // D — golden-hour portrait
    (title, snippet) => `golden-hour portrait of ${snippet}, warm rim light, soft focus background, intimate, photographed in 35mm, Wong Kar-wai palette — in the style of ${title}`,
];

// ---------- Snippet rotation ----------
//
// Distributes the lyric lines across the N prompts so each prompt
// pulls from a different slice. If there are fewer lyric lines
// than prompts, snippets rotate (line i % lines.length) so each
// prompt gets at least one lyric fragment, and the index is
// included so every prompt is visually distinct.
function snippetFor(i, n, lyricLines, title, ideaText) {
    const lines = lyricLines.length > 0 ? lyricLines : (ideaText ? [ideaText] : [title]);
    const start = Math.floor((i * lines.length) / n);
    const end   = Math.floor(((i + 1) * lines.length) / n);
    const slice = lines.slice(start, end).join(', ');
    if (slice.length > 0) return slice;
    // Fallback: rotate a single line, prefixed with prompt index
    // so visually distinct prompts come out even when lyrics are
    // sparse. The AI-written expansion is preferred when lines
    // are sparse; this keeps the deterministic version functional.
    const base = lines[i % lines.length];
    return `${base} (vignette ${i + 1} of ${n})`;
}

// ---------- Build prompts ----------
function build({ title, ideaText, lyricLines, n, ar }) {
    const prompts = [];
    for (let i = 0; i < n; i++) {
        const style = STYLES[i % STYLES.length];
        const snippet = snippetFor(i, n, lyricLines, title, ideaText);
        const prompt = style(title, snippet);
        prompts.push(`- ${prompt} --ar ${ar}`);
    }
    return prompts;
}

// ---------- Format ----------
function formatMd({ title, ideaText, lyricLines, prompts, ar, n }) {
    const ideaLower = (ideaText || '').toLowerCase();
    const summarySource = (ideaText || `${ideaLower || 'lyric pack'} based on ${lyricLines.length} lyric lines`).slice(0, 200);
    return [
        `# ${title} — ${n} prompts (${ar})`,
        ``,
        `> Source: ${summarySource}`,
        ``,
        ...prompts,
        ``,
    ].join('\n');
}

// ---------- Main ----------
function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function gatherInput({ IDEA, LYRICS_FILE }) {
    let ideaText = IDEA || '';
    let lyricLines = [];
    if (LYRICS_FILE) {
        const txt = fs.readFileSync(LYRICS_FILE, 'utf8');
        lyricLines = txt.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !/^[#>\-\[\]]/.test(l)); // strip markdown + tags
    }
    return { ideaText, lyricLines };
}

function main(argv = process.argv.slice(2)) {
    const cli = parseCli(argv);
    if (cli.HELP) {
        console.log(HELP_TEXT);
        process.exit(0);
    }
    if (!cli.IDEA && !cli.LYRICS_FILE) {
        console.error('ERROR: --idea or --lyrics-file is required');
        console.error(HELP_TEXT);
        process.exit(1);
    }
    const { ideaText, lyricLines } = gatherInput(cli);
    const title = cli.TITLE || (cli.LYRICS_FILE
        ? path.basename(cli.LYRICS_FILE, path.extname(cli.LYRICS_FILE))
        : 'Untitled');
    const lineCount = lyricLines.length > 0 ? lyricLines.length : (ideaText ? 1 : 0);
    const n = countFor(lineCount, cli.N_RAW);
    const prompts = build({ title, ideaText, lyricLines, n, ar: cli.AR });
    const md = formatMd({ title, ideaText, lyricLines, prompts, ar: cli.AR, n });

    const outPath = cli.OUT
        ? path.resolve(cli.OUT)
        : path.resolve(__dirname, '..', 'prompts-inbox', `${slugify(title)}.md`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md, 'utf8');

    console.log(`[mj-prompt-generator] wrote ${prompts.length} prompts to ${outPath}`);
    console.log(`[mj-prompt-generator] ar=${cli.AR} title=${JSON.stringify(title)} n=${n}`);
}

if (require.main === module) main();

// ---------- Module exports for the test harness ----------
module.exports = {
    countFor,
    snippetFor,
    STYLES,
    build,
    formatMd,
    slugify,
    parseCli,
    gatherInput,
    main,
};