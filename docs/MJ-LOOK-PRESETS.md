# MJ Look Presets

> 30 film, video-tape and emulation looks · one anchor subject · a comparison sheet

**Anchor subject.** A man in a dark overcoat stands alone in a bare room beside a single window, a wooden chair in the middle of the floor, dust in the air

**Why one subject.** Every look renders the same scene, so any
difference between two cells is the look's doing. The subject is
deliberately plain — no neon sign for the neon preset to borrow,
no wet street for the rain look — so a look cannot be credited for
the scene it happened to be handed.

Each prompt opens with its own short phrase for the same scene,
because a shared prefix collapses the acceptance matcher's excerpt
and N prompts get attributed to a few task ids.

**Flags.** `--style raw --s 21 --ar 16:9`

**Suffix.** no text

**The rendered set.** All thirty were rendered from the same anchor subject, so
any difference between two frames is the LOOK's doing. The comparison sheet is
`mj-output/mj-look-presets-sheet/look-sheet-30up.png` — one chosen cell per look,
captioned with the look's name, its group, the cell and its measured luma.

---

## The looks

| # | look | family |
|---|------|--------|
| 01 | Analog Noir 1970s European Arthouse | film-analog |
| 02 | VHS Glitch Noir 1980s | video-tape |
| 03 | B&W 16mm Grunge 1990s | film-analog |
| 04 | French New Wave 1960s | film-analog |
| 05 | Italian Giallo 1970s | film-analog |
| 06 | Neon Noir 1980s | film-analog |
| 07 | Dogme 95 | digital-documentary |
| 08 | Digital Lo-Fi 2000s | digital-video |
| 09 | British Kitchen Sink 1960s | film-analog |
| 10 | American New Hollywood 1970s | film-analog |
| 11 | Soviet Post-Punk 1980s | film-analog |
| 12 | Super 8 Memory | film-analog |
| 13 | Betacam Newsraw | video-tape |
| 14 | MiniDV Y2K | digital-video |
| 15 | CCTV Surveillance | surveillance |
| 16 | Thermal / Infrared | surveillance |
| 17 | Bleach Bypass War | film-analog |
| 18 | Cross-Process Crush | film-analog |
| 19 | Expired Polaroid | film-analog |
| 20 | Technicolor Melodrama | film-analog |
| 21 | Film Noir 1940s | film-analog |
| 22 | German Expressionist | film-analog |
| 23 | Brutalist Concrete | film-analog |
| 24 | Desert Mirage | film-analog |
| 25 | Rain-Soaked City | film-analog |
| 26 | Warehouse Rave | digital-video |
| 27 | Rooftop Dawn | film-analog |
| 28 | Club Toilet Realism | digital-documentary |
| 29 | Pastoral Overcast | film-analog |
| 30 | Tape Loop / Feedback | video-tape |

---

## The prompts

### 01 — Analog Noir 1970s European Arthouse

*film-analog*

faded Kodak 500T, tobacco browns and dirty teal, nicotine yellow and winter gray, soft halation, analog grain, 35mm anamorphic, documentary realism

```
A man in a dark overcoat stands alone in a bare room, beside a single window, a wooden chair in the middle of the floor, dust in the air, faded Kodak 500T, tobacco browns and dirty teal, nicotine yellow and winter gray, soft halation, analog grain, 35mm anamorphic, documentary realism, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 66.6

### 02 — VHS Glitch Noir 1980s

*video-tape*

degraded VHS tape, scanlines, chroma noise, a burnt-in timestamp, neon bleed, tracking errors, soft analog smear

```
In a bare room, a window throws one pale rectangle of light, a wooden chair in the middle of the floor, dust in the air, degraded VHS tape, scanlines, chroma noise, a burnt-in timestamp, neon bleed, tracking errors, soft analog smear, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 50.7

### 03 — B&W 16mm Grunge 1990s

*film-analog*

high-contrast black and white, heavy 16mm grain, handheld framing, available natural light, blown highlights and blocked shadows

```
A wooden chair stands alone in the middle of an empty floor, beside a single window, dust in the air, high-contrast black and white, heavy 16mm grain, handheld framing, available natural light, blown highlights and blocked shadows, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 55.6

### 04 — French New Wave 1960s

*film-analog*

handheld 16mm, jump-cut framing, available natural light, faded black and white or washed-out color, informal snapshot composition

```
Dust hangs in the air of a bare room, beside a single window, a wooden chair in the middle of the floor, handheld 16mm, jump-cut framing, available natural light, faded black and white or washed-out color, informal snapshot composition, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 80.9

### 05 — Italian Giallo 1970s

*film-analog*

saturated color, deep stylized shadows, colored gel lighting, wide-angle lens, lurid 70s thriller palette

