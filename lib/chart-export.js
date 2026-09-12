#!/usr/bin/env node
// lib/chart-export.js
//
// Sprint 0.4 — the chart-export pipeline.
//
// Takes a MusicXML score, splits it into per-instrument MusicXML
// parts, and produces muted variants for backing-track generation
// (no-trumpet, no-sax). Writes a manifest + per-output README so
// the rest of the workflow (PDF / WAV / MIDI rendering) is a
// one-click operation in MuseScore or via the music21 bridge.
//
// Why this exists:
//   * Manual part-export in notation software is tedious and
//     error-prone — naming, ordering, transposition labels all
//     drift between charts.
//   * "No trumpet" / "no sax" backing tracks require muting whole
//     parts cleanly; doing it by hand invites velocity-zero leaks
//     that still occupy the timeline.
//   * A machine-readable manifest makes the whole pipeline
//     scriptable downstream (Soundslice sync, web share, etc.).
//
// Output structure (relative to the input file's directory):
//
//   <song>_PDF/
//     manifest.json                 ← machine-readable index
//     README.md                     ← MuseScore one-click render
//     parts/
//       01_Trumpet_Bb.musicxml      ← per-instrument parts
//       02_Alto_Sax_Eb.musicxml
//       03_Tenor_Sax_Bb.musicxml
//       ...
//
//   <song>_No_Trumpet/
//     score.musicxml                ← whole score, trumpet part removed
//     README.md                     ← bounce in DAW / MuseScore
//
//   <song>_No_Sax/
//     score.musicxml                ← whole score, all sax parts removed
//     README.md
//
//   <song>_Whole/
//     <song>.musicxml               ← untouched copy, for reference
//
// Mirrors the existing repo voice (pure-Node, no deps, --apply --yes).
//
// Usage:
//   node lib/chart-export.js                          # dry-run on default fixture
//   node lib/chart-export.js <path/to/song.musicxml>  # dry-run that file
//   node lib/chart-export.js <path> --apply           # write outputs
//   node lib/chart-export.js <path> --apply --yes     # skip prompt
//
// Exit: 0 on success, 1 on bad input.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------- CLI parsing (matches songs-indexer.js) ----------
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const YES   = ARGV.includes('--yes');
const RENDER = ARGV.includes('--render');    // post-export: invoke mscore to produce PDF/MP3
const MP3_ONLY = ARGV.includes('--mp3-only'); // skip splitting + muting, just re-render audio

// --chords <json-file> — sidecar chord chart keyed by measure number.
// Format: { "1": "Dm7", "2": "G7sus", ... }
// Injects <harmony> elements at the specified measures (1-based, matching
// MusicXML's measure number attribute). Quality parsing: sharp/flat
// root + common chord-quality suffix (m, m7, 7, maj7, m7b5, dim, etc.)
// mapped to MusicXML's <kind> strings. Unrecognized qualities pass
// through as <kind text="...">.
const CHORDS_IDX = ARGV.indexOf('--chords');
const CHORDS_FILE = CHORDS_IDX >= 0 ? ARGV[CHORDS_IDX + 1] : null;

let INPUT = ARGV.find(a => !a.startsWith('--'));
if (!INPUT) {
    // default to a built-in test fixture
    INPUT = '/tmp/mini-score.musicxml';
    if (!fs.existsSync(INPUT)) {
        process.stderr.write('[export] usage: node lib/chart-export.js <path.musicxml> [--apply]\n');
        process.exit(2);
    }
}

const SONG_BASE = path.basename(INPUT, path.extname(INPUT));
const INPUT_DIR = path.dirname(INPUT);
const OUT_PDF   = path.join(INPUT_DIR, `${SONG_BASE}_PDF`);
const OUT_NOTR  = path.join(INPUT_DIR, `${SONG_BASE}_No_Trumpet`);
const OUT_NOSX  = path.join(INPUT_DIR, `${SONG_BASE}_No_Sax`);
const OUT_WHOLE = path.join(INPUT_DIR, `${SONG_BASE}_Whole`);

