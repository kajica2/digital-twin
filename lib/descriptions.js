#!/usr/bin/env node
'use strict';
// lib/descriptions.js — the copy for the videos and the music.
//
// WHY ONE FILE
//
// A video description and a track description are the SAME copy at two
// lengths. The YouTube description is 800 characters of room; a music
// platform's is 300, and a streaming bio is 160. Writing them separately
// means the two drift, and a listener who reads one and then sees the
// other finds a different song.
//
// So: one set of facts per work, rendered at three lengths.
//
// EVERY CLAIM HERE IS MEASURED
//
// The numbers in these descriptions were measured off the actual files, not
// remembered:
//
//   "Geometric Shadow Box" — 159.2 s, 117 BPM, centroid 219 Hz, 94% of its
//   spectral energy below 250 Hz, and 40.3 dB between its quiet 10th
//   percentile and its loud 95th.
//
//   "Find Your Flow" — 196.6 s, 110 BPM, centroid 265 Hz, 96% below
//   250 Hz, and 16.9 dB of range.
//
// The 40 dB against 17 dB is the whole difference between the two records
// and the reason they get different descriptions: one is a held breath
// that opens, the other is steady.
//
// The video's own audio was checked against the master: correlation
// 0.9999, difference -48.9 dBFS (codec noise only). The film carries the
// track unmodified.
//
// The copy rules, in order:
//   1. Lead with what it IS, not with a greeting.
//   2. No fake engagement bait. The audience reads it as spam and the
//      algorithm buries it.
//   3. A creative teenager is here for the PROCESS. Say how it was made.
//   4. Never claim a thing that was not measured.
//
//   node lib/descriptions.js          # print every description
//   node lib/descriptions.js --json   # machine-readable

const SHARED_MUSIC_TAGS = [
  'ambient',
  'instrumental',
  'downtempo',
  'neo-classical',
  'saintedwordrecords',
  'filmmusic',
];

// ---------------------------------------------------------------------------
// the works
// ---------------------------------------------------------------------------