```
One man, one room, one chair, and a single window, dust in the air, saturated color, deep stylized shadows, colored gel lighting, wide-angle lens, lurid 70s thriller palette, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 62.9

### 06 — Neon Noir 1980s

*film-analog*

rain-slicked street, magenta and cyan neon, thick fog, horizontal anamorphic flares, glossy black reflections

```
A man in a dark overcoat waits beside a window, a wooden chair in the middle of the floor, dust in the air, rain-slicked street, magenta and cyan neon, thick fog, horizontal anamorphic flares, glossy black reflections, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 69.2

### 07 — Dogme 95

*digital-documentary*

available natural light only, handheld camera, desaturated muted color, unstyled and raw, no artificial lighting

```
A chair sits in the middle of a bare room, unoccupied, beside a single window, dust in the air, available natural light only, handheld camera, desaturated muted color, unstyled and raw, no artificial lighting, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 61.4

### 08 — Digital Lo-Fi 2000s

*digital-video*

webcam and MiniDV quality, blocky pixelation, compression artifacts, flat unflattering light, low resolution

```
Pale window light falls across a dusty empty room, a wooden chair in the middle of the floor, webcam and MiniDV quality, blocky pixelation, compression artifacts, flat unflattering light, low resolution, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 89.0

### 09 — British Kitchen Sink 1960s

*film-analog*

social realism, black and white, flat overcast light, cramped 16mm framing of ordinary rooms

```
A figure in a dark coat stands at the edge of a window's light, a wooden chair in the middle of the floor, dust in the air, social realism, black and white, flat overcast light, cramped 16mm framing of ordinary rooms, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 68.2

### 10 — American New Hollywood 1970s

*film-analog*

grainy color, long lenses, muted warm tones, 35mm anamorphic, golden late-afternoon light

```
An empty room with a chair and a tall window, dust in the air, grainy color, long lenses, muted warm tones, 35mm anamorphic, golden late-afternoon light, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 65.1

### 11 — Soviet Post-Punk 1980s

*film-analog*

bleak industrial gray, cold blue-green colors, brutalist concrete, wide distant shots, coarse grain

```
A tall window and a standing man in a bare room, a wooden chair in the middle of the floor, dust in the air, bleak industrial gray, cold blue-green colors, brutalist concrete, wide distant shots, coarse grain, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_3` · luma 82.0

### 12 — Super 8 Memory

*film-analog*

small-gauge home movie, soft focus, warm faded color, gate weave, light leaks across the frame

```
Dust drifts through the light from a single window, A man in a dark overcoat stands alone in a bare room, a wooden chair in the middle of the floor, small-gauge home movie, soft focus, warm faded color, gate weave, light leaks across the frame, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 71.2

### 13 — Betacam Newsraw

*video-tape*

80s and 90s broadcast ENG tape, low contrast, chroma bleed, harsh on-camera zoom, visible tape noise

```
A man in a dark overcoat waits in the half-lit space beside a window in a bare room, a wooden chair in the middle of the floor, dust in the air, 80s and 90s broadcast ENG tape, low contrast, chroma bleed, harsh on-camera zoom, visible tape noise, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 63.0

### 14 — MiniDV Y2K

*digital-video*

early consumer digital video, 4:3 frame, hard sharp edges, compression blocking, on-camera flash

```
A wooden chair stands in front of a bare wall, beside a single window, dust in the air, early consumer digital video, 4:3 frame, hard sharp edges, compression blocking, on-camera flash, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 73.3

### 15 — CCTV Surveillance

*surveillance*

fixed high-angle surveillance view, burnt-in timecode, infrared green monochrome, very wide lens, motion ghosting

```
A wide bare room with one man at its far side, beside a single window, a wooden chair in the middle of the floor, dust in the air, fixed high-angle surveillance view, burnt-in timecode, infrared green monochrome, very wide lens, motion ghosting, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 73.7

### 16 — Thermal / Infrared

*surveillance*

false-color thermal imaging, heat bloom around the body, stark silhouettes, surveillance aesthetic

```
A dim room, a chair, and the grey rectangle of a window, dust in the air, false-color thermal imaging, heat bloom around the body, stark silhouettes, surveillance aesthetic, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 41.4

### 17 — Bleach Bypass War

*film-analog*

desaturated silver, crushed blacks, harsh contrast, gritty 35mm war photography

```
One figure in a dark coat beside a chair and a single window, dust in the air, desaturated silver, crushed blacks, harsh contrast, gritty 35mm war photography, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 65.2

### 18 — Cross-Process Crush

*film-analog*

shifted cyan and magenta, blown highlights, expired film color, chemical color cast

