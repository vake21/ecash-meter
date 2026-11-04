// DB-backed dashboard reader. Aggregates persisted BMM commitments into the same
// DashboardData shape the mock and live-node paths return — so the UI is unchanged.
//
// This path NEVER talks to the node: the website reads history straight from the
// SQLite store, so it renders even while the node is off. The indexer
// (scripts/index.ts) is what keeps the store fresh.
//
// The reporting window is a run of CONTIGUOUS UTC calendar days ending at the
// latest indexed block's date — NOT "the N most recent days that happened to have
// activity". Zero-activity days appear as zeros, and the window can never reach
// further than WINDOW_DAYS calendar days into the past. "Fees last 24h" is a real
// rolling boundary (blocks newer than latest-block-time − 24h), and lastBlockTime
// is exposed so the UI can show freshness rather than presenting stale data as new.

import type { DashboardData, DrivechainStats, FeePoint } from "./types";
import { ACTIVATED_DRIVECHAINS, resolveDrivechains, WINDOW_DAYS } from "./config";
import { get, all, getMeta } from "./db";
import { finalizeStats } from "./aggregate";
import { utcDate } from "./bmm";
import {
  dailyBalances,
  replayTreasuryHistory,
  type TreasuryOutputRow,
  type TreasurySpendRow,
} from "./treasury";

/** Thrown when the store has no data yet (caller can fall back to mock). */
export class EmptyStoreError extends Error {}

interface AggRow {
  slot: number;
  date: string;
  bmm: number;
  fee: number;
}

const DAY_SECONDS = 86_400;

/** ISO date `iso` shifted by `delta` whole UTC days. */
function addDaysUTC(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
/** Whole UTC days from ISO date `a` to ISO date `b` (b − a). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}
/** `n` contiguous UTC dates ending at `refDate` (chronological). */
function lastNDatesEnding(refDate: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDaysUTC(refDate, -i));
  return out;
}

