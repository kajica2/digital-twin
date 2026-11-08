# Kišna soba — the series, the reference set, and the tooling

*Kišna soba* is a calm evening animation for preschool children (2–5): Lea,
Niko and the cat Muka solve one small problem before bed, with the rain, the
silence and one shared blanket. The bible lives at
`~/Downloads/Kisna-soba-bible.md`.

This page is the **production reference**: what has been rendered, what the
reference set is, and how to render the next episode.

## The reference set (the consistency system)

`assets/kisna-soba/refs/` holds the sheets, and `refs.json` holds their
**Midjourney URLs** — the URLs are the working part, the pictures are the
record.

| what | job | file |
|---|---|---|
| the style sheet | `75a86176-7c74-4ae6-a04c-451c1098d8f9` | `style.jpg` |
| Lea's sheet | `1bebd671-90f0-4a40-9a2f-5731ce3ff400` | `lea.jpg` |
| Niko's sheet | `f8eacfa4-…` | `niko.jpg` |
| Muka's sheet | `e98f824f-…` | `muka.jpg` |
| the group sheet | `8aa45188-…` | `group.jpg` |
| Zeka the bunny | `b83f8276-…` | `zeka.jpg` |

The rule, unchanged for every episode:

- the **style sheet** goes in every prompt as `--sref <url>`;
- each **character sheet** goes in as `--cref <url> --cw 100` for the
  characters actually in the frame (all three → the group sheet);
- the same negative tail in every prompt: `--no text, watermark, extra
  limbs, photorealism, neon, harsh shadows, busy background`;
- when a frame comes out perfect, keep its `--seed` and reuse it for the
  same shot type.

`tools/apply-refs.mjs` rewrites a pack with exactly that, from `refs.json`:

```bash
node tools/apply-refs.mjs assets/mural-prompts/kisna-soba-ep22-8.md
```

It strips the flags a pack already carries, removes the old style clause
(the reference set owns the look now), and appends the `--sref`, the
`--cref` locks for the characters named in the bullet, and the negative
tail.

## What has been rendered

| set | frames | style | where |
|---|---|---|---|
| Ep. 1 + Ep. 2, from the bible | 12 | the linocut reference (edit route) | `mj-output/kisna-soba-episodes/` |
| "Ne može biti to" (the episode song) | 12 | the linocut reference | `mj-output/ne-moze-biti-to-12/` |
| "Nema me u meni" | 12 | the linocut reference | `mj-output/nema-me-u-meni-12/` |
| Ep. 16-21 | 8 each | the reference set (`--sref` + `--cref`) | `mj-output/kisna-ep16…21/` |

**Two looks, on purpose.** The first three sets are **edits of the linocut
still** (`assets/kisna-soba/reference-linocut.png`) — the edit route carries
the room, the three faces and the print texture exactly, and the bible's
first episodes were written for it. The reference set is the *other* route:
a style sheet plus character sheets, which is what the guide describes and
what the later episodes use. Re-rendering the earlier sets in the reference
style is a flag change, not a new idea: apply the refs, run the pack.

## The packs

`assets/mural-prompts/`:

- `kisna-soba-episodes-12.md` — the bible's Ep. 1 and Ep. 2, twelve frames.
- `ne-moze-biti-to-12.md` — the episode song ("Ne može biti to!").
- `nema-me-u-meni-12.md` — "Nema me u meni".
- `kisna-soba-refs-6.md` — the style sheet and the five reference sheets.
- `kisna-soba-ep16-8.md` … `ep21-8.md` — eight frames each, the words the
  children say kept inside the prompt (between quotation marks) and
  `--no text` so nothing is painted on the frame.

The lyric lines live in the **blockquotes** under each bullet, which the
parser skips: only the bullet is submitted.

## Rendering

```bash
# one episode
node lib/mj-web.js --prompt-file assets/mural-prompts/kisna-soba-ep16-8.md \
    --output mj-output/kisna-ep16 --port 9452 --user-data-dir /tmp/mj-ep16-profile

# the cells
node lib/mj-download.js --dir mj-output/kisna-ep16 --port 9452

# the sheet, to look at
node lib/mj-contact-sheet.js --pack kisna-ep16 --title "Kišna soba — Ep. 16" --port 9452

# the cut
node bin/images-to-mp4.mjs "$PWD/mj-output/kisna-ep16/frames" \
    --mode kenburns --each 5 --size 1920x1080 \
    --motions zoom-in,zoom-in,pan-left,zoom-in,zoom-out,zoom-in,zoom-in,zoom-out \
    --grade vignette --out "$PWD/mj-output/kisna-ep16/ep16-cut.mp4"
```

**Pick the cell by eye, not by default.** The sheet shows cell 0 of every
frame; a frame whose brief asked for something the cell 0 did not have
(Muka in the middle of the blanket, a lamp going off) usually has it in
another cell. The thumbnail of Ep. 1 is cell 1 of frame 01 — cell 0 has no
cat in it.

## The music

The songs are generated locally by **HeartMuLa** (Apache-2.0, code and
weights) — see `docs/HEARTMULA.md`:

```bash
npm run heartmula:generate -- --lyrics lib/heartmula/assets/lyrics/ne-moze-biti-to.txt \
    --tags "soft funk, sleepy, flugelhorn, brushed drums" --seconds 90 \
    --out data/heartmula/ne-moze-biti-to.mp3 --codec-device cpu
```

The clips are cut from the frames; the audio is mixed in afterwards (the
twin's `heartmula-mix` time-matches a reference drum track to the song
before summing them).
