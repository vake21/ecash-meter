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
// further than the chosen window (7 or 30 calendar days) into the past. "Fees last 24h" is a real
// rolling boundary (blocks newer than latest-block-time − 24h), and lastBlockTime
// is exposed so the UI can show freshness rather than presenting stale data as new.

import type {
  DashboardData,
  DrivechainStats,
  FeePoint,
  PendingProposalView,
} from "./types";
import {
  ACTIVATED_DRIVECHAINS,
  ECX_FORK_HEIGHT,
  KNOWN_DRIVECHAINS,
  resolveDrivechains,
  DEFAULT_WINDOW_DAYS,
} from "./config";
import {
  replayProposals,
  type AckRow,
  type Declaration,
  type ProposalReplay,
  type ProposalRow,
} from "./proposals";
import { get, all, getMeta } from "./db";
import { finalizeStats } from "./aggregate";
import { utcDate } from "./bmm";
import {
  dailyBalances,
  dailyFlows,
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

/**
 * Which slots are activated, from the stored BIP 300 votes — and the vote
 * replay itself (for pending proposals and on-chain names). Needs the store to
 * reach back to the ECX fork, where BIP 300 began; a shallower store can't see
 * the votes that activated a slot, so it falls back to the activation table in
 * config.ts and has no replay (pending proposals unknown).
 */
export function loadActivation(
  tipHeight: number,
  storeFloor: number,
): {
  replay: ProposalReplay | null;
  activated: { slot: number; activationHeight: number }[];
} {
  const replay =
    storeFloor <= ECX_FORK_HEIGHT
      ? replayProposals(
          all<ProposalRow>(
            `SELECT height, vout, slot, description_hex AS descriptionHex, hash
             FROM sidechain_proposals`,
          ),
          all<AckRow>("SELECT height, slot, hash FROM sidechain_acks"),
          tipHeight,
        )
      : null;
  const activated = replay
    ? [...replay.active.values()].map((a) => ({
        slot: a.slot,
        activationHeight: a.activationHeight,
      }))
    : ACTIVATED_DRIVECHAINS.map((c) => ({
        slot: c.slot,
        activationHeight: c.activationHeight!,
      }));
  return { replay, activated };
}

/** Blocks used to measure the current block rate (~2 days at ECX's late-2026 pace). */
const RATE_WINDOW_BLOCKS = 432;

/**
 * Mean seconds per block over the most recent RATE_WINDOW_BLOCKS — not the
 * whole store. ECX's difficulty was still settling after the fork: blocks
 * since the fork averaged 57 s while the last 432 averaged 387 s (2026-11-04),
 * so a whole-history mean would understate a voting window ~7×.
 */
function recentBlockSeconds(
  tipHeight: number,
  tipTime: number,
  storeFloor: number,
): number | undefined {
  const from = Math.max(storeFloor, tipHeight - RATE_WINDOW_BLOCKS);
  if (from >= tipHeight) return undefined;
  const row = get<{ time: number }>("SELECT time FROM blocks WHERE height = ?", from);
  if (!row) return undefined;
  const s = (tipTime - row.time) / (tipHeight - from);
  return s > 0 ? s : undefined;
}

/**
 * `windowDays` is the reporting window the visitor chose (7 or 30). It sets the
 * dates the series, totals and shares cover. Current balances, pending
 * proposals and the rolling 24h figure don't depend on it.
 */
export async function getStoredDashboardData(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<DashboardData> {
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
  // Contiguous calendar window: at most the chosen window, and never longer than the
  // span actually covered (so a 3-day-old store doesn't render 27 empty days).
  const spanDays = daysBetween(firstDate, refDate) + 1;
  const shownDays = Math.max(1, Math.min(windowDays, spanDays));
  const dates = lastNDatesEnding(refDate, shownDays);
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
  // Which slots are activated, and which proposals are pending, replayed from
  // the stored BIP 300 messages. That needs the store to reach back to the ECX
  // fork, where BIP 300 began; a shallower store can't see the votes that
  // activated a slot, so it falls back to the activation table in config.ts
  // and reports pending proposals as unknown.
  const storeFloor = tipRow.minHeight ?? Infinity;
  const { replay, activated } = loadActivation(tipHeight, storeFloor);
  // On-chain names for active slots — used only where config.ts has no entry.
  const declarations = new Map<number, Declaration>();
  for (const a of replay?.active.values() ?? []) {
    if (a.declaration) declarations.set(a.slot, a.declaration);
  }

  // Activated slots are listed too, even with no BMM activity in the window:
  // an activated sidechain that isn't merge-mining yet can still hold coins.
  const activatedSlots = new Set(activated.map((c) => c.slot));
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
    activated,
  );
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
    const chain = activated.find((c) => c.slot === slot);
    if (!chain) return undefined;
    if (storeFloor > chain.activationHeight) return null;
    return ctips.get(slot)?.valueSats ?? 0;
  };
  const stats: DrivechainStats[] = resolveDrivechains(observedSlots, declarations).map((chain) => {
    const byDate = tally.get(chain.slot);
    // End-of-day treasury balances and daily deposits/withdrawals, only where
    // the balance is known (a store that misses part of the history would
    // misread the first change it sees as one big deposit).
    const known = treasuryOf(chain.slot) != null;
    const changes = history.get(chain.slot) ?? [];
    const heightTime = (h: number) => timeByHeight.get(h);
    const balances = known
      ? dailyBalances(changes, heightTime, dates, utcDate)
      : undefined;
    const flows = known ? dailyFlows(changes, heightTime, dates, utcDate) : undefined;
    const series: FeePoint[] = dates.map((date, i) => ({
      date,
      bmmCount: byDate?.get(date)?.bmm ?? 0,
      feeSats: byDate?.get(date)?.fee ?? 0,
      ...(balances ? { treasurySats: balances[i] } : {}),
      ...(flows
        ? { depositSats: flows.deposits[i], withdrawalSats: flows.withdrawals[i] }
        : {}),
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
    // Days actually covered: shorter than the chosen window while the store's
    // history is younger than it.
    windowDays: shownDays,
    blocksScanned,
    stats,
    grandTotalFeesSats,
    grandTotalBmmCommitments,
    lastBlockTime,
    activatedCount: activatedSlots.size,
    avgBlockSeconds: recentBlockSeconds(tipHeight, lastBlockTime, storeFloor),
    pendingProposals: replay
      ? replay.pending.map((p): PendingProposalView => {
          const occupant = p.replaces
            ? (KNOWN_DRIVECHAINS.find((c) => c.slot === p.slot)?.name ??
              p.replaces.declaration?.title ??
              `Slot ${p.slot}`)
            : null;
          return {
            slot: p.slot,
            name: p.declaration?.title ?? `Slot ${p.slot}`,
            description: p.declaration?.description ?? "",
            proposalHeight: p.proposalHeight,
            votes: p.votes,
            votesNeeded: p.threshold + 1,
            age: p.age,
            blocksLeft: p.maxAge - p.age,
            replaces: occupant,
          };
        })
      : null,
    totalTreasurySats,
    note:
      grandTotalBmmCommitments > 0 && grandTotalFeesSats === 0
        ? "No BMM bid in this window paid a fee, so the headline is commitment activity."
        : undefined,
  };
}
