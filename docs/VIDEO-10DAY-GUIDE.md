# 10-Day Video Practice — Midjourney V1 Image-to-Video Guide

> **Subject:** a 10-day daily practice for learning Midjourney V1 Video
> (image-to-clip, ~5s). Each day pairs a **source frame** (generated as
> a Midjourney image) with a **video prompt** (pasted into V1 with the
> motion setting you want).
>
> **Two files, deliberately separate:**
>
> - **This doc** — the *video* prompts (with `--motion` tags), the
>   pairing rules, and the tuning notes. Human reference only.
> - **`assets/mural-prompts/source-frames-10days.md`** — the ten
>   *source-frame image* prompts, ready for the MJ watcher. They are
>   image prompts only: **no `--motion` flags ever enter that file** —
>   `--motion` is a V1 parameter, and feeding it to the image pipeline
>   would pollute the submissions.
>
> Workflow per day: render the source frame (image pack), then paste
> the same day's video prompt into V1 with the source frame as the
> start image.

---

## Day 1 — Macro / Organic

**Video:** extreme close-up tracking slowly across wet leaves after rain, water droplets catching light. A single ant crosses frame at the end. Atmosphere: still, humid, alive. Style: macro photography, soft natural light, 100mm macro lens, shallow depth of field. `--ar 16:9 --motion medium`

*Why it works:* tight subject + clear motion direction + a small payoff at the end. Good warm-up for organic surfaces.

**Source frame (image):** see pack Day 1. Tune: keep the ant small and slightly off-center-left — lateral tracking reads better with "room" to push into.

---

## Day 2 — Architectural / Geometric

**Video:** slow push-in through a brutalist concrete corridor, parallel lines converging, dust catching a hard sidelight. A single figure walks toward camera in the deep background, scale crushing. Atmosphere: cold, monumental, quiet. Style: shot on 35mm, anamorphic flare, desaturated palette, golden hour into blue hour. `--ar 16:9 --motion low`

*Why it works:* built environment + lens reference anchors V1; the deep-background figure gives it a foreground/background plane.

**Source frame (image):** see pack Day 2. Tune: figure small enough that V1 has "space" to render the push-in — let the architecture lead.

---

## Day 3 — Portrait / Human

**Video:** locked-off medium close-up of a person at a kitchen table, late afternoon. They lift a coffee cup, take a slow sip, set it down, look past camera out a window. Eyes catch the light. Atmosphere: tired, tender, ordinary. Style: Kodak Portra 400, natural light, 50mm lens, slight grain, 4:3 frame. `--ar 4:3 --motion low`

*Why it works:* V1 is good at one human action + one emotion; the "look past camera" beat is where the clip breathes. One gesture only.

**Source frame (image):** see pack Day 3. Tune: the gaze-past-camera must already be in the still — V1 animates *from* the gaze, not toward it.

---

## Day 4 — Material / Texture

**Video:** tight handheld close-up of a hand slowly peeling the backing off a vintage film poster. Paper fibers visible. A small tear runs. Dust falls in slow-motion light. Atmosphere: tactile, intimate, archival. Style: macro detail, warm tungsten light, 60mm lens, shallow DOF, slight 16mm grain. `--ar 16:9 --motion medium`

*Why it works:* paper/dust/fiber give V1 something it can actually deform; the hand gives the clip a protagonist.

**Source frame (image):** see pack Day 4. Tune: hands at "just about to peel," not mid-peel — the video's motion *is* the peel.

---

## Day 5 — Landscape / Epic

**Video:** slow lateral tracking across a salt flat at golden hour, low to the ground. Mirrored sky in shallow water; a single horse walks left-to-right in the distance. Atmosphere: vast, still, mythic. Style: anamorphic widescreen, 35mm, warm palette, dust haze, slight lens bloom. `--ar 21:9 --motion low`

*Why it works:* lateral motion + clear horizon + small moving subject = a shot V1 can complete without hallucinating geography. 21:9 forces cinematic.

**Source frame (image):** see pack Day 5. Tune: horse already **mid-stride** (legs apart) — a standing horse gets "frozen."

---

## Day 6 — Surreal / Dream

**Video:** slow orbit around a porcelain teacup floating mid-room in dark wood panelling. The room tilts subtly. A faint steam trail becomes small birds drifting upward. Atmosphere: uncanny, soft, dreamlike. Style: painted surrealism meets cinematography, chiaroscuro, soft lens diffusion, painterly grain. `--ar 1:1 --motion medium`

