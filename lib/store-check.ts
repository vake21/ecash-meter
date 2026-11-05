// Validates the SQLite store BEFORE anything is served from it. Shared by the
// dashboard loader (lib/dashboard.ts) and /api/health, so the page and the
// probe always agree on whether real data is available.
//
// The checks mirror the indexer's own guards (lib/indexer.ts), applied on the
// read side: a store built from another chain, by another parser version, or
// with no identity stamp at all is never shown as ECX data.
//
// Results carry two levels of detail. `detail` is SAFE TO PUBLISH — no file
// paths, no error text, no credentials — because /api/health is public. The raw
// cause goes to the server log only (logStoreProblem), where the operator can
// read it.

import { existsSync } from "node:fs";
import { getDb, get, getMeta, getDbPath } from "./db";
import { PARSER_VERSION } from "./bmm";
import { ECX_FORK_BLOCK_HASH } from "./config";

export type UnavailableReason =
  | "missing"
  | "unreadable"
  | "empty"
  | "chain-mismatch"
  | "parser-mismatch"
  | "network-mismatch";

export interface StoreSummary {
  network: string;
  tipHeight: number;
  blocks: number;
  commitments: number;
  lastBlockTime: number;
  parserVersion: number;
  forkBlockHash: string;
}

export type StoreCheck =
  | { ok: true; summary: StoreSummary }
  | {
      ok: false;
      reason: UnavailableReason;
      /** Operator-facing, safe to publish. */
      detail: string;
      /** Stored vs expected values, for identity/version mismatches. */
      stored?: Record<string, string | number | null>;
      expected?: Record<string, string | number>;
      /** Raw cause — server log ONLY, never returned to a client. */
      cause?: unknown;
    };

/** The network the store must be stamped with. */
const NETWORK = "ecx";

export function checkStore(): StoreCheck {
  // Don't let a read create the file: the web process opening a missing path
  // would leave an empty database behind and hide the real problem.
  const path = getDbPath();
  if (path !== ":memory:" && !existsSync(path)) {
    return {
      ok: false,
      reason: "missing",
      detail:
        "No database file at the configured ECASH_METER_DB path. Run the indexer, or point ECASH_METER_DB at the store.",
    };
  }

  try {
    getDb();
    const row = get<{ tip: number | null; blocks: number; last: number | null }>(
      "SELECT MAX(height) AS tip, COUNT(*) AS blocks, MAX(time) AS last FROM blocks",
    );
    const blocks = Number(row?.blocks ?? 0);

    const storedFork = getMeta("fork_block_hash");
    const storedParserRaw = getMeta("parser_version");
    const storedNetwork = getMeta("network");

    if (blocks === 0 || row?.tip == null || row?.last == null) {
      return {
        ok: false,
        reason: "empty",
        detail: "The database has no indexed blocks yet. Run the indexer.",
      };
    }

    // Identity first: data from the wrong chain is wrong regardless of parser.
    // A missing stamp counts as a mismatch — it predates identity stamping, or
    // carries the old genesis-only identity, which cannot tell ECX from Bitcoin.
    if (storedFork !== ECX_FORK_BLOCK_HASH) {
      return {
        ok: false,
        reason: "chain-mismatch",
        detail:
          storedFork == null
            ? "The database has no ECX fork-block stamp, so its chain cannot be verified. Rebuild it with the indexer."
            : "The database was built from a different chain than ECX mainnet. Rebuild it with the indexer against an ECX node.",
        stored: { forkBlockHash: storedFork },
        expected: { forkBlockHash: ECX_FORK_BLOCK_HASH },
      };
    }
    if (storedNetwork !== NETWORK) {
      return {
        ok: false,
        reason: "network-mismatch",
        detail: "The database is not stamped as ECX mainnet data. Rebuild it with the indexer.",
        stored: { network: storedNetwork },
        expected: { network: NETWORK },
      };
    }
    const storedParser = storedParserRaw == null ? null : Number(storedParserRaw);
    if (storedParser !== PARSER_VERSION) {
      return {
        ok: false,
        reason: "parser-mismatch",
        detail:
          "The database was built by a different parser version than this code. Rebuild it: delete the database file and re-run the indexer.",
        stored: { parserVersion: storedParser },
        expected: { parserVersion: PARSER_VERSION },
      };
    }

    const commitments = get<{ n: number }>("SELECT COUNT(*) AS n FROM commitments")?.n ?? 0;
    return {
      ok: true,
      summary: {
        network: storedNetwork,
        tipHeight: Number(row.tip),
        blocks,
        commitments: Number(commitments),
        lastBlockTime: Number(row.last),
        parserVersion: storedParser,
        forkBlockHash: storedFork,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      reason: "unreadable",
      detail: "The database could not be opened or read. See the server log for the cause.",
      cause,
    };
  }
}

// Log each distinct problem once, not on every request — the page is rendered
// per request, and an unavailable store would otherwise flood the journal.
let lastLogged: string | null = null;

/** Write a store problem to the server log (operator-only), once per change. */
export function logStoreProblem(
  check: Extract<StoreCheck, { ok: false }>,
  log: (...args: unknown[]) => void = console.error,
): void {
  const key = `${check.reason}:${JSON.stringify(check.stored ?? null)}`;
  if (key === lastLogged) return;
  lastLogged = key;
  log(
    `[ecash-meter] dashboard data unavailable (${check.reason}): ${check.detail}` +
      ` [db: ${getDbPath()}]` +
      (check.stored ? ` stored=${JSON.stringify(check.stored)} expected=${JSON.stringify(check.expected)}` : ""),
    ...(check.cause ? [check.cause] : []),
  );
}

/** Reset the log de-duplication (tests, and after recovery). */
export function resetStoreProblemLog(): void {
  lastLogged = null;
}
