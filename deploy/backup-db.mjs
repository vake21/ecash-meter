#!/usr/bin/env node
// Daily backup of the eCash Meter SQLite store.
//
//   node deploy/backup-db.mjs
//
// Self-contained on purpose: it imports nothing from the app (only Node's
// built-in node:sqlite), so it can be installed outside the code checkout and
// keeps working across deploys, whatever version of the site is running.
//
// Why it matters: the VPS node is PRUNED. Once the blocks from around the ECX
// fork are pruned away, the server cannot rebuild the store from scratch — so a
// lost or corrupted database file would leave treasury balances and proposal
// votes "unknown". Restoring a backup avoids that: the indexer resumes from the
// backup's tip, and those recent blocks are still on the node. (A backup does
// NOT replace a rebuild after a parser change — see "Rebuilding after a parser
// change" in deploy/README.md.)
//
// How: `VACUUM INTO` writes a consistent, compacted, standalone copy (no -wal or
// -shm side files) even while the indexer is writing. The copy is written under
// a temporary name, checked with PRAGMA integrity_check, then renamed into
// place, so a half-written file is never left looking like a good backup.
//
// Environment:
//   ECASH_METER_DB     store to back up (default .data/ecash-meter.sqlite)
//   ECASH_BACKUP_DIR   where backups go  (default <store dir>/backups)
//   ECASH_BACKUP_KEEP  daily backups to keep (default 14)

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const src = resolve(process.env.ECASH_METER_DB ?? ".data/ecash-meter.sqlite");
const dir = resolve(process.env.ECASH_BACKUP_DIR ?? join(dirname(src), "backups"));
const keep = Math.max(1, Number(process.env.ECASH_BACKUP_KEEP ?? 14) || 14);

const PREFIX = "ecash-meter-";
const SUFFIX = ".sqlite";

function fail(msg) {
  console.error(`[backup] FAILED: ${msg}`);
  process.exit(1);
}

if (!existsSync(src)) fail(`no database at ${src}`);
mkdirSync(dir, { recursive: true });

// One file per UTC day; a second run the same day replaces that day's file.
const day = new Date().toISOString().slice(0, 10);
const final = join(dir, `${PREFIX}${day}${SUFFIX}`);
const tmp = `${final}.partial`;
rmSync(tmp, { force: true });

// 1. Consistent snapshot.
const db = new DatabaseSync(src, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
} catch (err) {
  rmSync(tmp, { force: true });
  fail(`could not snapshot ${src}: ${err instanceof Error ? err.message : err}`);
} finally {
  db.close();
}

// 2. Verify the copy before it replaces anything.
const copy = new DatabaseSync(tmp, { readOnly: true });
let summary;
try {
  const integrity = copy.prepare("PRAGMA integrity_check").get();
  if (Object.values(integrity)[0] !== "ok") throw new Error(`integrity_check: ${JSON.stringify(integrity)}`);
  const blocks = copy.prepare("SELECT COUNT(*) AS n, MAX(height) AS tip FROM blocks").get();
  const meta = Object.fromEntries(
    copy.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]),
  );
  summary = `${blocks.n} blocks, tip ${blocks.tip ?? "-"}, network ${meta.network ?? "-"}, parser ${meta.parser_version ?? "-"}`;
} catch (err) {
  copy.close();
  rmSync(tmp, { force: true });
  fail(`backup copy did not verify: ${err instanceof Error ? err.message : err}`);
}
copy.close();
renameSync(tmp, final);

// 3. Keep the newest `keep` daily files, delete older ones.
const backups = readdirSync(dir)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
  .sort(); // YYYY-MM-DD sorts chronologically
for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
  rmSync(join(dir, old), { force: true });
}

const kb = Math.round(statSync(final).size / 1024);
console.log(`[backup] ${final} (${kb} KB) — ${summary}; keeping ${Math.min(keep, backups.length)} daily backups`);
