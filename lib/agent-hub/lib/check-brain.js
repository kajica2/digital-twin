#!/usr/bin/env node
/**
 * SWR-Check's brain — pure logic, no filesystem, no network.
 *
 * The agent decides WHAT to verify; this module decides what a
 * verification result looks like and how a result is rendered. Keeping
 * the wording here means the agent and the tests agree on it.
 */

/** The verification kinds the agent understands. */
const VERIFICATION_TYPES = ['file', 'tests', 'claim', 'diff'];

/**
 * The verb a user types → the verification type it maps to.
 *
 * The CLI says `test`; the type is `tests`. Without this map, `check
 * test` was classified as unknown and never ran.
 */
const VERB_ALIASES = { test: 'tests' };

/**
 * Classify a verification request.
 *
 * `file <path>`   → a file check
 * `test`          → the repo's own check suite
 * `claim <text>`  → a claim, searched for in the docs
 * `diff <text>`   → a working-tree diff summary
 *
 * A request may also carry a `verify:` prefix — that is the shape the
 * twin sends (`Verify: <task>`). The prefix is stripped before
 * classifying, so `Verify: file pages/x.html` is a file check and not
 * an unknown one.
 *
 * @param {string} request
 * @returns {{type: string, target: string}}
 */
function classifyRequest(request) {
  let text = String(request == null ? '' : request).trim();
  const prefixed = /^verify\s*:\s*(.*)$/i.exec(text);
  if (prefixed) text = prefixed[1].trim();

  const spaceAt = text.indexOf(' ');
  const verb = (spaceAt === -1 ? text : text.slice(0, spaceAt)).toLowerCase();
  const target = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();

  const type = VERB_ALIASES[verb] || verb;
  if (VERIFICATION_TYPES.includes(type)) return { type, target };
  return { type: 'unknown', target: text };
}

/**
 * Is a request a task to be done, rather than a claim to be checked?
 *
 * The twin asks the check agent to verify a TASK ("Write liner notes
 * for a lo-fi hip hop vinyl reissue"). That is not a claim: there is
 * no sentence to look for in the docs, and treating it as one made the
 * verifier grep for a single word of it and "pass" on an unrelated
 * file. A task-shaped request is not verifiable by a grep, and the
 * honest answer is that it needs a file or a diff to check.
 *
 * @param {string} request
 * @returns {boolean}
 */
function isTaskShaped(request) {
  const { type, target } = classifyRequest(request);
  // A request that names a verification type is a request, whatever
  // it says. A bare sentence is judged on its own words.
  const text = type === 'unknown' ? String(target || '').trim() : '';
  if (!text) return false;
  // An imperative verb at the head of the sentence.
  return /^(write|build|make|create|add|fix|ship|record|design|draft|compose|remix|cover|index|post|publish|render|install|set ?up|clean|review|research)\b/i.test(text);
}

/**
 * The honest answer to a request that is a TASK rather than a check.
 *
 * There is nothing to verify: the work has not happened yet. A grep
 * that happens to match the task's first word is how a false PASS
 * happened, so a task is refused with a stated reason instead.
 *
 * @param {string} task
 * @returns {{type: string, target: string, passed: boolean, evidence: string}}
 */
function refuseTask(task) {
  return buildResult(
    'task',
    task,
    false,
    'a task is not a claim — name a file to check it, or a claim to look for'
  );
}

/** Directories a claim search must never look in: vendored, built, or VCS data. */
const { SEARCH_EXCLUDES, claimSearchArgs } = require('./claim-search.js');

/**
 * Phrase a task as a verification request the check agent can act on.
 *
 * A task that names a file is verified as a file ("does this exist?").
 * A task that names nothing is verified as a claim ("is this written
 * down?"). Anything else is left to the check agent to refuse.
 *
 * @param {string} task
 * @returns {string} a request string for the check agent.
 */
function verificationRequest(task) {
  const text = String(task == null ? '' : task).trim();
  const path = findPathToken(text);
  if (path) return `file ${path}`;
  return `claim ${text}`;
}

/**
 * Find a path-like token in a sentence ("docs/REEL-WATCHER.md",
 * "src/index.js", "README.md").
 *
 * @param {string} text
 * @returns {string} the token, or '' when there is none.
 */
function findPathToken(text) {
  const body = String(text == null ? '' : text);
  const match = /(?:^|[\s'"(])([A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6})(?:$|[\s'",);:!?])/.exec(body);
  if (!match) return '';
  const token = match[1];
  // A bare word with a dot ("e.g") is not a path.
  if (!token.includes('.') || token.endsWith('.')) return '';
  return token;
}

/**
 * Build a verification result.
 *
 * @param {string} type one of VERIFICATION_TYPES.
 * @param {string} target what was checked.
 * @param {boolean} passed
 * @param {string} evidence the proof — the command output, the path, the
 *   matched file. Never empty: an unevidenced result is not a result.
 * @returns {{type: string, target: string, passed: boolean, evidence: string}}
 */
function buildResult(type, target, passed, evidence) {
  const text = String(evidence == null ? '' : evidence).trim();
  return {
    type: String(type),
    target: String(target == null ? '' : target),
    passed: Boolean(passed),
    evidence: text || (passed ? 'ok' : 'no evidence'),
  };
}

/**
 * Render a verification result as the agent's log line.
 *
 * @param {{type: string, target: string, passed: boolean, evidence: string}} result
 * @returns {string}
 */
function renderResult(result) {
  const mark = result.passed ? 'PASS' : 'FAIL';
  return `${result.type}:${result.target || '(none)'} → ${mark} — ${result.evidence}`;
}

/**
 * Render the verification as a markdown section, the shape the
 * `check/verifications.md` ledger stores.
 *
 * @param {{type: string, target: string, passed: boolean, evidence: string}} result
 * @param {string} [iso] timestamp; defaults to now.
 * @returns {string}
 */
function renderLedgerEntry(result, iso = new Date().toISOString()) {
  return `\n## ${iso}\n- Type: ${result.type}\n- Target: ${result.target}\n- Passed: ${result.passed}\n- Evidence: ${result.evidence}\n`;
}

/**
 * Count the verifications in a ledger body.
 *
 * @param {string} content
 * @returns {number}
 */
function countVerifications(content) {
  return (String(content == null ? '' : content).match(/^##/gm) || []).length;
}

module.exports = {
  VERIFICATION_TYPES,
  VERB_ALIASES,
  SEARCH_EXCLUDES,
  classifyRequest,
  isTaskShaped,
  refuseTask,
  claimSearchArgs,
  verificationRequest,
  findPathToken,
  buildResult,
  renderResult,
  renderLedgerEntry,
  countVerifications,
};
