---
title: MJ Style Presets — Registry
source: user-supplied preset list, 2026-09-29
count: 23
note: |
  Canonical registry of the MJ style presets the digital_twin mural
  pipeline renders against. One section per preset:

      ## <slug>            stable slug — the programmatic handle
      **<DISPLAY NAME>**   the name a pack carries in each prompt tail
      <descriptor>         the visual direction the prompt renders

  The source list cited two upstream portfolios —
  flexible-smart-videomaker and morpha-protocol. The morpha-* group
  carries its `From …` attribution; per-entry attributions elsewhere
  were not part of the durable copy.

  A descriptor marked † is a faithful visual reading of the preset
  name; an unmarked descriptor quotes the source list.

  Wire-in target: lib/mj-prompt-generator.js STYLES rotation
  (slug-addressed), plus a future `--style <slug>` selection flag.
  Pack convention: PROMPT-EXPANSION-FORMAT.md § Style-preset packs.

  Packs generated from this registry:
  prompts-inbox/style-presets-vol-1.md (23 prompts, dry-run validated).
---

# MJ Style Presets

23 presets. A descriptor is written to drop straight into a prompt as
the style clause; the pack convention fixes the ratio at `--ar 16:9`.

Slug = the `##` heading. Display name = the bold line (packs carry it
in each prompt's tail, so `mj-output/<pack>/prompt-NN/` traces back
here). † = descriptor reconstructed from the preset name; unmarked =
quoted from the source list.

## cross-raw

**CROSS · RAW**

Minimal intervention. Pure layers, light hue only. Clean music-video
look.

## cross-poster

**CROSS · POSTER**

Heavy posterization (color reduction), high-contrast, no chromatic
noise. Graphic-design look.

## cross-mask

**CROSS · MASK**

† Layered matte masking — figures cut against a flat ground, hard
silhouette edges, one accent hue over a neutral field.

## auditor-fx

**AUDITOR · FX**

† Signal-processing artifacts as texture — scanline smear, chroma
bloom, dub-delay ghosting, an animated frame.

## broker-filter

**BROKER · FILTER**

† Heavy color-grade pass — split-tone shadows, crushed blacks, one
saturated hue through a desaturated field.

## auditor-neon

**AUDITOR · NEON**

† Neon signage palette — saturated magenta and cyan over deep night
blue, wet reflective surfaces, glowing edge light.

## broker-film

**BROKER · FILM**

† Analog film emulation — halation, grain, soft gate weave, warm
tungsten highlights against muted teal shadows.

## cross-grid

**CROSS · GRID**

† Orthogonal grid ruled across the frame — modular composition,
precise alignment, blueprint restraint.

## cross-smoke

**CROSS · SMOKE**

† Atmospheric smoke and haze — volumetric light shafts, soft
diffusion, low contrast.

## auditor-hallucination

**AUDITOR · HALLUCINATION**

† Surreal generative hallucination — morphing anatomy, melting edges,
dream-logic scale, uncanny detail.

## practitioner-liquid-glass

**PRACTITIONER · LIQUID GLASS**

† Refractive glass volumes — caustics, chromatic dispersion, fluid
highlights on a dark ground.

## practitioner-pearl-haze

**PRACTITIONER · PEARL HAZE**

† Iridescent pearl sheen through soft haze — pastel nacre gradients,
low-contrast bloom.

## auditor-club-strobe

**AUDITOR · CLUB STROBE**

† Hard strobe flashes on a dark floor — frozen silhouettes,
high-energy contrast, motion caught mid-beat.

## cross-vhs-vibe

**CROSS · VHS VIBE**

† VHS emulation — tracking noise, tape warp, timestamp burn-in,
low-res chroma smear.

## practitioner-neon-wash

**PRACTITIONER · NEON WASH**

† Broad neon wash flooding the frame — magenta-to-cyan gradient
bloom, soft glow, no hard lines.

## cross-morpha-anchor

**CROSS · MORPHA · ANCHOR** · *From morpha-protocol*

† A stable anchor form holds the center while the surroundings morph —
identity preserved through transformation.

## practitioner-morpha-flow

**PRACTITIONER · MORPHA · FLOW** · *From morpha-protocol*

† Continuous fluid morph between states — no seams, motion blur
carrying the transition.

## auditor-morpha-fracture

**AUDITOR · MORPHA · FRACTURE** · *From morpha-protocol*

† Form fractures into shards mid-morph — faceted fragments suspended,
broken symmetry.

## broker-morpha-void

**BROKER · MORPHA · VOID** · *From morpha-protocol*

† Form dissolves into negative space — silhouette swallowed by flat
darkness, minimal trace.

## broker-morpha-echo

**BROKER · MORPHA · ECHO** · *From morpha-protocol*

† Form repeats as decaying afterimages — temporal echo trail, ghosted
duplicates.

## cross-train-stage-1

**CROSS · TRAIN · STAGE 1**

† Coarse base pass — low-frequency structure and broad shapes only,
no fine detail.

## auditor-train-stage-2

**AUDITOR · TRAIN · STAGE 2**

† Mid-pass refinement — texture and mid-frequency detail build over
the stage 1 base, contrast tightens.

## cross-train-stage-3

**CROSS · TRAIN · STAGE 3**

AdamW + multi-discriminator (CQT + spectral). All losses. 4:1 G:D.
Refined, complex, multi-objective.
