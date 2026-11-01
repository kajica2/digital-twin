# MJ scene presets — reference

23 reusable scene presets for music videos and short
visual stories. Each one is a **scene** (what is in the frame), a **frame**
(where the camera stands and what it names), and a **cut** (how the renderer
turns the still into video).

The registry is canonical: `lib/mj-scene-presets.json`. This doc and the
packs are generated from it — edit the registry, regenerate, do not hand-
edit a prompt here.

## The three rules

**1. The camera's distance is not in the prompt.** Measured across three
series (2026-10-26 → 2026-11-01): a clause naming an *object in the frame*
is obeyed — "the door frame passing close across the edges of the frame"
landed in all four cells of a job — while a clause naming a *distance* is
not. "Wide", "extreme close-up", "seen from behind" did not move the camera:
in edit mode the reference photo's framing wins the distance. So every
preset names what is IN the picture, and the distance is the cut's job.

**2. No preset carries a flag.** `--v 7` was MEASURED soft-banned on this
account (2026-10-26): a job id came back, the job was never queued, the CDN
404'd every size forever. `--v 8.2` is the account's proven engine and lives
in `lib/mj-config.json`. The house style (`--style raw --s 21`) lives there
too — and `buildFullPrompt` drops the config's `--s` when the PROMPT names
a style, so a preset naming one would silently reset stylize to 100.
Reference flags (`--cref`, `--oref`) are refused on this account outright.

**3. The subject's identity is left to the reference photo.** A prompt must
not name the subject's race or ethnicity (`lib/prompt-lint.js`), because the
reference is authoritative and a demographic adjective overrides it.

## Using them

```bash
# the whole registry as a prompt pack
node lib/mj-scene-presets.js --pack

# one group (the pack lands in prompts-inbox/, the watcher renders it)
node lib/mj-scene-presets.js --pack --group vertical

# compose one preset without rendering anything
node lib/mj-scene-presets.js --show neon-night-drive

# the cut recipe for the rendered stills
node lib/mj-scene-presets.js --cut-plan --group vertical
```

### Keeping a set consistent

A set is one look, not twelve pictures. Two things make it so, and they are
the same two things `docs/VIDEO-FRAMING.md` found:

- **A constant clause, written once and repeated verbatim** in every prompt —
  the wardrobe, the texture, the negation. In edit mode the attachment
  out-ranks the prose, so the prose has to lead and deny.
- **One key light per frame**, named the same way every time.

The `--subject` and `--extra-tail` options carry both:

```bash
node lib/mj-scene-presets.js --pack \
  --subject "a man in a dark coat over a black roll-neck" \
  --extra-tail "no denim jacket and no leather jacket and no necklace"
```

## Music-video scene presets (`music-video`)

9 presets.

### Neon Night Drive

**`neon-night-drive`** · `--ar 16:9`

*Best for:* electronic, synthwave, R&B, night-drive anthems

```text
A driver in a dark jacket behind the wheel of a car on a rain-soaked street at night, the windshield beaded with water, neon signs smeared into wet asphalt, a passenger's hand on the gear stick, the camera low beside the front wheel at street level, the door frame passing close across the edges of the picture, the wet road filling the lower third, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `chroma+grain`, whole-cut grade `vignette`, 3s per shot.

### Desert Ritual

**`desert-ritual`** · `--ar 21:9`

*Best for:* cinematic pop, world music, emotional ballads

```text
A lone dancer in flowing white fabric turning slowly in a vast red desert, dust lifting in the air around the hem, long shadows running away from the low sun, the camera low in the sand looking across the dune toward the figure, the ridge line cutting across the frame, warm dust in the air, fine natural film grain, muted palette, no text --ar 21:9
```

*Cut:* crossfade, zoom-out, per-shot `warm+grain`, whole-cut grade `vignette`, 4s per shot.

### Abandoned Warehouse Performance

**`warehouse-performance`** · `--ar 16:9`

*Best for:* rock, hip-hop, dark pop, industrial electronic

```text
A singer standing alone in an abandoned industrial warehouse, one hand lifted off the microphone, dust drifting through the air, the camera at chest height in the middle of the floor facing the singer square on, the steel columns passing close at the edges of the picture, a single hard spotlight from above, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `grain`, whole-cut grade `vignette+grain`, 3s per shot.

### Underwater Dream

**`underwater-dream`** · `--ar 9:16`