export async function getStoredDashboardData(): Promise<DashboardData> {
  const tipRow = get<{
    tip: number | null;
    minHeight: number | null;
    scanned: number;
    firstTime: number | null;
    lastTime: number | null;
  }>(
    "SELECT MAX(height) AS tip, MIN(height) AS minHeight, COUNT(*) AS scanned, MIN(time) AS firstTime, MAX(time) AS lastTime FROM blocks",
  );
  const tipHeight = tipRow?.tip;
  const blocksScanned = tipRow?.scanned ?? 0;
  if (tipHeight == null || blocksScanned === 0 || tipRow?.lastTime == null) {
    throw new EmptyStoreError("no blocks indexed yet");
  }

  const network = (getMeta("network") ?? "ecx") as DashboardData["network"];

  // Reference point for the whole window is the latest indexed block time.
  const lastBlockTime = tipRow.lastTime;
  const refDate = utcDate(lastBlockTime);
  const firstDate = utcDate(tipRow.firstTime!);
  // Contiguous calendar window: at most WINDOW_DAYS, and never longer than the
  // span actually covered (so a 3-day-old store doesn't render 27 empty days).
  const spanDays = daysBetween(firstDate, refDate) + 1;
  const windowDays = Math.max(1, Math.min(WINDOW_DAYS, spanDays));
  const dates = lastNDatesEnding(refDate, windowDays);
  const windowStart = dates[0];

  // Per slot/day aggregates within the window.
  const rows = all<AggRow>(
    `SELECT c.slot AS slot,
            strftime('%Y-%m-%d', b.time, 'unixepoch') AS date,
            COUNT(*) AS bmm,
            COALESCE(SUM(c.fee_sats), 0) AS fee
     FROM commitments c
     JOIN blocks b ON b.height = c.height
     WHERE strftime('%Y-%m-%d', b.time, 'unixepoch') >= ?
     GROUP BY c.slot, date`,
    windowStart,
  );

  // Rolling 24h: fees on blocks newer than (latest block time − 24h), per slot.
  const cutoff = lastBlockTime - DAY_SECONDS;
  const last24Rows = all<{ slot: number; fee: number }>(
    `SELECT c.slot AS slot, COALESCE(SUM(c.fee_sats), 0) AS fee
     FROM commitments c
     JOIN blocks b ON b.height = c.height
     WHERE b.time > ?
     GROUP BY c.slot`,
    cutoff,
  );
  const last24BySlot = new Map(last24Rows.map((r) => [r.slot, r.fee]));

  // slot -> date -> {bmm, fee} (all dates in the window are contiguous).
  const tally = new Map<number, Map<string, { bmm: number; fee: number }>>();
  for (const r of rows) {
    let byDate = tally.get(r.slot);
    if (!byDate) tally.set(r.slot, (byDate = new Map()));
    byDate.set(r.date, { bmm: r.bmm, fee: r.fee });
  }

  // Rows come from the slots actually present in the window (plus any slot with
  // rolling-24h activity), NOT from a hardcoded registry. Iterating a fixed
  // slate silently dropped every slot missing from it — real indexed activity
  // vanished from the site. resolveDrivechains() supplies metadata, synthesizing
  // an entry for a slot we have no published name for.
  //
  // Activated slots are listed too, even with no BMM activity in the window:
  // an activated sidechain that isn't merge-mining yet can still hold coins.
  const activatedSlots = new Set(ACTIVATED_DRIVECHAINS.map((c) => c.slot));
  const observedSlots = new Set<number>([
    ...tally.keys(),
    ...last24BySlot.keys(),
    ...activatedSlots,
  ]);

  // Treasury balances, replayed from every stored treasury event. A slot's
  // balance is only trustworthy if the store reaches back to its activation —
  // a store that starts later may have missed the deposits that created its
  // current treasury, so that slot reads as unknown (null), never as 0.
  const { ctips, history } = replayTreasuryHistory(
    all<TreasuryOutputRow>(
      `SELECT height, tx_index AS txIndex, txid, vout, slot, value_sats AS valueSats
       FROM treasury_outputs`,
    ),
    all<TreasurySpendRow>(
      "SELECT height, tx_index AS txIndex, txid, vout FROM treasury_spends",
    ),
    ACTIVATED_DRIVECHAINS,
  );
  const storeFloor = tipRow.minHeight ?? Infinity;
  // Block times for the heights where a balance changed (few rows).
  const changeHeights = [...new Set([...history.values()].flat().map((c) => c.height))];
  const timeByHeight = new Map<number, number>(
    changeHeights.length === 0
      ? []
      : all<{ height: number; time: number }>(
          `SELECT height, time FROM blocks WHERE height IN (${changeHeights.map(() => "?").join(",")})`,
          ...changeHeights,
        ).map((r) => [r.height, r.time]),
  );
  const treasuryOf = (slot: number): number | null | undefined => {
    const chain = ACTIVATED_DRIVECHAINS.find((c) => c.slot === slot);
    if (!chain) return undefined;
    if (storeFloor > chain.activationHeight!) return null;
    return ctips.get(slot)?.valueSats ?? 0;
  };
  const stats: DrivechainStats[] = resolveDrivechains(observedSlots).map((chain) => {
    const byDate = tally.get(chain.slot);
    // End-of-day treasury balances, only where the balance is known.
    const balances =
      treasuryOf(chain.slot) != null
        ? dailyBalances(
            history.get(chain.slot) ?? [],
            (h) => timeByHeight.get(h),
            dates,
            utcDate,
          )
        : undefined;
    const series: FeePoint[] = dates.map((date, i) => ({
      date,
      bmmCount: byDate?.get(date)?.bmm ?? 0,
      feeSats: byDate?.get(date)?.fee ?? 0,
      ...(balances ? { treasurySats: balances[i] } : {}),
    }));
    const bmmCommitments = series.reduce((s, p) => s + p.bmmCount, 0);
    const totalFeesSats = series.reduce((s, p) => s + p.feeSats, 0);
    return {
      chain,
      totalFeesSats,
      feesLast24hSats: last24BySlot.get(chain.slot) ?? 0,
      bmmCommitments,
      bmmBidCount: 0,
      avgBidSats: 0,
      shareOfTotal: 0, // filled by finalizeStats
      series,
      activated: activatedSlots.has(chain.slot),
      treasurySats: treasuryOf(chain.slot),
    };
  });

  // Metric selection, per-chain share, and ranking — all from the same metric.
  const { metric, grandTotalFeesSats, grandTotalBmmCommitments } =
    finalizeStats(stats);

  const treasuries = stats
    .filter((r) => r.activated)
    .map((r) => r.treasurySats);
  const totalTreasurySats = treasuries.some((t) => t == null)
    ? null
    : treasuries.reduce<number>((sum, t) => sum + (t ?? 0), 0);

  return {
    network,
    metric,
    tipHeight,
    windowDays,
    blocksScanned,
    stats,
    grandTotalFeesSats,
    grandTotalBmmCommitments,
    lastBlockTime,
    activatedCount: activatedSlots.size,
    totalTreasurySats,
    note:
      grandTotalBmmCommitments > 0 && grandTotalFeesSats === 0
        ? "No BMM bid in this window paid a fee, so the headline is commitment activity."
        : undefined,
  };
}
