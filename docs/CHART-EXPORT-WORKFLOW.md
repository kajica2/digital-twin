# Chart Export & Soundslice Sync — Workflow

> Sprint 0.6. The chart-export pipeline now ships a single combined
> demo MP3 alongside the muted backing tracks, and exposes a
> `--mp3-only` re-render path for iterating on audio without
> re-splitting MusicXML. `lib/chart-export.js` + `lib/midi-export.js`
> remain the two pure-Node scripts. `--render` invokes MuseScore 4
> (`brew install --cask musescore`) for headless PDF + MP3 export.
>
> Last touched: 2026-09-12.

---

## 1. What `lib/chart-export.js` does

Given a `*.musicxml` file, it produces:

```
<song>_PDF/
  manifest.json                    ← machine-readable index
  README.md                        ← MuseScore one-click render steps
  parts/
    01_Alto_Sax_Eb.musicxml        ← per-instrument parts
    02_Trumpet_Bb.musicxml
    03_Piano_C.musicxml
    ...
    *.pdf                          ← only when --render is passed

<song>_No_Trumpet/
  score.musicxml                   ← whole score, trumpet part removed
  README.md                        ← bounce instructions

<song>_No_Sax/
  score.musicxml                   ← whole score, all sax parts removed
  README.md

<song>_Whole/
  <song>.musicxml                  ← untouched reference copy
```

When `--render` is passed (or the pipeline is run via
`npm run export-all`), the script additionally produces these audio
files at the top level next to the input:

```
<song>_Full_Score.pdf              ← full transposed score
<song>_No_Trumpet.mp3              ← muted backing track
<song>_No_Sax.mp3                  ← muted backing track
<song>_Demo.mp3                    ← whole arrangement with all parts
```

The naming convention follows the full-band staff order from
`docs/COLTRANE-SHAW-ENGRAVING.md` §2. Trumpet is Bb, Alto Sax is Eb,
etc. — labels are inferred from part-name patterns, not hard-coded.

### Running it

```bash
# dry run (prints the part list, writes nothing)
node lib/chart-export.js path/to/song.musicxml

# apply (writes MusicXML splits + manifest + muted variants)
node lib/chart-export.js path/to/song.musicxml --apply --yes

# or via npm
npm run export-parts -- path/to/song.musicxml

# Full chart package: MusicXML splits + per-part PDFs + Demo/No_Trumpet/No_Sax MP3s + MIDI.
# Requires mscore on PATH (brew install --cask musescore).
npm run export-all -- path/to/song.musicxml

# Or run the pieces individually:
npm run export-parts -- path/to/song.musicxml --apply --yes --render   # adds PDFs + MP3s
npm run export-midi   -- path/to/song.musicxml --apply --yes           # adds the .mid file

# Audio-only re-render. Skips MusicXML re-splitting, just bounces
# fresh audio from the existing Whole/ + muted variants. Use this
# after tweaking a part in MuseScore, or after switching soundfonts.
# Requires an existing split (run --apply first).
npm run export-mp3 -- path/to/song.musicxml
node lib/chart-export.js path/to/song.musicxml --apply --yes --mp3-only
```

`--mp3-only` short-circuits the split/mute work — it expects the
`<song>_Whole/`, `<song>_No_Trumpet/`, and `<song>_No_Sax/`
directories from a previous `--apply` to already exist. If they
don't, the script exits with code 2 and a one-line fix hint.

---

## 2. What `lib/midi-export.js` does

Reads the same MusicXML and writes a multi-track MIDI (one track per
part, conductor track carries tempo + time signature + key signature).

The MIDI is the lingua franca for:

- **Soundslice** (sync the cursor to the audio; section 4 below).
- **Synthesia / Piano VFX / SeeMusic** (falling-notes videos).
- **DAW re-import** (Logic, Reaper, Ableton, etc.).
- **Notation software round-trip** (open the MIDI to extract parts
  back into MusicXML if needed).

### Running it

```bash
node lib/midi-export.js path/to/song.musicxml --apply --yes
npm run export-midi -- path/to/song.musicxml
```

The output goes to `<song>_Whole/<song>.mid`. Run `chart-export.js`
first (the `Whole/` directory is created there); `midi-export.js`
adds the `.mid` file to it.

---

## 3. Rendering PDFs and MP3s with `--render`

The `--render` flag (on by default in `npm run export-all`) invokes
MuseScore 4 headlessly to produce PDFs and MP3s from the MusicXML
inputs. This makes the whole chart package scriptable — no manual
MuseScore steps required.

### What's produced

For every chart, `--render` emits:

| File | Source | What it is |
|------|--------|------------|
| `<song>_Full_Score.pdf` | input `<song>.musicxml` | All parts in one transposed score |
| `<song>_PDF/parts/NN_*.pdf` | per-part MusicXML | One PDF per instrument, in its transposed key |
| `<song>_No_Trumpet.mp3` | `<song>_No_Trumpet/score.musicxml` | Backing track, no trumpets |
| `<song>_No_Sax.mp3` | `<song>_No_Sax/score.musicxml` | Backing track, no saxes |
| `<song>_Demo.mp3` | `<song>_Whole/<song>.musicxml` | **Whole arrangement, all parts playing** — the shareable audition |

MP3s use MuseScore's bundled `MS Basic.sf3` soundfont (ships with
the cask install). All MP3 outputs are validated via `ffprobe`
immediately after MuseScore writes them — the script reports the
duration and bitrate per file, and prints a warning if any file
came out empty.

### Requirements

- `mscore` on PATH (`brew install --cask musescore`)
- `ffprobe` on PATH (ships with `ffmpeg`, used to validate MP3
  outputs are real audio with non-trivial duration)

### Detection