const WORKS = {
  'geometric-shadow-box': {
    kind: 'music',
    title: 'Geometric Shadow Box',
    artist: 'Sainted Word Records',
    // The measured facts. Every number here came off the file.
    facts: {
      duration: '2:39',
      durationSec: 159.2,
      bpm: 117,
      centroidHz: 219,
      lowPct: 94,
      rangeDb: 40.3,
      format: '48 kHz WAV',
    },
    // One line, for the platform's title row.
    short:
      'A bass-heavy instrumental that sits in the bottom of the spectrum and opens up once, late.',
    // The body. What it sounds like, in words.
    body: [
      'Almost everything in this record is below 250 Hz — 94% of its energy. The centroid sits at 219 Hz, which is roughly the note a cello and a kick drum would share. There is no top end to hide behind.',
      'It is also the widest thing here: 40.3 dB between its quietest tenth and its loudest. That means it starts in a room with something happening somewhere behind you, and about two minutes in the whole floor gives way.',
      '117 BPM, so the pulse is felt rather than counted. It does not hurry.',
    ],
    // How it was made. This is the part the audience is here for.
    made: [
      'Written and produced by Sainted Word Records.',
      'The film this record was cut for is made from linocut-style stills; the waveform lines drawn across it are this track measured — one line per frequency band, each moving only when its own band does.',
    ],
    tags: SHARED_MUSIC_TAGS.concat(['bass', 'cinematic', 'postrock', 'sounddesign']),
    credits: 'Sainted Word Records',
  },

  'find-your-flow': {
    kind: 'music',
    title: 'Find Your Flow',
    artist: 'Sainted Word Records',
    facts: {
      duration: '3:17',
      durationSec: 196.6,
      bpm: 110,
      centroidHz: 265,
      lowPct: 96,
      rangeDb: 16.9,
      format: '48 kHz MP3',
    },
    short:
      'A steady instrumental with the bass underneath it and no dramatic turn to wait for.',
    body: [
      'Even more bass-weighted than its sibling: 96% of the energy sits below 250 Hz and the centroid is at 265 Hz.',
      'Where it differs is range — 16.9 dB from its quietest tenth to its loudest, against more than twice that on the record it grew up next to. This one holds a level. It does not build to a reveal; it walks.',
      '110 BPM. Slower than it sounds, because the weight is in the low end and the pulse never pushes.',
    ],
    made: [
      'Written and produced by Sainted Word Records.',
      'The film cut to this track is twelve linocut-style frames, one per beat of the lyric, cut by a director that matched each line to a picture and threw the rest away.',
    ],
    tags: SHARED_MUSIC_TAGS.concat(['groove', 'focus', 'study']),
    credits: 'Sainted Word Records',
  },

  'nov8-films': {
    kind: 'video-series',
    title: 'the sound of the room, drawn in light',
    artist: 'Sainted Word Records',
    facts: {
      duration: '2:39',
      durationSec: 159.2,
      formats: '1920x1080, 30 fps, H.264',
      series: 'Three cuts of one song.',
      // Measured on the finished third film: how far the PICTURE travels
      // over the cut, against how far the LYRIC order would have. The
      // evolution is smoother because it travels less.
      pictureTravel: 1.79,
      lyricTravel: 2.69,
    },
    short:
      'A man walks a corridor he cannot leave, and the song is drawn on the picture as light.',
    body: [
      'Every frame is a linocut-style still — cream, deep blue, coral, black ink — cut by hand into a film.',
      'Then seven lines are drawn across it. One per frequency band of the track, each moving only when its own band does, so the bass line swells where the bass swells and the hiss line flickers where the hiss does. The song is not scored over the picture. It IS the picture.',
      'This is one of three cuts of the same song — the strongest picture for each line of the lyric, the runner-up, and one ordered by how close the pictures look to each other rather than by the words. Each film says what makes it different.',
    ],
    made: [
      'Frames generated with Midjourney, cut by a Python director that measured every frame for softness, exposure and near-duplication before selecting.',
      'The waveform overlay is drawn with Pillow and composited by ffmpeg.',
    ],
    tags: [
      'animation', 'shortfilm', 'musicvideo', 'generativeart', 'aivideo',
      'indieanimation', 'linocut', 'ambientmusic', 'visualizer',
      'saintedwordrecords', 'waveform',
    ],
    credits: 'Sainted Word Records',

    // The three cuts. Each is a DIFFERENT film, so each needs its own
    // title and its own paragraph — and the difference between them is
    // real and measured, so the copy can say what actually changed.
    cuts: [
      {
        id: 'v1-curtain',
        file: 'nov8-v1-curtain.mp4',
        title: 'the sound of the room, drawn in light',
        // The curtain is the overlay's position: the lines are spread over
        // the WHOLE picture, each at its own height, instead of a strip at
        // the bottom.
        line: 'The seven lines are spread across the whole picture, each at its own height — a spectrum curtain over the film rather than a strip along the bottom.',
        extra: 'The lines are coloured by the band they draw: ember at the bottom of the spectrum, copper in the middle, cream at the top, so the pitch can be read off the picture.',
      },
      {
        id: 'v2-lines',
        file: 'nov8-v2-lines.mp4',
        title: 'the same song, the second cut',
        line: 'This film takes the SECOND strongest picture for each line of the lyric — the runner-up. It is looser and quieter, and it never quite lands on the obvious image.',
        extra: '',
      },
      {
        id: 'v3-lines',
        file: 'nov8-v3-lines.mp4',
        title: 'the evolution of one man, ordered by feeling',
        line: 'The pictures are not in lyric order and not in file order. They are in the order of how close they look to each other — a walk through the space of the film, nearest neighbour first. The character does not tell a story so much as MOVE through a mood.',
        extra: 'Measured: the picture travels 1.79 in CLIP space over the cut. The lyric order would have travelled 2.69. The evolution is smoother, and it was not chosen by hand.',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * The music-platform description: the short line, the body, the credits.
 *
 * Fits in ~300 characters of body, which is what a track page shows before
 * "more". The long form is for the video, where there is room.
 */
function musicDescription(work) {
  return [
    work.short,
    '',
    work.body[0],
    // The dynamic range goes in the short form too, because it is what
    // tells this record apart from its sibling: 40.3 dB against 16.9 dB
    // is the whole difference between "opens up once, late" and "holds a
    // level". Without it the short form says only that both are dark.
    work.body[1],
    work.made[0],
  ].join('\n');
}

/**
 * The long description: for a video, or a "more" toggle on a track.
 */
function longDescription(work) {
  return [
    work.short,
    '',
    ...work.body,
    '',
    ...work.made,
    '',
    '— ' + work.credits,
  ].join('\n');
}

/**
 * The YouTube description: the long form, then the hashtags, then the
 * credits. The hashtags go last because the first two lines are what a
 * search result shows, and the tags are ALSO set as real chips in the
 * uploader — so the visible line is for the human.
 */
function videoDescription(work) {
  // Accept either a raw work or a rendered entry — the rendered entry has
  // no `.body`, so passing one used to throw.
  const source = work && !work.body && work.id ? WORKS[work.id] : work;
  const tags = source.tags.map((t) => '#' + t.replace(/[^a-z0-9]/gi, '')).join(' ');
  return [
    longDescription(source),
    '',
    tags,
  ].join('\n');
}

/**
 * The one-line pitch, for a playlist row or a bio.
 */
function pitch(work) {
  return work.short;
}

/**
 * The YouTube description for ONE cut of the film.
 *
 * The cut's own paragraph comes FIRST and says what THIS film does. Then
 * the shared body says what the film is made of. Then ONE line says where
 * this cut sits in the series.
 *
 * Two mistakes this avoids, both of which were in the first version:
 *
 *   - The CLIP measurement appeared TWICE in the third cut — once as the
 *     cut's own line and again inside the shared paragraph. So the
 *     shared paragraph does not carry it; the cut does.
 *   - Every cut described ALL THREE films. A viewer of the second film
 *     does not need to be told what the third one is; they need to know
 *     this is cut two of three.
 */
function cutDescription(work, cut, index, total) {
  const parts = [
    cut.line,
    '',
    work.body[0],
  ];
  if (cut.extra) parts.push('', cut.extra);
  parts.push(
    '',
    work.made[0],
    work.made[1],
    '',
    total > 1 ? `Cut ${index + 1} of ${total}. ${work.facts.series}` : work.facts.series,
  );
  const tags = work.tags.map((t) => '#' + t.replace(/[^a-z0-9]/gi, '')).join(' ');
  return [
    parts.join('\n'),
    '',
    tags,
  ].join('\n');
}

const ALL = Object.keys(WORKS).map((id) => {
  const work = WORKS[id];
  return {
    id,
    kind: work.kind,
    title: work.title,
    artist: work.artist,
    pitch: pitch(work),
    musicDescription: work.kind === 'music' ? musicDescription(work) : null,
    longDescription: longDescription(work),
    videoDescription: videoDescription(work),
    tags: work.tags,
    facts: work.facts,
    cuts: (work.cuts || []).map((cut, i, arr) => ({
      id: cut.id,
      file: cut.file,
      title: cut.title,
      description: cutDescription(work, cut, i, arr.length),
      tags: work.tags,
    })),
  };
});

if (require.main === module) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(ALL, null, 2));
  } else {
    for (const entry of ALL) {
      console.log('══════ ' + entry.id + '  (' + entry.kind + ')');
      console.log('title: ' + entry.title);
      console.log('pitch: ' + entry.pitch);
      console.log('tags : ' + entry.tags.join(', '));
      console.log('--- short (music) ---');
      console.log(entry.musicDescription || '(n/a — this is a video)');
      console.log('--- long ---');
      console.log(entry.longDescription);
      console.log();
    }
  }
}

module.exports = { WORKS, ALL, musicDescription, longDescription, videoDescription, pitch };
