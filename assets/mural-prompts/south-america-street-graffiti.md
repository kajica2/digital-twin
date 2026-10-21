# South America — Street Graffiti Mural Prompts

8 prompts for Midjourney. Style is inferred from the three coherent families
already in `~/Downloads/midjourney_session (8)/`:

  • **Family A** — `a_simple_asymmetrical_graphic_black_and_white_logo_…`
    → high-contrast B&W throw-ups, stencil-line, asymmetric composition,
    928×1232 portrait, graphic-design energy.

  • **Family B** — `presented_in_the_style_of_sheet_music_atop_architectural_draw_…`
    → mixed-media layering: stencil portrait + architectural blueprint
    + musical notation as overlay. 816×1456 tall portrait, dense texture,
    urban-decay substrate (peeling paint, brick, plaster).

  • **Family C** — `KAI_Dj_Medium_shot_of_the_sunrise_signaling_the_end_of_the_ni_…`
    → eye-level medium shot of a real urban setting at dawn. Cinematic,
    928×1232 portrait, narrative moment, gritty-but-beautiful.

Each prompt below is tagged `[A]`, `[B]`, or `[C]` so you know which style
it leans toward. Run them as `v 6` or `v 6.1` with `--style raw` if you
want to keep it gritty. Suggested aspect ratios per family noted inline.

---

## 1. La Boca, Buenos Aires — Caminito

`[C] --ar 3:4`

> Street-level medium shot of a brightly painted corrugated-metal
> tenement wall in La Boca at first light, every panel a different
> saturated color (oxblood, cobalt, sun-yellow, ochre), covered in
> fresh graffiti tags layered over the original paint, an old man in a
> beret walking past with a newspaper tucked under his arm, low warm
> dawn light raking across the corrugations, concrete sidewalk wet
> from last night's rain, cinematic, shot on 35mm, gritty but tender,
> in the style of Buenos Aires street photography at sunrise signaling
> the end of the night.

---

## 2. Valparaíso, Chile — Cerro Alegre staircase

`[A] --ar 3:4`

> Asymmetrical graphic black-and-white mural-style composition of a
> steep Valparaíso hillside staircase climbing diagonally from bottom-
> right to upper-left, every wall along the stair covered in bold
> stencil graffiti portraits and wildstyle tags, a single tiny human
> figure mid-climb for scale, hard contrast, no midtones, urban
> decayed texture, designed as a poster — simple asymmetrical graphic
> black-and-white logo-style mural composition.

---

## 3. São Paulo, Brazil — Beco do Batman

`[A] --ar 3:4`

> Asymmetrical graphic black-and-white logo composition: a single
> narrow alley wall in Vila Madalena entirely consumed by overlapping
> stencil graffiti of bats, tropical leaves, and bold sans-serif
> Portuguese lettering, one splash of red paint drips down the left
> third, hard contrast, no gradient, designed as a poster, urban
> decayed texture — a_simple_asymmetrical_graphic_black_and_white_logo.

---

## 4. Salvador, Bahia — Pelourinho colonial wall

`[B] --ar 9:16`

> Tall narrow vertical mural presented in the style of sheet music
> atop architectural drawing: a crumbling pastel-colored Pelourinho
> colonial facade in Salvador da Bahia, every window arched and
> overflowing with painted Afrofuturist figures and stencil graffiti,
> overlaid with translucent sheet-music staves carrying the contour
> of an atabaque drum pattern, faded blue architectural blueprint
> grid showing the building's elevation, peeling plaster substrate,
> dense layered texture, in the style of sheet music atop
> architectural drawing.

---

## 5. Medellín, Colombia — Comuna 13 escalator

`[C] --ar 3:4`

> Street-level medium shot of a Medellín Comuna 13 outdoor escalator
> at golden hour, every concrete wall and railing covered in vivid
> spray-paint murals of condors, Indigenous faces, and protest poetry,
> two teenagers riding up the escalator with headphones, low warm
> raking light, palm-tree shadows on the painted concrete, shot on
> 35mm, cinematic, gritty but hopeful — sunrise signaling the end of
> the night in Comuna 13.

---

## 6. Bogotá, Colombia — graffiti truck on the cordillera

`[A] --ar 3:4`

> Asymmetrical graphic black-and-white logo composition: a single
> heavily-loaded Colombian freight truck parked at altitude on the
> road to Monserrate, every panel of the truck cab hand-painted in
> bold wildstyle graffiti lettering and stencil rosettes, misty
> Andean cordillera behind it, hard contrast, single splash of yellow
> on the truck's horn, designed as a poster, urban decayed texture
> — a_simple_asymmetrical_graphic_black_and_white_logo style.

---

## 7. Quito, Ecuador — stairs through the old town

`[B] --ar 9:16`

> Tall vertical mural presented in the style of sheet music atop
> architectural drawing: a steep narrow Quito old-town staircase
> descending into a tiled plaza, the wall running up the left edge
> layered with pre-Columbian-inspired stencil graffiti and modern
> spray-paint tags, overlaid with translucent sheet-music staves
> carrying the contour of a charango melody, faded sepia
> architectural drawing of the colonial grid in the background,
> peeling plaster substrate, dense layered texture — in the style
> of sheet music atop architectural drawing.

---

## 8. Cusco, Peru — Inca wall meets spray paint

`[C] --ar 3:4`

> Street-level medium shot at sunrise of a Cusco street where an
> original Inca fitted-stone wall meets a modern poured-concrete
> building, the seam between the two covered in fresh stencil
> graffiti of pumas, condors, and Aymara geometric patterns, a
> Quechua woman in traditional dress walking past with a woven
> bundle, low warm dawn light raking across both walls, shot on
> 35mm, gritty but sacred — sunrise signaling the end of the night
> in the Andes.

---

## Notes

  • Run as `v 6` or `v 6.1` — these prompts assume modern MJ.
  • Add `--style raw` if the output is too "designed" / commercial.
  • `--s 250` keeps the gritty texture; drop to `--s 50` for cleaner.
  • If MJ defaults to 1:1, the `--ar` flags above pin portrait ratios.
  • The three families mix well — feel free to mash (e.g. a `[B]`-style
    La Boca, or a `[A]`-style Comuna 13) if one direction is too narrow.

## File location

These prompts live at:
  `~/digital-twin/assets/mural-prompts/south-america-street-graffiti.md`

Run them in Midjourney, save the best 4-up grids back to
`~/digital-twin/assets/murals/south-america/` if you want them tracked.