// --mp3-only short-circuits the split + mute pipeline.
// Re-renders the audio set from the *Whole* directory's untouched
// MusicXML copy plus the two muted variants. Requires that the main
// pipeline has already been run at least once on this input.
if (MP3_ONLY) {
    if (!APPLY) {
        process.stderr.write('[export] --mp3-only implies --apply (no dry-run mode)\n');
        process.exit(2);
    }
    if (!fs.existsSync(path.join(OUT_WHOLE, `${SONG_BASE}.musicxml`))) {
        process.stderr.write(`[export] --mp3-only requires an existing split: run \`node lib/chart-export.js ${INPUT} --apply --yes\` first.\n`);
        process.exit(2);
    }
    renderMp3Only(OUT_WHOLE, OUT_NOTR, OUT_NOSX, SONG_BASE);
    process.exit(0);
}

// ---------- Transposition / order reference ----------
//
// Mirrors the full-band staff order from docs/COLTRANE-SHAW-ENGRAVING.md §2.
// Index 0 = top staff. Lower = further down. Used to number the per-part
// outputs and to drive the manifest's "displayOrder" field.

const BAND_ORDER = [
    { match: /^flute$/i,                   label: 'Flute',         transpose: 'C' },
    { match: /^oboe$/i,                    label: 'Oboe',          transpose: 'C' },
    { match: /^clarinet$/i,                label: 'Clarinet',      transpose: 'Bb' },
    { match: /^bassoon$/i,                 label: 'Bassoon',       transpose: 'C' },
    { match: /^soprano\s*sax(ophone)?$/i,  label: 'Soprano Sax',   transpose: 'Bb' },
    { match: /^alto\s*sax(ophone)?$/i,     label: 'Alto Sax',      transpose: 'Eb' },
    { match: /^tenor\s*sax(ophone)?$/i,    label: 'Tenor Sax',     transpose: 'Bb' },
    { match: /^baritone\s*sax(ophone)?$/i, label: 'Baritone Sax',  transpose: 'Eb' },
    { match: /^horn\s*in\s*f$/i,           label: 'Horn',          transpose: 'F' },
    { match: /^trumpet(\s*\d+)?$/i,        label: 'Trumpet',       transpose: 'Bb' },
    { match: /^trombone(\s*\d+)?$/i,       label: 'Trombone',      transpose: 'C' },
    { match: /^bass\s*trombone$/i,         label: 'Bass Trombone', transpose: 'C' },
    { match: /^euphonium$/i,               label: 'Euphonium',     transpose: 'C' },
    { match: /^tuba$/i,                    label: 'Tuba',          transpose: 'C' },
    { match: /^guitar$/i,                  label: 'Guitar',        transpose: 'C' },
    { match: /^piano$/i,                   label: 'Piano',         transpose: 'C' },
    { match: /^(acoustic\s*)?bass$/i,      label: 'Bass',          transpose: 'C' },
    { match: /^drums?$/i,                  label: 'Drums',         transpose: 'C' },
    { match: /^vibes?$/i,                  label: 'Vibes',         transpose: 'C' },
];

function inferInstrument(rawName) {
    const name = (rawName || '').trim();
    // exact family match first; then numbered variants
    for (const slot of BAND_ORDER) {
        if (slot.match.test(name)) {
            // carry through any number suffix (Trumpet 1/2/3 etc.)
            const numMatch = name.match(/(\d+)$/);
            const num = numMatch ? ` ${numMatch[1]}` : '';
            return {
                displayName: `${slot.label}${num}`.trim(),
                transpose: slot.transpose,
            };
        }
    }
    // unknown — preserve as-is, label C
    return { displayName: name || 'Unknown', transpose: 'C' };
}

function isTrumpet(displayName) {
    return /^Trumpet(\s+\d+)?$/.test(displayName);
}

function isSax(displayName) {
    return /Sax$/.test(displayName);
}

// ---------- XML helpers (MusicXML is well-formed, hand-rolled is fine) ----------
//
// We need three operations:
//   1. Extract the <part-list> (mapping part IDs to display names).
//   2. Extract each <part id="...">...</part> as a self-contained
//      MusicXML document (so it imports cleanly into MuseScore / Dorico).
//   3. Remove specified parts from the full score (for muted variants).
//
// Hand-rolled tag-aware splitter that handles attributes and nested
// elements with the same name. The score-partwise structure is
// guaranteed by the MusicXML DTD; we lean on that guarantee.

