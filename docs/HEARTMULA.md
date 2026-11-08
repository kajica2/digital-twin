# HeartMuLa — the twin's open-source music model

**HeartMuLa** ([github.com/HeartMuLa/heartlib](https://github.com/HeartMuLa/heartlib),
[heartmula.github.io](https://heartmula.github.io/)) is a family of open-source
music foundation models. The piece the twin uses is the song generator: it
writes a **whole song from lyrics + style tags**, in several languages, from a
3B-parameter open-weights release.

- **Licence: Apache-2.0** for the code *and* the weights (the repo and the
  weights were relicensed on 2026-01-20).
- **Package**: `lib/heartmula/` (uv-managed) · **tests**: `npm run test:heartmula`
- **CLI**: `npm run heartmula:check` · `npm run heartmula:generate` ·
  `npm run heartmula:mix`
- **Reference**: the paper is [arXiv:2601.10547](https://arxiv.org/abs/2601.10547);
  the family also ships HeartCLAP (audio–text alignment), HeartCodec (the
  12.5 Hz codec) and HeartTranscriptor (lyric recognition).

## The model

| | |
|---|---|
|weights|`HeartMuLa/HeartMuLa-oss-3B-happy-new-year` + `HeartMuLa/HeartCodec-oss-20260123` + `HeartMuLa/HeartMuLaGen` (the tokenizer)|
|size|22.4 GB on disk (the 3B model in bf16 + the codec in fp32 + the tokenizer)|
|inputs|lyrics (a UTF-8 text file with `[Verse]`/`[Chorus]` sections) + tags (a comma-separated style string)|
|outputs|one audio file (mp3 or wav), up to `--seconds` long|
|device|MPS on Apple silicon, CUDA on nvidia, CPU otherwise — the CLI picks and prints it|

The weights live in `lib/heartmula/ckpt/` and are **gitignored**. Fetch them once:

```bash
hf download --local-dir ./lib/heartmula/ckpt 'HeartMuLa/HeartMuLaGen'
hf download --local-dir ./lib/heartmula/ckpt/HeartMuLa-oss-3B 'HeartMuLa/HeartMuLa-oss-3B-happy-new-year'
hf download --local-dir ./lib/heartmula/ckpt/HeartCodec-oss HeartMuLa/HeartCodec-oss-20260123
```

## Using it

```bash
npm run heartmula:setup          # uv sync (torch + heartlib from git)
npm run heartmula:check          # the device, and what is on disk

# a dry run prints the plan and loads nothing
npm run heartmula:generate -- --lyrics lib/heartmula/assets/lyrics/flames-dont-warm-me.txt \
    --tags "modal jazz, trumpet, sparse, warm" --seconds 90 --dry-run

# the real thing
npm run heartmula:generate -- --lyrics lib/heartmula/assets/lyrics/flames-dont-warm-me.txt \
    --tags "modal jazz, trumpet, sparse, warm" --seconds 90 --out data/heartmula/flames.mp3
```

## Mixing a reference track under it

`heartmula-mix` puts a reference drum track under a generated song. A naive sum
is a flam — two performances, two tempi, two downbeats — so the reference is
**time-stretched to the song's tempo** (librosa measures both, ffmpeg's
`atempo` does the work) before the two are summed and limited:

```bash
npm run heartmula:mix -- --song data/heartmula/flames.mp3 \
    --drums "/Users/…/Track 2 - drums - Treblo.wav" \
    --out data/heartmula/flames-with-drums.mp3 --drums-gain-db -6
```

## What was measured on this machine (M4 Pro, 24 GB, macOS)

**MPS is the slow path, and the reason is not the model.** The generation runs
on the GPU, but the *codec* — the flow-matching decoder that turns the model's
tokens back into audio — is where the time goes. Two things had to be true for
it to run at all:

1. **`torch.compile` has to be off.** The pipeline compiles the backbone, and
   the Metal backend dies with
   `NotImplementedError: MetalKernel: device_assert_async should be handled by
   CSEProxy`. The inductor also wants `triton`, which does not exist on macOS.
   The CLI sets `TORCH_COMPILE_DISABLE=1` before torch is imported, unless
   `--compile` is passed.
2. **`--lazy-load` has to be off.** With lazy loading the pipeline frees the
   model between calls; on MPS that deadlocks — the process sits at 0 % CPU
   with the GPU idle. Without it, the model stays resident (about 12 GB of the
   24 GB) and the run proceeds.

## "Based on this reference" — what HeartMuLa can and cannot do

**HeartMuLa itself takes no reference audio.** The 3B release is conditioned on
**lyrics + style tags**; reference-audio conditioning is still on the upstream
TODO list, and the model that does it is **MuLaCover** (below). So "generate
based on this file" is done by **measuring** the reference and feeding the
measurements in:

```bash
# 1. measure the reference: tempo, key, brightness, level, length
python3 - <<'PY'
import librosa, numpy as np
y, sr = librosa.load('/Users/.../rado2.wav', sr=22050, mono=True)
tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
print('tempo %.1f' % float(np.atleast_1d(tempo)[0]))
PY

# 2. generate with the measurements as tags
npm run heartmula:generate -- --lyrics /tmp/instrumental-lyrics.txt \
    --tags "95 BPM, F sharp major, afro-house, spiritual jazz, percussive drums" \
    --seconds 90 --out data/heartmula/rado2-based.mp3 --codec-device cpu

# 3. match the tempo exactly (atempo keeps the pitch), extend, and mix
ffmpeg -i data/heartmula/rado2-based.mp3 -af "atempo=0.5,atempo=1.2592" out.wav
```

**What the tags actually bought, measured on `rado2.wav`:**

| | reference | generated | after the tempo match |
|---|---|---|---|
| tempo | 95.7 BPM | **152.0 BPM** | **95.7 BPM** (atempo) |
| key | F# major-ish | G# major-ish | G# major-ish — a tone off, and not correctable without a pitch shift |
| brightness | 1631 Hz | 1558 Hz | — |
| level | −17.8 dB | −16.2 dB | — |
| length | 207.0 s | 90.1 s | 207.0 s (loop + tail) |

So the tags carry the **character** (brightness, level, the genre) and not the
**musical facts** (tempo, key). The tempo can be corrected afterwards; the key
cannot, without changing what the song sounds like.

## Two bugs the write path had, both found by running it

1. **torchaudio 2.10 needs torchcodec**, and torchcodec's bundled ffmpeg
   dylibs will not load against a Homebrew ffmpeg 8. The write therefore goes
   through **soundfile** directly.
2. **The codec hands the audio channels-first** (2, samples). A writer that
   expects (samples, channels) then reads the **sample count as the channel
   count** and libsndfile answers *"Format not recognised"* — the whole song
   lost at the last step, after eight minutes of generation. The layout is now
   detected rather than trusted.

## The sibling model — MuLaCover, and why it is not the default


[MuLaCover](https://github.com/HeartMuLa/MuLaCover) is the *cover and remix*
model: it takes **reference audio** (or melody/chord MIDI) and rewrites it with
new lyrics and a new style. That is the literal "mix of this recording".

It is not the default here because of three measured facts:

- **Its weights are a private release candidate.** The account this machine's
  `hf` CLI is signed in with *can* download `HeartMuLa/MuLaCover`, but the
  upstream guide says to authenticate with an account that has access — most
  people do not.
- **Its licence is different.** The code is Apache-2.0; the weights and the
  **outputs are non-commercial** under its own `MODEL_LICENSE`. The plain
  HeartMuLa weights are Apache-2.0.
- **It is documented for Linux on an NVIDIA GPU** (PyTorch 2.10 / CUDA 13),
  and it wants ~15 GB more checkpoints than the disk had free.

The route that works here is the plain model plus the twin's own mix: generate
the song, measure the reference's tempo, stretch it to the song, sum them.

## The Treblo session

A Treblo cookie jar belongs at `~/.treblo-cookies.txt` (mode 0600, outside the
repository — the repo's secrets guard checks that every cookie path resolves
outside the tree). The Treblo API sits behind **Cloudflare**: a plain request
gets a 403 challenge page, so anything that needs the API has to go through a
real browser.
