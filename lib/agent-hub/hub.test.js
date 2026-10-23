#!/usr/bin/env node
/**
 * SWR Agent Hub — unit suite.
 *
 * Covers the four modules the three agents are built from:
 *   hub-runtime  — the message protocol, the inbox, the isolation root
 *   ops-brain    — the task board
 *   twin-brain   — the voice rules, the decision, the plan
 *   check-brain  — the verification shapes
 *
 * No processes are started, no network is touched, and every file the
 * suite writes goes into a temp directory it removes afterwards.
 *
 * Plain Node, no test framework. The repo's canonical shape.
 */

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hub = require('./lib/hub-runtime.js');
const opsBrain = require('./lib/ops-brain.js');
const twinBrain = require('./lib/twin-brain.js');
const checkBrain = require('./lib/check-brain.js');
const claimSearch = require('./lib/claim-search.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
  }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swr-hub-test-'));
}

// ───────────────────────────────────────────────────────────── 1. envelopes

check('formatMessage writes [FROM→TO] body', () => {
  assert.equal(hub.formatMessage('ops', 'twin', 'New task: x'), '[OPS→TWIN] New task: x');
});

check('formatMessage is case-insensitive about the ids', () => {
  assert.equal(hub.formatMessage('OPS', 'TWIN', 'hi'), '[OPS→TWIN] hi');
});

check('formatMessage trims trailing whitespace', () => {
  assert.equal(hub.formatMessage('ops', 'twin', 'hi   '), '[OPS→TWIN] hi');
});

check('formatMessage survives a null body', () => {
  assert.equal(hub.formatMessage('ops', 'twin', null), '[OPS→TWIN] ');
});

check('parseMessage reads an envelope back', () => {
  const parsed = hub.parseMessage('[OPS→TWIN] New task: build the reel');
  assert.equal(parsed.from, 'ops');
  assert.equal(parsed.to, 'twin');
  assert.equal(parsed.body, 'New task: build the reel');
});

check('parseMessage lowercases the ids', () => {
  const parsed = hub.parseMessage('[OPS→TWIN] x');
  assert.equal(parsed.from, 'ops');
  assert.equal(parsed.to, 'twin');
});

check('parseMessage returns null for a plain line', () => {
  assert.equal(hub.parseMessage('just a note'), null);
});

check('parseMessage returns null for an empty line', () => {
  assert.equal(hub.parseMessage(''), null);
});

check('parseMessage returns null for a half-written envelope', () => {
  assert.equal(hub.parseMessage('[OPS→] no recipient'), null);
});

check('a message round-trips through format and parse', () => {
  const line = hub.formatMessage('check', 'ops', 'Verified: PASS — evidence');
  const parsed = hub.parseMessage(line);
  assert.equal(parsed.from, 'check');
  assert.equal(parsed.to, 'ops');
  assert.equal(parsed.body, 'Verified: PASS — evidence');
});

check('the envelope round-trip survives a body with an arrow in it', () => {
  const line = hub.formatMessage('ops', 'twin', 'a → b');
  const parsed = hub.parseMessage(line);
  assert.equal(parsed.body, 'a → b');
});

check('isAgentId knows the three agents', () => {
  assert.equal(hub.isAgentId('ops'), true);
  assert.equal(hub.isAgentId('twin'), true);
  assert.equal(hub.isAgentId('check'), true);
  assert.equal(hub.isAgentId('OPS'), true);
  assert.equal(hub.isAgentId('personas'), false);
  assert.equal(hub.isAgentId(''), false);
});

// ───────────────────────────────────────────────────────── 2. the inbox

/** The message files sitting in an agent's inbox. */
function inboxFiles(root, agent) {
  let names = [];
  try {
    names = fs.readdirSync(hub.inboxDir(root, agent));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(hub.MESSAGE_EXT)).sort();
}

