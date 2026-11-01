# Video framing — how a lyric becomes a shot

> The method this repo uses to turn a lyric into a Midjourney pack, and
> the five ways to make video out of one frame.
>
> Written 2026-11-01 after the `Get Into The Beat` / `Till You Get The
> Light` sets, where the packs specified *what* was in the frame and left
> the video-making decisions implicit. The gap showed up in the cuts:
> twelve correct stills, assembled by one person guessing.

---

## 1. The translation ladder

One line of the lyric is one frame. Getting from the line to the prompt
is six steps, and each one has burned a generation somewhere.

### Step 0 — the beat

The lyric's line units become the frames. A twelve-frame set is twelve
beats; a four-frame set is four. If the lyric has a section that repeats
(a chorus), the set repeats it — the same beat rendered again is a
legitimate shot, not a duplicate.

### Step 1 — the gesture

**The lyric is abstract. Midjourney is literal.** "Back, back, back" is
not a frame; a man retracing a corridor is. The translation is not to
illustrate the line but to find the *physical event that carries it*:

| lyric | gesture to shoot |
|---|---|
| sometimes it's hard to do | a foot lifted over a kerb, not hovering |
| back, back, back | a corridor walked twice, the same doors behind him |
| tap, par, pa, par, par | knuckles on a painted door |
| get the light, give it time | a match struck in the dark |
| you'll be home | a lit doorway seen from a cold street |
| every body needs somebody | two figures at a door, one turning away |

If you cannot name the gesture, the line is not ready for a frame — it
is a line for the cut (see approach D), not for a picture.

### Step 2 — the camera's place

**This is the step the old packs skipped, and it is the biggest lever
there is.** Every frame should name where the camera is standing and how
far it is:

- **distance** — "wide", "medium", "extreme close-up"
- **lens/angle** — "the camera at chest height", "from the low corner",
  "seen from behind"
- **height** — "low to the floor", "from above"

Two frames of the same subject in the same room are different shots
because of where the camera is, not because of what is in them.

**What the camera cannot move (measured, 2026-10-26 → 2026-10-27):**
distance and subject height are the reference photo's decision in edit
mode — a chest-height selfie keeps winning, whatever the prose says.
What *does* move: the camera's own height and angle, a 2-D transform
(roll, dutch tilt), the light, and the framing's edges. So write the
camera's **place and attitude**, not a focal length and not a distance
you have to hope for.

### Step 3 — one light, one direction

Name the single key light and where it comes from: "one streetlamp
burning far down the road", "a warm lamp low to the left", "the room's
light flaring across the wet road". Two lights muddy the read; the
frame's whole job is often that one source.

### Step 4 — the constant identity clause

Write the wardrobe once and repeat it in every bullet, verbatim. Only
the moment clause changes between frames. Two reasons: in edit mode the
attachment out-ranks prose, so the prose has to lead and deny; and a set
whose wardrobe clause is constant reads as one film rather than twelve
pictures.

The shape that has worked all year:

```
a man in a dark coat over a black roll-neck <moment>, no denim jacket and
no leather jacket and no necklace, shaved very short haircut, fine
natural film grain, muted palette, no text
```

### Step 5 — the texture and the negation

The tail (`fine natural film grain, muted palette, no text`) is the
house look; the negations are there because the reference photograph
carries a denim jacket, a leather jacket and a cord necklace, and in edit
mode the attachment beats the prose.

---

## 2. Six rules, each with the failure behind it

1. **One change per frame.** Two new ideas in one bullet means MJ
   picks one and you cannot tell which.
2. **Name a physical event, not a mood.** "Abstract, dreamy" renders
   mush; "dozens of clock faces in broken mirror shards" renders an image
   you can cut to.
3. **Distance is the reference's decision.** Ask for the camera's place,
   not the shot size (measured across three series, 2026-10-26/27).
4. **Keep the identity clause constant.** It is the difference between a
   set and a folder.
5. **One key light per frame.** The frame's job is often that source.
6. **Let the cut do what the still cannot.** Motion, look, grade and
   rhythm are the renderer's job (`bin/images-to-mp4.mjs`), not the
   prompt's.

---

## 3. Five approaches to video making

The same frame can be made five ways. Each is a different *film*, and
each changes the prompt and the cut in a different place.

### A · The literal cut — classical continuity

*Establish → medium → close, matched on the action.*

- **Prompt:** the camera where an operator would stand — "at chest
  height in the street facing him square on" — and one legible action.
- **Cut:** `--mode cut`, hard cuts, 2.5–4 s per shot, motion matched to
  the action (a push-in for approach, a pan for travel).
- **Use it** when the story is the action and the audience needs
  geography.
- **Costs** the most frames: continuity needs the setup, the middle and
  the detail.

### B · The single take — one move, no cut

*One continuous move through the space.*

- **Prompt:** the camera's path written as a movement — "low at the
  threshold moving out toward him, the door frame passing close across
  the edges".
- **Cut:** one still, one slow motion, a long hold (6–10 s), no grade.
- **Use it** when the movement *is* the content, or when the material is
  thin and honesty beats assembly.
- **Costs** one frame per move — but the move has to be describable, or
  MJ renders a static frame and the take lies.

