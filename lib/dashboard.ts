// The dashboard's ONE entry point for data. The website reads the local SQLite
// store and nothing else; the indexer (scripts/index.ts) is the only thing that
// talks to the ECX node. So the site keeps serving saved mainnet data while the
// node is offline, and a node outage can never take the page down.
//
// Three outcomes, never blended:
//   saved        Real ECX mainnet data from a store that passed every check in
//                lib/store-check.ts (identity, network, parser version).
//   unavailable  The store is missing, empty, unreadable or incompatible. The
//                page says "Data temporarily unavailable" and shows NO figures.
//   demo         Sample data — ONLY when ECASH_DEMO=1 is set explicitly. A data
//                failure never switches this on; there is no fallback to it.
//
// (There used to be a request-time "live" mode that scanned the node on every
// render, and both it and the store fell back to mock figures on failure. Both
// are gone: the first made the site depend on the node, the second could pass
// invented numbers off as real ones.)

import type { DashboardData } from "./types";
import { DEFAULT_WINDOW_DAYS } from "./config";
import { getDemoDashboardData } from "./mock-data";
import { getStoredDashboardData, EmptyStoreError } from "./store";
import {
  checkStore,
  logStoreProblem,
  type StoreCheck,
  type StoreSummary,
  type UnavailableReason,
} from "./store-check";

export type Dashboard =
  | { kind: "saved"; data: DashboardData; summary: StoreSummary }
  | { kind: "demo"; data: DashboardData }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      /** Operator-facing detail, safe to publish (no paths or error text). */
      detail: string;
      stored?: Record<string, string | number | null>;
      expected?: Record<string, string | number>;
    };

/** Demo mode is opt-in and explicit: ECASH_DEMO=1, nothing else. */
export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ECASH_DEMO === "1";
}

let warnedLegacySource = false;
/** ECASH_SOURCE / ECASH_LIVE no longer do anything; say so once. */
function warnLegacySettings(env: NodeJS.ProcessEnv): void {
  if (warnedLegacySource) return;
  const source = env.ECASH_SOURCE?.toLowerCase();
  if ((source && source !== "db") || env.ECASH_LIVE === "1") {
    warnedLegacySource = true;
    console.warn(
      "[ecash-meter] ECASH_SOURCE / ECASH_LIVE are no longer supported and are ignored: " +
        "the site always reads the SQLite store. For sample data set ECASH_DEMO=1.",
    );
  }
}

function unavailable(check: Extract<StoreCheck, { ok: false }>): Dashboard {
  logStoreProblem(check);
  return {
    kind: "unavailable",
    reason: check.reason,
    detail: check.detail,
    ...(check.stored ? { stored: check.stored, expected: check.expected } : {}),
  };
}

export async function loadDashboard(
  env: NodeJS.ProcessEnv = process.env,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<Dashboard> {
  warnLegacySettings(env);
  if (isDemoMode(env)) return { kind: "demo", data: getDemoDashboardData(windowDays) };

  const check = checkStore();
  if (!check.ok) return unavailable(check);

  try {
    const data = await getStoredDashboardData(windowDays);
    return { kind: "saved", data, summary: check.summary };
  } catch (err) {
    // The checks passed but reading the figures failed — still never demo data.
    return unavailable(
      err instanceof EmptyStoreError
        ? {
            ok: false,
            reason: "empty",
            detail: "The database has no indexed blocks yet. Run the indexer.",
          }
        : {
            ok: false,
            reason: "unreadable",
            detail: "The database could not be read. See the server log for the cause.",
            cause: err,
          },
    );
  }
}
