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
 * ── the pending-verification ledger ────────────────────────────────────
 *
 * When ops dispatches a verification to the check agent, the check
 * agent's reply carries ONLY what it verified — a path, a claim — with
 * no correlation id. Two tasks can name the same file ("write the
 * liner notes in agents/TASKS.md" and "index the low-tide notes in
 * agents/TASKS.md"), so the reply alone cannot say which board entry
 * it belongs to. Matching the subject against the board picked the
 * wrong one: the containment match moved a task nobody had verified
 * into Done.
 *
 * The ledger is the record of what was dispatched FOR which task, so a
 * reply is resolved against the dispatch, not against the board's text.
 * Ops dispatches one verification at a time and the check agent
 * answers in dispatch order, so equal targets resolve oldest-first.
 */

/**
 * An empty pending ledger.
 *
 * @returns {Array<{task: string, request: string, target: string, at: string}>}
 */
function emptyPending() {
  return [];
}

/**
 * Record a dispatched verification.
 *
 * @param {Array} ledger
 * @param {{task: string, request?: string, target?: string, at?: string}} entry
 * @returns {Array} a new ledger with the entry appended
 */
function addPending(ledger, entry) {
  const list = Array.isArray(ledger) ? [...ledger] : [];
  const task = String(entry && entry.task != null ? entry.task : '').trim();
  if (!task) return list;
  list.push({
    task,
    request: String(entry && entry.request != null ? entry.request : ''),
    target: String(entry && entry.target != null ? entry.target : '').trim(),
    at: String(entry && entry.at != null ? entry.at : ''),
  });
  return list;
}

/**
 * Score a pending entry against a verification subject.
 *
 * Exact wins over containment; containment is a weaker hint.
 *
 * @param {{target?: string}} entry
 * @param {string} wanted
 * @returns {number} 0 for no match, 1 for containment, 2 for exact
 */
function pendingMatches(entry, wanted) {
  const t = String(entry && entry.target != null ? entry.target : '').trim().toLowerCase();
  const w = String(wanted == null ? '' : wanted).trim().toLowerCase();
  if (!t || !w) return 0;
  if (t === w) return 2;
  if (t.includes(w) || w.includes(t)) return 1;
  return 0;
}

/**
 * Find the pending entry a reply belongs to.
 *
 * Ties go to the OLDEST entry: ops dispatches one verification at a
 * time and the check agent answers in dispatch order, so the first
 * reply is the first dispatch.
 *
 * @param {Array} ledger
 * @param {string} wanted the subject the check agent reported
 * @returns {number} the index of the entry, or -1
 */
function matchPending(ledger, wanted) {
  let best = -1;
  let bestScore = 0;
  (Array.isArray(ledger) ? ledger : []).forEach((entry, index) => {
    const score = pendingMatches(entry, wanted);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

/**
 * Take (consume) the pending entry a reply belongs to.
 *
 * @param {Array} ledger
 * @param {string} wanted
 * @returns {{ledger: Array, entry: object|null}}
 */
function takePending(ledger, wanted) {
  const list = Array.isArray(ledger) ? [...ledger] : [];
  const index = matchPending(list, wanted);
  if (index === -1) return { ledger: list, entry: null };
  const entry = list.splice(index, 1)[0];
  return { ledger: list, entry };
}

/**
 * Complete a task by its EXACT board text.
 *
 * Unlike completeTask, this never matches loosely and never invents a
 * Done entry for a task that is not on the board: the task text came
 * from the board in the first place, and a loose match is what moved
 * the wrong task.
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @param {string} task
 * @returns {{board: object, moved: boolean, message: string}}
 */
function completeTaskExact(board, task) {
  const current = {
    blocked: [...(board.blocked || [])],
    inProgress: [...(board.inProgress || [])],
    done: [...(board.done || [])],
  };

  const wanted = String(task == null ? '' : task).trim();
  if (!wanted) return { board: current, moved: false, message: 'Nothing to complete' };

  const inProgress = current.inProgress.findIndex((t) => String(t).trim() === wanted);
  if (inProgress !== -1) {
    const moved = current.inProgress.splice(inProgress, 1)[0];
    if (!current.done.includes(moved)) current.done.push(moved);
    return { board: current, moved: true, message: `Completed: ${moved}` };
  }

  const blocked = current.blocked.findIndex((t) => String(t).trim() === wanted);
  if (blocked !== -1) {
    const moved = current.blocked.splice(blocked, 1)[0];
    if (!current.done.includes(moved)) current.done.push(moved);
    return { board: current, moved: true, message: `Completed: ${moved}` };
  }

  if (current.done.some((t) => String(t).trim() === wanted)) {
    return { board: current, moved: false, message: `Already done: ${wanted}` };
  }

  return { board: current, moved: false, message: `Not on the board: ${wanted}` };
}

/**
 * Apply a verification reply to the board.
 *
 * A reply that matches a dispatched verification completes the task
 * that verification was dispatched FOR — exact text, no loose match,
 * no invented Done entry. A failed verification consumes its entry and
 * leaves the board alone.
 *
 * A reply with no matching dispatch (a hand-driven `check` request)
 * keeps the old behaviour: the verification is the evidence, so the
 * subject is recorded in Done.
 *
 * @param {{blocked: string[], inProgress: string[], done: string[]}} board
 * @param {Array} ledger
 * @param {string} subject what the check agent reported
 * @param {boolean} passed
 * @returns {{board: object, ledger: Array, matched: boolean, moved: boolean, message: string}}
 */
function applyVerification(board, ledger, subject, passed) {
  const current = {
    blocked: [...(board.blocked || [])],
    inProgress: [...(board.inProgress || [])],
    done: [...(board.done || [])],
  };
  const wanted = String(subject == null ? '' : subject).trim();
  const taken = takePending(ledger, wanted);

  if (taken.entry) {
    if (!passed) {
      return {
        board: current,
        ledger: taken.ledger,
        matched: true,
        moved: false,
        message: `Verification failed: ${taken.entry.task}`,
      };
    }
    const applied = completeTaskExact(current, taken.entry.task);
    return {
      board: applied.board,
      ledger: taken.ledger,
      matched: true,
      moved: applied.moved,
      message: applied.message,
    };
  }

  if (passed && wanted) {
    const applied = completeTask(current, wanted);
    return {
      board: applied.board,
      ledger: taken.ledger,
      matched: false,
      moved: applied.moved,
      message: applied.message,
    };
  }

  return {
    board: current,
    ledger: taken.ledger,
    matched: false,
    moved: false,
    message: passed ? '' : `Verification failed: ${wanted}`,
  };
}

/**
 * Parse a persisted pending ledger.
 *
 * A corrupt file is an empty ledger: the dispatch record is a
 * convenience, and losing it must not take the agent down.
 *
 * @param {string} content
 * @returns {Array}
 */
function parsePending(content) {
  const text = String(content == null ? '' : content).trim();
  if (!text) return emptyPending();
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return emptyPending();
    return parsed
      .filter((entry) => entry && typeof entry === 'object' && String(entry.task || '').trim())
      .map((entry) => ({
        task: String(entry.task).trim(),
        request: String(entry.request || ''),
        target: String(entry.target || '').trim(),
        at: String(entry.at || ''),
      }));
  } catch {
    return emptyPending();
  }
}

/**
 * Read the task out of a "Verify task: <task>" message.
 *
 * The twin no longer talks to the check agent directly: it hands the
 * TASK back to ops, and ops is the only dispatcher — so ops knows
 * which task every verification belongs to. The contract is one
 * message form, and this is the one place it is parsed.
 *
 * @param {string} body
 * @returns {string|null} the task text, or null when the message is
 *   not a verify-task request
 */
function parseVerifyTask(body) {
  const text = String(body == null ? '' : body).trim();
  const match = /^verify\s+task\s*:\s*(.+)$/i.exec(text);
  if (!match) return null;
  const task = match[1].trim();
  return task ? task : null;
}

/**
 * Render the pending ledger for persistence.
 *
 * @param {Array} ledger
 * @returns {string}
 */
function renderPending(ledger) {
  return `${JSON.stringify(Array.isArray(ledger) ? ledger : [], null, 2)}\n`;
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
  emptyPending,
  addPending,
  pendingMatches,
  matchPending,
  takePending,
  completeTaskExact,
  applyVerification,
  parsePending,
  renderPending,
  parseVerifyTask,
};