function splitTopLevel(xml, tag) {
    // Returns the substring of the first <tag ...> ... </tag>, or null.
    const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
    const m = openRe.exec(xml);
    if (!m) return null;
    const start = m.index;
    const openEnd = openRe.lastIndex;
    let depth = 1;
    const re = new RegExp(`<\\/?${tag}(\\s[^>]*)?>`, 'g');
    re.lastIndex = openEnd;
    while (depth > 0) {
        const next = re.exec(xml);
        if (!next) return null;
        const isClose = next[0].startsWith(`</`);
        depth += isClose ? -1 : 1;
    }
    const end = re.lastIndex;
    return { start, end, openAttrs: m[1] || '', body: xml.slice(openEnd, end - (`</${tag}>`).length) };
}

function extractPartList(xml) {
    const block = splitTopLevel(xml, 'part-list');
    if (!block) return [];
    // inside part-list: zero or more <score-part id="P1"><part-name>X</part-name>...
    const parts = [];
    const re = /<score-part(\s[^>]*)?>([\s\S]*?)<\/score-part>/g;
    let m;
    while ((m = re.exec(block.body))) {
        const attrs = m[1] || '';
        const inner = m[2];
        const idMatch = attrs.match(/id="([^"]+)"/);
        const nameMatch = inner.match(/<part-name>([\s\S]*?)<\/part-name>/);
        parts.push({
            id: idMatch ? idMatch[1] : null,
            name: nameMatch ? nameMatch[1].trim() : '',
        });
    }
    return parts;
}

function extractPart(xml, partId) {
    // Returns the full <part id="...">...</part> substring, or null.
    const re = new RegExp(`<part(\\s[^>]*)?>`, 'g');
    let open;
    while ((open = re.exec(xml))) {
        const attrs = open[1] || '';
        const idMatch = attrs.match(/id="([^"]+)"/);
        if (idMatch && idMatch[1] === partId) {
            const openEnd = re.lastIndex;
            // find matching </part> with depth tracking
            let depth = 1;
            const close = new RegExp(`<\\/?part(\\s[^>]*)?>`, 'g');
            close.lastIndex = openEnd;
            while (depth > 0) {
                const next = close.exec(xml);
                if (!next) return null;
                depth += next[0].startsWith('</') ? -1 : 1;
            }
            return {
                start: open.index,
                end: close.lastIndex,
                block: xml.slice(open.index, close.lastIndex),
            };
        }
    }
    return null;
}

function stripParts(xml, partIds) {
    // Return a copy of xml with the listed <part id="..."> elements
    // AND their corresponding <score-part> declarations removed, so
    // the resulting score has a clean part-list matching the parts
    // that survive.
    let out = xml;
    // 1. Strip <score-part id="X">...</score-part> from the part-list.
    for (const id of partIds) {
        const re = new RegExp(
            `<score-part(\\s[^>]*)?>[\\s\\S]*?<\\/score-part>`,
            'g'
        );
        let m;
        while ((m = re.exec(out))) {
            const attrs = m[1] || '';
            const idMatch = attrs.match(/id="([^"]+)"/);
            if (idMatch && idMatch[1] === id) {
                out = out.slice(0, m.index) + out.slice(re.lastIndex);
                break;
            }
        }
    }
    // 2. Strip the <part id="X">...</part> elements.
    for (const id of partIds) {
        const ext = extractPart(out, id);
        if (ext) out = out.slice(0, ext.start) + out.slice(ext.end);
    }
    return out;
}

