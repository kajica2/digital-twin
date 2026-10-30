---
title: Kai Balkan Underground
instrumental: true
bpm: 105
mood: experimental fusion
series: kai 01-03
number: 3
weirdness: 65%
style-influence: 85%
duration: 198
model: none — the server picks its own default for a text generation
brief-note: >
  03 of three. The brief's own pick: 01 first, 02 second, 03 third —
  establish the authentic southern Serbian brass sound before
  transforming it into the Kai signature. Weirdness is 65% for this one
  (40-55% for 01 and 02).
  `lib/suno-create.js` exposes the style influence (`--influence`, sent as
  the `audio_weight` slider) but has NO weirdness lever: the request body
  carries `weirdness_constraint: 0` and `aug_creativity: 1` as fixed
  values. The 65% target therefore rides in the tags text, not in a
  slider — the field's semantics are the server's, and guessing them
  costs a generation to find out.
  ATTEMPTED 2026-10-30: clip `c71e9ad1`, submitted with the body below
  and refused — `status: "error"`, audio URL
  `studio-api.prod.suno.com/api/forbidden`, balance unchanged at 7
  credits. Every request on this account fails the same way (a 60 s
  simple-mode one with an explicit model, and one without a model, both
  errored identically), so it is the ACCOUNT refusing, not the body.
  Re-run the command when the balance allows.
---

- Raw southern Serbian brass orchestra fused with experimental jazz electronica, expressive low-register flugelhorn, virtuosic Balkan trumpet melodies, rapid ornamental brass runs, tightly harmonized trumpets, powerful trombones, deep acoustic tuba bass, driving traditional snare and bass drum, African hand percussion, hypnotic broken-beat accents, dark modal jazz harmony, repetitive Balkan brass motifs, spontaneous improvisation, subtle degraded analog tape textures, raw rehearsal-room recording, energetic and deeply human, no vocals, no polished commercial production, 105 BPM