*Best for:* ambient, dream pop, emotional storytelling

```text
A woman floating weightless underwater in a flowing dress, her hair drifting upward, bubbles rising past her hands, the camera underwater at the level of her shoulders looking slightly up, shafts of blue sunlight from the surface crossing the frame, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* crossfade, zoom-in, per-shot `blur+grain`, whole-cut grade `cold`, 4s per shot.

### Rainy City Confession

**`rainy-city-confession`** · `--ar 9:16`

*Best for:* sad pop, lo-fi, breakup songs, spoken-word

```text
A person standing under a lit bus shelter during heavy rain at night, arms folded against the cold, water running off the shelter's edge in front of them, the camera on the wet pavement looking up at the shelter, the glass panel passing close across the edges of the picture, blurred city lights behind, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, zoom-in, per-shot `grain+cold`, whole-cut grade `vignette`, 3.5s per shot.

### Rooftop Sunrise

**`rooftop-sunrise`** · `--ar 16:9`

*Best for:* uplifting pop, motivational stories, endings

```text
A person walking toward the edge of a city rooftop at sunrise, their coat moving in the wind, the low sun breaking through the cloud, the camera behind them at shoulder height, the rooftop parapet passing close across the edges of the picture, the city skyline beyond, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-out, per-shot `warm+grain`, whole-cut grade `warm`, 4s per shot.

### Surreal Mirror Room

**`surreal-mirror-room`** · `--ar 16:9`

*Best for:* concept videos, identity themes, alternative music

```text
A person walking through an endless hall of tall mirrors, each pane showing a different version of the same figure, cold white light on the polished floor, the camera directly behind them at head height, the mirror frames passing close across the edges of the picture, one red accent light far down the hall, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `grain`, whole-cut grade `contrast`, 3s per shot.

### Forest Spirit Sequence

**`forest-spirit`** · `--ar 21:9`

*Best for:* folk, fantasy storytelling, acoustic tracks

```text
A hooded figure walking through a misty ancient forest at dawn, glowing fireflies drifting between the trunks, fog lying in the hollows, the camera low among the roots at the edge of the path, the tree trunks passing close across the edges of the picture, deep green and gold in the light, fine natural film grain, muted palette, no text --ar 21:9
```

*Cut:* crossfade, zoom-in, per-shot `blur+grain`, whole-cut grade `vignette`, 4s per shot.

### Vintage Road Trip

**`vintage-road-trip`** · `--ar 16:9`

*Best for:* indie, folk-pop, summer anthems, friendship stories

```text
Two friends in a vintage convertible driving along a coastal highway at sunset, the wind lifting their hair, the sea flashing past the barrier, the camera from the following car at bumper height, the car's tail passing close across the edges of the picture, warm sun flare across the lens, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `warm+grain`, whole-cut grade `vignette`, 3.5s per shot.

## Electronic and pop scene presets (`electronic-pop`)

4 presets.

### High-Energy Street Dance

**`street-dance`** · `--ar 9:16`

*Best for:* hip-hop, drill, dance-pop, fast edits

```text
A street dancer mid-step under a graffiti-covered underpass, one arm swept across the body, a wall of tags behind them, the camera at waist height close to the dancer, the pillar passing close across the edges of the picture, hard red and blue light on the wet ground, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, none, per-shot `chroma+flicker`, whole-cut grade `contrast`, 1.2s per shot.

### Neon Church

**`neon-church`** · `--ar 16:9`

*Best for:* ambient electronica, sacred-geometry, the cool-down

```text
The interior of a disused church where a spiral of coloured bulbs has been threaded through the columns, the whole vault a lattice of light, no pews, bare stone floor, the camera at the back of the nave looking down the aisle, the nearest column passing close across the edges of the picture, dust in the light shafts, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* crossfade, zoom-in, per-shot `chroma+grain`, whole-cut grade `vignette`, 4s per shot.

### Strobe Floor

**`strobe-floor`** · `--ar 9:16`

*Best for:* dance tracks, the drop, the strobe chorus

```text
A packed floor caught at the peak of a strobe flash, every body turned the same way, arms raised, mouths open on the same syllable, the camera at shoulder height inside the crowd, a raised arm passing close across the edges of the picture, hard magenta and cyan against black, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, none, per-shot `flicker+chroma`, whole-cut grade `contrast`, 0.8s per shot.

