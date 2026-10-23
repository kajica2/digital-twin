#!/usr/bin/env node
/**
 * SWR-Ops's brain — the task board, as pure logic.
 *
 * The board is three lists (blocked / in progress / done). It is stored
 * as markdown so it can be read by a human without the agent running.
 */

const BOARD_SECTIONS = ['Blocked', 'In Progress', 'Done'];

/**
 * An empty board.
 *
 * @returns {{blocked: string[], inProgress: string[], done: string[]}}
 */
function emptyBoard() {
  return { blocked: [], inProgress: [], done: [] };
}

/**
 * Parse a task board from markdown.
 *
 * @param {string} content
 * @returns {{blocked: string[], inProgress: string[], done: string[]}}
 */
function parseBoard(content) {
  const board = emptyBoard();
  const text = String(content == null ? '' : content);

  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const heading = /^###\s+(.*)$/.exec(line);
    if (heading) {
      const name = heading[1].trim();
      section = BOARD_SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase()) || null;
      continue;
    }
    if (!section) continue;

    const item = /^-\s*\[( |x|X)\]\s*(.+)$/.exec(line);
    if (!item) continue;

    const text2 = item[2].trim();
    if (!text2) continue;

    if (section === 'Blocked') board.blocked.push(text2);
    else if (section === 'In Progress') board.inProgress.push(text2);
    else board.done.push(text2);
  }

  return board;
}

/**
 * Render a task board as markdown.
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @param {string} [iso] timestamp for the footer.
 * @returns {string}
 */
function renderBoard(board, iso = new Date().toISOString()) {
  const b = board || emptyBoard();
  const list = (items, done) =>
    (items || []).map((t) => `- [${done ? 'x' : ' '}] ${t}`).join('\n');

  return `# SWR-Ops Task Board

### Blocked
${list(b.blocked)}

### In Progress
${list(b.inProgress)}

### Done
${list(b.done, true)}

---
Last updated: ${iso}
`;
}

/**
 * Apply a command to a board.
 *
 * `add <task>`    → into In Progress
 * `done`          → the first In Progress task moves to Done
 * `block`         → the first In Progress task moves to Blocked
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @param {string} command
 * @returns {{board: object, action: string, task: string|null, message: string}}
 */
function applyCommand(board, command) {
  const current = {
    blocked: [...(board.blocked || [])],
    inProgress: [...(board.inProgress || [])],
    done: [...(board.done || [])],
  };

  const text = String(command == null ? '' : command).trim();
  const spaceAt = text.indexOf(' ');
  const verb = (spaceAt === -1 ? text : text.slice(0, spaceAt)).toLowerCase();
  const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();

  switch (verb) {
    case 'add': {
      if (!args) return { board: current, action: 'add', task: null, message: 'nothing to add' };
      current.inProgress.push(args);
      return { board: current, action: 'add', task: args, message: `Added: ${args}` };
    }
    case 'done': {
      const task = current.inProgress.shift();
      if (!task) return { board: current, action: 'done', task: null, message: 'nothing in progress' };
      current.done.push(task);
      return { board: current, action: 'done', task, message: `Completed: ${task}` };
    }
    case 'block': {
      const task = current.inProgress.shift();
      if (!task) return { board: current, action: 'block', task: null, message: 'nothing in progress' };
      current.blocked.push(task);
      return { board: current, action: 'block', task, message: `Blocked: ${task}` };
    }
    default:
      return { board: current, action: verb || 'unknown', task: null, message: `Unknown: ${verb}` };
  }
}

/**
 * Score how well a board entry matches a verification subject.
 *
 * The check agent reports what it VERIFIED (a file path, a claim), not
 * the task it came from — so the two strings are related but not equal.
 * An exact match scores highest; a containment match scores by the
 * length of the fragment that is shared, so a specific entry
 * ("… in agents/TASKS.md") beats a short generic one ("liner notes").
 *
 * @param {string} entry a task as it is written on the board
 * @param {string} wanted the verification subject
 * @returns {number} 0 for no match, otherwise the shared length
 */
function matchScore(entry, wanted) {
  const e = String(entry == null ? '' : entry).trim().toLowerCase();
  const w = String(wanted == null ? '' : wanted).trim().toLowerCase();
  if (!e || !w) return 0;
  if (e === w) return Math.max(e.length, w.length);
  if (e.includes(w)) return w.length;
  if (w.includes(e)) return e.length;
  return 0;
}

/**
 * Find the board entry that best matches a verification subject.
 *
 * @param {string[]} entries
 * @param {string} wanted
 * @returns {number} the index of the best match, or -1
 */
function bestMatch(entries, wanted) {
  let best = -1;
  let bestScore = 0;
  (entries || []).forEach((entry, index) => {
    const score = matchScore(entry, wanted);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

/**
 * Move a task to Done because it was verified.
 *
 * The task may be in In Progress (the usual case) or in Blocked (a
 * blocked task that was later proven). The BOARD's own text is the
 * record of the task and is what moves — the verification subject is
 * only the pointer that says which task it was.
 *
 * A task that is not on the board is added to Done — the verification is
 * the evidence, and dropping it would lose the only record that the
 * work finished.
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @param {string} task
 * @returns {{board: object, moved: boolean, message: string}}
 */
function completeTask(board, task) {
  const current = {
    blocked: [...(board.blocked || [])],
    inProgress: [...(board.inProgress || [])],
    done: [...(board.done || [])],
  };

  const wanted = String(task == null ? '' : task).trim();
  if (!wanted) return { board: current, moved: false, message: 'Nothing to complete' };

  let moved = null;
  const fromProgress = bestMatch(current.inProgress, wanted);
  if (fromProgress !== -1) {
    moved = current.inProgress.splice(fromProgress, 1)[0];
  } else {
    const fromBlocked = bestMatch(current.blocked, wanted);
    if (fromBlocked !== -1) moved = current.blocked.splice(fromBlocked, 1)[0];
  }

  const record = moved || wanted;
  if (!current.done.includes(record)) current.done.push(record);
  return { board: current, moved: true, message: `Completed: ${record}` };
}

/**
 * The board's counts, for the status line.
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @returns {{blocked: number, inProgress: number, done: number, total: number}}
 */
function boardCounts(board) {
  const b = board || emptyBoard();
  const blocked = (b.blocked || []).length;
  const inProgress = (b.inProgress || []).length;
  const done = (b.done || []).length;
  return { blocked, inProgress, done, total: blocked + inProgress + done };
}

module.exports = {
  BOARD_SECTIONS,
  emptyBoard,
  parseBoard,
  renderBoard,
  applyCommand,
  completeTask,
  matchScore,
  bestMatch,
  boardCounts,
};