*Why it works:* impossible physics grounded in a real surface (porcelain, wood); the orbiting camera stops V1 "fixing" the spatial logic. 1:1 forces different composition.

**Source frame (image):** see pack Day 6. Tune: steam barely there — a single wisp, so V1 can "grow" it into birds. Heavy steam = V1 doesn't know what to do.

---

## Day 7 — Documentary / Observational

**Video:** handheld observer walking through a wet market stall at dawn. Vendor hands arrange fruit in the foreground; steam from a noodle cart drifts left. Atmosphere: working, alive, unsentimental. Style: newsreel 16mm, available light, 28mm wide, slight grain, desaturated, on-camera-mic vibe. `--ar 16:9 --motion high`

*Why it works:* "documentary" + handheld + wide lens → messier, more lifelike motion; high motion lets it improvise hands/steam details.

**Source frame (image):** see pack Day 7. Tune: visible hands-blur in the still — V1 preserves "in motion" from blur; a sharp still snaps to stillness.

---

## Day 8 — Night / Low-key

**Video:** locked-off wide of a single motel parking lot at night. A neon "VACANCY" sign flickers, buzzing. A car slowly pulls in, headlights sweep the wall, engine cuts, silence implied. Atmosphere: lonely, Americana, humid. Style: cinematic noir, anamorphic, deep blacks, sodium-vapor cast, film grain. `--ar 2.39:1 --motion low`

*Why it works:* night + neon + one vehicle = a contained "event" V1 can hold for 5s; locked-off prevents drift.

**Source frame (image):** see pack Day 8. Tune: lot **empty of cars** (the car is the motion); sign slightly flickering (neon blur) gives permission to keep flickering.

---

## Day 9 — Kinetic / Energetic

**Video:** handheld low-angle fisheye following a skateboarder through a sunlit underpass. Concrete pillars blur past. The skater pops an ollie, lands, rolls away. Atmosphere: hot, fast, summer. Style: 90s skate video, super 8 transferred to video, oversaturated, sun-flare, 16mm grain, fisheye distortion. `--ar 16:9 --motion high`

*Why it works:* a clear physical action (ollie) + a recognizable style anchor (90s skate) → controlled chaos.

**Source frame (image):** see pack Day 9. Tune: ollie already **in progress** (board off ground, body airborne); say fisheye explicitly or V1 defaults to rectilinear.

---

## Day 10 — Still Life / Quiet

**Video:** locked-off, slowly drifting closer to a table set for one. A glass of red wine catches window light; a half-read paperback rests open; a candle flickers once. Atmosphere: contemplative, after-someone-left, warm. Style: Dutch still-life painting meets cinematography, painterly chiaroscuro, 50mm, very shallow DOF, soft grain. `--ar 4:3 --motion low`

*Why it works:* stillness + one micro-event (the flicker) + rich material surface. 4:3 forces compositional weight. Quiet close to the cycle.

**Source frame (image):** see pack Day 10. Tune: candle **unlit** in the still — V1 animates the flicker on first lighting; an already-lit candle reads as steady state and loses the flicker.

---

## Pairing rules (hold across all 10)

1. **The still contains the start of motion, never the middle or end.** Mid-ollie, hand-just-touching-peel, mid-stride horse. A completed action leaves V1 nothing to animate *from*.
2. **Composition anticipates direction.** Video tracks right → subject sits slightly left. Video pushes in → subject small in frame. V1 honors negative space — use it.
3. **Style language must match image ↔ video.** "Kodak Portra 400" in the still needs "Kodak Portra 400" in the video prompt. Mixed styles break the pair.
4. **Aspect ratios must match.** Don't render the still 16:9 and ask for 9:16 — V1 crops or distorts.

## Motion setting cheat-sheet

| Setting | Use for |
|---|---|
| `low` | subtle drift, atmosphere (2, 3, 5, 8, 10) |
| `medium` | readable camera move + subject action (1, 4, 6) |
| `high` | handheld / kinetic / documentary (7, 9) |

When in doubt, go **one step lower** than you think.

## V1 prompt structure notes

- `Camera:` as the first word is the most reliable way to commit V1 to a motion type instead of improvising (all ten above obey this).
- **One style anchor** (one film stock or one lens) is enough; stacking three references muddies the result.
- **Name one person, one object, one place.** A single protagonist beats a scene description.
- **Avoid:** complex choreography, multiple characters with dialogue, continuity between two events.