### Empty Club After

**`empty-club-after`** · `--ar 16:9`

*Best for:* the last chorus, the comedown, the outro

```text
First light outside a club after the party, a few figures sitting on the kerb with their jackets over their shoulders, empty bottles, pale dawn in the sky, the streetlights still burning, the camera on the kerb at the height of the seated figures, the doorway's lit sign passing close across the edges of the picture, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* crossfade, zoom-out, per-shot `cold+grain`, whole-cut grade `cold`, 4.5s per shot.

## Story-video scene presets (`story-video`)

6 presets.

### Mystery Alley

**`mystery-alley`** · `--ar 16:9`

*Best for:* mystery, noir, thriller openings

```text
A detective in a long coat stepping into a foggy alley at midnight, one hand on the wall, a streetlamp flickering above the entrance, the camera at the mouth of the alley looking in, the brickwork passing close across the edges of the picture, the lamp's light failing and returning, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `grain+cold`, whole-cut grade `vignette`, 3.5s per shot.

### Romance Platform

**`romance-platform`** · `--ar 9:16`

*Best for:* romance, longing, the chorus of a love song

```text
Two people reaching toward each other across a crowded train platform, a train arriving behind them, commuters passing between, the camera low at platform level looking along the crowd, the train's lit windows passing close across the edges of the picture, soft golden backlight, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* crossfade, zoom-in, per-shot `warm+grain`, whole-cut grade `warm`, 3.5s per shot.

### Loss

**`loss-childrens-room`** · `--ar 16:9`

*Best for:* grief, absence, the quiet end of a verse

```text
An empty child's bedroom, a curtain moving in the window, an unmade bed with the blanket turned back, the camera in the corner at the height of the bed frame looking across the room, the window curtain passing close across the edges of the picture, pale morning light, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* crossfade, zoom-out, per-shot `grain+cold`, whole-cut grade `cold`, 4.5s per shot.

### Triumph

**`triumph-summit`** · `--ar 16:9`

*Best for:* arrival, victory, the last chorus

```text
An exhausted runner reaching the top of a mountain trail at sunrise, one hand on a fence post, dust and sweat in the air, the camera on the trail below looking up, the fence post passing close across the edges of the picture, the sun coming over the ridge behind, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `warm+grain`, whole-cut grade `warm`, 3.5s per shot.

### Horror Corridor

**`horror-corridor`** · `--ar 16:9`

*Best for:* horror, dread, the turn before the drop

```text
A figure standing motionless at the end of a dim hospital corridor, a gurney pushed against the wall halfway along, the camera low down the corridor looking along it, the gurney passing close across the edges of the picture, one fluorescent tube flickering overhead, fine natural film grain, muted palette, no text --ar 16:9
```

*Cut:* cut, zoom-in, per-shot `grain+cold`, whole-cut grade `vignette+grain`, 4s per shot.

### Sci-Fi Monolith

**`scifi-monolith`** · `--ar 21:9`

*Best for:* sci-fi, scale, the outro

```text
A lone astronaut walking across an alien desert toward a massive black monolith, orange dust blowing sideways across the ground, the camera low behind them at the height of the dust, the monolith's edge passing close across the sides of the picture, twin suns on the horizon, fine natural film grain, muted palette, no text --ar 21:9
```

*Cut:* crossfade, zoom-out, per-shot `warm+grain`, whole-cut grade `vignette`, 4.5s per shot.

## Vertical presets (Reels, TikTok, Shorts) (`vertical`)

4 presets.

### Platform, 4 A.M.

**`platform-four-am`** · `--ar 9:16`

*Best for:* Reels, TikTok, Shorts, the vertical hook

```text
A person sitting alone on a subway platform at four in the morning, a paper cup beside them, one train light sweeping the far wall, the camera at the height of the bench looking along the platform, the tiled wall passing close across the edges of the picture, one fluorescent tube overhead, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, zoom-in, per-shot `grain+cold`, whole-cut grade `vignette`, 3s per shot.

### Phone-Screen Light

**`phone-screen-light`** · `--ar 9:16`

*Best for:* shorts, the vertical chorus, a face lit by a screen

