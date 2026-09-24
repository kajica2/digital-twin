#!/usr/bin/env node
// lib/jazz-solos-indexer.js
//
// Sprint 0.22 — the jazz-solos (MIDI corpus) indexer. Reads the
// WJazzD manifest.csv, cross-checks every row against the actual
// files on disk in midis/ and pdfs/, and writes a searchable
// catalog to data/songs/catalog-jazz-solos.json.
//
// Why a second indexer rather than extending songs-indexer.js:
//   * songs-indexer walks audio directories and parses ID3/RIFF
//     headers. This one reads a CSV manifest and verifies two file
//     trees (MIDI + PDF). Different input, different output schema.
//   * The two catalogs are independent datasets with independent
//     rebuild triggers. The Songs panel renders them as separate
//     sections (audio vs MIDI corpus).
//   * Sharing one indexer would couple two unrelated pipelines —
//     same reasoning as the watchers being separate.
//
// Source: ~/Documents/jazz solos/ — the Weimar Jazz Database
// (WJazzD r2.2/v2.3) solo archive. 456 transcribed solos, 78 unique
// performers, 8 styles. See the corpus README for provenance.
//
// Usage:
//   node lib/jazz-solos-indexer.js                   # dry run, prints summary
//   node lib/jazz-solos-indexer.js --apply           # write catalog
//   node lib/jazz-solos-indexer.js --apply --yes     # skip prompt
//   node lib/jazz-solos-indexer.js --source <dir>    # alternate corpus dir
//   node lib/jazz-solos-indexer.js --keep-abspath    # debug: keep abs paths
//
// Output: data/songs/catalog-jazz-solos.json
//   {
//     "generatedAt": "...",
//     "durationMs": 42,
//     "source": {
//       "label": "jazz-solos",
//       "pathHint": "jazz-solos",
//       "manifest": "manifest.csv",
//       "corpus": "Weimar Jazz Database (WJazzD r2.2/v2.3)",
//       "counts": { ... },
//       "repairs": [ ... ],        // malformed manifest rows, repaired
//       "discrepancies": [ ... ]   // CSV flags that disagree with disk
//     },
//     "performers": [ { "name": "...", "count": 20 } ],
//     "styles":     [ { "name": "...", "count": 147 } ],
//     "instruments":[ { "code": "ts", "name": "tenor saxophone", "count": 157 } ],
//     "items": [
//       {
//         "id": "jazz-solos/1",
//         "label": "jazz-solos",
//         "performer": "Art Pepper",
//         "title": "Anthropology",
//         "instrument": "cl",
//         "instrumentName": "clarinet",
//         "style": "Cool",
//         "year": 1979,
//         "tempo": 218.8,
//         "tones": 530,
//         "midi": "ArtPepper_Anthropology_FINAL.mid",
//         "pdf":  "ArtPepper_Anthropology_FINAL.pdf",
//         "hasMidi": true,
//         "hasPdf": true,
//         "midiSize": 1234,
//         "pdfSize": 45678
//       }
//     ]
//   }
//
// Exit:
//   0  success
//   1  filesystem / parse error
//   2  source dir or manifest missing
//
// Pure Node, no deps, idempotent.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const YES = ARGV.includes('--yes');
const HELP = ARGV.includes('--help') || ARGV.includes('-h');
const KEEP_ABSPATH = ARGV.includes('--keep-abspath');

const SRC_FLAG = ARGV.indexOf('--source');
const SOURCE_DIR = SRC_FLAG !== -1 && ARGV[SRC_FLAG + 1] && !ARGV[SRC_FLAG + 1].startsWith('--')
  ? path.resolve(ARGV[SRC_FLAG + 1].replace(/^~/, process.env.HOME || ''))
  : path.join(process.env.HOME || '', 'Documents', 'jazz solos');

const MANIFEST = path.join(SOURCE_DIR, 'manifest.csv');
const MIDI_DIR = path.join(SOURCE_DIR, 'midis');
const PDF_DIR  = path.join(SOURCE_DIR, 'pdfs');
const LABEL = 'jazz-solos';
const OUT_PATH = path.join(ROOT, 'data', 'songs', 'catalog-jazz-solos.json');