### C · The graphic — the frame as a poster

*Shape and light carry it; the figure is reduced to a silhouette.*

- **Prompt:** the light becomes the subject — "the open doorway a hard
  bright vertical shape inside a black frame … no face visible".
- **Cut:** the look does the work — `--fx contrast+grain`, a `--grade`,
  and a slow drift (`--motion pan-left`).
- **Use it** for the set's title card, its cover, and the frames where
  the lyric is a slogan rather than a scene.
- **Costs** one frame per idea, and it is the strongest register for a
  still that has to survive being a thumbnail.

### D · The rhythm cut — the edit carries the lyric

*The frame is caught on the beat; the edit is the music.*

- **Prompt:** the instant — "caught at the exact instant of the beat
  with the room's light flaring".
- **Cut:** `--mode cut` at 0.5–1 s, the same frame repeated with
  `--fx flicker` / `chroma`, `--fade` short.
- **Use it** when the lyric's metre is the point (the "tap, par, pa,
  par, par" sections) and the picture is only the pulse.
- **Costs** almost nothing: one frame, many cuts. It is the cheapest way
  to make a lyric feel performed rather than illustrated.

### E · The held moment — time passes inside the frame

*The light changes while the shot holds.*

- **Prompt:** the change itself — "the light moving across his face
  from lamp-orange to the first cold blue of morning".
- **Cut:** one still, a very long hold, a slow zoom, a grade that leans
  cold.
- **Use it** for the lyrics about waiting, arriving, or dawn — the
  "till you get the light" frame is this approach by definition.
- **Costs** one frame, and it only works if the change is *written*: MJ
  renders one instant, never a transition.

### Choosing

| the lyric is | the shot is |
|---|---|
| a story with events | A — the literal cut |
| a movement or a journey | B — the single take |
| a slogan, a title card, a hook | C — the graphic |
| a metre, a chant, a hook line | D — the rhythm cut |
| a wait, an arrival, a night into morning | E — the held moment |

The five are not exclusive. The sets in this repo are mostly A with C
for the cover and D for the chant sections; `Till You Get The Light` is
mostly E.

---

## 4. The proof — one frame, five ways

`assets/mural-prompts/one-door-five-ways-5.md` renders **one** beat
(a door swung wide in the middle of the night, the artist in the
opening, one streetlamp far down the road) five times, with the identity
clause and the house tail identical and only the framing clause changed:

| # | approach | what changed in the prompt |
|---|---|---|
| 01 | A — the literal cut | camera at chest height in the street, square on |
| 02 | B — the single take | camera low at the threshold moving out toward him |
| 03 | C — the graphic | the light as a hard bright shape, the figure without a face |
| 04 | D — the rhythm cut | the exact instant of the beat, the room's light flaring |
| 05 | E — the held moment | the light moving from lamp-orange to first blue |

The results, and what each one showed, are in the sprint log for the
set (AGENTS.md).

### What the five-way test actually showed

Rendered 2026-11-01 (five edit jobs from `6606f40f`, 2944×1648 each),
cut with each approach's own recipe. The five frames are visibly five
different films — and three of the five taught the method something it
did not know.

**A — the literal cut.** The most stable of the five and the least
surprising. But "the camera at chest height in the street facing him
square on" barely moved the camera: the result is a doorway portrait,
not a street-level two-shot. The reference's framing won again. What the
job *did* give is three usable distances of the same beat across its
four cells — which is exactly what continuity needs, and is the reason
this approach gets three frames of one job instead of three jobs.

**B — the single take.** "The door frame passing close across the edges
of the frame" **landed** — in all four cells the door frame is in the
picture, close, with the street opening up beyond it. The lesson:
**a framing clause that names an OBJECT IN THE FRAME is obeyed; a
clause that names a DISTANCE is not.** That is the same boundary the
earlier sets found about camera height, now stated for framing.

**C — the graphic.** The hard bright shape landed — the doorway blew
out to a white rectangle, which is the poster the approach wanted. But
**"no face visible" did not**: the face is the anchor, and a negative
about it cannot remove what the attachment is holding. To get a graphic
frame, remove the person from the shot; do not negate them.

**D — the rhythm cut.** The strongest of the five, and the cheapest.
"Caught at the exact instant of the beat with the room's light flaring
across the wet road" produced real motion — mid-stride, coat flying,
flare on the wet road — and the cut (one frame, four treatments,
`flicker,chroma,cold+grain,vignette`, one second each) makes a beat out
of a single still for the cost of one generation.

**E — the held moment.** "The light moving across his face from
lamp-orange to the first cold blue of morning" produced a frame
containing **both** lights — the amber streetlamp and the blue sky in
one instant. MJ renders the two ends of a change, not the change; so
the held-moment approach is written as a *state* ("lamp-orange and
first blue together"), and the movement between them is the cut's job
(the long hold, the slow push, the cold grade).

### The three rules the test added

1. **Name what is IN the frame, not how far away it is.** The door
   frame clause landed; every distance clause in the test did not.
2. **A negative cannot remove the anchor.** "No face visible" kept the
   face. Remove the subject instead.
3. **Write a change as the two ends of it.** "Orange and first blue
   together" renders; "the light changing" does not.

