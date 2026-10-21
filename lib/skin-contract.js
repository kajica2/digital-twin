// lib/skin-contract.js — the machine-readable design-token contract.
//
// This is the single source of truth for "what a skin must define".
// DESIGN.md explains the contract in prose; this file is the part a
// machine checks. `lib/skin-tokens.js` validates every skin against it
// and fails loudly on a missing token, so a skin can never be half
// applied.
//
// Three kinds of token:
//
//   themed   — a colour. MUST be defined in the light scope AND the
//              dark scope of a skin. These are the ones a skin changes.
//   static   — a constant (a font stack, a spacing step, a radius).
//              Defined once in the base scope. A skin may override it
//              but does not have to, and a light/dark pair is not
//              required.
//   local    — a deliberately one-off palette (a sepia photo treatment,
//              a flag colour, a building's stone). NEVER a skin token.
//              It stays in the page that owns it. Listed here so the
//              validator can tell "this page forgot to migrate" apart
//              from "this token was never skinnable".
//
// Usage:
//   const { themed, static: fixed, local, all } = require('./skin-contract.js');
//   const missing = themed.filter(t => !defs[t]);
//
// Group ids are stable: they are the contract's public vocabulary and
// are referenced by DESIGN.md §4.

'use strict';

/** Token groups → the themed (colour) tokens each group owns. */
const GROUPS = {
  // Surfaces — the ground the page sits on, back to front.
  surfaces: [
    'bg', 'bg-warm', 'surface', 'surface2', 'line', 'line-soft',
    'bg-card', 'bg-card-hover', 'bg-primary', 'bg-secondary',
    'bg-soft', 'bg-soft-2', 'bg-tertiary',
  ],
  // Ink — text and its three levels of emphasis.
  ink: [
    'ink', 'ink-muted', 'ink-faint', 'ink-2',
    'fg', 'fg-dim', 'fg-mute', 'fg-muted',
    'text', 'text-dim', 'text-primary', 'text-secondary', 'text-tertiary',
    'muted',
  ],
  // Brand — the project's own voice. The one thing a skin MUST change.
  brand: [
    'primary', 'primary-2', 'primary-soft', 'primary-mid',
  ],
  // Accent — the supporting voice, plus the domain accents the
  // cognitive-twin page uses to colour its four layers.
  accent: [
    'accent', 'accent-2', 'accent-3', 'accent-hover',
    'accent-soft', 'accent-strong', 'accent-text',
    'accent-2-text', 'accent-3-text',
    'accent-agents', 'accent-audio', 'accent-github', 'accent-knowledge',
    'accent-model', 'accent-music', 'accent-orchestrator',
    'accent-reasoner', 'accent-scanner', 'accent-visual',
    'accent-agents-text', 'accent-audio-text', 'accent-github-text',
    'accent-knowledge-text', 'accent-model-text', 'accent-music-text',
    'accent-orchestrator-text', 'accent-reasoner-text',
    'accent-scanner-text', 'accent-visual-text',
    'node-color',
  ],
  // Status — feedback. Must read in both themes without relying on hue
  // alone, so every status colour ships with a text variant.
  status: [
    'success', 'success-bg', 'error', 'warn', 'warning', 'ok', 'info',
    'red', 'green', 'yellow', 'blue', 'purple',
  ],
  // Code — inline and block code. A skin that changes the surfaces
  // without changing the code colours produces unreadable snippets.
  code: [
    'code-bg', 'code-text',
  ],
  // Series — the categorical colours charts and graphs cycle through.
  // A skin that changes the brand without changing the series produces
  // a chart whose first bar no longer belongs to the product.
  series: [
    'c1', 'c2', 'c3', 'c4', 'c5', 'c6',
  ],
};

/**
 * Static tokens: declared once, in the base scope.
 *
 * "Declared once" is a placement rule, not a value rule. A static
 * token MAY reference a themed token, in which case it resolves
 * differently per theme — custom properties are late-bound, so that is
 * how var() works, not a contract violation. The shadow tokens are the
 * intended case: one rule derives a warm grey shadow on the cream
 * ground and a deeper, quieter one on the near-black ground, instead
 * of hard-coding one theme's shadow and pasting it into the other.
 *
 * What is forbidden is REDEFINING a static token in the dark scope —
 * a repeated literal would pin the light theme's value onto the dark
 * one. The validator checks placement (present in base, absent from
 * dark) and never compares static values across themes.
 */
const STATIC = {
  typography: [
    'font-display', 'font-body', 'font-mono',
    'sans', 'serif', 'mono',
    'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl',
    'fs-2xl', 'fs-3xl', 'fs-4xl', 'fs-5xl', 'fs-base',
    'lh-tight', 'lh-normal', 'lh-base', 'lh-snug',
  ],
  space: [
    'space-1', 'space-2', 'space-3', 'space-4', 'space-5',
    'space-6', 'space-7', 'space-8', 'space-9',
  ],
  radius: [
    'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-pill',
  ],
  shadow: [
    'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-glow',
  ],
  motion: [
    'dur-fast', 'dur-base', 'dur-slow', 'ease-out-expo', 'ease-in-out',
  ],
  layout: [
    'container', 'container-narrow', 'container-wide',
  ],
};

/**
 * Local (non-skinnable) palettes. These belong to a page's content, not
 * to the project's look: a sepia photographic treatment, a flag's three
 * stripes, a building's stone. A skin must NOT redefine them.
 */
const LOCAL = [
  'building-cream', 'building-stone', 'building-terracotta',
  'eagle-gold', 'fountain-bronze', 'paper-white', 'ink-black',
  'sepia-cream', 'sepia-dark', 'sepia-light', 'sepia-medium', 'sepia-tint',
  'sky-haze', 'sky-warm',
  'flag-blue', 'flag-red', 'flag-white',
];

/** Every themed token, flat. */
const themed = Object.values(GROUPS).flat();

/** Every static token, flat. */
const staticTokens = Object.values(STATIC).flat();

/** Every token a skin may define. */
const all = [...themed, ...staticTokens];

// A token must not appear in two groups — a duplicate would make the
// "which group does this belong to" question ambiguous, and the
// validator's per-group error messages would lie.
const seen = new Map();
for (const [group, tokens] of Object.entries(GROUPS)) {
  for (const t of tokens) {
    if (seen.has(t)) {
      throw new Error(
        `skin-contract: token "${t}" is in both "${seen.get(t)}" and "${group}"`
      );
    }
    seen.set(t, group);
  }
}
for (const t of staticTokens) {
  if (seen.has(t)) {
    throw new Error(`skin-contract: token "${t}" is in both "${seen.get(t)}" and "static"`);
  }
  seen.set(t, 'static');
}
for (const t of LOCAL) {
  if (seen.has(t)) {
    throw new Error(`skin-contract: local token "${t}" collides with a skinnable token`);
  }
}

/** The full CSS custom-property name for a bare token name. */
function cssName(token) {
  return token.startsWith('--') ? token : `--${token}`;
}

module.exports = {
  GROUPS,
  STATIC,
  LOCAL,
  themed,
  staticTokens,
  all,
  cssName,
  /** The group a token belongs to, or null. */
  groupOf(token) {
    return seen.get(token) || null;
  },
};
