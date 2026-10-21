# Seamless Loops — V1 Video Template for the Twin's World

> Copy-paste template for **seamless loop clips** (image-to-video,
> V1). These are VIDEO prompts — `--loop`, `--motion`, `--seed` are
> V1/motion params, so they live here, not in the image packs the MJ
> watcher submits. The `--tile` pattern variant below IS an image
> prompt and lives in its own pack.
>
> Drawn from the twin's world: rain platforms, neon, brass corridors,
> singing bowls, lake dusk. All 16:9.

## The template

```
[subject] [cyclic action], seamless loop, repeating motion, ambient, static camera, centered composition, consistent lighting --loop --motion low --ar 16:9 --seed 1234 --no cuts, scene change, morphing, camera movement, text
```

The three rules hiding in the template:

1. **The action must be cyclic** — rain falls, vapor rises, ripples
   expand, signs flicker. Nothing that "finishes" can loop.
2. **Static camera + centered + consistent lighting** — any drift
   becomes a visible seam.
3. **`--no cuts, scene change, morphing, camera movement, text`**
   reinforces the loop contract for the model.

## Generic examples (kept verbatim)

- `koi pond, koi circling slowly, water ripples, petals drifting, seamless loop, static camera, soft light --loop --motion low --ar 16:9 --no cuts, scene change`
- `neon alley in rain, rain falling, puddle ripples, steam drifting, blinking sign, seamless loop, locked camera --loop --motion low --ar 16:9`

## The twin's loop set (all 16:9)

- Rain over the platform puddle, the neon VACANCY glow flickering and reflection rippling as rain falls, seamless loop, static camera, cool teal and copper light --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text
- A singing bowl on dark wood, a thread of vapor rising and dissolving into nothing, its faint shimmer repeating, seamless loop, locked camera, warm key light, chiaroscuro --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text
- A shaft of sodium light over an empty corridor, smoke drifting in slow circles, dust motes orbiting the beam, seamless loop, static camera, deep shadows, new wave noir --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text
- Dark lake water at dusk, slow ripples spreading from the center, a molten reflection column shimmering under a low sun, petals drifting, amber and slate, seamless loop, static camera --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text
- Venetian blind stripes slowly crossing an empty wall as unseen clouds pass, dust hanging in the beams, seamless loop, static camera, cyan and warm mix --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text
- An ink drop falling onto a white page, blooming and drying, the same drop starting again, seamless loop, macro, static camera, warm tungsten, centered --loop --motion low --ar 16:9 --no cuts, scene change, morphing, camera movement, text

## The `--tile` distinction (image-side)

If you want **seamless tile patterns** instead of video loops, the
flags change completely: `--tile` is a Midjourney IMAGE parameter —
flat lighting, symmetrical composition, a repeating motif. Those
prompts live in `assets/mural-prompts/poetic-patterns-tiles.md` and
CAN go through the MJ watcher. 16:9 tiles horizontally; use 1:1 if
you want an equal grid in both directions.