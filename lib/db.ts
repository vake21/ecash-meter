// SQLite access for the tracker, using Node's built-in `node:sqlite` (no external
// dependency, no native module, no DB server). Used by BOTH the Next.js reader
// (lib/store.ts) and the standalone indexer (scripts/index.ts).
//
// The whole site runs on one box (node + indexer + web server share this file),
// so a local SQLite file is the simplest, fastest fit: one writer (the indexer),
// many cheap reads (page renders). WAL mode lets reads proceed while the indexer
// writes. To relocate the file, set ECASH_METER_DB; otherwise it lives at ./.data/ecash-meter.sqlite.

import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = ".data/ecash-meter.sqlite";

let db: DatabaseSync | null = null;

/** The configured store path (ECASH_METER_DB, else the default). */
export function getDbPath(): string {
  return process.env.ECASH_METER_DB ?? DEFAULT_PATH;
}

export function getDb(): DatabaseSync {
  if (!db) {
    const path = getDbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const handle = new DatabaseSync(path);
    try {
      handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      ensureSchema(handle);
    } catch (err) {
      // Don't cache a handle that failed to initialise (e.g. a file that isn't
      // SQLite): the next call retries, so a repaired store recovers without a
      // restart.
      handle.close();
      throw err;
    }
    db = handle;
  }
  return db;
}

/**
 * Close the current connection and drop the cached handle. Mainly for tests,
 * which open a fresh in-memory DB per case; also fine to call at process exit.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Create tables if absent. Safe to call repeatedly (idempotent DDL). */
export function ensureSchema(d: DatabaseSync = getDb()): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      height     INTEGER PRIMARY KEY,
      hash       TEXT NOT NULL,
      time       INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS commitments (
      height   INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      slot     INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      hstar    TEXT NOT NULL CHECK (length(hstar) = 64),
      fee_sats INTEGER NOT NULL DEFAULT 0 CHECK (fee_sats >= 0),
      PRIMARY KEY (height, slot, hstar)
    );
    CREATE INDEX IF NOT EXISTS commitments_slot_idx ON commitments (slot);

    -- Raw BIP 300 treasury events, per block (lib/treasury.ts replays them).
    -- Cascade with blocks so a reorg prune removes them too.
    CREATE TABLE IF NOT EXISTS treasury_outputs (
      height     INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      tx_index   INTEGER NOT NULL,
      txid       TEXT NOT NULL CHECK (length(txid) = 64),
      vout       INTEGER NOT NULL,
      slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      value_sats INTEGER NOT NULL CHECK (value_sats >= 0),
      PRIMARY KEY (txid, vout)
    );
    CREATE TABLE IF NOT EXISTS treasury_spends (
      height   INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      tx_index INTEGER NOT NULL,
      txid     TEXT NOT NULL CHECK (length(txid) = 64),
      vout     INTEGER NOT NULL,
      PRIMARY KEY (txid, vout)
    );

    -- Raw BIP 300 coinbase messages (lib/proposals.ts replays them):
    -- M1 sidechain proposals and M2 acks. Cascade with blocks for reorgs.
    CREATE TABLE IF NOT EXISTS sidechain_proposals (
      height          INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      vout            INTEGER NOT NULL,
      slot            INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      description_hex TEXT NOT NULL,
      hash            TEXT NOT NULL CHECK (length(hash) = 64),
      PRIMARY KEY (height, vout)
    );
    CREATE TABLE IF NOT EXISTS sidechain_acks (
      height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      slot   INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      hash   TEXT NOT NULL CHECK (length(hash) = 64),
      PRIMARY KEY (height, slot)
    );

    -- BIP 300 withdrawal bundles (lib/bundles.ts replays them): M3 proposals,
    -- M4 acks (raw payload), and M6 withdrawals with their M6id. Recorded for
    -- every indexed block; meta 'bundles_from' says how far back they reach.
    CREATE TABLE IF NOT EXISTS bundle_proposals (
      height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      vout   INTEGER NOT NULL,
      slot   INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      m6id   TEXT NOT NULL CHECK (length(m6id) = 64),
      PRIMARY KEY (height, vout)
    );
    CREATE TABLE IF NOT EXISTS bundle_acks (
      height    INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      vout      INTEGER NOT NULL,
      version   INTEGER NOT NULL CHECK (version BETWEEN 0 AND 255),
      votes_hex TEXT NOT NULL,
      PRIMARY KEY (height)
    );
    CREATE TABLE IF NOT EXISTS withdrawal_m6ids (
      height   INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
      tx_index INTEGER NOT NULL,
      txid     TEXT NOT NULL CHECK (length(txid) = 64),
      slot     INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 255),
      m6id     TEXT NOT NULL CHECK (length(m6id) = 64),
      PRIMARY KEY (txid)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ── Thin query helpers (synchronous — node:sqlite is a sync API) ──────────────

export function get<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | bigint | null)[]
): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function all<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | bigint | null)[]
): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function run(
  sql: string,
  ...params: (string | number | bigint | null)[]
): StatementResultingChanges {
  return getDb().prepare(sql).run(...params);
}

/** Run `fn` inside a single transaction (rolls back on throw). */
export function tx(fn: () => void): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    fn();
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function getMeta(key: string): string | null {
  const row = get<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}