```text
A face lit from below by a phone screen in a dark room, the window behind it a pale rectangle, the camera close to the face at eye level, the phone's light passing close across the edges of the picture, the room around it black, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, zoom-in, per-shot `grain`, whole-cut grade `vignette`, 2.5s per shot.

### Vertical Corridor

**`vertical-corridor`** · `--ar 9:16`

*Best for:* vertical storytelling, a walk, a journey

```text
A figure walking down a narrow corridor lined with closed doors, one light burning at the far end, the camera low behind them looking down the corridor, the door frames passing close across the edges of the picture, the far light small in the middle, fine natural film grain, muted palette, no text --ar 9:16
```

*Cut:* cut, zoom-in, per-shot `grain`, whole-cut grade `vignette+cold`, 3s per shot.

### Square Cover

**`square-cover`** · `--ar 1:1`

*Best for:* album art, cover plates, a looping visualiser

```text
A single figure standing in the middle of a bare room, one light above them, the floor and the ceiling the same colour, the camera square on at the height of the figure's chest, the wall's corner passing close across the edges of the picture, a hard shadow on the floor behind them, fine natural film grain, muted palette, no text --ar 1:1
```

*Cut:* cut, zoom-in, per-shot `grain`, whole-cut grade `contrast+vignette`, 3s per shot.

## The cut vocabulary

The cut recipes use the renderer's own names, so a plan can be handed
straight to `bin/images-to-mp4.mjs`:

| | names |
|---|---|
| motion | `none`, `zoom-in`, `zoom-out`, `pan-left` |
| look (`--fx`, per shot) | `grain`, `grain-heavy`, `vignette`, `chroma`, `vhs`, `smear`, `flicker`, `warm`, `cold`, `blur`, `sharpen`, `contrast` |
| grade (`--grade`, once) | the same names |
| mode | `cut`, `crossfade`, `kenburns` |

A shot stacks looks with `+` (`grain+chroma`). `--grade` is applied ONCE to
the joined cut: a per-shot vignette stacks once per shot, a graded one is one.

### A cut is one aspect ratio

The renderer takes ONE `--size` for a whole cut, so a cut can only be built
from presets that share an aspect ratio — mixing a 1:1 plate into a 16:9
cut means the renderer scales or crops it, and the frame stops being the
frame the prompt asked for. `--ar-filter` selects the subset:

```bash
node lib/mj-scene-presets.js --pack --ar-filter 16:9
node lib/mj-scene-presets.js --cut-plan --ar-filter 16:9
```

## A verified run

MEASURED 2026-11-01, on this account, with the live web backend:

| | |
|---|---|
| prompts rendered | 4 (3 accepted, 1 soft-banned) |
| job types | `v8-2_diffusion`, matched by `feed-command` |
| image size | 1141×640 (16:9), 12 cells written |
| the cut | 1920×1080, 30 fps, 9.0 s, h264 / yuv420p / bt709 / tv |

The grade and the looks were measured in the ENCODE, not assumed — a still
and the frame cut from it differ measurably:

| shot | look | measured |
|---|---|---|
| 1 | `chroma+grain` | U +0.75 with V −0.01 — the RGB split moved one axis |
| 2 | `grain` | luma −9.1 against the still |
| 3 | `warm+grain` | U +2.20 — the warm push, and only the warm shot moved |

| shot | vignette grade | edges vs centre |
|---|---|---|
| 1 | `vignette` | 28.22 vs 54.08 |
| 2 | `vignette` | 22.16 vs 88.90 |
| 3 | `vignette` | 29.90 vs 45.57 |

### The softban

One of the four prompts was soft-banned: the composer accepted it, the job
was never queued, and no image exists. The tool reports it and moves on,
so the other three still shipped.

What soft-bans is NOT: an expired engine. `--v 8.2` is this account's
proven engine and the accepted jobs came back `v8-2_diffusion`. The
refused prompt was the church interior — a scene of a RELIGIOUS building
full of coloured bulbs. That is a content trigger, not a parameter one,
and the house response is to re-word the scene, not to change the flags.

### Choosing one cell per frame

Midjourney returns four cells per prompt and they are four different takes,
not four renditions. The choice is a real decision, and the rule used here
is measurable rather than aesthetic: take the cell whose exposure is
closest to the MEDIAN of the four, and never a blown one (>90 luma).

That picked `0_1`, `0_1`, `0_0` for the three prompts above. The third
prompt's cells ran 65.8 / 93.3 / 100.0 / 98.7 — three of them nearly
clipped, and the rule took the only one with headroom.
