#!/usr/bin/env node
'use strict';
// lib/flux2-keep-it-up.js — the 100 prompts for the four-song cycle.
//
// WHY A GENERATOR AND NOT A FILE OF PROMPTS
//
// The look has to be IDENTICAL across 100 frames. A hand-written prompt
// file drifts: frame 47 forgets the jacket, frame 72 drops the grain, and
// the cut stops holding together. So the shared parts are assembled here
// and the per-frame part is the only thing written by hand.
//
// The shared parts are VERBATIM in every prompt:
//   - the character string (the man, his jacket, his trumpet)
//   - the house look (anamorphic, 35mm grain, halation, no text)
//   - the room's light and palette
//
// And the composition rule (sprint 0.76's camera grid): a composition is
// written as WHAT IS IN THE FRAME AND WHAT IS NOT, never as a lens name.
// Every prompt therefore ends with a negative clause — "nothing in the
// frame but…" — because that clause is what actually holds the shot.
//
//   node lib/flux2-keep-it-up.js            # write the manifest
//   node lib/flux2-keep-it-up.js --check    # verify it, do not write
//
// Output: assets/flux2/keep-it-up/manifest.json

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'assets', 'flux2', 'keep-it-up', 'manifest.json');

// ---------------------------------------------------------------------------
// the shared parts — verbatim on every frame
// ---------------------------------------------------------------------------

// The man. Repeated word for word, because the model has no memory between
// prompts; consistency comes from repetition, not from a reference image.
const CHARACTER =
  'a lean man in his thirties with short dark hair and a dark work jacket ' +
  'over a plain tee';

// The house look. "no text" is load-bearing: these songs are full of words
// and the model will paint a title card without being asked.
const LOOK =
  'cinematic film still, anamorphic widescreen, 35mm grain and halation, ' +
  'shallow depth of field, no text, no lettering, no watermark';

const ROOMS = {
  1: {
    slug: 'keep-it-up',
    light: 'one amber worklight on a stand, the rest of the room in deep shadow',
    palette: 'warm amber and deep blue',
    place: 'a bare rehearsal room with a concrete floor and a brick wall behind',
  },
  2: {
    slug: 'needle-drop-healer',
    light: 'green-white light through a window with a turning fan, the blades cutting the light into bars',
    palette: 'sickly green and warm brown',
    place: 'a cramped flat at night, a low bed and a table with a glass on it',
  },
  3: {
    slug: 'slip-between-the-beats',
    light: 'a broken red neon sign flickering above, wet pavement throwing the light back up',
    palette: 'red and wet blue-black',
    place: 'a wet city street at night, parked cars along the kerb',
  },
  4: {
    slug: 'it-aint-what-it-is',
    light: 'cold pre-dawn blue with no sun in it, the city far below going pale',
    palette: 'pale blue and bone white',
    place: 'a rooftop above the city, a low parapet wall and open sky',
  },
};

// ---------------------------------------------------------------------------
// the 100 frames
//
// Each is: [composition, what happens]. The composition is written as what
// is in the frame and what is not — never as a lens name.
// ---------------------------------------------------------------------------

