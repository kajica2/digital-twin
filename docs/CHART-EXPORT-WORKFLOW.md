# Chart Export & Soundslice Sync — Workflow

> Sprint 0.4. Two new scripts in `lib/` make the chart-export pipeline
> scriptable. This doc is the canonical reference for going from a
> MusicXML file to per-instrument PDFs, muted backing tracks, and the
> MIDI that drives Soundslice highlight videos.
>
> Last touched: 2026-09-09.

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

<song>_No_Trumpet/
  score.musicxml                   ← whole score, trumpet part removed
  README.md                        ← bounce instructions

<song>_No_Sax/
  score.musicxml                   ← whole score, all sax parts removed
  README.md

<song>_Whole/
  <song>.musicxml                  ← untouched reference copy
  <song>.mid                       ← MIDI of the whole arrangement
```

The naming convention follows the full-band staff order from
`docs/COLTRANE-SHAW-ENGRAVING.md` §2. Trumpet is Bb, Alto Sax is Eb,
etc. — labels are inferred from part-name patterns, not hard-coded.

### Running it

```bash
# dry run (prints the part list, writes nothing)
node lib/chart-export.js path/to/song.musicxml

# apply
node lib/chart-export.js path/to/song.musicxml --apply --yes

# or via npm
npm run export-parts -- path/to/song.musicxml
```

Same `--apply --yes` convention as `lib/songs-indexer.js`.

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

## 3. Rendering PDFs in MuseScore

This machine does not have MuseScore installed (Sibelius / Finale /
Dorico work too with the same shape). The `lib/` scripts produce the
**inputs**; the user runs the notation software once to produce the
final PDFs / audio.

### Per-instrument PDFs (one file per part)

1. Open MuseScore. **File → Open**. Pick `parts/02_Trumpet_Bb.musicxml`.
2. **Layout → Page Settings**: 9×12" or Letter, 0.6–0.75" margins.
3. **File → Export → PDF**. Save as `02_Trumpet_Bb.pdf` next to the
   `parts/` folder.
4. Repeat for each part. Rename per the convention below.

Or batch from the full score:

1. Open the full score (the input `*.musicxml` directly in MuseScore).
2. **File → Export → Parts…**.
3. Tick **every** instrument. Pick an output folder. Click **Export**.

### Full score PDF (all parts together)

1. Open the input `*.musicxml` in MuseScore.
2. **File → Export → PDF** → `00_Full_Score.pdf`.

### Naming convention

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

## 4. Bouncing the muted backing tracks

Two `score.musicxml` files are produced automatically:

- `<song>_No_Trumpet/score.musicxml` — whole score with all trumpet
  parts removed.
- `<song>_No_Sax/score.musicxml` — whole score with all sax parts
  removed.

### Bounce in MuseScore (simplest)

1. Open `<song>_No_Trumpet/score.musicxml` in MuseScore.
2. **File → Export → MP3** (or WAV).
3. Save as `<song>_No_Trumpet.mp3` next to the source folder.

Repeat for the No_Sax variant.

### Bounce in a DAW (more flexible)

Logic / Reaper / Ableton / GarageBand all import MusicXML natively.
Open the muted `score.musicxml`, route to a single aux bus, add
virtual instruments (Keyscape for piano, Trilian for bass, Superior
Drummer for drums), export the mix.

---

## 5. Soundslice sync workflow

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
  -H "Authorization: Token <api-token>" \
  -F "musicxml=@parts/02_Trumpet_Bb.musicxml" \
  -F "audio=@bounce.wav.mp3"
```

(The exact endpoint / shape depends on your Soundslice plan; check
their current API docs. Out of scope for this script — once you have
the API token, this is a `curl` away.)

---

## 6. Putting it all together — one chart's worth of outputs

After running both scripts against `MySong.musicxml`:

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

MySong_No_Trumpet/
  score.musicxml        → MySong_No_Trumpet.mp3   (bounce in MuseScore)

MySong_No_Sax/
  score.musicxml        → MySong_No_Sax.mp3       (bounce in MuseScore)

MySong_Whole/
  MySong.musicxml
  MySong.mid            → upload to Soundslice
```

Then render in MuseScore to get `00_Full_Score.pdf` +
`01_…_06_…pdf` next to `parts/`, and you have the full chart
package.

---

## 7. Limitations (sprint 0.4)

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

These are candidates for sprint 0.5 once a chart in the wild shows
what's worth deepening.