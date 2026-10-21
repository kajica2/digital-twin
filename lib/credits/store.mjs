// Credit ledger — SQLite-backed, using node:sqlite (no npm dependencies).
//
// Tokens are never stored: only a sha256 hash of the bearer token lives in
// the users table. Every balance change is an immutable ledger row; the
// balance is the sum of the deltas for a user.
//
// Charges and refunds are keyed by `ref` (an idempotency key). Charging twice
// with the same ref is a no-op, so a retried request can never double-charge.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB_PATH = path.join('data', 'credits.sqlite');

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Generate a fresh bearer token: 32 random bytes, hex encoded. */
export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  params      TEXT NOT NULL,
  output_path TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger (user_id);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id);
`;

/**
 * Open (and create if needed) the credit store.
 * @param {{dbPath?: string}} [opts]
 */
export function openStore(opts = {}) {
  const rawPath = opts.dbPath || DEFAULT_DB_PATH;
  const dbPath = rawPath === ':memory:' ? ':memory:' : path.resolve(rawPath);
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmts = {
    insertUser: db.prepare(
      'INSERT INTO users (id, token_hash, created_at) VALUES (?, ?, ?)'
    ),
    userByHash: db.prepare('SELECT id, created_at FROM users WHERE token_hash = ?'),
    insertLedger: db.prepare(
      'INSERT INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    ledgerByRef: db.prepare('SELECT id, delta, user_id FROM ledger WHERE ref = ?'),
    balance: db.prepare(
      'SELECT COALESCE(SUM(delta), 0) AS balance FROM ledger WHERE user_id = ?'
    ),
    insertJob: db.prepare(
      `INSERT INTO jobs (id, user_id, status, params, output_path, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getJob: db.prepare(
      'SELECT id, user_id, status, params, output_path, error, created_at, updated_at FROM jobs WHERE id = ?'
    ),
    updateJob: db.prepare(
      'UPDATE jobs SET status = ?, params = ?, output_path = ?, error = ?, updated_at = ? WHERE id = ?'
    ),
  };

  const store = {
    dbPath,

    /** Close the underlying database handle. */
    close() {
      try { db.close(); } catch { /* already closed */ }
    },

    /**
     * Resolve a bearer token to its user, creating the user on first use.
     * @returns {{userId: string, created: boolean}}
     */
    userForToken(token) {
      const raw = String(token || '').trim();
      if (!raw) throw new Error('userForToken: token is required');
      const hash = hashToken(raw);
      const found = stmts.userByHash.get(hash);
      if (found) return { userId: found.id, created: false };
      const userId = 'usr_' + crypto.randomBytes(12).toString('hex');
      stmts.insertUser.run(userId, hash, nowIso());
      return { userId, created: true };
    },

    /** Current credit balance of a user (sum of ledger deltas). */
    balance(userId) {
      const row = stmts.balance.get(userId);
      return row ? Number(row.balance) : 0;
    },

    /**
     * Grant credits to a user.
     * @param {string} userId
     * @param {number} credits positive integer
     * @param {string} reason
     * @returns {number} new balance
     */
    grant(userId, credits, reason) {
      if (!Number.isInteger(credits) || credits <= 0) {
        throw new Error('grant: credits must be a positive integer');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        stmts.insertLedger.run(userId, credits, String(reason || 'grant'), null, nowIso());
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      return store.balance(userId);
    },

    /**
     * Charge credits. `ref` is the idempotency key: calling charge twice with
     * the same ref is a no-op that returns the current balance.
     * @returns {number} new balance
     */
    charge(userId, credits, ref) {
      if (!Number.isInteger(credits) || credits <= 0) {
        throw new Error('charge: credits must be a positive integer');
      }
      if (!ref) throw new Error('charge: ref (idempotency key) is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = stmts.ledgerByRef.get(ref);
        if (existing) {
          db.exec('COMMIT');
          return store.balance(userId);
        }
        const balance = store.balance(userId);
        if (balance < credits) {
          const err = new Error(
            `insufficient credits: balance ${balance} < required ${credits}`
          );
          err.code = 'insufficient_credits';
          err.balance = balance;
          throw err; // rolled back by the catch below
        }
        stmts.insertLedger.run(userId, -credits, 'render', ref, nowIso());
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
      return store.balance(userId);
    },

    /**
     * Refund credits under its own unique ref.
     * @returns {number} new balance
     */
    refund(userId, credits, ref) {
      if (!Number.isInteger(credits) || credits <= 0) {
        throw new Error('refund: credits must be a positive integer');
      }
      if (!ref) throw new Error('refund: ref (idempotency key) is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = stmts.ledgerByRef.get(ref);
        if (existing) {
          db.exec('COMMIT');
          return store.balance(userId);
        }
        stmts.insertLedger.run(userId, credits, 'refund', ref, nowIso());
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
      return store.balance(userId);
    },

    /** Create a job row. `params` is stored as a JSON string. */
    createJob({ id, userId, params }) {
      if (!id) throw new Error('createJob: id is required');
      const ts = nowIso();
      stmts.insertJob.run(
        id,
        userId,
        'queued',
        JSON.stringify(params ?? {}),
        null,
        null,
        ts,
        ts
      );
      return store.getJob(id);
    },

    /** Patch a job row. Only the provided fields are changed. */
    updateJob(id, patch = {}) {
      const existing = store.getJob(id);
      if (!existing) return null;
      const status = patch.status ?? existing.status;
      // getJob() returns parsed params; the DB column always holds a JSON string.
      const params = JSON.stringify(patch.params ?? existing.params ?? {});
      const outputPath =
        patch.outputPath === undefined ? existing.outputPath : patch.outputPath;
      const error = patch.error === undefined ? existing.error : patch.error;
      stmts.updateJob.run(status, params, outputPath, error, nowIso(), id);
      return store.getJob(id);
    },

    /** Fetch a job row. */
    getJob(id) {
      const row = stmts.getJob.get(id);
      if (!row) return null;
      let params = row.params;
      try { params = JSON.parse(row.params); } catch { /* keep the raw string */ }
      return {
        id: row.id,
        userId: row.user_id,
        status: row.status,
        params,
        outputPath: row.output_path,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  };

  return store;
}
