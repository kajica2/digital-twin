#!/usr/bin/env node
/**
 * SWR-Check's claim search.
 *
 * The search for a claim in a repo's markdown. It lives in its own
 * module because it is the one piece of the check agent that can be
 * wrong in a way nobody notices: a claim search that finds the WRONG
 * file reports a PASS, and a PASS moves a task off the board.
 *
 * Two things went wrong before, and both are prevented here:
 *
 *   1. The claim was interpolated into a SHELL string, so a claim with
 *      spaces was word-split and grep searched for its first word
 *      alone. "Write liner notes for a lo-fi hip hop vinyl reissue"
 *      searched for "Write" — which matched a vendored
 *      node_modules README, and the check PASSED on a file that has
 *      nothing to do with the claim. The args are argv now, and the
 *      claim is one element behind a `--` terminator.
 *
 *   2. The search walked node_modules, dist and .git, so a vendored
 *      file could satisfy a claim about the project's own work. Those
 *      directories are excluded.
 *
 * Plain Node, no dependencies.
 */

'use strict';

const { spawnSync } = require('node:child_process');

/** Directories a claim search must never look in: vendored, built, or VCS data. */
const SEARCH_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor'];

/**
 * Build the argv for a claim search.
 *
 * @param {string} claim the text to look for.
 * @param {string} repoDir the repo to search.
 * @returns {string[]} argv for grep.
 */
function claimSearchArgs(claim, repoDir) {
  const args = ['-r', '-F', '-l', '--include=*.md'];
  for (const dir of SEARCH_EXCLUDES) args.push(`--exclude-dir=${dir}`);
  args.push('--', String(claim), String(repoDir));
  return args;
}

/**
 * Search a repo's markdown for a claim.
 *
 * @param {string} claim the text to look for.
 * @param {string} repoDir the repo to search.
 * @returns {{found: boolean, evidence: string, matches: string[]}}
 */
function searchClaim(claim, repoDir) {
  const text = String(claim == null ? '' : claim).trim();
  if (!text) return { found: false, evidence: 'empty claim', matches: [] };

  const result = spawnSync('grep', claimSearchArgs(text, repoDir), {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const matches = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (matches.length === 0) {
    return { found: false, evidence: `not found in the repo's markdown: ${text}`, matches };
  }

  // The evidence names the file AND the line that matched, so a reader
  // can see that the file really carries the claim. Same exclusions,
  // but without -l so grep prints the matching line.
  const lineArgs = claimSearchArgs(text, repoDir).filter((a) => a !== '-l');
  const line = spawnSync('grep', lineArgs, { cwd: repoDir, encoding: 'utf8' });
  const evidence = String(line.stdout || '').trim().split('\n')[0] || matches[0];

  return { found: true, evidence, matches };
}

module.exports = { SEARCH_EXCLUDES, claimSearchArgs, searchClaim };