const FRAMES = {
  // === SONG 1 — KEEP IT UP · 105 BPM · rehearsal room ====================
  1: [
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he holds the horn up but not to his mouth, looking at it'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he lowers the horn and listens to the room'],
    ['nothing in the frame but a pair of hands and a small drumstick striking a snare, the stick blurred mid-stroke',
     'a pair of hands on a snare, the stick caught mid-stroke'],
    ['the frame from the waist up, nothing in the frame but his foot and the concrete floor',
     'his foot taps the floor twice, out of time with itself'],
    ['nothing in the frame but a low bass cabinet standing in the corner, the room behind it dark',
     'a bass cabinet in the corner, the plug trailing across the floor'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he breathes in, the horn still down'],
    ['the frame from the waist up, nothing in the frame but his shoulders and the brass catching the worklight',
     'he plays four notes and stops'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'the horn is up and he plays a note he does not like'],
    ['nothing in the frame but an empty cup on a table, nothing in the cup',
     'an empty cup on a table, nothing in it'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he wipes the mouthpiece with a cloth'],
    ['nothing in the frame but a pair of shoes seen from above, one foot angled across the other on bare floor',
     'his feet, one crossing the other'],
    ['nothing in the frame but a school corridor seen from the floor, a row of lockers, no people',
     'an empty school corridor, lockers down one side'],
    ['the frame from the waist down, nothing in the frame but his legs and the corridor floor',
     'a boy walks the corridor with his hands in his pockets'],
    ['nothing in the frame but a row of shoes under a school desk, all facing the same way',
     'shoes under a desk, all facing the same way'],
    ['the frame from the waist down, nothing in the frame but a foot stepping between two chalk lines on a floor',
     'a foot lands between two chalk lines'],
    ['the frame from the waist up, nothing in the frame but his hands and the trumpet',
     'he plays a small figure with one hand off the horn'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'the note holds, his chest visible in the light'],
    ['the frame from the waist up, nothing in the frame but his shoulders and the brass',
     'he plays the swing, loose and behind'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he stops, the horn still up'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he plays one note and lets it die'],
    ['the frame from the waist down, nothing in the frame but his feet walking a city pavement',
     'his feet on a wet pavement at night'],
    ['the frame from the waist up, nothing in the frame but an old man on a street corner and a folded newspaper',
     'an old man stands on a corner with a folded newspaper under his arm'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he plays a beat that is deliberately wrong, dragging behind the count'],
    ['the frame from the waist up, nothing in the frame but his face and the worklight behind him',
     'he looks up at the ceiling, listening for the next one'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the amber light on the bell',
     'he plays into the room and the room does not answer'],
  ],

  // === SONG 2 — NEEDLE DROP HEALER · 100 BPM · flat at night ==============
  2: [
    ['nothing in the frame but a record sleeve standing on a table, a turntable behind it',
     'a needle drops onto a record'],
    ['the frame from the waist up, nothing in the frame but a doctor in a white coat and a desk lamp',
     'a doctor sits across a desk, the lamp between them'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the green-white window light',
     'he sits on a bed with the horn, the fan turning behind him'],
    ['nothing in the frame but a glass of water on a table, the light passing through it',
     'a glass of water, half full'],
    ['the frame from the waist down, nothing in the frame but his hands in his pockets and a street kerb',
     'his hands in his pockets beside a kerb'],
    ['nothing in the frame but a pair of borrowed shoes, too large, on a bare floor',
     'borrowed shoes, too large, on a bare floor'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the green-white window light',
     'he plays a crooked figure, the notes uneven'],
    ['nothing in the frame but a wall with a small clock and a chair beside it',
     'a wall clock and an empty chair'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the green-white window light',
     'he plays until the run out of breath'],
    ['nothing in the frame but a doctor with his head tilted and a pen in his hand',
     'the doctor tilts his head, listening'],
    ['nothing in the frame but a small metronome on a table, its arm swinging',
     'a metronome ticking on a table'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the green-white window light',
     'he plays with the horn held low, almost in his lap'],
    ['nothing in the frame but a chipped mug on a table by a window',
     'a chipped mug by the window'],
    ['the frame from the waist up, nothing in the frame but his hands and the trumpet',
     'he plays the line again, and this time it lands'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the green-white window light',
     'the note holds and the fan turns'],
    ['nothing in the frame but an old man playing a small drum with his fingers on a table',
     'old fingers on a table drum'],
    ['the frame from the waist down, nothing in the frame but two old men at a table and the hands between them',
     'two old men at a table, one tapping out a rhythm'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the green-white window light',
     'he joins them, quietly'],
    ['nothing in the frame but a bare floor and a chair leg striking it',
     'a chair leg struck against the floor'],
    ['the frame from the waist up, nothing in the frame but his face and the fan turning behind him',
     'he stops and listens to the old men'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the green-white window light',
     'he plays the answer, alone'],
    ['nothing in the frame but a stairwell seen from above, the light coming down one flight',
     'a stairwell with light on one flight'],
    ['the frame from the waist down, nothing in the frame but his feet on a stair, not moving',
     'his feet on a stair, stopped'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the green-white window light',
     'he plays into the empty flat'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the green-white window light',
     'the note he was looking for, and then nothing'],
  ],

  // === SONG 3 — SLIP BETWEEN THE BEATS · 108 BPM · wet street ============
  3: [
    ['the frame from the waist down, nothing in the frame but two feet on wet pavement',
     'two feet, one slightly ahead of the beat'],
    ['nothing in the frame but a third footstep marked in wet chalk on the pavement',
     'a third footprint marked in chalk'],
    ['the frame from the waist down, nothing in the frame but a foot sliding sideways across wet pavement',
     'a foot sliding across wet pavement'],
    ['nothing in the frame but a puddle taking the reflection of a red sign above it',
     'a puddle holding a broken red reflection'],
    ['the frame from the waist down, nothing in the frame but his legs moving down a narrow street',
     'legs moving down a narrow street'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays walking, the horn swinging at his side'],
    ['the frame from the waist down, nothing in the frame but a line of other people\'s feet all facing one way',
     'a line of feet, all facing the same way'],
    ['the frame from the waist down, nothing in the frame but his feet going the other way',
     'his feet going the other way'],
    ['nothing in the frame but a shop clock seen through wet glass',
     'a clock through wet glass'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays a phrase that lands between two beats'],
    ['nothing in the frame but a crowd of backs moving away down the street',
     'a crowd moving away down the street'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays alone while the street empties'],
    ['the frame from the waist down, nothing in the frame but his feet and the wet street',
     'his feet keeping their own count'],
    ['nothing in the frame but a motorbike engine idling at a kerb',
     'a motorbike idling at the kerb'],
    ['nothing in the frame but a car with its interior light on and nobody in it',
     'a car with the interior light on, empty'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays in the road, between the parked cars'],
    ['nothing in the frame but a shop shutter half down and a lit gap at the bottom',
     'a shutter half down, a lit gap under it'],
    ['the frame from the waist down, nothing in the frame but two spoons striking a plate held in one hand',
     'spoons striking a plate'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays along with the spoons for a moment'],
    ['nothing in the frame but a street that is suddenly empty, the neon still lit',
     'an empty street, the neon still lit'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays and waits'],
    ['the frame from the waist down, nothing in the frame but his feet standing still on wet pavement',
     'his feet, stopped on wet pavement'],
    ['nothing in the frame but a bass speaker in a doorway and the bottom of a pair of legs behind it',
     'a bass speaker in a doorway, legs behind it'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'the bass comes in, and he plays with it'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the red neon flicker on the bell',
     'he plays one last figure and lifts the horn out of frame'],
  ],

  // === SONG 4 — IT AIN'T WHAT IT IS · 96 BPM · rooftop ===================
  4: [
    ['nothing in the frame but a rooftop parapet wall and the sky beginning to pale behind it',
     'a rooftop wall with the sky paling behind'],
    ['the frame from the waist up, nothing in the frame but the man and the pale city far below',
     'he stands at the parapet, looking down'],
    ['nothing in the frame but a glass on the parapet wall, half full, the city behind it',
     'a glass on the wall, half full'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the cold blue light',
     'the horn rests across his knees'],
    ['nothing in the frame but a man who knew the future, a paper of numbers in his hand, out of focus',
     'a blurred figure holding a page of numbers'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'he plays a question'],
    ['nothing in the frame but a stairwell door on a rooftop, the light under it',
     'a rooftop door with light under it'],
    ['nothing in the frame but a puddle on the rooftop reflecting the pale sky',
     'a rooftop puddle taking the sky'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'he plays the past, not the future'],
    ['the frame from the waist up, nothing in the frame but his face and the pale sky behind him',
     'he looks up, the sky behind his head'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the cold blue light',
     'the note reaches and does not arrive'],
    ['nothing in the frame but a vending machine glowing on the rooftop',
     'a vending machine glowing alone on a roof'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'he plays toward the city below'],
    ['nothing in the frame but a radio on the parapet wall, small, with its dial lit',
     'a small radio on the wall, dial lit'],
    ['the frame from the waist up, nothing in the frame but the man and the pale city far below',
     'he stands still and the music is in his head'],
    ['the frame from the waist down, nothing in the frame but the roof under his feet and his shoes on it',
     'his shoes on the roof, the city beyond the edge'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the cold blue light',
     'he opens his mouth to play and does not'],
    ['the frame from the waist up, nothing in the frame but his face and the pale sky behind him',
     'his eyes close'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'he plays one long note and holds it'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'the horn bell pointed at the city, the note still going'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'THE FRAME: behind him the dark wall has opened into a doorway of pale light, a room visible beyond it, and he is still holding the note'],
    ['the frame from the knees up, nothing in the frame but the trumpet and the cold blue light',
     'he lowers the horn and looks at the open doorway'],
    ['the frame from the waist down, nothing in the frame but a ladder going down into the building',
     'a ladder going down into the building'],
    ['the frame from the waist up, nothing in the frame but the man and a low rooftop door, the light inside warm',
     'he stands by a low door with warm light inside'],
    ['the frame from his knees up, nothing in the frame but the trumpet and the cold blue light',
     'he plays once more, to himself, and the sky is brighter'],
  ],
};

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function composePrompt(songNo, composition, action) {
  const room = ROOMS[songNo];
  const parts = [
    room.place + ', ' + room.light,
    action,
    composition,
    room.palette,
    LOOK,
  ];
  // The character clause only goes on the frames that actually have him.
  // Putting it on a frame of just a pair of shoes would tell the model to
  // render a man who is not in the shot.
  const hasHim = /\bhe\b|\bhis\b|\bhim\b/.test(action);
  if (hasHim) {
    parts.splice(1, 0, CHARACTER);
  }
  return parts.join(' — ');
}

function build() {
  const entries = [];
  const seen = new Set();

  for (const songNo of [1, 2, 3, 4]) {
    const frames = FRAMES[songNo];
    if (!frames || frames.length !== 25) {
      throw new Error(`song ${songNo} has ${frames ? frames.length : 0} frames, expected 25`);
    }
    frames.forEach(([composition, action], i) => {
      const n = String(i + 1).padStart(2, '0');
      const slug = `${ROOMS[songNo].slug}-${n}`;
      if (seen.has(slug)) throw new Error(`duplicate slug ${slug}`);
      seen.add(slug);
      entries.push({
        slug,
        song: ROOMS[songNo].slug,
        index: i + 1,
        composition,
        action,
        prompt: composePrompt(songNo, composition, action),
        width: 832,
        height: 464,
      });
    });
  }

  if (entries.length !== 100) {
    throw new Error(`built ${entries.length} entries, expected 100`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// checks — the same discipline as the descriptions module
// ---------------------------------------------------------------------------

function verify(entries) {
  const problems = [];

  // Every prompt carries the house look.
  for (const e of entries) {
    if (!e.prompt.includes('anamorphic widescreen')) problems.push(`${e.slug}: no anamorphic`);
    if (!e.prompt.includes('35mm grain')) problems.push(`${e.slug}: no grain`);
    if (!e.prompt.includes('no text')) problems.push(`${e.slug}: no 'no text' clause`);
    // A lens name is banned — the composition must be a description of
    // what is in the frame.
    if (/\b(\d{2,3}mm|medium shot|close-up|wide shot|extreme close|bokeh lens)\b/i.test(e.composition)) {
      problems.push(`${e.slug}: a lens name in the composition — ${e.composition}`);
    }
    // The negative clause is what holds the composition.
    if (!/nothing in the frame/.test(e.composition) && !/only /.test(e.composition)) {
      problems.push(`${e.slug}: composition has no negative clause`);
    }
  }

  // The man is described the same way every time he appears.
  const withHim = entries.filter((e) => /\bhe\b|\bhis\b|\bhim\b/.test(e.action));
  for (const e of withHim) {
    if (!e.prompt.includes('a lean man in his thirties with short dark hair')) {
      problems.push(`${e.slug}: the character string is missing or altered`);
    }
    if (!e.prompt.includes('a dark work jacket')) {
      problems.push(`${e.slug}: the jacket is missing`);
    }
  }

  // Each room keeps its own light and palette.
  for (const e of entries) {
    const room = ROOMS[Object.keys(ROOMS).find((k) => ROOMS[k].slug === e.song)];
    if (!e.prompt.includes(room.palette)) problems.push(`${e.slug}: wrong palette`);
    if (!e.prompt.includes(room.light.split(',')[0])) problems.push(`${e.slug}: wrong light`);
  }

  // No duplicate prompt — two identical frames are two wasted renders.
  const prompts = new Set();
  for (const e of entries) {
    if (prompts.has(e.prompt)) problems.push(`${e.slug}: duplicate prompt`);
    prompts.add(e.prompt);
  }

  return problems;
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  const entries = build();
  const problems = verify(entries);

  if (process.argv.includes('--check')) {
    if (problems.length) {
      console.error(`${problems.length} problems:`);
      for (const p of problems) console.error('  - ' + p);
      process.exit(1);
    }
    console.log(`all ${entries.length} prompts verified`);
    process.exit(0);
  }

  if (problems.length) {
    console.error(`${problems.length} problems — refusing to write:`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(entries, null, 2) + '\n');
  console.log(`wrote ${entries.length} prompts -> ${path.relative(REPO, OUT)}`);
  console.log(`  song 1: ${entries.filter((e) => e.song === 'keep-it-up').length}`);
  console.log(`  song 2: ${entries.filter((e) => e.song === 'needle-drop-healer').length}`);
  console.log(`  song 3: ${entries.filter((e) => e.song === 'slip-between-the-beats').length}`);
  console.log(`  song 4: ${entries.filter((e) => e.song === 'it-aint-what-it-is').length}`);
}

module.exports = { build, verify, composePrompt, ROOMS, FRAMES, CHARACTER, LOOK, OUT };
