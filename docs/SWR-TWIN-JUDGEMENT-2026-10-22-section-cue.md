# SWR-Twin judgement — P1.3 section cue + P1.1 shared reactor contract

Date: 2026-10-22
Role: SWR-Twin (founder's digital twin) — creative/taste review only.
Judged: the uncommitted working tree in `~/Documents/sainted-word-records`
(23 modified files + `lib/apply-reactors.js` + `scripts/check-apply-reactor-unit.mjs`).

**Verdict: APPROVE-WITH-CHANGES.** The idea is right, the shipping of it is
not. Two of the four changes below are independent of the escalation
question; two depend on it.

---

## 0. Corpus check (the canonical voice corpus is MISSING)

The role prompt points at `digital_twin/voice/` — `samples/`, `decisions.md`,
`never-list.md`, `brand-pillars.md`. **It does not exist.** Proof:

```
$ ls -la ~/Documents/digital_twin/voice
ls: cannot access '.../digital_twin/voice': No such file or directory   (exit 2)

$ find ~/Documents/digital_twin -maxdepth 3 -type d -name "voice*"
(no output)

$ find ~/Documents/digital_twin -maxdepth 4 \
    \( -name samples -o -name decisions.md -o -name never-list.md -o -name brand-pillars.md \)
(no output)
```

`.kai/decisions/` exists but is empty; `.kai/preferences/user.yaml` and
`.kai/my-memory.md` exist and are the closest thing to a preferences record.
So there is **no brand-pillar list, no past-decision log, and no never-list**
to check this change against. Every taste claim below is anchored to a file
that does exist, or is marked as my own judgement.

**Corpus actually used (read):** `docs/PERSONALITY-TONE-GUIDE.md`,
`docs/AGENT-PLAN.md`, `WORK-SCHEDULE.md`, `cognitive-twin.html`, `AGENTS.md`
(rules + sprint log), `.kai/memory.yaml`, `.kai/my-memory.md`,
`.kai/preferences/user.yaml`.

---

## 1. Which taste filters actually apply

### APPLY

| Filter | Source | How it lands on this change |
|---|---|---|
| Aesthetic embodiment over explanation | PERSONALITY-TONE-GUIDE.md §3.1 | The transition must land on the breath. A *remembered* boundary is an explanation of the music; the music is the thing happening now. |
| Specificity over generality | §3.2 | `SECTION_CLASS` is a 4-row table; the house already has a specific chorus answer (`flash-cover`, "high-energy section break"). |
| Creative independence — borrow freely, owe nothing | §3.3 | "chorus = loud = glitch" imports a breakcore convention for material that is not breakcore. |
| "You don't switch at the section bar — you crossfade" | §4 blending rule | A hard cue override at the act bar is a switch, not a crossfade. |
| Stillness as a technology (Tone B) | §2 Tone B | A breakdown is a *rest*. Duration is the whole point of a rest. |
| The twin is calm, not chatty | AGENTS.md:188 | The cue never fires on its own — that restraint is right and worth keeping. |
| Honest inventory of what's actually there | cognitive-twin.html | The diff is honest about the offline/live gap and about "an empty map is not a boundary". Keep that voice; the header's "BIASES" claim should be true in code too. |
| A vibe-name is not a clause | WORK-SCHEDULE.md:101 ("Beautifully lit" is a vibe-name) | "chorus → dynamic" is currently a vibe-name in code: hand-authored, unmeasured, unproven. |

### DO NOT APPLY (out of scope)

- The four prose tones (A–D) and the vocabulary bank — for books/liner notes,
  not for the renderer. Only the blending rule transfers.
- The MJ prompt hard rules (subject-first, `--ar 16:9`, no text in frame) —
  the image-prompt pipeline.
- The model-routing table in `docs/AGENT-PLAN.md` — infrastructure, not taste.
- The twin's scan/model/reason/orchestrate layers and cron machinery in
  `cognitive-twin.html` — product architecture, not this change.

---

## 2. What I approve as written

- **"A section boundary NEVER fires a transition."** True, and it is the
  best sentence in the diff. The detector can retime nothing and break
  nothing; transitions still land on act boundaries. Keep this line.
- **verse/prechorus neutral**, with the right reason: the act plan is the
  better signal through the middle of a song.
- **The one-shot**, the **separate `swr-section-reset` event** (an empty map
  is not a boundary — and other consumers already parse `detail.to`),
  the **pure picker** exposed for testing, the **"skip, never reject"**
  guard, the try/catch around the listener.
- **The idea itself.** The arc is a *synthetic* 3–5 act trajectory
  (`ARCHETYPES` at `client/automix-arc.client.js:145-151`, `MIN_ACTS/MAX_ACTS`
  at `:104`) with boundaries snapped to an onset-flux curve (`:164-170`) — it
  does **not** follow the song's real structure. So a channel carrying the
  *real* section into it is genuinely new information. That is the reason to
  keep P1.3, and it is not the reason the diff gives.

## 3. The changes

**C1 — The comment says bias; the code says override.**
`client/automix-arc.client.js:37-40` ("a boundary only *BIASES* which
transition the next act boundary picks … leaves the act's own
warmth/intensity to decide") versus `pickTransition` at `:414-425` ("The
cue has an opinion and the act plan does not get a say", early return). The
gate locks the override in: `scripts/check-section-detector-unit.mjs:487-495`
asserts "a subtle cue overrides a hot act" / "a dynamic cue overrides a cold
act". Pick one word and make the code and the comment agree. House position
(crossfade, don't switch) argues for a blend: the cue narrows to a family,
the plan picks inside it, or the cue wins only when it agrees with the plan.

**C1b — The cue is a memory with no TTL.** `noteSection` stores `tMs` and
`novelty` (`:392-399`) and *nothing ever reads them*; the only clears are
spending it at an act boundary (`:461-462`) and `swr-section-reset`
(`:418`). With 3–5 acts over a track and a section every ~20–40 s, a chorus
cue can be spent at an act boundary a minute later, in a different section.
The detector already publishes the live map (`client/section-detector.client.js:571`,
`window.SWR_SECTIONS`) and returns the active section (`:777`) — read the
section *now* at the boundary instead of remembering the last boundary.

**C2 — "dynamic" is too broad for a chorus.** `DYNAMIC` = `glitch-burst`,
`chromatic-split`, `circle-wipe`, `linear-wipe-lr`, `vhs-tracking`
(`:375`) — two glitch-family, two geometric wipes, one VHS. The house matrix
already says chorus → `flash-cover`, "high-energy section break"
(`client/storyboard-transitions.client.js:32`), and the house's own preset
rationales say *don't fight the texture* ("Restraint", "Transitions that feel
invisible", `data/preset-transitions.json`). The founder scopes digital decay
to "artists who break rules on purpose" (this repo's AGENTS.md:3582-3583,
the System Error brief) — a warm deep-house chorus is not that. A chorus
wants the peak family; the wipes belong to the presets that own them.

**C3 — A contemplative break needs its duration.** The house gives
breakdown/outro a 1200–1500 ms `dip-to-color` ("contemplative break",
"winding down", `client/storyboard-transitions.client.js:34,36`). The
"subtle" bucket's fastest member is `pure-crossfade` at 480 ms and
`fade-to-black` at 520 ms (`engine-transitions.client.js:69-70`). A breakdown
that ends in a 480 ms crossfade reads as a cut, not a rest. Keep a duration
tier, or let the cue pick a family and the catalog own the timing.

**C4 — The act's preset never gets a vote.** `docs/automix-architecture.md:481-489`
says the transition vocabulary should follow the act's preset/colour grade
(`applyPresetAutoFire`), and `data/preset-transitions.json` carries the
per-preset aesthetic rationale. The cue never looks at the preset, so an
`eclipse` act ("Restraint — only let the dark reveal transitions through")
can fire `glitch-burst`. Crossfade the two signals; don't let one replace
the other.

## 4. P1.1 — approves on taste, with one look-check

The extraction is the right shape and it preserves each surface's character:
the per-surface unit tables survive as named options (`UNITS.gain200` on
aurora and friends; `UNITS.natural` on the engine, whose own `release` ease
map is deliberately not `lib/ease.js`'s — `engine.html:5005-5050`), and every
page keeps its own rotation gate and angle wrap. One system, many skins.

But three surfaces visibly change: neon / music_video / music_video_mtv
grades now respond to `r.scale`; grid's opacity loses its inverse blend and
gains x/y/brightness/contrast; and **`scale` is now clamped to [0.05, 4]
everywhere**, so a layer that used to collapse to scale 0 (a silent no-op in
`drawImage`) now sits at 5% instead of vanishing. The clamp is correct — but
that is a look change on the engine and on every variant, and the unit gate
proves the table, not the picture. One page-look pass before it ships.

## 5. Escalation

One question (house rule: one question per task —
`.kai/preferences/user.yaml` `max_questions_per_task: 1`):

> Does the section cue get the last word, or does the act's preset? In a
> warm/deep-house track, is the loudest moment allowed to fire the
> breakcore/glitch family (`glitch-burst`, `vhs-tracking`) when the act's own
> preset and colour grade say warm expansion — or should the cue only ever
> narrow a choice the preset already made?

C1b and C3 stand whichever way that lands. C2 and C4 are the changes that
follow from the answer.
