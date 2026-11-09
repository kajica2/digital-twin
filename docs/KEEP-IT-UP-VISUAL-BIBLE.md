# KEEP IT UP — the four-song cycle

Four songs, one video. Each song gets **25 frames** — 100 frames total.

## The premise

The songs are a cycle about a man who makes his own rhythm because nobody
gave him one. School told him how to walk and how to follow; the city sold
him clocks but no time; a doctor told him he keeps good time; a man who
knew the future said the music is only vibration and air. Every song is
the same man, alone, in a room or a street, with a beat he has to invent.

So the video is **one night, one man, four rooms**. Not four unrelated
music videos — one continuous walk through one night, where each song is
the same man at a different hour, in a different space, with the same
yellow streetlight and the same trumpet.

That is what makes 100 frames cut together instead of sitting beside each
other.

## The protagonist — locked

A man in his thirties, lean, short dark hair, a dark work jacket over a
plain tee. He plays a trumpet. He is never performing for anyone. The
camera never sees him succeed.

Locked by description, repeated in every prompt, because a model has no
memory between prompts. The consistency comes from repeating the same
words, not from a reference image (FLUX.2 klein here is text-to-image).

**Character string (verbatim in every frame that has him in it):**

    a lean man in his thirties with short dark hair and a dark work jacket
    over a plain tee, playing a trumpet

## The four rooms

| # | song | BPM | hour | room | key light | palette |
|---|---|---|---|---|---|---|
| 01 | KEEP IT UP | 105 | early evening | a bare rehearsal room, one worklight | amber worklight | warm amber + deep blue |
| 02 | NEEDLE DROP HEALER | 100 | late evening | a cramped flat at night, a window with a fan | green-white window light | sickly green + warm brown |
| 03 | SLIP BETWEEN THE BEATS | 108 | the small hours | a wet street under a broken sign | red neon flicker | red + wet blue-black |
| 04 | IT AIN'T WHAT IT IS | 96 | before dawn | a rooftop, city below, open sky | cold pre-dawn blue | pale blue + bone white |

Each room has its own light, so a frame from song 3 is unmistakable from a
frame from song 1 even in a fast cut. **That is the whole trick** — the
cut has to read as four rooms, not one room with a filter on it.

## The house look — verbatim on every frame

    cinematic film still, anamorphic widescreen, 35mm grain and halation,
    shallow depth of field, no text, no lettering, no watermark

The `no text` clause is not decoration. The songs are full of words and the
model will happily paint a title card. The repo has hit this three times
already — the words are the INPUT to the cut, never the OUTPUT to the
screen.

## The camera rule

Per the repo's camera grid (sprint 0.76): **a camera instruction must be
written as what is in the frame and what is not**, not as a lens name.

So:

> GOOD — "the frame from his knees up, nothing in the frame but his hands
> on the horn and the light on the floor"
>
> BAD — "medium shot, 50mm"

Lens names are banned. The negative clause ("nothing in the frame but…")
is what actually holds the composition.

## The frame distribution

25 frames per song, and **each frame is a lyric beat, not a mood**. The
lyrics are specific — a paper cup, a crooked little tune, a man on the
corner selling yesterday's news — and a specific lyric gives a specific
frame. Mood words give the model the same shot twenty-five times.

**Song 1 — KEEP IT UP (25):**
intro room (5) · verse 1 walking/jumping the beat (6) · pre-chorus
school, feet between the numbers (4) · chorus, the thing, the swing (5) ·
verse 2, the city, the man on the corner (3) · bridge, lost the one (2)

**Song 2 — NEEDLE DROP HEALER (25):**
the doctor's room, the needle drop (5) · verse 1, the crooked tune, the
borrowed shoes (6) · chorus, make me feel alright (4) · verse 2, the old
men playing, the tapping (5) · bridge, bass to the bottom (3) · outro,
you're a little late (2)

**Song 3 — SLIP BETWEEN THE BEATS (25):**
one two three and a half (4) · verse 1, crooked street, the city not
talking (6) · chorus, move your feet (4) · verse 2, the motor, the car,
the bar, the spoons on a plate (6) · bridge, stop, where'd everybody go (3)
· outro, see, told you (2)

**Song 4 — IT AIN'T WHAT IT IS (25):**
they say it is what it is (4) · verse 1, the glass, the future and the
past (5) · chorus, what you call reality (4) · verse 2, the man who knew
the future, vibration and air (5) · bridge, the silence after one long
trumpet note (4) · final verse, the rhythm in the basement, the question
on the roof (3)

## The frame that must exist

Song 4's bridge is the whole record's argument: *can you tell me why the
silence after one long trumpet note feels like somebody opened up a door
inside my throat?* So there is a frame where he holds a note and the
image itself opens — a doorway of light in the dark behind him, or the
horn bell itself becoming a room. It is the one image that has to be there.

## What this is NOT

- **Not four music videos.** One night, four rooms.
- **Not the singer on a stage.** He is alone in every frame.
- **Not text-heavy.** No lyric is painted on the picture. The words live
  in the cut list and are burned in separately by `lib/story/lyrics.py`.
- **Not four different art styles.** The house look is verbatim on all
  100; only the light and the room change.