// WJazzD instrument codes → human names. Codes not in this map fall
// through as the raw code (logged, never silently dropped).
const INSTRUMENTS = {
  as:    'alto saxophone',
  ts:    'tenor saxophone',
  'ts-c':'tenor saxophone / clarinet',
  bs:    'baritone saxophone',
  ss:    'soprano saxophone',
  cl:    'clarinet',
  bcl:   'bass clarinet',
  fl:    'flute',
  tp:    'trumpet',
  cor:   'cornet',
  tb:    'trombone',
  vib:   'vibraphone',
  p:     'piano',
  g:     'guitar',
  b:     'bass',
  d:     'drums',
};

function log(msg) { process.stderr.write(`[jazz-solos] ${msg}\n`); }

// --- CSV -----------------------------------------------------------------
//
// Minimal RFC 4180 parser: quoted fields, "" as an escaped quote,
// LF or CRLF line endings. Returns an array of rows (each an array
// of raw string fields). No dependency on a CSV package.

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Repair a manifest row whose field count exceeds the header because
// a filename contains an unquoted comma.
//
// The WJazzD manifest has one such row (Chris Potter / "Item 1,
// D.I.T.", whose filenames are `ChrisPotter_Item1,D.I.T._FINAL.mid`
// and `.pdf`). Rather than special-case that row, we handle the
// general shape: a row with N extra fields has commas inside
// pdf_filename and/or midi_filename, which are always the last two
// fields before the has_pdf/has_midi booleans and always end in
// `_FINAL.<ext>`.
//
// Strategy: peel the fixed prefix (id..tones) and the fixed suffix
// (has_pdf, has_midi); re-join the middle fragments by scanning for
// the first fragment that ends like a PDF filename, then treating
// the remainder as the MIDI filename.
function repairRow(raw, expectedLen) {
  if (raw.length === expectedLen) return { fields: raw, repaired: false };
  if (raw.length < expectedLen)   return { fields: raw, repaired: false, reason: 'short' };

  const prefix = raw.slice(0, 8);       // id, performer, title, instrument, style, year, tempo, tones
  const suffix = raw.slice(-2);         // has_pdf, has_midi
  const middle = raw.slice(8, -2);      // filename fragments

  const isPdfEnd  = s => /_FINAL\.[a-z0-9]+$/i.test(s);
  const isMidiEnd = s => /_FINAL\.(mid|midi|mp3|midi)$/i.test(s);

  const pdfParts = [];
  let i = 0;
  for (; i < middle.length; i++) {
    pdfParts.push(middle[i]);
    if (isPdfEnd(middle[i])) { i++; break; }
  }
  const midiParts = middle.slice(i);

  // Sanity: the rejoined fragments must look like the filenames we
  // expect. If not, bail out rather than emit garbage.
  const pdf = pdfParts.join(',');
  const midi = midiParts.join(',');
  const okPdf = !pdf || isPdfEnd(pdf);
  const okMidi = !midi || isMidiEnd(midi);
  if (!okPdf || !okMidi || midiParts.length === 0) {
    return { fields: raw, repaired: false, reason: 'unrepairable' };
  }

  return { fields: [...prefix, pdf, midi, ...suffix], repaired: true };
}

// --- indexing ------------------------------------------------------------

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function toNum(v) { const n = parseFloat(v);   return Number.isFinite(n) ? n : null; }