// Build a minimal self-contained MusicXML document for a single part
// (MuseScore + Dorico both accept this for "Open Part").
function wrapSinglePart(scoreXml, partId) {
    const list = extractPartList(scoreXml);
    const target = list.find(p => p.id === partId);
    if (!target) return null;
    const ext = extractPart(scoreXml, partId);
    if (!ext) return null;

    // header: take everything before the first <part>
    const firstPartIdx = scoreXml.indexOf('<part ');
    const header = scoreXml.slice(0, firstPartIdx);
    // part-list: keep only the target score-part
    const listBlock = splitTopLevel(header, 'part-list');
    let headerWithoutList = header.slice(0, listBlock.start) + header.slice(listBlock.end);
    const singleList =
        `<part-list>` +
        `<score-part id="${target.id}"><part-name>${escapeXml(target.name)}</part-name></score-part>` +
        `</part-list>`;
    // assemble
    return headerWithoutList + singleList + '\n' + ext.block + '\n</score-partwise>\n';
}

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------- Output writers ----------

function writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
}

function readme(songBase, parts, variant) {
    const lines = [];
    lines.push(`# ${songBase} — ${variant}`);
    lines.push('');
    lines.push(`This folder was produced by \`lib/chart-export.js\` from the`);
    lines.push(`original MusicXML for **${songBase}**.`);
    lines.push('');
    if (variant === 'PDF') {
        lines.push('## To produce PDFs');
        lines.push('');
        lines.push('Open MuseScore, then **File → Open** the per-instrument MusicXML files');
        lines.push('in `parts/` one at a time. For each, **File → Export → PDF**.');
        lines.push('');
        lines.push('Or batch-export from the full score:');
        lines.push('');
        lines.push('1. Open the full score in MuseScore.');
        lines.push('2. **File → Export → Parts…**');
        lines.push('3. Tick every instrument, pick an output folder, click **Export**.');
        lines.push('');
        lines.push('Naming follows the convention from');
        lines.push('`docs/COLTRANE-SHAW-ENGRAVING.md` §2 (full-band staff order).');
    } else if (variant === 'No_Trumpet' || variant === 'No_Sax') {
        lines.push('## To bounce a backing track');
        lines.push('');
        lines.push('Open `score.musicxml` in MuseScore and **File → Export → MP3** (or WAV).');
        lines.push('The respective part has been removed from the score, so the bounce');
        lines.push(`will have **no ${variant === 'No_Trumpet' ? 'trumpet' : 'saxophone'}** in it.`);
        lines.push('');
        lines.push('Or open in your DAW (Logic / Reaper / Ableton) via the MusicXML import.');
    } else if (variant === 'Whole') {
        lines.push('## Untouched reference copy');
        lines.push('');
        lines.push('Same as the input MusicXML. Kept here so downstream tools have a');
        lines.push('canonical filename to reference.');
    }
    lines.push('');
    lines.push('## Manifest');
    lines.push('');
    lines.push('See `../<song>_PDF/manifest.json` for the machine-readable index.');
    lines.push('');
    return lines.join('\n');
}

function manifestJson(songBase, parts) {
    return JSON.stringify({
        generatedAt: new Date().toISOString(),
        inputFile: path.basename(INPUT),
        song: songBase,
        parts: parts.map((p, i) => ({
            index: String(i + 1).padStart(2, '0'),
            partId: p.id,
            displayName: p.displayName,
            transposition: p.transpose,
            fileName: `${String(i + 1).padStart(2, '0')}_${p.displayName.replace(/\s+/g, '_')}_${p.transpose}.musicxml`,
        })),
        mutedVariants: [
            { variant: 'No_Trumpet', removedInstrument: 'Trumpet' },
            { variant: 'No_Sax',     removedInstrument: 'Saxophone (all)' },
        ],
    }, null, 2) + '\n';
}

