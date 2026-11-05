// Single source of truth for headline-metric selection, per-chain share, and
// ranking. Shared by the stored (lib/store.ts) and demo
// (lib/mock-data.ts) paths so they cannot drift apart — the bug this fixes was
// the store choosing "fees" as the headline metric while still computing each
// chain's share and sort order from BMM commitment counts, so `stats[0]` and the
// "% of fees" label were actually driven by commitments.

import type { DrivechainStats } from "./types";

export type Metric = "fees" | "bmm";

/**
 * Choose the headline metric from the aggregated stats, then compute each chain's
 * `shareOfTotal` and the ranking FROM THAT SAME METRIC. Mutates each stat's
 * `shareOfTotal` and sorts `stats` in place (descending by the selected metric,
 * tie-broken by slot so ordering is deterministic when totals are equal).
 *
 * Rule (unchanged): any attributed fee in the window makes "fees" the headline;
 * otherwise the headline is BMM commitment activity.
 */
export function finalizeStats(stats: DrivechainStats[]): {
  metric: Metric;
  grandTotalFeesSats: number;
  grandTotalBmmCommitments: number;
} {
  const grandTotalFeesSats = stats.reduce((s, r) => s + r.totalFeesSats, 0);
  const grandTotalBmmCommitments = stats.reduce(
    (s, r) => s + r.bmmCommitments,
    0,
  );

  const metric: Metric = grandTotalFeesSats > 0 ? "fees" : "bmm";
  const grandTotal =
    metric === "fees" ? grandTotalFeesSats : grandTotalBmmCommitments;
  const valueOf = (r: DrivechainStats) =>
    metric === "fees" ? r.totalFeesSats : r.bmmCommitments;

  for (const r of stats) {
    r.shareOfTotal = grandTotal === 0 ? 0 : valueOf(r) / grandTotal;
  }

  stats.sort((a, b) => {
    const diff = valueOf(b) - valueOf(a);
    return diff !== 0 ? diff : a.chain.slot - b.chain.slot;
  });

  return { metric, grandTotalFeesSats, grandTotalBmmCommitments };
}

/**
 * Order rows by ECX custodied (current treasury balance), largest first, for the
 * drivechain table. Returns a new array; `stats` is untouched, so the headline
 * ranking (top contributor, chart order) is unaffected.
 *
 * Rows whose balance is unknown (null) or untracked (undefined) sort after
 * every known balance. Ties — e.g. several chains holding the same deposit —
 * keep their incoming order, which is the headline ranking from finalizeStats.
 */
export function orderByCustody(stats: DrivechainStats[]): DrivechainStats[] {
  const custody = (r: DrivechainStats) =>
    typeof r.treasurySats === "number" ? r.treasurySats : -1;
  // Array.prototype.sort is stable, so equal balances keep their order.
  return [...stats].sort((a, b) => custody(b) - custody(a));
}