function index() {
  const t0 = Date.now();

  if (!fs.existsSync(MANIFEST)) {
    log(`manifest not found: ${MANIFEST}`);
    process.exit(2);
  }

  const raw = fs.readFileSync(MANIFEST, 'utf8');
  const rows = parseCSV(raw);
  if (rows.length < 2) {
    log(`manifest has no data rows: ${MANIFEST}`);
    process.exit(2);
  }

  const header = rows[0].map(h => h.trim());
  const expected = header.length;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  // Files actually on disk. Used both to verify each row and to
  // report which corpus files the manifest doesn't mention.
  const midiOnDisk = new Set(
    fs.existsSync(MIDI_DIR) ? fs.readdirSync(MIDI_DIR).filter(f => !f.startsWith('.')) : []
  );
  const pdfOnDisk = new Set(
    fs.existsSync(PDF_DIR) ? fs.readdirSync(PDF_DIR).filter(f => !f.startsWith('.')) : []
  );

  const items = [];
  const repairs = [];
  const discrepancies = [];
  const seenMidi = new Set();
  const seenPdf = new Set();
  const unknownInstruments = new Set();

  for (let r = 1; r < rows.length; r++) {
    const { fields, repaired, reason } = repairRow(rows[r], expected);
    if (repaired) {
      repairs.push({
        line: r + 1,
        id: fields[idx.id],
        performer: fields[idx.performer],
        reason: 'unquoted comma in filename column(s)',
      });
    } else if (reason) {
      log(`row ${r + 1}: ${reason} — skipping (expected ${expected} fields, got ${rows[r].length})`);
      continue;
    }
    if (fields.length !== expected) {
      log(`row ${r + 1}: field count still ${fields.length} after repair — skipping`);
      continue;
    }

    const performer = (fields[idx.performer] || '').trim();
    const title     = (fields[idx.title] || '').trim();
    const code      = (fields[idx.instrument] || '').trim();
    const midiName  = (fields[idx.midi_filename] || '').trim();
    const pdfName   = (fields[idx.pdf_filename] || '').trim();
    const csvHasMidi = (fields[idx.has_midi] || '').trim().toLowerCase() === 'yes';
    const csvHasPdf  = (fields[idx.has_pdf] || '').trim().toLowerCase() === 'yes';

    // Real presence on disk is the source of truth; the CSV flags are
    // advisory. Disagreements get surfaced, never silently applied.
    const hasMidi = midiOnDisk.has(midiName);
    const hasPdf  = pdfOnDisk.has(pdfName);
    if (csvHasMidi !== hasMidi) {
      discrepancies.push({ id: fields[idx.id], performer, title,
        field: 'has_midi', csv: csvHasMidi, disk: hasMidi });
    }
    if (csvHasPdf !== hasPdf) {
      discrepancies.push({ id: fields[idx.id], performer, title,
        field: 'has_pdf', csv: csvHasPdf, disk: hasPdf });
    }
    if (hasMidi) seenMidi.add(midiName);
    if (hasPdf)  seenPdf.add(pdfName);

    if (!INSTRUMENTS[code]) unknownInstruments.add(code);

    items.push({
      id: `${LABEL}/${fields[idx.id]}`,
      label: LABEL,
      performer,
      title,
      instrument: code,
      instrumentName: INSTRUMENTS[code] || code,
      style: (fields[idx.style] || '').trim(),
      year: toInt(fields[idx.year]),
      tempo: toNum(fields[idx.tempo]),
      tones: toInt(fields[idx.tones]),
      midi: hasMidi ? midiName : null,
      pdf: hasPdf ? pdfName : null,
      hasMidi,
      hasPdf,
      midiSize: hasMidi ? fs.statSync(path.join(MIDI_DIR, midiName)).size : null,
      pdfSize: hasPdf ? fs.statSync(path.join(PDF_DIR, pdfName)).size : null,
    });
  }

  items.sort((a, b) => {
    if (a.performer !== b.performer) return a.performer.localeCompare(b.performer);
    if (a.year !== b.year) return (a.year || 0) - (b.year || 0);
    return a.title.localeCompare(b.title);
  });

  // Aggregate facets for the panel's grouping + the summary printout.
  const countBy = (keyFn) => {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (k == null || k === '') continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };

  const performers = countBy(i => i.performer).map(([name, count]) => ({ name, count }));
  const styles     = countBy(i => i.style).map(([name, count]) => ({ name, count }));
  const instruments = countBy(i => i.instrument)
    .map(([code, count]) => ({ code, name: INSTRUMENTS[code] || code, count }));

  // Corpus files the manifest never mentions.
  const orphanMidi = [...midiOnDisk].filter(f => !seenMidi.has(f) && !f.startsWith('.'));
  const orphanPdf  = [...pdfOnDisk].filter(f => !seenPdf.has(f) && !f.startsWith('.'));

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    source: {
      label: LABEL,
      pathHint: LABEL,
      manifest: path.basename(MANIFEST),
      corpus: 'Weimar Jazz Database (WJazzD r2.2/v2.3) — jazzomat.hfm-weimar.de',
      counts: {
        manifestRows: rows.length - 1,
        items: items.length,
        midiOnDisk: midiOnDisk.size,
        pdfOnDisk: pdfOnDisk.size,
        midiVerified: items.filter(i => i.hasMidi).length,
        pdfVerified: items.filter(i => i.hasPdf).length,
      },
      repairs,
      discrepancies,
      orphanMidi,
      orphanPdf,
      unknownInstruments: [...unknownInstruments],
    },
    performers,
    styles,
    instruments,
    items,
  };
}