// ---------- Chord-symbol injection (--chords) ----------
//
// Parse a sidecar JSON like { "1": "Dm7", "2": "G7sus", ... } and
// inject <harmony> elements at the start of those measures. The
// injection runs against the extracted <part> block (per-part),
// and against the muted variants (No_Trumpet / No_Sax) since those
// share the same measure structure.
//
// Quality mapping: we accept common Nashville/lead-sheet chord
// notation and translate to MusicXML's <kind> strings. The
// translation table is intentionally narrow — extending it is
// easy. Unrecognized qualities fall back to <kind text="..."> so
// MuseScore renders them as text instead of dropping the chord.
const CHORD_QUALITY_MAP = {
    '':           { kind: 'major',           text: '' },
    'M':          { kind: 'major',           text: 'M' },
    'maj':        { kind: 'major',           text: 'maj' },
    'maj7':       { kind: 'major-seventh',   text: 'maj7' },
    'M7':         { kind: 'major-seventh',   text: 'M7' },
    'm':          { kind: 'minor',           text: 'm' },
    'min':        { kind: 'minor',           text: 'min' },
    'm7':         { kind: 'minor-seventh',   text: 'm7' },
    'min7':       { kind: 'minor-seventh',   text: 'min7' },
    '7':          { kind: 'dominant',        text: '7' },
    'dom':        { kind: 'dominant',        text: 'dom' },
    'dim':        { kind: 'diminished',      text: 'dim' },
    'dim7':       { kind: 'diminished-seventh', text: 'dim7' },
    'aug':        { kind: 'augmented',       text: 'aug' },
    'm7b5':       { kind: 'half-diminished', text: 'm7b5' },
    'sus':        { kind: 'suspended-fourth',text: 'sus' },
    'sus4':       { kind: 'suspended-fourth',text: 'sus4' },
    'sus2':       { kind: 'suspended-second',text: 'sus2' },
    '7sus':       { kind: 'dominant',        text: '7sus' },
    '7sus4':      { kind: 'dominant',        text: '7sus4' },
    '5':          { kind: 'major',           text: '5' },
};

