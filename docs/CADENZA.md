# Cadenza — the Rust DAW the twin drives

**Cadenza** ([github.com/Pep3M/cadenza](https://github.com/Pep3M/cadenza)) is an
open-source digital audio workstation and audio editor written in **Rust**. It hosts
**CLAP and VST3** plugins (each sandboxed in its own process), renders offline, and
ships an AI producer that is just another client of the same command API the UI uses.

`lib/cadenza.js` is the twin's seam to it: a thin wrapper that builds the argv,
refuses a flag it does not understand, and never puts a secret on a command line.

- **Installed**: v0.3.3, `~/.local/bin/cadenza` + `~/Applications/Cadenza.app`
  (per-user install, verified against the release's `SHA256SUMS`; the script has an
  `--uninstall`).
- **Wrapper**: `lib/cadenza.js` · **tests**: `lib/cadenza.test.js` (19 assertions)
- **npm**: `npm run cadenza:check` · `npm run cadenza:render` · `npm run cadenza:export`
  · `npm run cadenza:mcp` · `npm run test:cadenza`

## The survey — what was found, and why this one

The brief was a DAW in Rust with VST support that the twin can automate. Six
projects were read at the source level; only one is all three of the things the twin
needs — Rust, VST hosting, **and** a scriptable surface.

|project|what it is|plugins|automation surface|maturity|
|---|---|---|---|---|
|**[Pep3M/cadenza](https://github.com/Pep3M/cadenza)**|full DAW + AI arranger/mix engineer|CLAP + VST3, sandboxed per plugin|**CLI + `cadenza mcp` (MCP over stdio)**|v0.3.3, released 2026-11-01|
|[hlavnjak/resynth-studio](https://github.com/hlavnjak/resynth-studio)|DAW that resynthesises any recording into an editable instrument; splits audio host-side into pitch-stable subtracks|VST3 + CLAP + VST2 + LV2 + AU|GUI-first; only `dump_render` and `plugin_probe` binaries|3 stars, Apache-2.0|
|[115dkk/vst-audio](https://github.com/115dkk/vst-audio)|headless VST2/VST3 **host library**, one worker process per plugin|VST2 + VST3|Python bindings + `render()` offline rendering|2 stars, Apache-2.0/MIT|
|[robbert-vdh/nih-plug](https://github.com/robbert-vdh/nih-plug)|plugin **framework** (+ a VST3 host example)|VST3 + CLAP|framework, not a DAW|3025 stars, in maintenance mode|
|[HelgeSverre/rust-vst3-host](https://github.com/HelgeSverre/rust-vst3-host)|safe Rust VST3 host library|VST3|Rust library only|—|
|[PoHsuanLai/vst3-host](https://github.com/PoHsuanLai/vst3-host)|VST3 host library|VST3|Rust library only|—|

**Cadenza won** because it is the only one with a DAW *and* a scriptable surface *and*
VST hosting. `resynth-studio` has the most interesting audio analysis (it splits a
recording into pitch-stable subtracks — the closest thing found to "auto split to
parts") but it is a GUI app; `vst-audio` is the right *headless* host but it is a
library, not a DAW.

## The verbs

```
node lib/cadenza.js check                              # version + where it is
node lib/cadenza.js scan-plugins --json               # scan installed CLAP/VST3
node lib/cadenza.js list-plugins --json -q trumpet
node lib/cadenza.js import-midi chart.mid --output song.cdz
node lib/cadenza.js render song.cdz --output song.wav
node lib/cadenza.js export song.cdz --stems tracks --format wav
node lib/cadenza.js analyze song.cdz
node lib/cadenza.js mcp                               # MCP server over stdio
node lib/cadenza.js compose "a modal blues in D" --out sketch --slug blues
node lib/cadenza.js mix song.cdz --target-lufs -14
```

Every verb takes `--plan` (print the exact argv, run nothing) and `--json` (machine
output). An **unknown flag is refused with exit 2** — never ignored. That rule is not
decoration: `--help` once started a paid render in another CLI in this repo, because
that CLI treated what it did not understand as a no-op.

## The measured pipeline — chart MIDI in, stems out

The twin's chart pipeline already produces a multi-track MIDI file
(`lib/midi-export.js`). Cadenza turns it into audio, one file per part:

```bash
node lib/midi-export.js song.musicxml --apply --yes     # → song_Whole/song.mid
node lib/cadenza.js import-midi song_Whole/song.mid --output song.cdz
node lib/cadenza.js render song.cdz --output song.wav   # the mix + a JSON report
node lib/cadenza.js export song.cdz --stems tracks --format wav
```

Measured on 2026-11-07 with a four-part chart (Trumpet, Piano, Bass, Drums):

- `import-midi` → **4 tracks, 16 notes each**; the project is a `.cdz` JSON file.
- `render` → an 8.35 s 48 kHz float WAV **plus a report**: peak, true peak, RMS,
  LUFS integrated, crest factor, per-band energy, stereo correlation, clipped samples.
- `export --stems tracks` → the mixdown **and one WAV per track**, written to
  `Renders/` next to the project, each with its own LUFS.

That is the twin's "auto split to parts": one command turns a chart into one audio
file per instrument, with the mix report attached.

## Two things that bite — both found by running it

**1. A MusicXML chord marked wrongly loses a part, silently.** MusicXML says the
*first* note of a chord carries no `chord` attribute and the rest do. Mark them all
and the part parses as empty — the twin's MIDI export writes a track with no notes
and says nothing, and Cadenza's importer skips an empty track
(`crates/midi-io/src/smf_import.rs`: `if track.notes.is_empty() { continue; }`). The
symptom is "Cadenza imported 3 of 4 parts"; the fault is upstream, in the MusicXML.
**The check**: count the tracks the import reports against the parts in the score.

**2. Program changes have no Cadenza equivalent.** Every imported track lands on a
built-in instrument ("pick the instrument or preset instead" — Cadenza's own warning).
So what you hear is Cadenza's built-ins until a track is re-pointed at a plugin.

## Plugins

There are **no VST3/CLAP plugins installed on this machine** — `list-plugins --json`
returns `[]`, and the render above is Cadenza's built-in instruments
(`poly_synth`, `electric_piano`, `drum_machine`, and the built-in EQ/compressor/
reverb/delay). To add one: install the plugin, then

```bash
node lib/cadenza.js scan-plugins --json
node lib/cadenza.js list-plugins --json -q <name>
```

`scan-plugins` loads each plugin in a separate helper process, so a plugin that
crashes is blocklisted instead of taking the catalog down.

## The AI verbs, and where the key goes

`compose`, `chat`, `mix` and `tune` drive Cadenza's embedded AI producer. It reads
`OPENROUTER_API_KEY` (or any OpenAI-compatible endpoint) **from the environment**.
The wrapper never puts a key on a command line — an argv is visible to every process
on the machine and lands in shell history — and it maps the twin's `DEEPSEEK_API_KEY`
onto `OPENROUTER_API_KEY` when that is the key you have. Cadenza also accepts
`--api-key-env <NAME>` and `--base-url <URL>`.

## What Cadenza is not

It does **not** do source separation: `export --stems` writes one file per *track in
the project*, not one file per instrument recovered from a mixed recording. A
recording that must be separated into instruments needs a separation model (a
stem-separation VST, or a separate tool) — Cadenza is the place to *host* that
plugin, not the separator itself.

## Uninstall

```bash
sh ~/.local/bin/cadenza-uninstall 2>/dev/null || \
  curl -fsSL https://github.com/Pep3M/cadenza/releases/latest/download/install.sh | sh -s -- --uninstall
```
