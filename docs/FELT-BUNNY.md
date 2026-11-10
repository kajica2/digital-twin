# Felt Bunny — the 2-frame story

> 2 frames · a needle-felted wool rabbit · the plain light backdrop of a toy studio

---

## The source

**Job.** `aeebaf75-ceb3-47d9-8249-87ede8f2ea30` index 2 (cell `0_2`)

**Anchor.** `https://cdn.midjourney.com/aeebaf75-ceb3-47d9-8249-87ede8f2ea30/0_2.webp`

**The source job's own prompt.** An adorable chibi rabbit protagonist handcrafted from needle-felted wool. An oversized round head, plump cheeks, a very short muzzle, a tiny button nose, widely spaced round dark eyes and a gentle little smile. A compact, chubby body with short arms and legs, tiny rounded paws and soft ears with rounded tips. Sweet, innocent and huggable. Dense fine wool fibres, velvety fuzzy edges and a soft matte surface. An original, imaginative outfit and accessories that express the character's personality. A cozy children's storybook toy aesthetic. Full-body view, ears and feet fully visible, natural standing pose, simple light background, soft diffused lighting, clearly visible wool texture.

**The source job's own flags.** `--ar 2:3` — 896x1344 native (0_2.webp) — 2:3, standard resolution, not --hd

---

## The composition

**Concept.** A story in two frames. The bunny stands alone on the pale floor with nothing in its paws, and then the small folded paper boat is in its paws and the light has warmed. Nothing happens between the frames that is not on screen: the boat arrives and the rabbit looks at it.

**Visual DNA.** cozy children's storybook toy aesthetic, soft matte felt surface, plain pale cream backdrop, gentle even light

**Identity clause.** no clothing and no accessories and no scarf and no hat and no clothes of any kind, bare cream wool

**Flags.** `--edit https://cdn.midjourney.com/aeebaf75-ceb3-47d9-8249-87ede8f2ea30/0_2.webp --v 8.2 --ar 2:3`

---

## The frames

### 01 — ALONE — nothing in its paws

*The change:* the setup — the bunny is on its own, and its paws are empty

On a pale cream paper floor, a small chibi rabbit handcrafted from needle-felted wool stands alone

with its tiny rounded paws resting empty at its sides and its soft ears standing upright

*Camera:* seen from the rabbit's own height, straight on, the pale floor filling the lower third of the picture, plain light backdrop behind

*Light:* one cool soft daylight from the left

*Picked cell:* `0_3` — the 4-up grid is four different
takes. Measurement screens (median luma, nothing blown); the eye
decides on content.

*Why this one:* front-facing, both ears up, its paws visibly EMPTY at its sides.

```
On a pale cream paper floor, a small chibi rabbit handcrafted from needle-felted wool stands alone, with its tiny rounded paws resting empty at its sides and its soft ears standing upright, dense fine wool fibres with velvety fuzzy edges and a soft matte surface, an oversized round head, plump cheeks, a very short muzzle, a tiny button nose, widely spaced round dark eyes and a gentle little smile, a compact chubby body with short arms and legs, tiny rounded paws and soft ears with rounded tips, seen from the rabbit's own height, straight on, the pale floor filling the lower third of the picture, plain light backdrop behind, one cool soft daylight from the left, cozy children's storybook toy aesthetic, soft matte felt surface, plain pale cream backdrop, gentle even light, no clothing and no accessories and no scarf and no hat and no clothes of any kind, bare cream wool, no text, no lettering, no watermark --edit https://cdn.midjourney.com/aeebaf75-ceb3-47d9-8249-87ede8f2ea30/0_2.webp --v 8.2 --ar 2:3
```

### 02 — THE BOAT — the paper boat, and warmer light

*The change:* the turn — the boat has arrived in its paws and the light has warmed

Holding a small folded paper boat at chest height, a small chibi rabbit handcrafted from needle-felted wool stands

with both tiny rounded paws around the boat and its soft ears tipped forward toward it

*Camera:* seen from the rabbit's own height, straight on, the pale floor filling the lower third of the picture, plain light backdrop behind

*Light:* one warm daylight from the left

*Picked cell:* `0_2` — the 4-up grid is four different
takes. Measurement screens (median luma, nothing blown); the eye
decides on content.

*Why this one:* the boat clearly folded at chest height, both paws around it, the light warmer.

```
Holding a small folded paper boat at chest height, a small chibi rabbit handcrafted from needle-felted wool stands, with both tiny rounded paws around the boat and its soft ears tipped forward toward it, dense fine wool fibres with velvety fuzzy edges and a soft matte surface, an oversized round head, plump cheeks, a very short muzzle, a tiny button nose, widely spaced round dark eyes and a gentle little smile, a compact chubby body with short arms and legs, tiny rounded paws and soft ears with rounded tips, seen from the rabbit's own height, straight on, the pale floor filling the lower third of the picture, plain light backdrop behind, one warm daylight from the left, cozy children's storybook toy aesthetic, soft matte felt surface, plain pale cream backdrop, gentle even light, no clothing and no accessories and no scarf and no hat and no clothes of any kind, bare cream wool, no text, no lettering, no watermark --edit https://cdn.midjourney.com/aeebaf75-ceb3-47d9-8249-87ede8f2ea30/0_2.webp --v 8.2 --ar 2:3
```

---

## Rendering it

The pack carries its own complete suffix, so it composes with NO
defaults — the config's master suffix would otherwise append the
master's prose and the master's `--edit` anchor to it:

```bash
node lib/mj-web.js --prompt-file assets/mural-prompts/felt-bunny.md \
    --all-prompts --defaults '' --output mj-output/felt-bunny
```

`--defaults ''` is empty on purpose. The config's master suffix ends
with `--edit https://s.mj.run/3Hv2HR2n3Zs` — the artist's own identity
anchor — and Midjourney honours the LAST of a duplicated flag, so
without the override the master's anchor would replace this story's.

Both frames come back as `v8-2_edit_diffusion` jobs (the anchor rides
as `--edit`), at 2:3, four cells each.

---

## The release

`assets/releases/felt-bunny/` holds the two frames as JPG (native
896x1344), the contact sheet, and the manifest. The MP4 is
gitignored, so the cut is built on demand:

```bash
node bin/images-to-mp4.mjs assets/releases/felt-bunny/frames/01.jpg \
    assets/releases/felt-bunny/frames/02.jpg \
    --out assets/releases/felt-bunny/felt-bunny-cut.mp4 \
    --mode cut --size 896x1344 --each 3
```

Two shots, three seconds each, hard cut between them: the bunny
stands alone, and then the boat is in its paws.