MuseScore exits with code 0 on success, but on macOS its Qt shutdown
can complete the export and then exit non-zero (or get SIGTERM'd).
The MP3/PDF file IS the source of truth, not the exit code. The
script polls for the file's existence + non-zero size with a 5-second
timeout per file.

### Soundfont swap (optional)

To use a higher-fidelity SF3 (e.g. FluidR3) instead of the bundled
`MS Basic.sf3`, drop the `.sf3` file into
`/Applications/MuseScore 4.app/Contents/Resources/sound/` and rename
to override the default. The pipeline picks up the new font on the
next `--render` — no script changes needed.

---

## 4. `--mp3-only` — re-render audio without re-splitting MusicXML

After a chart has been split once, you often want to re-bounce just
the audio — after editing a part in MuseScore, after switching
soundfonts, or after MuseScore fixes a rendering bug. `--mp3-only`
re-runs only the `mscore -f ... -o ...mp3` invocations against the
existing MusicXML inputs:

```
[export] demo        → mini-score_Demo.mp3 (112848 bytes, 1.7s, 7.1s @ 128kbps)
[export] no-trumpet → mini-score_No_Trumpet.mp3 (112848 bytes, 1.7s, 7.1s @ 128kbps)
[export] no-sax     → mini-score_No_Sax.mp3 (112848 bytes, 0.8s, 7.1s @ 128kbps)
[export] mscore mp3-only pass complete in 4.2s
```

Compare to the full pipeline's 7.8s — the audio-only path saves
~50% of the wall time by skipping the MusicXML re-writes and PDF
render. The script exits with code 2 and a one-line hint if the
required `<song>_Whole/<song>.musicxml` is missing.

---

## 5. Naming convention

```
00_Full_Score.pdf                ← transposed score (Trumpet in Bb, Alto in Eb)
01_Trumpet_Bb.pdf                ← individual parts in their transposed keys
02_Alto_Sax_Eb.pdf
03_Tenor_Sax_Bb.pdf
...
07_Piano_C.pdf
08_Bass_C.pdf
09_Drums_C.pdf
```

The **Full Score is best in concert pitch** for the conductor; the
**individual parts MUST be in the transposed key** so the player reads
naturally.

---

## 6. Putting it all together — one chart's worth of outputs

After running the full pipeline against `MySong.musicxml`:

```
MySong.musicxml                                ← original input

MySong_PDF/
  manifest.json
  README.md
  parts/
    01_Alto_Sax_Eb.musicxml
    02_Trumpet_Bb.musicxml
    03_Tenor_Sax_Bb.musicxml
    04_Piano_C.musicxml
    05_Bass_C.musicxml
    06_Drums_C.musicxml
    01_Alto_Sax_Eb.pdf
    02_Trumpet_Bb.pdf
    03_Tenor_Sax_Bb.pdf
    04_Piano_C.pdf
    05_Bass_C.pdf
    06_Drums_C.pdf

MySong_No_Trumpet/score.musicxml

MySong_No_Sax/score.musicxml

MySong_Whole/
  MySong.musicxml
  MySong.mid                                  ← upload to Soundslice

# Top-level deliverables:
MySong_Full_Score.pdf
MySong_Demo.mp3                               ← whole-arrangement audition
MySong_No_Trumpet.mp3
MySong_No_Sax.mp3
```

The `Demo.mp3` is the single file you share for auditions. The
two muted MP3s are the backing tracks for the soloist to practice
over.

---

## 7. Soundslice sync workflow

Per the AI-generated Soundslice reference (saved alongside this doc
for posterity):

1. **Record the trumpet** in your DAW. **Humanize the timing** —
   straight MIDI quantize makes jazz sound robotic. Soundslice wants
   a real performance.
2. **Bounce WAV** of the trumpet track.
3. **Export MusicXML** of the trumpet part: `parts/02_Trumpet_Bb.musicxml`.
4. **Create a new Soundslice slice** at soundslice.com.
5. **Upload the WAV + MusicXML.**
6. **Sync manually** — drag the barlines while the audio plays. A
   2-minute solo takes 10–15 minutes to sync.
7. **Customize colors** for the falling-notes visual.

### Programmatic Soundslice import

Soundslice's API can import MusicXML + audio URL directly. The shape
is roughly:

```bash
curl -X POST https://www.soundslice.com/api/v1/slices/ \
  -H "Authorization: Token ***" \
  -F "musicxml=@parts/02_Trumpet_Bb.musicxml" \
  -F "audio=@bounce.wav.mp3"
```

(The exact endpoint / shape depends on your Soundslice plan; check
their current API docs. Out of scope for this script — once you have
the API token, this is a `curl` away.)

---

## 8. Limitations (sprint 0.6)

- **No pitch auto-correction in the MIDI.** The MIDI is faithful to
  the MusicXML (rests, pitches, durations). It does not humanize
  timing — Soundslice sync is the humanize step.
- **No percussion mapping.** Drum parts come through as unpitched
  notes; the channel-9 / GM percussion map is not yet applied. If
  the drum part already uses channel 9 in the MusicXML (some
  software does), it survives; otherwise drum pitches are literal
  MIDI note numbers, not GM percussion keys.
- **No chord symbol extraction.** Horn voicings stay as written
  pitches; the chord-symbol layer (common in jazz scores) is not
  parsed.
- **No lyric / rehearsal mark extraction.** Both are present in
  MusicXML; both are skipped here.
- **Audio uses the bundled GM soundfont.** MP3s sound generic. To
  upgrade, drop a higher-fidelity SF3 into the MuseScore sound
  directory (see §3). The pipeline picks it up automatically on the
  next `--render`.

These are candidates for sprint 0.7 once a chart in the wild shows
what's worth deepening.