/** Drop a raw envelope (or anything else) into an agent's inbox dir. */
function writeInboxFile(root, agent, content, name) {
  const dir = hub.inboxDir(root, agent);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** The command files queued for an agent. */
function commandFiles(root, agent) {
  let names = [];
  try {
    names = fs.readdirSync(hub.commandDir(root, agent));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(hub.MESSAGE_EXT)).sort();
}

check('appendMessage writes into the RECIPIENT inbox', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'hello');
  assert.ok(fs.existsSync(hub.inboxDir(root, 'twin')));
  assert.equal(inboxFiles(root, 'twin').length, 1);
  assert.equal(inboxFiles(root, 'ops').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

check('appendMessage returns the envelope it wrote', () => {
  const root = tmpRoot();
  const line = hub.appendMessage(root, 'ops', 'twin', 'hello');
  assert.equal(line, '[OPS→TWIN] hello');
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages returns the message addressed to the agent', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'hello');
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].body, 'hello');
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages consumes the message — the inbox is empty afterwards', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'hello');
  hub.takeMessages(root, 'twin');
  assert.equal(hub.takeMessages(root, 'twin').length, 0);
  assert.equal(inboxFiles(root, 'twin').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

check('the inbox holds one file per message', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'one');
  hub.appendMessage(root, 'ops', 'twin', 'two');
  assert.equal(inboxFiles(root, 'twin').length, 2);
  hub.takeMessages(root, 'twin');
  assert.equal(inboxFiles(root, 'twin').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

check('messages are delivered in the order they were sent', () => {
  const root = tmpRoot();
  for (const body of ['one', 'two', 'three']) hub.appendMessage(root, 'ops', 'twin', body);
  const taken = hub.takeMessages(root, 'twin');
  assert.deepEqual(taken.map((m) => m.body), ['one', 'two', 'three']);
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages leaves a message addressed to somebody else in place', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'for twin');
  hub.appendMessage(root, 'ops', 'check', 'for check');
  const twin = hub.takeMessages(root, 'twin');
  assert.equal(twin.length, 1);
  assert.equal(twin[0].body, 'for twin');
  // The check agent's message is still waiting.
  const check = hub.takeMessages(root, 'check');
  assert.equal(check.length, 1);
  assert.equal(check[0].body, 'for check');
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages leaves a FOREIGN envelope in place, even inside its own inbox', () => {
  // A mis-routed envelope — addressed to check, but sitting in the
  // twin's inbox. The twin is not the one to consume it.
  const root = tmpRoot();
  const file = writeInboxFile(root, 'twin', '[OPS→CHECK] not for the twin\n', '0001-foreign.msg');
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 0);
  assert.ok(fs.existsSync(file), 'the foreign envelope was consumed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('[OPS→CHECK] not for the twin'));
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages takes only its own messages out of a mixed inbox', () => {
  const root = tmpRoot();
  writeInboxFile(root, 'twin', '[OPS→TWIN] mine one\n', '0001-mine.msg');
  writeInboxFile(root, 'twin', '[OPS→CHECK] not mine\n', '0002-not-mine.msg');
  writeInboxFile(root, 'twin', '[OPS→TWIN] mine two\n', '0003-mine.msg');
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 2);
  assert.deepEqual(taken.map((m) => m.body), ['mine one', 'mine two']);
  assert.deepEqual(inboxFiles(root, 'twin'), ['0002-not-mine.msg']);
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages leaves a non-envelope line in place', () => {
  const root = tmpRoot();
  const file = writeInboxFile(root, 'twin', 'a human note\n', '0001-note.msg');
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 0);
  assert.ok(fs.existsSync(file), 'a note that is not an envelope was consumed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('a human note'));
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages on a missing inbox returns nothing and does not throw', () => {
  const root = tmpRoot();
  assert.deepEqual(hub.takeMessages(root, 'twin'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeMessages leaves no temp or claim file behind', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'hello');
  hub.takeMessages(root, 'twin');
  const leftovers = fs
    .readdirSync(hub.inboxDir(root, 'twin'))
    .filter((f) => f.includes('.tmp-') || f.includes('.claimed-'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(root, { recursive: true, force: true });
});

check('two readers never consume the same message', () => {
  const root = tmpRoot();
  hub.appendMessage(root, 'ops', 'twin', 'only once');
  const first = hub.takeMessages(root, 'twin');
  const second = hub.takeMessages(root, 'twin');
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────── 2b. the race that ate messages

const HUB_PATH = path.join(__dirname, 'lib', 'hub-runtime.js');

/**
 * Run a writer and a reader against the same inbox, concurrently.
 *
 * The writer appends `count` messages while the reader drains the
 * inbox. The old shared-file inbox LOST messages here: the reader
 * rewrote the file (read → filter → temp file → rename) while the
 * writer was appending to it, and every append landing in that window
 * was destroyed with no error anywhere.
 *
 * @returns {{seen: number, unique: number}}
 */
function raceInbox(root, count) {
  const resultFile = path.join(root, 'race-result.json');
  const writer = path.join(root, 'race-writer.js');
  const reader = path.join(root, 'race-reader.js');

  fs.writeFileSync(
    writer,
    `const hub = require(${JSON.stringify(HUB_PATH)});\n` +
      `for (let i = 0; i < ${count}; i++) hub.appendMessage(${JSON.stringify(root)}, 'ops', 'twin', 'msg ' + i);\n`
  );

  fs.writeFileSync(
    reader,
    `const fs = require('node:fs');\n` +
      `const hub = require(${JSON.stringify(HUB_PATH)});\n` +
      `function nap(ms){ const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }\n` +
      `const seen = [];\n` +
      `const deadline = Date.now() + 8000;\n` +
      `while (seen.length < ${count} && Date.now() < deadline) {\n` +
      `  for (const m of hub.takeMessages(${JSON.stringify(root)}, 'twin')) seen.push(m.body);\n` +
      `  if (seen.length < ${count}) nap(2);\n` +
      `}\n` +
      `fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ seen: seen.length, unique: new Set(seen).size }));\n`
  );

  execFileSync('bash', ['-c', `node ${JSON.stringify(writer)} & node ${JSON.stringify(reader)}; wait`], {
    cwd: root,
    stdio: 'ignore',
  });

  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

check('a message written while another is taken is NEVER lost', () => {
  const root = tmpRoot();
  const result = raceInbox(root, 300);
  assert.equal(result.unique, 300, `only ${result.unique} of 300 messages survived the race`);
  assert.equal(result.seen, 300, `the reader saw ${result.seen} of 300 messages`);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the temp-file trap, deterministically

check("a reader never claims a writer's in-flight temp file", () => {
  // A writer creates `.tmp-<name>.msg`, writes into it, then renames it
  // to `<name>.msg`. A reader that treats the temp file as a message
  // renames it aside — which makes the WRITER's rename fail with
  // ENOENT and kills the writer mid-batch. Measured on a 300-message
  // batch: 297 lost, the writer dead on the fourth message.
  //
  // The race test above catches it, but only when the timing lines up.
  // This is the same trap, provoked on purpose.
  const root = tmpRoot();
  hub.ensureLayout(root);
  const dir = hub.inboxDir(root, 'twin');
  const tmpName = '.tmp-000000175300000000-000123-000000-abc123.msg';
  const tmpFile = path.join(dir, tmpName);
  fs.writeFileSync(tmpFile, '[OPS→TWIN] half written\n');

  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 0, 'the reader consumed a temp file');
  assert.ok(fs.existsSync(tmpFile), 'the reader stole the writer\'s temp file');
  fs.rmSync(root, { recursive: true, force: true });
});

check("a writer survives a temp file that vanished under it", () => {
  // Defence in depth: even if a reader (or a prune) removes the temp
  // file, the writer must not die — it takes a fresh name and carries
  // on. A message must never die with its writer.
  const root = tmpRoot();
  hub.ensureLayout(root);
  const realRename = fs.renameSync;
  let stolen = 0;
  fs.renameSync = function patchedRename(from, to) {
    // A reader claims the temp file the instant it is created, so the
    // writer's own rename finds nothing there. Steal only the FIRST
    // one — the writer's retry must then get through.
    if (stolen === 0 && String(from).includes('.tmp-')) {
      stolen += 1;
      realRename.call(fs, from, `${from}.stolen`);
      const err = new Error('ENOENT: no such file or directory, rename');
      err.code = 'ENOENT';
      throw err;
    }
    return realRename.call(fs, from, to);
  };
  try {
    const line = hub.appendMessage(root, 'ops', 'twin', 'survives a stolen temp file');
    assert.equal(line, '[OPS→TWIN] survives a stolen temp file');
    assert.ok(stolen > 0, 'the patch never fired — the test proved nothing');
  } finally {
    fs.renameSync = realRename;
  }
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 1, 'the message did not arrive');
  fs.rmSync(root, { recursive: true, force: true });
});

check('an already-claimed message is never read twice', () => {
  const root = tmpRoot();
  hub.ensureLayout(root);
  const dir = hub.inboxDir(root, 'twin');
  fs.writeFileSync(
    path.join(dir, `.claimed-99999-000000175300000000-000123-000000-abc123.msg`),
    '[OPS→TWIN] already taken\n'
  );
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 0, 'a claimed message was read again');
  fs.rmSync(root, { recursive: true, force: true });
});

check('a command that is still being written is not consumed', () => {
  // The same trap in the command channel: the CLI writes
  // `.tmp-<name>.msg` and renames it into place. A reader that listed
  // it would consume a half-written command — and the CLI's own
  // rename would then fail, losing the command.
  const root = tmpRoot();
  hub.ensureLayout(root);
  const dir = hub.commandDir(root, 'ops');
  const tmpFile = path.join(dir, '.tmp-000000175300000000-000123-000000-abc123.msg');
  fs.writeFileSync(tmpFile, 'add a half-writ');

  assert.equal(hub.peekCommand(root, 'ops'), null, 'a half-written command was returned');
  assert.equal(hub.takeCommand(root, 'ops'), null, 'a half-written command was consumed');
  assert.ok(fs.existsSync(tmpFile), 'the half-written command was consumed');
  fs.rmSync(root, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────── 3. commands

check('peekCommand reads without consuming', () => {
  const root = tmpRoot();
  hub.queueCommand(root, 'ops', 'add a task');
  assert.equal(hub.peekCommand(root, 'ops'), 'add a task');
  assert.equal(hub.peekCommand(root, 'ops'), 'add a task');
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeCommand consumes the command', () => {
  const root = tmpRoot();
  hub.queueCommand(root, 'ops', 'add a task');
  assert.equal(hub.takeCommand(root, 'ops'), 'add a task');
  assert.equal(hub.takeCommand(root, 'ops'), null);
  assert.deepEqual(commandFiles(root, 'ops'), []);
  fs.rmSync(root, { recursive: true, force: true });
});

check('two commands sent in a row are BOTH delivered', () => {
  // The old channel was one command.txt: the second CLI call
  // truncated the first one before the agent ever read it.
  const root = tmpRoot();
  hub.queueCommand(root, 'ops', 'first');
  hub.queueCommand(root, 'ops', 'second');
  assert.equal(hub.takeCommand(root, 'ops'), 'first');
  assert.equal(hub.takeCommand(root, 'ops'), 'second');
  assert.equal(hub.takeCommand(root, 'ops'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

check('commands are delivered in the order they were queued', () => {
  const root = tmpRoot();
  for (const body of ['one', 'two', 'three']) hub.queueCommand(root, 'ops', body);
  assert.equal(hub.takeCommand(root, 'ops'), 'one');
  assert.equal(hub.takeCommand(root, 'ops'), 'two');
  assert.equal(hub.takeCommand(root, 'ops'), 'three');
  fs.rmSync(root, { recursive: true, force: true });
});

check('takeCommand returns null when there is no command', () => {
  const root = tmpRoot();
  assert.equal(hub.takeCommand(root, 'ops'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

check('the command queue lives in the hub root, not under agents/', () => {
  const root = tmpRoot();
  hub.ensureLayout(root);
  assert.equal(hub.commandDir(root, 'ops'), path.join(root, 'ops', 'commands'));
  assert.ok(!hub.commandDir(root, 'ops').includes(`${path.sep}agents${path.sep}`));
  fs.rmSync(root, { recursive: true, force: true });
});

check('ensureLayout migrates a legacy inbox.txt into the new layout', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'twin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'twin', 'inbox.txt'), '[OPS→TWIN] pending message\n');
  hub.ensureLayout(root);
  assert.ok(!fs.existsSync(path.join(root, 'twin', 'inbox.txt')), 'the legacy inbox was left behind');
  const taken = hub.takeMessages(root, 'twin');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].body, 'pending message');
  fs.rmSync(root, { recursive: true, force: true });
});

// ───────────────────────────────────────────── 4. the isolation root

check('resolveRoot prefers an explicit root', () => {
  assert.equal(hub.resolveRoot('/tmp/example'), path.resolve('/tmp/example'));
});

check('the DEFAULT ROOT is the hub directory, one level up from lib/', () => {
  // hub-runtime.js lives in lib/agent-hub/lib. The hub's directory is
  // ONE level up from THAT — two levels up is lib/, and the agents then
  // looked for their task board in lib/tasks/ and loaded zero tasks.
  //
  // This test file lives in lib/agent-hub itself, so the hub directory
  // is this file's own directory.
  const expected = path.resolve(__dirname);
  assert.equal(hub.DEFAULT_ROOT, expected);
  assert.equal(path.basename(expected), 'agent-hub');
});

check('the default root holds the tracked board, and the agent dirs are created on demand', () => {
  // The board is TRACKED source — it is in the repository, so a fresh
  // clone has it. The per-agent directories hold only runtime state
  // (logs, inboxes, commands) and git cannot track an empty directory,
  // so the hub CREATES them at start. Asserting they exist in the
  // checkout passed only on a machine where the hub had already run —
  // the local harness lying about a fresh clone.
  assert.ok(
    fs.existsSync(path.join(hub.DEFAULT_ROOT, 'tasks', 'swr-ops-tasks.md')),
    'the task board is not tracked at the default root'
  );
  const root = tmpRoot();
  hub.ensureLayout(root);
  for (const agent of hub.AGENT_IDS) {
    assert.ok(fs.existsSync(path.join(root, agent, 'inbox')), `missing ${agent}/inbox`);
    assert.ok(fs.existsSync(path.join(root, agent, 'commands')), `missing ${agent}/commands`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

check('the default root is where the task board lives', () => {
  const boardFile = path.join(hub.DEFAULT_ROOT, 'tasks', 'swr-ops-tasks.md');
  assert.ok(fs.existsSync(boardFile), 'the task board is not where the agent looks for it');
});

check('resolveRoot honours SWR_HUB_ROOT', () => {
  const previous = process.env.SWR_HUB_ROOT;
  process.env.SWR_HUB_ROOT = '/tmp/from-env';
  assert.equal(hub.resolveRoot(), path.resolve('/tmp/from-env'));
  if (previous === undefined) delete process.env.SWR_HUB_ROOT;
  else process.env.SWR_HUB_ROOT = previous;
});

check('two roots do not share an inbox', () => {
  const a = tmpRoot();
  const b = tmpRoot();
  hub.appendMessage(a, 'ops', 'twin', 'for A');
  assert.equal(hub.takeMessages(b, 'twin').length, 0);
  assert.equal(hub.takeMessages(a, 'twin').length, 1);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

check('ensureLayout creates the three agent directories plus tasks and memory', () => {
  const root = tmpRoot();
  hub.ensureLayout(root);
  for (const dir of ['ops', 'twin', 'check', 'tasks', 'memory', 'pids']) {
    assert.ok(fs.existsSync(path.join(root, dir)), `missing ${dir}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────── 5. the task board

check('an empty board has three empty lists', () => {
  const board = opsBrain.emptyBoard();
  assert.deepEqual(board.blocked, []);
  assert.deepEqual(board.inProgress, []);
  assert.deepEqual(board.done, []);
});

check('parseBoard reads the three sections', () => {
  const board = opsBrain.parseBoard(
    '# SWR-Ops Task Board\n\n### Blocked\n- [ ] blocked task\n\n### In Progress\n- [ ] live task\n\n### Done\n- [x] finished task\n'
  );
  assert.deepEqual(board.blocked, ['blocked task']);
  assert.deepEqual(board.inProgress, ['live task']);
  assert.deepEqual(board.done, ['finished task']);
});

check('parseBoard on empty content gives an empty board', () => {
  const board = opsBrain.parseBoard('');
  assert.deepEqual(board, opsBrain.emptyBoard());
});

check('parseBoard ignores lines outside a known section', () => {
  const board = opsBrain.parseBoard('some prose\n\n### In Progress\n- [ ] task\n');
  assert.deepEqual(board.inProgress, ['task']);
  assert.deepEqual(board.blocked, []);
});

check('a board round-trips through render and parse', () => {
  const board = { blocked: ['b1'], inProgress: ['p1', 'p2'], done: ['d1'] };
  const parsed = opsBrain.parseBoard(opsBrain.renderBoard(board, '2026-01-01T00:00:00.000Z'));
  assert.deepEqual(parsed, board);
});

check('renderBoard writes the three headings', () => {
  const md = opsBrain.renderBoard(opsBrain.emptyBoard());
  for (const heading of opsBrain.BOARD_SECTIONS) assert.ok(md.includes(`### ${heading}`));
});

check('applyCommand add puts the task in progress', () => {
  const applied = opsBrain.applyCommand(opsBrain.emptyBoard(), 'add build the reel');
  assert.deepEqual(applied.board.inProgress, ['build the reel']);
  assert.equal(applied.task, 'build the reel');
});

check('applyCommand add with no argument changes nothing', () => {
  const applied = opsBrain.applyCommand(opsBrain.emptyBoard(), 'add');
  assert.deepEqual(applied.board.inProgress, []);
  assert.equal(applied.task, null);
});

check('applyCommand done moves the first task to done', () => {
  const board = { blocked: [], inProgress: ['first', 'second'], done: [] };
  const applied = opsBrain.applyCommand(board, 'done');
  assert.deepEqual(applied.board.done, ['first']);
  assert.deepEqual(applied.board.inProgress, ['second']);
});

check('applyCommand done with an empty board changes nothing', () => {
  const applied = opsBrain.applyCommand(opsBrain.emptyBoard(), 'done');
  assert.equal(applied.task, null);
});

check('applyCommand block moves the first task to blocked', () => {
  const board = { blocked: [], inProgress: ['stuck'], done: [] };
  const applied = opsBrain.applyCommand(board, 'block');
  assert.deepEqual(applied.board.blocked, ['stuck']);
  assert.deepEqual(applied.board.inProgress, []);
});

check('applyCommand does not mutate the board it was given', () => {
  const board = { blocked: [], inProgress: ['task'], done: [] };
  opsBrain.applyCommand(board, 'done');
  assert.deepEqual(board.inProgress, ['task']);
});

check('applyCommand on an unknown verb changes nothing', () => {
  const board = { blocked: [], inProgress: ['task'], done: [] };
  const applied = opsBrain.applyCommand(board, 'frobnicate');
  assert.deepEqual(applied.board.inProgress, ['task']);
});

check('completeTask moves a task from progress to done', () => {
  const board = { blocked: [], inProgress: ['task'], done: [] };
  const applied = opsBrain.completeTask(board, 'task');
  assert.deepEqual(applied.board.inProgress, []);
  assert.deepEqual(applied.board.done, ['task']);
  assert.equal(applied.moved, true);
});

check('completeTask does not duplicate a task that is already done', () => {
  const board = { blocked: [], inProgress: [], done: ['task'] };
  const applied = opsBrain.completeTask(board, 'task');
  assert.deepEqual(applied.board.done, ['task']);
});

check('completeTask with an empty task does nothing', () => {
  const applied = opsBrain.completeTask(opsBrain.emptyBoard(), '  ');
  assert.equal(applied.moved, false);
});

check('completeTask moves the BOARD text when the subject is a fragment of it', () => {
  // The check agent reports what it VERIFIED, not the task it came from.
  // The board's own text is the record of the task and is what moves.
  const task = 'Write the liner notes for the lo-fi hip hop vinyl reissue in agents/TASKS.md';
  const board = { blocked: [], inProgress: [task], done: [] };
  const applied = opsBrain.completeTask(board, 'agents/TASKS.md');
  assert.deepEqual(applied.board.inProgress, []);
  assert.deepEqual(applied.board.done, [task]);
});

check('completeTask moves the BOARD text when the board entry is a fragment of the subject', () => {
  const task = 'write the liner notes';
  const board = { blocked: [], inProgress: [task], done: [] };
  const applied = opsBrain.completeTask(board, 'write the liner notes for the lo-fi reissue');
  assert.deepEqual(applied.board.inProgress, []);
  assert.deepEqual(applied.board.done, [task]);
});

check('completeTask picks the most specific entry when two could match', () => {
  const board = { blocked: [], inProgress: ['liner notes', 'liner notes in agents/TASKS.md'], done: [] };
  const applied = opsBrain.completeTask(board, 'agents/TASKS.md');
  assert.deepEqual(applied.board.inProgress, ['liner notes']);
  assert.deepEqual(applied.board.done, ['liner notes in agents/TASKS.md']);
});

check('completeTask on a blocked task moves it to done', () => {
  const board = { blocked: ['stuck task'], inProgress: [], done: [] };
  const applied = opsBrain.completeTask(board, 'stuck task');
  assert.deepEqual(applied.board.blocked, []);
  assert.deepEqual(applied.board.done, ['stuck task']);
});

check('completeTask on an unknown subject still records the verification', () => {
  const board = { blocked: [], inProgress: [], done: [] };
  const applied = opsBrain.completeTask(board, 'a file that was never on the board');
  assert.deepEqual(applied.board.done, ['a file that was never on the board']);
  assert.equal(applied.moved, true);
});

check('the plan summary carries the reason, not the verdict', () => {
  // "Plan: proceed — Proceed — lo-fi hip hop" was the composed message
  // before the verdict was taken out of the summary.
  const plan = twinBrain.planFor('write the deep house liner notes');
  assert.equal(plan.verdict, 'proceed');
  assert.ok(!/^proceed\b/i.test(plan.summary), `summary repeats the verdict: ${plan.summary}`);
  assert.ok(plan.summary.includes('deep house'));
});

check('boardCounts counts the three lists', () => {
  const counts = opsBrain.boardCounts({ blocked: ['b'], inProgress: ['p1', 'p2'], done: ['d'] });
  assert.equal(counts.blocked, 1);
  assert.equal(counts.inProgress, 2);
  assert.equal(counts.done, 1);
  assert.equal(counts.total, 4);
});

// ─────────────────────────────────────────────────────────── 6. the twin

check('the twin identity keeps the confidence threshold at 0.85', () => {
  assert.equal(twinBrain.TWIN_IDENTITY.confidenceThreshold, 0.85);
});

check('the twin identity keeps its four non-negotiables', () => {
  assert.equal(twinBrain.TWIN_IDENTITY.voice.nonNegotiables.length, 4);
  assert.ok(twinBrain.TWIN_IDENTITY.voice.nonNegotiables.includes('Always credit sources'));
});

check('checkVoice flags a phrase that breaks a rule', () => {
  const issues = twinBrain.checkVoice('this invents facts about artists');
  assert.ok(issues.length > 0);
});

check('checkVoice passes clean text', () => {
  assert.deepEqual(twinBrain.checkVoice('a warm, direct note about the new record'), []);
});

check('scoreOption rewards a focus hit', () => {
  const scored = twinBrain.scoreOption('a deep house vinyl pressing');
  assert.ok(scored.focusHits.includes('deep house'));
  assert.ok(scored.score > 0.5);
});

check('scoreOption is capped at 1', () => {
  const scored = twinBrain.scoreOption('deep house lo-fi hip hop vinyl culture new wave');
  assert.ok(scored.score <= 1);
});

check('decide picks the option with the higher score', () => {
  const result = twinBrain.decide(['a plain option', 'a deep house pressing']);
  assert.equal(result.decision, 'a deep house pressing');
});

check('decide reports below-threshold when no option scores high enough', () => {
  const result = twinBrain.decide(['a plain option']);
  assert.equal(result.belowThreshold, true);
  assert.equal(result.decision, 'a plain option');
});

check('decide on no options returns an empty decision', () => {
  const result = twinBrain.decide([]);
  assert.equal(result.decision, '');
  assert.equal(result.confidence, 0);
  assert.equal(result.belowThreshold, true);
});

check('decide lists the alternatives', () => {
  const result = twinBrain.decide(['a plain option', 'a deep house pressing', 'a new wave record']);
  assert.equal(result.alternatives.length, 2);
});

check('planFor escalates a task outside the focus', () => {
  const plan = twinBrain.planFor('fix the payroll spreadsheet');
  assert.equal(plan.verdict, 'escalate');
  assert.equal(plan.belowThreshold, true);
});

check('planFor proceeds on a task inside the focus', () => {
  const plan = twinBrain.planFor('write the deep house liner notes');
  assert.equal(plan.verdict, 'proceed');
  assert.equal(plan.belowThreshold, false);
  assert.ok(plan.focusHits.includes('deep house'));
});

check('planFor escalates a task that breaks a voice rule', () => {
  const plan = twinBrain.planFor('write aggressive sales copy about a deep house album');
  assert.equal(plan.verdict, 'escalate');
});

check('planFor on an empty task escalates', () => {
  const plan = twinBrain.planFor('');
  assert.equal(plan.verdict, 'escalate');
});

// ────────────────────────────────────────────────────────── 7. the check

check('the four verification types are known', () => {
  assert.deepEqual(checkBrain.VERIFICATION_TYPES, ['file', 'tests', 'claim', 'diff']);
});

check('classifyRequest reads a file request', () => {
  const parsed = checkBrain.classifyRequest('file pages/index.html');
  assert.equal(parsed.type, 'file');
  assert.equal(parsed.target, 'pages/index.html');
});

check('classifyRequest reads a test request', () => {
  const parsed = checkBrain.classifyRequest('test');
  assert.equal(parsed.type, 'tests');
  assert.equal(parsed.target, '');
});

check('classifyRequest reads a claim request', () => {
  const parsed = checkBrain.classifyRequest('claim FLUX generation');
  assert.equal(parsed.type, 'claim');
  assert.equal(parsed.target, 'FLUX generation');
});

check('classifyRequest reads a diff request', () => {
  const parsed = checkBrain.classifyRequest('diff working tree');
  assert.equal(parsed.type, 'diff');
});

check('classifyRequest returns unknown for a bare sentence', () => {
  const parsed = checkBrain.classifyRequest('build the reel pipeline');
  assert.equal(parsed.type, 'unknown');
  assert.equal(parsed.target, 'build the reel pipeline');
});

check('buildResult keeps the evidence', () => {
  const result = checkBrain.buildResult('file', 'pages/index.html', true, '/abs/path');
  assert.equal(result.passed, true);
  assert.equal(result.evidence, '/abs/path');
});

check('buildResult never leaves the evidence empty', () => {
  assert.equal(checkBrain.buildResult('file', 'x', true, '').evidence, 'ok');
  assert.equal(checkBrain.buildResult('file', 'x', false, '').evidence, 'no evidence');
});

check('renderResult marks pass and fail', () => {
  assert.ok(checkBrain.renderResult(checkBrain.buildResult('file', 'a', true, 'ok')).includes('PASS'));
  assert.ok(checkBrain.renderResult(checkBrain.buildResult('file', 'a', false, 'nope')).includes('FAIL'));
});

check('renderLedgerEntry writes a markdown section', () => {
  const entry = checkBrain.renderLedgerEntry(checkBrain.buildResult('file', 'a', true, 'ok'), '2026-01-01T00:00:00.000Z');
  assert.ok(entry.includes('## 2026-01-01T00:00:00.000Z'));
  assert.ok(entry.includes('- Type: file'));
  assert.ok(entry.includes('- Target: a'));
  assert.ok(entry.includes('- Passed: true'));
});

check('countVerifications counts the ledger sections', () => {
  const ledger = '# Verifications\n' + checkBrain.renderLedgerEntry(checkBrain.buildResult('file', 'a', true, 'ok'));
  assert.equal(checkBrain.countVerifications(ledger), 1);
});

check('countVerifications on an empty ledger is zero', () => {
  assert.equal(checkBrain.countVerifications(''), 0);

});

// ─────────────────────────────── 7b. the false-PASS, and its two causes

check('a "verify:" prefix is stripped before classifying', () => {
  const parsed = checkBrain.classifyRequest('Verify: file pages/index.html');
  assert.equal(parsed.type, 'file');
  assert.equal(parsed.target, 'pages/index.html');
});

check('a "verify:" prefix on a claim is stripped too', () => {
  const parsed = checkBrain.classifyRequest('Verify: claim FLUX generation');
  assert.equal(parsed.type, 'claim');
  assert.equal(parsed.target, 'FLUX generation');
});

check('a task-shaped request is recognised as a task', () => {
  assert.equal(checkBrain.isTaskShaped('Write liner notes for a lo-fi hip hop vinyl reissue'), true);
  assert.equal(checkBrain.isTaskShaped('build the reel pipeline'), true);
  assert.equal(checkBrain.isTaskShaped('ship the marketplace page'), true);
});

check('a claim-shaped request is not a task', () => {
  assert.equal(checkBrain.isTaskShaped('the reel pipeline is documented'), false);
  assert.equal(checkBrain.isTaskShaped('file pages/index.html'), false);
  assert.equal(checkBrain.isTaskShaped(''), false);
});

check('the claim search passes the claim as ONE argv element', () => {
  // The bug: a shell split the claim on its spaces, so grep searched
  // for the first word alone and matched an unrelated vendored file.
  const args = checkBrain.claimSearchArgs('Write liner notes for a lo-fi hip hop vinyl reissue', '/repo');
  const claimIndex = args.indexOf('--');
  assert.ok(claimIndex !== -1, 'the claim must sit after a -- terminator');
  assert.equal(args[claimIndex + 1], 'Write liner notes for a lo-fi hip hop vinyl reissue');
});

check('the claim search excludes vendored and built directories', () => {
  const args = checkBrain.claimSearchArgs('a claim', '/repo');
  for (const dir of ['node_modules', '.git', 'dist', 'build']) {
    assert.ok(args.includes(`--exclude-dir=${dir}`), `missing --exclude-dir=${dir}`);
  }
});

check('the claim search is fixed-string, not a pattern', () => {
  const args = checkBrain.claimSearchArgs('a claim', '/repo');
  assert.ok(args.includes('-F'), 'the search must be a fixed string');
});

check('findPathToken finds a path in a sentence', () => {
  assert.equal(checkBrain.findPathToken('Write docs/REEL-WATCHER.md today'), 'docs/REEL-WATCHER.md');
  assert.equal(checkBrain.findPathToken('update README.md'), 'README.md');
  assert.equal(checkBrain.findPathToken('write the reel pipeline'), '');
});

check('verificationRequest turns a task with a path into a file check', () => {
  assert.equal(
    checkBrain.verificationRequest('Write docs/REEL-WATCHER.md'),
    'file docs/REEL-WATCHER.md'
  );
});

check('verificationRequest turns a task with no path into a claim', () => {
  assert.equal(
    checkBrain.verificationRequest('Write liner notes for a lo-fi hip hop vinyl reissue'),
    'claim Write liner notes for a lo-fi hip hop vinyl reissue'
  );
});

check('a claim that is really a task is recognised as task-shaped', () => {
  // The claim branch checks the claim TEXT, not the request, so the
  // "claim <task sentence>" form is caught too.
  assert.equal(
    checkBrain.isTaskShaped('Write liner notes for a lo-fi hip hop vinyl reissue'),
    true
  );
});

check('a real claim is not task-shaped', () => {
  assert.equal(checkBrain.isTaskShaped('the reel pipeline is documented'), false);
  assert.equal(checkBrain.isTaskShaped('FLUX generation runs on Apple silicon'), false);
});

check('refuseTask fails with a stated reason', () => {
  const result = checkBrain.refuseTask('Write liner notes');
  assert.equal(result.passed, false);
  assert.equal(result.type, 'task');
  assert.ok(result.evidence.includes('not a claim'), `weak reason: ${result.evidence}`);
});

// The false PASS, reproduced end to end against a real directory.
//
// The bug: a claim with spaces was word-split by a shell, so grep
// searched for "Write" alone and matched a vendored node_modules
// README. The check then reported PASS on a file that had nothing to
// do with the claim, and the task left the board as "done".
check('a claim search does NOT match a vendored file on the first word', () => {
  const repo = tmpRoot();
  fs.mkdirSync(path.join(repo, 'node_modules', 'xcode'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'node_modules', 'xcode', 'RELEASENOTES.md'),
    '# Release notes\n\nWrite the docs before you ship.\n'
  );

  const search = claimSearch.searchClaim(
    'Write liner notes for a lo-fi hip hop vinyl reissue',
    repo
  );
  assert.equal(search.found, false, 'the vendored file must not satisfy the claim');
  assert.ok(!search.evidence.includes('node_modules'), `evidence named a vendored file: ${search.evidence}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('a claim search DOES match the project file that carries the claim', () => {
  const repo = tmpRoot();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'docs', 'reel.md'),
    '# Reel\n\nThe reel pipeline is documented here.\n'
  );

  const search = claimSearch.searchClaim('The reel pipeline is documented', repo);
  assert.equal(search.found, true, 'the real doc must satisfy the claim');
  assert.ok(search.evidence.includes('reel.md'), `evidence did not name the file: ${search.evidence}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('a claim search finds nothing for a phrase nobody wrote', () => {
  const repo = tmpRoot();
  fs.writeFileSync(path.join(repo, 'README.md'), '# Readme\n\nNothing to see.\n');
  const search = claimSearch.searchClaim('a phrase that appears nowhere', repo);
  assert.equal(search.found, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ────────────────────────────────────────── 8. the round trip, on disk

check('a full round trip lands: ops → twin → ops', () => {
  const root = tmpRoot();
  hub.ensureLayout(root);

  // Ops receives a task and hands it to the twin.
  hub.appendMessage(root, 'ops', 'twin', 'New task: write the deep house liner notes');

  // The twin takes it and plans.
  const forTwin = hub.takeMessages(root, 'twin');
  assert.equal(forTwin.length, 1);
  const plan = twinBrain.planFor(forTwin[0].body.replace(/^New task:\s*/i, ''));
  assert.equal(plan.verdict, 'proceed');
  hub.appendMessage(root, 'twin', 'ops', `Plan: proceed — ${plan.summary}`);

  // Ops takes the reply.
  const forOps = hub.takeMessages(root, 'ops');
  assert.equal(forOps.length, 1);
  assert.ok(forOps[0].body.startsWith('Plan: proceed'));

  fs.rmSync(root, { recursive: true, force: true });
});

check('a check verdict moves the task to done', () => {
  const root = tmpRoot();
  hub.ensureLayout(root);

  let board = { blocked: [], inProgress: ['write the liner notes'], done: [] };
  hub.appendMessage(root, 'ops', 'check', 'Verify: write the liner notes');

  const request = hub.takeMessages(root, 'check')[0].body.replace(/^Verify:\s*/i, '');
  assert.equal(request, 'write the liner notes');

  const result = checkBrain.buildResult('claim', request, true, 'found in docs');
  hub.appendMessage(root, 'check', 'ops', `Verified: ${result.passed ? 'PASS' : 'FAIL'} — ${result.target}`);

  const verdict = hub.takeMessages(root, 'ops')[0].body;
  const subject = verdict.replace(/^Verified:\s*(pass|fail)\b\s*/i, '').replace(/^—\s*/, '');
  board = opsBrain.completeTask(board, subject).board;
  assert.deepEqual(board.done, ['write the liner notes']);

  fs.rmSync(root, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────── 9. lm-client

check('lm-client loads on this Node — it used to import a module that no longer exists', () => {
  const lm = require('./lib/lm-client.js');
  assert.equal(typeof lm.chat, 'function');
  assert.equal(typeof lm.complete, 'function');
  assert.equal(typeof lm.setProvider, 'function');
});

check('lm-client reports which providers have a key', () => {
  const lm = require('./lib/lm-client.js');
  const status = lm.providerStatus();
  assert.equal(status.length, 4);
  assert.ok(status.every((s) => typeof s.hasKey === 'boolean' && typeof s.keyEnv === 'string'));
});

check('lm-client rejects an unknown provider by name', () => {
  const lm = require('./lib/lm-client.js');
  const message = lm.setProvider('nope');
  assert.ok(message.includes('Unknown provider'));
  assert.ok(message.includes('minimax'));
});

process.stdout.write(`[agent-hub.test] passed: ${passed}, failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