```
A bare room seen past the shoulder of a dark coat, beside a single window, a wooden chair in the middle of the floor, dust in the air, shifted cyan and magenta, blown highlights, expired film color, chemical color cast, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 78.8

### 19 — Expired Polaroid

*film-analog*

instant film with its white borders, soft rounded edges, chemical stains, low contrast, faded uneven color

```
A man in a long dark coat, seen from the side of the chair, beside a single window, dust in the air, instant film with its white borders, soft rounded edges, chemical stains, low contrast, faded uneven color, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_3` · luma 111.0

> **Every cell is blown.** The measurement screen found no cell under the
> 90-luma ceiling, so the sheet shows the LEAST-blown one. For this look
> an overexposed frame IS the look — the medium is meant to be hot.

### 20 — Technicolor Melodrama

*film-analog*

saturated primaries, glossy studio lighting, soft focus, rich 35mm Technicolor color

```
A chair and a figure in a room with one small window, dust in the air, saturated primaries, glossy studio lighting, soft focus, rich 35mm Technicolor color, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 64.9

### 21 — Film Noir 1940s

*film-analog*

hard key light, venetian blind shadows across the wall, black and white, 35mm, smoke in the air

```
A tall window, and a man in a dark overcoat standing with his back to it in a bare room, a wooden chair in the middle of the floor, dust in the air, hard key light, venetian blind shadows across the wall, black and white, 35mm, smoke in the air, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 86.2

### 22 — German Expressionist

*film-analog*

distorted stage sets, hard angular shadows, tilted camera angles, black and white, stark chiaroscuro

```
A single window in a bare wall, and a man in a dark overcoat beneath it, a wooden chair in the middle of the floor, dust in the air, distorted stage sets, hard angular shadows, tilted camera angles, black and white, stark chiaroscuro, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 48.1

### 23 — Brutalist Concrete

*film-analog*

gray palette, wide-angle lens, flat overcast sky, raw concrete textures, 35mm

```
A dusty room, a chair, and one man in a long coat, beside a single window, gray palette, wide-angle lens, flat overcast sky, raw concrete textures, 35mm, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 71.8

### 24 — Desert Mirage

*film-analog*

heat haze rippling above pale sand, bleached color, long lens compression, slow drifting dust

```
A figure waits beside a window in an otherwise empty room, a wooden chair in the middle of the floor, dust in the air, heat haze rippling above pale sand, bleached color, long lens compression, slow drifting dust, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 95.9

> **Every cell is blown.** The measurement screen found no cell under the
> 90-luma ceiling, so the sheet shows the LEAST-blown one. For this look
> an overexposed frame IS the look — the medium is meant to be hot.

### 25 — Rain-Soaked City

*film-analog*

wet black asphalt, umbrella lights reflected in the road, muted teal and orange, anamorphic

```
A man in a dark overcoat, and the chair behind him, beside a single window, dust in the air, wet black asphalt, umbrella lights reflected in the road, muted teal and orange, anamorphic, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 37.3

### 26 — Warehouse Rave

*digital-video*

strobe flash, heavy haze, hard backlight, wide lens, heavy motion blur

```
The chair is empty, the window is not, A man in a dark overcoat stands alone in a bare room, dust in the air, strobe flash, heavy haze, hard backlight, wide lens, heavy motion blur, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_0` · luma 67.0

### 27 — Rooftop Dawn

*film-analog*

soft gray dawn light, a silhouette against the sky, long lens, grain, a slow reveal

```
A man stands in a bare room as the light changes, beside a single window, a wooden chair in the middle of the floor, dust in the air, soft gray dawn light, a silhouette against the sky, long lens, grain, a slow reveal, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 49.7

### 28 — Club Toilet Realism

*digital-documentary*

harsh fluorescent green, flash photography, cramped composition, raw unflattering documentary realism

```
A window and a chair and a man, all in a bare room, dust in the air, harsh fluorescent green, flash photography, cramped composition, raw unflattering documentary realism, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 60.1

### 29 — Pastoral Overcast

*film-analog*

soft gray fields, muted green, available natural light, 16mm, unhurried and still

```
A lone figure in a long coat, in a room with nothing else, beside a single window, a wooden chair in the middle of the floor, dust in the air, soft gray fields, muted green, available natural light, 16mm, unhurried and still, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_2` · luma 85.7

### 30 — Tape Loop / Feedback

*video-tape*

analog video feedback, scanlines, color bars, repeating glitch loops, analog tracking noise

```
A man, a chair and a window in a bare room, dust in the air, analog video feedback, scanlines, color bars, repeating glitch loops, analog tracking noise, no text --style raw --s 21 --ar 16:9
```

**Picked cell.** `0_1` · luma 75.2

