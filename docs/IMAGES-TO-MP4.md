# Images → MP4

A set of stills becomes a video, from the shell:

```bash
node bin/images-to-mp4.mjs assets/marketplace/system-error
node bin/images-to-mp4.mjs assets/marketplace/covers --mode crossfade --size 1:1
node bin/images-to-mp4.mjs assets/flux2/two-am-infrastructure-30 --size 16:9 --total 30
node bin/images-to-mp4.mjs assets/marketplace/system-error --size 9:16 --each 1.6 --loop
node bin/images-to-mp4.mjs assets/marketplace/daily/2026-10-24T20 --motion pan-left
node bin/images-to-mp4.mjs <dir> --mode cut --each 0.12 --loop     # flicker loop
node bin/images-to-mp4.mjs <dir> --audio track.mp3 --out clip.mp4
```

`npm run images:mp4` is the same entry point; `npm run test:images-mp4` runs
the suite.

## Where the render actually happens

This CLI does **not** own a filter graph. The repo already had a
stills-to-video renderer before this tool existed, and
[`docs/MEDIA-TOOLCHAIN.md`](MEDIA-TOOLCHAIN.md) rule 3 is that there is
exactly one plan:

| piece | job |
|---|---|
| `lib/render/plan.mjs` | the filter graph and the ffmpeg argv — pure, ESM, browser-safe (no Node built-ins, no DOM) |
| `lib/render/server.mjs` | runs ffmpeg: binary discovery, progress, stall watchdog, timeout |
| `lib/render/sets.mjs` | Node-side set questions: which files, in what order, at what size, for how long |
| `bin/images-to-mp4.mjs` | the CLI: arguments → `sets.mjs` → `renderImagesToMp4()` |

The browser page (`pages/images-to-mov.html`, via
`pages/assets/ffmpeg-client.mjs`) and the local API (`lib/api/router.mjs`)
call the same plan, so a clip rendered here and a clip rendered in the browser
come out of one graph. That is why this file is a thin argument parser and a
reporter, and why it is `bin/…mjs` rather than a second `lib/*.js` renderer.

## Options

| flag | default | notes |
|---|---|---|
| `--out <file>` | `data/mp4/<set>-<mode>-<date>.mp4` | generated, gitignored |
| `--mode` | `kenburns` | `kenburns`, `crossfade`, `cut` |
| `--motion` | `zoom-in` | `kenburns` only: `zoom-in`, `zoom-out`, `pan-left` |
| `--size` | `16:9` | `16:9`, `9:16`, `1:1`, `4:5`, `4:3`, `21:9`, or `WxH` |
| `--fps` | `30` | `1`–`120` |
| `--each <s>` | `2.5` | seconds per image |
| `--total <s>` | — | total clip length; wins over `--each`, and accounts for the fades it will subtract |
| `--fade <s>` | `0.6` | dissolve length, `crossfade` only; clamped to half the shortest segment |
| `--audio <file>` | — | muxed and re-encoded (`aac`), video cut to it (`-shortest`) |
| `--loop` | off | ping-pong the set (`a,b,c,b`) so the clip repeats without a visible seam. **Needs 3+ stills** — fewer cannot ping-pong without showing one twice, so a one-image set is left alone. For a single-still seamless loop, ping-pong the *motion*: render half the length, then `concat` it with its reverse |
| `--dry-run` | | print the ffmpeg command, run nothing |
| `--json` | | the whole plan as JSON: graph, argv, durations, image list |

`cut` with a small `--each` is a flicker/glitch loop (`--each 0.12`).

Sizes are floored to even dimensions: H.264 4:2:0 cannot encode an odd height,
and a clip that fails to play is worse than one a pixel smaller.

Images sort **naturally** — `frame-2.jpg` before `frame-10.jpg`,
`system-error-9.jpg` before `system-error-10.jpg`. Directories are walked to a
shallow depth; dotfiles, `.json` sidecars and other non-images are ignored.

## Four things that fail silently if you get them wrong

Each of these produced a wrong file, not an error, before it was fixed:

1. **`scale`/`crop` take `w:h`; `zoompan`'s `s=` takes `WxH`.** `scale=1920x1080`
   parses as one invalid expression, and ffmpeg answers *"could not open
   encoder before EOF … nothing was written"*, which names none of the cause.
2. **Limited range has to be both converted and tagged.** A JPEG decodes as
   full range; an encoder handed full range but tagged limited renders milky
   blacks. The chain converts (`out_range=tv`) and the encoder tags
   (`-colorspace bt709 -color_range tv`), because a `yuv420p` stream with no
   tag is decoded as limited by some players and full by others.
3. **`xfade` offsets accumulate as `sum(segments[0..i-1]) − i × fade`.** Get it
   wrong and the render succeeds — it just shows two images colliding
   mid-dissolve.
4. **A looped set must echo its durations.** `--loop` repeats input names;
   expanding the names without expanding the per-image durations falls back to
   the uniform value and renders the wrong length (this one shipped for exactly
   one run: 11 s instead of 5.4 s).

Every branch also ends `setsar=1`, because a set can mix pixel aspect ratios
and the drift shows up as a horizontal squeeze on some frames only.

## Output

H.264 (`libx264`, crf 18, `medium`), `yuv420p`, limited range, `bt709`,
`+faststart`. Renders go to `data/mp4/` (gitignored — sets are tracked, the
motion is rebuilt on demand).

Measured on this machine (2026-10-24):

| set | mode | size | duration | file |
|---|---|---|---|---|
| System Error (10 plates) | kenburns | 1920×1080 | 25.0 s | 5.8 MB |
| Covers (12 plates) | crossfade `--each 1.5` | 1080×1080 | 11.4 s | 2.8 MB |
| Two A.M. Infrastructure (30) | crossfade `--total 30` | 1920×1080 | 29.6 s | 20.5 MB |
| System Error `--loop` (18 = 10 ping-pong) | kenburns | 1080×1920 | 28.8 s | 6.8 MB |

Those four took 16 s of wall clock together.

## How it composes

Drop the clip into `reel-inbox/` and the reel watcher takes it from there —
letterboxed to 1080×1920, cover extracted, `POST.md` written. That is the path
from a still set to something publishable:

```bash
node bin/images-to-mp4.mjs assets/marketplace/system-error --size 9:16 --loop
cp data/mp4/system-error-kenburns-*.mp4 reel-inbox/
```

For a clip that must cut on beats rather than a fixed cadence, the Loopable
Video Segmenter is the other half
([`docs/LOOPABLE-VIDEO-SEGMENTER.md`](LOOPABLE-VIDEO-SEGMENTER.md)).

## Open

- `kenburns` applies one motion to the whole set (`--motion`). Alternating
  push-in and pan per frame would read better, and belongs in `plan.mjs` where
  both executors get it.
- No per-image hold list — `--each` is uniform (the plan accepts `durations`
  per image; the CLI does not expose it yet).
- The zoom is linear. Easing is a one-expression change plus a test.