function parseChordSymbol(sym) {
    const m = String(sym).match(/^([A-G])([#b])?(.*?)(\/([A-G])([#b])?)?$/);
    if (!m) return null;
    const [, root, acc = '', qual = '', , bassRoot, bassAcc = ''] = m;
    const quality = CHORD_QUALITY_MAP[qual];
    if (!quality) {
        return {
            xml: `<harmony><root><root-step>${root}</root-step></root>` +
                 `<kind text="${escapeXml(sym)}">${escapeXml(qual || 'major')}</kind></harmony>`,
        };
    }
    const accXml = acc === '#'
        ? '<root-alter><alter>1</alter></root-alter>'
        : acc === 'b'
        ? '<root-alter><alter>-1</alter></root-alter>'
        : '';
    let kindXml = `<kind text="${escapeXml(quality.text)}">${quality.kind}</kind>`;
    if (bassRoot) {
        const bassAccXml = bassAcc === 'b' ? '<bass-alter><alter>-1</alter></bass-alter>' : '';
        kindXml += `<bass><bass-step>${bassRoot}</bass-step>${bassAccXml}</bass>`;
    }
    return { xml: `<harmony><root><root-step>${root}</root-step>${accXml}</root>${kindXml}</harmony>` };
}

function loadChordMap() {
    if (!CHORDS_FILE) return null;
    if (!fs.existsSync(CHORDS_FILE)) {
        process.stderr.write(`[export] WARN: --chords file not found: ${CHORDS_FILE}\n`);
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(CHORDS_FILE, 'utf8'));
        const map = {};
        for (const [k, v] of Object.entries(raw)) {
            const num = parseInt(k, 10);
            const parsed = parseChordSymbol(v);
            if (parsed) map[num] = parsed.xml;
        }
        process.stderr.write(`[export] loaded ${Object.keys(map).length} chord symbols from ${CHORDS_FILE}\n`);
        return map;
    } catch (e) {
        process.stderr.write(`[export] WARN: --chords parse failed: ${e.message}\n`);
        return null;
    }
}

function injectChords(partBlock, chordMap) {
    if (!chordMap) return partBlock;
    return partBlock.replace(
        /<measure\s+number="(\d+)"[^>]*>([\s\S]*?)<\/measure>/g,
        (m, num, inner) => {
            const sym = chordMap[parseInt(num, 10)];
            if (!sym) return m;
            return `<measure number="${num}">${sym}${inner}</measure>`;
        }
    );
}

// ---------- Main ----------

function main() {
    process.stderr.write(`[export] reading ${INPUT}\n`);
    const xml = fs.readFileSync(INPUT, 'utf8');

    if (!xml.includes('<score-partwise')) {
        process.stderr.write('[export] ERROR: input is not a partwise MusicXML file\n');
        process.exit(1);
    }

    const rawList = extractPartList(xml);
    if (rawList.length === 0) {
        process.stderr.write('[export] ERROR: no <score-part> entries found\n');
        process.exit(1);
    }

    // Order by BAND_ORDER; unknowns go to the end in input order.
    const ordered = [];
    const usedIdx = new Set();
    for (const slot of BAND_ORDER) {
        for (let i = 0; i < rawList.length; i++) {
            if (usedIdx.has(i)) continue;
            if (slot.match.test(rawList[i].name)) {
                const inf = inferInstrument(rawList[i].name);
                ordered.push({
                    id: rawList[i].id,
                    name: rawList[i].name,
                    displayName: inf.displayName,
                    transpose: inf.transpose,
                    inputIndex: i,
                });
                usedIdx.add(i);
                break;
            }
        }
    }
    for (let i = 0; i < rawList.length; i++) {
        if (usedIdx.has(i)) continue;
        const inf = inferInstrument(rawList[i].name);
        ordered.push({
            id: rawList[i].id,
            name: rawList[i].name,
            displayName: inf.displayName,
            transpose: inf.transpose,
            inputIndex: i,
        });
    }

    // DRY-RUN summary
    process.stderr.write(`[export] ${ordered.length} parts:\n`);
    for (const p of ordered) {
        process.stderr.write(`  ${p.displayName} (${p.transpose}) — id=${p.id}\n`);
    }
    const trumpetIds = ordered.filter(p => isTrumpet(p.displayName)).map(p => p.id);
    const saxIds     = ordered.filter(p => isSax(p.displayName)).map(p => p.id);
    process.stderr.write(`[export] trumpets to mute: ${trumpetIds.length} (${trumpetIds.join(', ')})\n`);
    process.stderr.write(`[export] saxes to mute:    ${saxIds.length} (${saxIds.join(', ')})\n`);

    if (!APPLY) {
        process.stderr.write(`[export] DRY RUN — pass --apply to write outputs under ${INPUT_DIR}\n`);
        return;
    }

    // --- write per-instrument parts ---
    const partsDir = path.join(OUT_PDF, 'parts');
    fs.mkdirSync(partsDir, { recursive: true });
    const chordMap = loadChordMap();
    const writtenParts = [];
    ordered.forEach((p, i) => {
        const fileName = `${String(i + 1).padStart(2, '0')}_${p.displayName.replace(/\s+/g, '_')}_${p.transpose}.musicxml`;
        const singleXml = injectChords(wrapSinglePart(xml, p.id), chordMap);
        if (!singleXml) {
            process.stderr.write(`[export] WARN: could not extract part ${p.id}\n`);
            return;
        }
        writeFile(path.join(partsDir, fileName), singleXml);
        writtenParts.push(p);
    });

    // --- write manifest + PDF README ---
    writeFile(path.join(OUT_PDF, 'manifest.json'), manifestJson(SONG_BASE, writtenParts));
    writeFile(path.join(OUT_PDF, 'README.md'), readme(SONG_BASE, writtenParts, 'PDF'));

    // --- write muted variants ---
    const noTrumpetXml = stripParts(xml, trumpetIds);
    fs.mkdirSync(OUT_NOTR, { recursive: true });
    writeFile(path.join(OUT_NOTR, 'score.musicxml'), noTrumpetXml);
    writeFile(path.join(OUT_NOTR, 'README.md'), readme(SONG_BASE, writtenParts, 'No_Trumpet'));

    const noSaxXml = stripParts(xml, saxIds);
    fs.mkdirSync(OUT_NOSX, { recursive: true });
    writeFile(path.join(OUT_NOSX, 'score.musicxml'), noSaxXml);
    writeFile(path.join(OUT_NOSX, 'README.md'), readme(SONG_BASE, writtenParts, 'No_Sax'));

    // --- write untouched whole-arrangement reference ---
    fs.mkdirSync(OUT_WHOLE, { recursive: true });
    writeFile(path.join(OUT_WHOLE, `${SONG_BASE}.musicxml`), xml);
    writeFile(path.join(OUT_WHOLE, 'README.md'), readme(SONG_BASE, writtenParts, 'Whole'));

    process.stderr.write(`[export] wrote:\n`);
    process.stderr.write(`  ${OUT_PDF}/manifest.json\n`);
    process.stderr.write(`  ${OUT_PDF}/parts/  (${writtenParts.length} files)\n`);
    process.stderr.write(`  ${OUT_NOTR}/score.musicxml\n`);
    process.stderr.write(`  ${OUT_NOSX}/score.musicxml\n`);
    process.stderr.write(`  ${OUT_WHOLE}/${SONG_BASE}.musicxml\n`);
    process.stderr.write(`[export] next: run \`node lib/midi-export.js ${INPUT} --apply\` to produce the MIDI of the whole arrangement.\n`);

    if (RENDER) {
        renderAll(OUT_PDF, OUT_NOTR, OUT_NOSX, OUT_WHOLE, SONG_BASE);
    }
}

// ---------- Optional render pass ----------
//
// When --render is passed, invoke MuseScore 4 (mscore) to produce
// PDFs and MP3s from the MusicXML inputs. This is the "set up
// everything" mode — produces the full chart package with no manual
// steps.
//
// Requires:
//   * mscore on PATH (brew install --cask musescore)
//   * a writable ~/.config/MuseScore/MuseScore4.ini (created on first run)

function renderAll(outPdfDir, outNoTrumpetDir, outNoSaxDir, outWholeDir, songBase) {
    if (!which('mscore')) {
        process.stderr.write(`[render] SKIP: mscore not on PATH. Install with:\n`);
        process.stderr.write(`         brew install --cask musescore\n`);
        return;
    }
    const mscoreStart = Date.now();

    // 1. Full score PDF
    runMscore(
        path.join(outNoTrumpetDir, '..', `${songBase}.musicxml`),
        path.join(INPUT_DIR, `${songBase}_Full_Score.pdf`),
        `full score → ${songBase}_Full_Score.pdf`
    );

    // 2. Per-part PDFs (already named in the convention)
    const partsDir = path.join(outPdfDir, 'parts');
    if (fs.existsSync(partsDir)) {
        for (const f of fs.readdirSync(partsDir)) {
            if (!f.endsWith('.musicxml')) continue;
            const xml = path.join(partsDir, f);
            const pdf = xml.replace(/\.musicxml$/, '.pdf');
            runMscore(xml, pdf, `part PDF → ${path.basename(pdf)}`);
        }
    }

    // 3. Muted backing tracks (MP3)
    runMscore(
        path.join(outNoTrumpetDir, 'score.musicxml'),
        path.join(INPUT_DIR, `${songBase}_No_Trumpet.mp3`),
        `no-trumpet → ${songBase}_No_Trumpet.mp3`
    );
    runMscore(
        path.join(outNoSaxDir, 'score.musicxml'),
        path.join(INPUT_DIR, `${songBase}_No_Sax.mp3`),
        `no-sax     → ${songBase}_No_Sax.mp3`
    );

    // 4. Full demo MP3 — whole arrangement with all parts playing.
    // This is the shareable audition artifact (SoundCloud-style demo).
    runMscore(
        path.join(outWholeDir, `${songBase}.musicxml`),
        path.join(INPUT_DIR, `${songBase}_Demo.mp3`),
        `demo        → ${songBase}_Demo.mp3`
    );

    const sec = ((Date.now() - mscoreStart) / 1000).toFixed(1);
    process.stderr.write(`[render] mscore pass complete in ${sec}s\n`);
}

// Audio-only re-render. Used when the MusicXML splits are already on
// disk (a previous --apply ran) but the user wants fresh audio — e.g.
// after tweaking a part in MuseScore, or after switching soundfonts.
function renderMp3Only(outWholeDir, outNoTrumpetDir, outNoSaxDir, songBase) {
    if (!which('mscore')) {
        process.stderr.write(`[render] SKIP: mscore not on PATH. Install with:\n`);
        process.stderr.write(`         brew install --cask musescore\n`);
        return;
    }
    const mscoreStart = Date.now();
    runMscore(
        path.join(outWholeDir, `${songBase}.musicxml`),
        path.join(INPUT_DIR, `${songBase}_Demo.mp3`),
        `demo        → ${songBase}_Demo.mp3`
    );
    runMscore(
        path.join(outNoTrumpetDir, 'score.musicxml'),
        path.join(INPUT_DIR, `${songBase}_No_Trumpet.mp3`),
        `no-trumpet → ${songBase}_No_Trumpet.mp3`
    );
    runMscore(
        path.join(outNoSaxDir, 'score.musicxml'),
        path.join(INPUT_DIR, `${songBase}_No_Sax.mp3`),
        `no-sax     → ${songBase}_No_Sax.mp3`
    );
    const sec = ((Date.now() - mscoreStart) / 1000).toFixed(1);
    process.stderr.write(`[render] mscore mp3-only pass complete in ${sec}s\n`);
}

function runMscore(inputXml, outputPath, label) {
    const t0 = Date.now();
    const { spawnSync } = require('node:child_process');
    // mscore exits with code 0 on success, but on macOS its Qt
    // shutdown can complete the export and then exit non-zero (or
    // be SIGTERM'd). The PDF/MP3 file IS the source of truth, not
    // the exit code.
    spawnSync('mscore', ['-f', inputXml, '-o', outputPath],
              { stdio: ['ignore', 'pipe', 'pipe'] });
    // tiny grace period so the OS finishes the file write
    const waited = waitForFile(outputPath, 5000);
    if (!waited) {
        process.stderr.write(`[render] FAIL ${label}: mscore did not write ${outputPath}\n`);
        return;
    }
    const size = fs.statSync(outputPath).size;
    let extra = '';
    if (outputPath.endsWith('.mp3') && size > 0) {
        const probe = verifyMp3(outputPath);
        if (probe.ok) {
            extra = `, ${probe.durationSec.toFixed(1)}s @ ${probe.bitrate}`;
        } else {
            extra = `, ⚠️ ffprobe: ${probe.error}`;
        }
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`[render] ${label} (${size} bytes, ${sec}s${extra})\n`);
}

// ffprobe-based MP3 verification. Returns {ok, durationSec, bitrate, error}.
// Used to catch the case where MuseScore writes a 0-byte file (e.g. an
// unparseable score) that the file-existence check alone would miss.
function verifyMp3(p) {
    const { spawnSync } = require('node:child_process');
    if (!which('ffprobe')) {
        return { ok: true, durationSec: 0, bitrate: 'unknown', error: null };
    }
    const r = spawnSync('ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration,bit_rate',
         '-of', 'default=noprint_wrappers=1:nokey=0', p],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        return { ok: false, durationSec: 0, bitrate: '?', error: (r.stderr || '').trim() || 'ffprobe failed' };
    }
    const out = r.stdout.trim();
    const dur = (out.match(/duration=([\d.]+)/) || [])[1];
    const br   = (out.match(/bit_rate=(\d+)/)     || [])[1];
    if (!dur) {
        return { ok: false, durationSec: 0, bitrate: '?', error: 'no duration in ffprobe output' };
    }
    const durSec = parseFloat(dur);
    const bitrate = br ? `${Math.round(parseInt(br, 10) / 1000)}kbps` : '?';
    if (durSec < 0.1) {
        return { ok: false, durationSec: durSec, bitrate, error: 'duration < 0.1s — likely empty render' };
    }
    return { ok: true, durationSec: durSec, bitrate, error: null };
}

function waitForFile(p, timeoutMs) {
    // Sync busy-wait. Blocking the event loop here is acceptable —
    // we're in a CLI script, not a server.
    const start = Date.now();
    let slept = 0;
    while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
        const until = Date.now() + 50;
        while (Date.now() < until) {}  // ~50ms sync sleep
        slept += 50;
    }
    return false;
}

function which(cmd) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
    return r.stdout.trim().length > 0;
}

main();