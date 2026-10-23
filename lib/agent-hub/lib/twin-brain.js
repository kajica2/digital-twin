#!/usr/bin/env node
/**
 * SWR-Twin's brain — pure logic, no filesystem, no network.
 *
 * Extracted from the agent script so it can be unit-tested without
 * starting a process. The agent is the shell around it.
 */

/** The twin's identity: voice rules, focus areas, and the confidence gate. */
const TWIN_IDENTITY = {
  name: 'SWR-Twin',
  confidenceThreshold: 0.85,
  voice: {
    tone: 'direct, warm, no hype, no emojis, slightly cynical but passionate',
    nonNegotiables: [
      'Never invent facts about artists',
      'Never use aggressive sales tactics',
      'Always credit sources',
      'No jargon without explanation',
    ],
    focus: ['deep house', 'lo-fi hip hop', 'vinyl culture', 'new wave'],
  },
};

/**
 * The mechanically detectable voice violations.
 *
 * Only the two "Never …" rules can be caught by looking at the text.
 * "Always credit sources" and "No jargon without explanation" are
 * advisory — a phrase can mention "credit sources" and still not credit
 * anything — so they are not patterns, and pretending otherwise would
 * make the check wrong in both directions.
 */
const VOICE_VIOLATIONS = [
  {
    rule: 'Never invent facts about artists',
    patterns: [
      /\b(invent\w*|make\s+up|made\s+up|fabricat\w+|guess\w*)\b[^.!?]*\b(fact|facts|artist|artists|track|tracks|album|albums|song|songs)\b/i,
    ],
  },
  {
    rule: 'Never use aggressive sales tactics',
    patterns: [
      /\b(aggressive|hard[\s-]?sell|buy\s+now|act\s+now|limited\s+time|guaranteed\s+(?:hit|seller))\b/i,
    ],
  },
];

/**
 * Check a piece of text against the twin's voice rules.
 *
 * @param {string} text
 * @returns {string[]} the rules the text breaks (empty when clean).
 */
function checkVoice(text) {
  const haystack = String(text == null ? '' : text);
  const issues = [];
  for (const { rule, patterns } of VOICE_VIOLATIONS) {
    if (patterns.some((p) => p.test(haystack))) {
      issues.push(`Violates: ${rule}`);
    }
  }
  return issues;
}

/**
 * Score one option against the twin's voice and focus.
 *
 * The score answers "how sure is the twin about this?" and is read
 * against `TWIN_IDENTITY.confidenceThreshold` (0.85):
 *
 *   0.60  the base — the twin has no signal either way
 *   +0.25 per focus area the text lands in (capped at 1.0)
 *   −0.30 a voice rule the text breaks
 *
 * So one focus area with a clean voice lands exactly on the threshold
 * and proceeds; two land above it; a text outside the twin's lane, or
 * one that breaks a rule, stays below and escalates to the human.
 *
 * @param {string} option
 * @returns {{option: string, score: number, issues: string[], focusHits: string[]}}
 */
function scoreOption(option) {
  const text = String(option == null ? '' : option);
  const lower = text.toLowerCase();
  const focusHits = TWIN_IDENTITY.voice.focus.filter((f) => lower.includes(f));
  const issues = checkVoice(text);
  let score = 0.6 + 0.25 * focusHits.length;
  if (issues.length > 0) score -= 0.3;
  return { option: text, score: Math.max(0, Math.min(1, score)), issues, focusHits };
}

/**
 * Choose between options.
 *
 * @param {string[]} options
 * @param {string} [context] unused by the current scoring, kept for the
 *   interface the agent's `decide` command exposes.
 * @returns {{decision: string, confidence: number, belowThreshold: boolean,
 *   issues: string[], alternatives: string[]}}
 */
function decide(options, context = '') {
  const list = (Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean);
  if (list.length === 0) {
    return { decision: '', confidence: 0, belowThreshold: true, issues: [], alternatives: [] };
  }

  const scored = list.map(scoreOption).sort((a, b) => b.score - a.score);
  const winner = scored[0];

  return {
    decision: winner.option,
    confidence: winner.score,
    belowThreshold: winner.score < TWIN_IDENTITY.confidenceThreshold,
    issues: winner.issues,
    alternatives: scored.slice(1, 4).map((s) => s.option),
  };
}

/**
 * Plan for a task handed over by the orchestrator.
 *
 * The same scoring as `decide`, applied to a single piece of work: a task
 * that lands in one of the twin's focus areas is clear enough to proceed;
 * a task that breaks a voice rule, or that touches nothing the twin
 * knows about, goes to the human.
 *
 * @param {string} task
 * @returns {{verdict: 'proceed'|'escalate', confidence: number,
 *   belowThreshold: boolean, issues: string[], focusHits: string[],
 *   summary: string}}
 */
function planFor(task) {
  const text = String(task == null ? '' : task).trim();
  const scored = scoreOption(text);
  const belowThreshold = scored.score < TWIN_IDENTITY.confidenceThreshold;
  const verdict = belowThreshold ? 'escalate' : 'proceed';

  // The summary is the REASON, not the verdict — the verdict travels
  // beside it ("Plan: proceed — lo-fi hip hop (confidence 85%)"), and
  // baking it into the summary too produced "proceed — Proceed — …".
  let summary;
  if (scored.issues.length) {
    summary = scored.issues.join('; ');
  } else if (scored.focusHits.length) {
    summary = scored.focusHits.join(', ');
  } else {
    summary = 'outside the twin’s focus';
  }

  return {
    verdict,
    confidence: scored.score,
    belowThreshold,
    issues: scored.issues,
    focusHits: scored.focusHits,
    summary,
  };
}

module.exports = { TWIN_IDENTITY, checkVoice, scoreOption, decide, planFor };
