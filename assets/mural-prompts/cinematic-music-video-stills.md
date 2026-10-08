# Cinematic Music Video Stills — 12 prompts (16:9)

> Source: the twin's house world — poetic songwriting imagery staged in
> cinematic still language. Night city, neon rain, brass and breath,
> quiet platform silences, the moment before the song starts. Each still
> is a potential music video frame: one held shot, one light, one feeling.
>
> Subject first. No text in frame. --ar 16:9 on every bullet.
> Run locally via:
>   lib/flux2-renderer/.venv/bin/python lib/flux2-renderer/render-many.py \
>     --manifest <(python3 -c "
>       import json, sys
>       prompts = [l.strip('- ').split(' --ar ',1)
>                  for l in open('assets/mural-prompts/cinematic-music-video-stills.md')
>                  if l.startswith('- ') and '--ar 16:9' in l]
>       print(json.dumps([{'slug': f'cinestill-{i+1:02d}',
>                          'prompt': p.strip()}
>                         for i,(p,_) in enumerate(prompts)], indent=2))
>     ") \
>     --out-dir assets/flux2/cinematic-music-video-stills --width 832 --height 832

## 1 · neon rain

- A saxophone player alone under a dripping fluorescent stairwell at 3am, neon leaking through the gaps in the concrete, one amber streetlight catching the bell of the horn, condensation on the metal — cinematic film still, anamorphic widescreen, teal and copper palette, 35mm grain and halation --ar 16:9

- A woman walking away down a rain-slicked alley, the neon sign behind her fracturing in a thousand reflected shards, her coat the only still point in all that movement — cinematic film still, anamorphic widescreen, slow shutter, shallow depth of field, cold blue and pink --ar 16:9

## 2 · platform at night

- An empty subway platform at 2am, a single fluorescent tube buzzing and flickering above the bench where someone left a paper cup, the tile walls holding every shadow, nobody coming — cinematic film still, anamorphic widescreen, flat tungsten, 35mm grain --ar 16:9

- A train conductor leaning against the door of a stopped carriage at the end of the line, the platform dark except for one sodium lamp, the city beyond the tunnel mouth barely visible — cinematic film still, anamorphic widescreen, warm interior against cold platform, long exposure --ar 16:9

## 3 · neon church

- Interior of a disused church where someone has threaded Christmas lights through every nave and column, the whole vault a warm amber lattice, no pews, just empty stone floor — cinematic film still, anamorphic widescreen, golden hour warmth, dust in the shafts, 35mm grain --ar 16:9

- A jazz club seen from across the street in the rain, the window fogged amber, a trumpet player mid-phrase inside, his silhouette lit from below by the stage light, rain on the lens --ar 16:9

## 4 · brass and breath

- Close-up of a trumpet player's hands on the valves, the instrument's bell just out of frame, breath visible in the cold air of an unheated rehearsal room, late afternoon light from a high window — cinematic film still, anamorphic widescreen, shallow depth of field, warm key light, 35mm grain --ar 16:9

- A trombone slide extended into a pool of streetlight on a wet pavement at 1am, the bell pointed at nothing, the player somewhere off left frame, breath smoke rising — cinematic film still, anamorphic widescreen, monochrome with one warm accent, halation, 35mm grain --ar 16:9

## 5 · the last frame

- The final chord of a set: hands leaving the keys, a pianist's silhouette against the stage light, the rest of the band already standing, the audience a dark blur beyond the stage edge — cinematic film still, anamorphic widescreen, slow shutter, warm stage amber fading to black, 35mm grain --ar 16:9

- A vocalist at a standing mic, eyes closed, one hand raised slightly off the mic stand, the whole room gone quiet, the light on her face the only thing moving — cinematic film still, anamorphic widescreen, single source, soft focus, held breath feeling, 35mm grain --ar 16:9

## 6 · between songs

- The pause between songs: a guitarist sitting on the edge of the stage with one foot on the floor, the other dangling, tuning peg turning slowly, the venue dark beyond the stage light, somebody laughing off-camera --ar 16:9

- A bass player walking off stage through a corridor of equipment cases, the exit door held open by a roadie, daylight on the other side, the instrument case under one arm still zipped shut --ar 16:9