// --- main ----------------------------------------------------------------

function main() {
  if (HELP) {
    process.stderr.write(`Usage: node lib/jazz-solos-indexer.js [options]

Reads the WJazzD manifest.csv + verifies every row against the
midis/ and pdfs/ trees on disk. Writes a searchable catalog the
Twin OS Songs panel can render. Pure Node, no deps.

Options:
  --apply              Write catalog to data/songs/catalog-jazz-solos.json
                       (default: dry-run summary only)
  --yes                Skip the y/N confirmation prompt
  --source <dir>       Alternate corpus dir (default: ~/Documents/jazz solos)
  --keep-abspath       Keep absolute filesystem paths in the output
                       (debug only; default strips them)
  --help, -h           Show this message

Corpus: Weimar Jazz Database (WJazzD r2.2/v2.3) solo archive.
See the corpus README for provenance and licensing.
`);
    process.exit(0);
  }

  const catalog = index();
  const c = catalog.source.counts;

  process.stderr.write('\n');
  process.stderr.write(`[jazz-solos] manifest: ${c.manifestRows} row(s) → ${c.items} catalog item(s)\n`);
  process.stderr.write(`[jazz-solos] disk: ${c.midiOnDisk} midi, ${c.pdfOnDisk} pdf\n`);
  process.stderr.write(`[jazz-solos] verified: ${c.midiVerified} midi, ${c.pdfVerified} pdf\n`);
  if (catalog.source.repairs.length) {
    process.stderr.write(`[jazz-solos] repaired ${catalog.source.repairs.length} malformed manifest row(s):\n`);
    for (const rp of catalog.source.repairs) {
      process.stderr.write(`[jazz-solos]   line ${rp.line}: ${rp.performer} — ${rp.id} (${rp.reason})\n`);
    }
  }
  if (catalog.source.discrepancies.length) {
    process.stderr.write(`[jazz-solos] ${catalog.source.discrepancies.length} manifest/disk disagreement(s):\n`);
    for (const d of catalog.source.discrepancies) {
      process.stderr.write(`[jazz-solos]   ${d.performer} — ${d.title}: ${d.field} csv=${d.csv} disk=${d.disk}\n`);
    }
  }
  if (catalog.source.orphanMidi.length || catalog.source.orphanPdf.length) {
    process.stderr.write(`[jazz-solos] manifest-orphan files: ${catalog.source.orphanMidi.length} midi, ${catalog.source.orphanPdf.length} pdf\n`);
  }
  if (catalog.source.unknownInstruments.length) {
    process.stderr.write(`[jazz-solos] unmapped instrument code(s): ${catalog.source.unknownInstruments.join(', ')}\n`);
  }
  process.stderr.write(`[jazz-solos] performers: ${catalog.performers.length}, styles: ${catalog.styles.length}, instruments: ${catalog.instruments.length}\n`);
  process.stderr.write(`[jazz-solos] took ${catalog.durationMs}ms\n\n`);

  if (!APPLY) {
    process.stderr.write(`[jazz-solos] DRY RUN — pass --apply to write ${OUT_PATH}\n`);
    process.exit(0);
  }

  if (!YES) {
    process.stderr.write(`Write ${catalog.items.length} entries to ${OUT_PATH}? [y/N]\n> `);
    const buf = fs.readFileSync(0, 'utf8');
    if (buf.trim().toLowerCase() !== 'y') {
      process.stderr.write('Aborted.\n');
      process.exit(0);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Hygiene: the catalog ships in a public repo. Corpus filenames are
  // public WJazzD data, but the source directory is the author's home
  // path — it is never written. `source.pathHint` carries the label
  // the UI groups by. --keep-abspath is accepted for parity with
  // songs-indexer.js but this indexer emits no absolute path either way.
  fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  process.stderr.write(`[jazz-solos] wrote ${OUT_PATH}\n`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseCSV, repairRow, index, INSTRUMENTS };
