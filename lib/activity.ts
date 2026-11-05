// Recent drivechain activity for the live feed: BMM blocks, deposits and
// withdrawals, newest first. Read from the SQLite store only — like the rest of
// the site it never contacts the node, so the feed is exactly as fresh as the
// indexer's last run.
//
//   bmm         a sidechain block merge-mined into L1 (a coinbase commitment),
//               with the bid the sidechain paid (0 when no paid bid matched)
//   deposit     ECX moved into a sidechain's L1 treasury
//   withdrawal  ECX paid out of it
//
// Deposits and withdrawals come from the same treasury replay as the balances
// (lib/treasury.ts), so a look-alike output never shows up as a deposit, and
// each amount is exactly the change in the sidechain's balance.

import { all } from "./db";
import { resolveDrivechains } from "./config";
import { checkStore, logStoreProblem, type UnavailableReason } from "./store-check";
import { activationCheck, loadActivation, loadPendingWithdrawals } from "./store";
import type { PendingWithdrawalView } from "./types";
import { decodeDeclaration, type Declaration, type ProposalReplay } from "./proposals";
import {
  replayTreasuryHistory,
  type TreasuryOutputRow,
  type TreasurySpendRow,
} from "./treasury";

export type ActivityKind = "bmm" | "deposit" | "withdrawal";

export interface ActivityEvent {
  /** Stable key: kind + height + slot (+ txid for treasury events). */
  id: string;
  kind: ActivityKind;
  height: number;
  /** Unix seconds of the L1 block. */
  time: number;
  blockHash: string;
  slot: number;
  name: string;
  color: string;
  /** bmm: the bid paid to L1 (sats). deposit/withdrawal: the amount moved (sats). */
  amountSats: number;
  /** deposit/withdrawal: the transaction that moved the treasury, when known. */
  txid?: string;
  /**
   * False for a BMM commitment to a slot that wasn't activated at that height
   * (no effect on L1; left out of the dashboard's figures). Always true for
   * deposits and withdrawals, which only exist for activated slots.
   */
  activated: boolean;
}

export type ActivityResult =
  | {
      ok: true;
      tipHeight: number;
      events: ActivityEvent[];
      /** Refreshed with the feed so the Pending Withdrawals box stays live. */
      pendingWithdrawals: PendingWithdrawalView[] | null;
    }
  | { ok: false; reason: UnavailableReason };

export const DEFAULT_ACTIVITY_LIMIT = 25;
export const MAX_ACTIVITY_LIMIT = 100;

export function getRecentActivity(limit: number = DEFAULT_ACTIVITY_LIMIT): ActivityResult {
  const n = Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(limit) || DEFAULT_ACTIVITY_LIMIT));

  // Same validation as the dashboard: never serve figures from a store that
  // fails the identity / parser checks.
  const check = checkStore();
  if (!check.ok) {
    logStoreProblem(check);
    return { ok: false, reason: check.reason };
  }
  const tipHeight = check.summary.tipHeight;

  // BMM blocks: the newest `n` commitments.
  const bmm = all<{ height: number; slot: number; fee: number; time: number; hash: string }>(
    `SELECT c.height AS height, c.slot AS slot, c.fee_sats AS fee, b.time AS time, b.hash AS hash
     FROM commitments c JOIN blocks b ON b.height = c.height
     ORDER BY c.height DESC, c.slot ASC
     LIMIT ?`,
    n,
  );

  // Treasury flows: replay the whole history (small), keep the newest `n`.
  // Activated slots exactly as the dashboard determines them.
  const minHeight =
    all<{ m: number | null }>("SELECT MIN(height) AS m FROM blocks")[0]?.m ?? Infinity;
  const { replay, activated } = loadActivation(tipHeight, minHeight);
  const isActivatedAt = activationCheck(activated);
  const { history } = replayTreasuryHistory(
    all<TreasuryOutputRow>(
      `SELECT height, tx_index AS txIndex, txid, vout, slot, value_sats AS valueSats
       FROM treasury_outputs`,
    ),
    all<TreasurySpendRow>("SELECT height, tx_index AS txIndex, txid, vout FROM treasury_spends"),
    activated,
  );
  const flows: { kind: ActivityKind; height: number; slot: number; amount: number; txid?: string }[] = [];
  for (const [slot, changes] of history) {
    let balance = 0;
    for (const c of changes) {
      const delta = c.valueSats - balance;
      balance = c.valueSats;
      if (delta === 0) continue;
      flows.push({
        kind: delta > 0 ? "deposit" : "withdrawal",
        height: c.height,
        slot,
        amount: Math.abs(delta),
        txid: c.txid,
      });
    }
  }
  flows.sort((a, b) => b.height - a.height);
  const recentFlows = flows.slice(0, n);

  // Block time + hash for the flow heights.
  const flowHeights = [...new Set(recentFlows.map((f) => f.height))];
  const blockInfo = new Map(
    flowHeights.length === 0
      ? []
      : all<{ height: number; time: number; hash: string }>(
          `SELECT height, time, hash FROM blocks WHERE height IN (${flowHeights.map(() => "?").join(",")})`,
          ...flowHeights,
        ).map((r) => [r.height, r]),
  );

  const declarations = slotDeclarations(replay);
  const chains = new Map(
    resolveDrivechains(
      [...bmm.map((r) => r.slot), ...recentFlows.map((f) => f.slot)],
      declarations,
    ).map((c) => [
      c.slot,
      c,
    ]),
  );

  const events: ActivityEvent[] = [
    ...bmm.map((r): ActivityEvent => ({
      id: `bmm-${r.height}-${r.slot}`,
      kind: "bmm",
      height: r.height,
      time: r.time,
      blockHash: r.hash,
      slot: r.slot,
      name: chains.get(r.slot)!.name,
      color: chains.get(r.slot)!.color,
      amountSats: r.fee,
      activated: isActivatedAt(r.slot, r.height),
    })),
    ...recentFlows.flatMap((f): ActivityEvent[] => {
      const b = blockInfo.get(f.height);
      if (!b) return [];
      return [
        {
          id: `${f.kind}-${f.height}-${f.slot}-${f.txid ?? ""}`,
          kind: f.kind,
          height: f.height,
          time: b.time,
          blockHash: b.hash,
          slot: f.slot,
          name: chains.get(f.slot)!.name,
          color: chains.get(f.slot)!.color,
          amountSats: f.amount,
          activated: true,
          ...(f.txid ? { txid: f.txid } : {}),
        },
      ];
    }),
  ];
  // Newest first; within a block, money movements before BMM, then by slot.
  const order: Record<ActivityKind, number> = { withdrawal: 0, deposit: 1, bmm: 2 };
  events.sort(
    (a, b) => b.height - a.height || order[a.kind] - order[b.kind] || a.slot - b.slot,
  );
  return {
    ok: true,
    tipHeight,
    events: events.slice(0, n),
    pendingWithdrawals: loadPendingWithdrawals(tipHeight, activated, declarations),
  };
}

/**
 * The best on-chain name for every slot that has ever been proposed, so the
 * feed can name a slot even before it's activated (published names in
 * config.ts still come first). Preference: the active sidechain's own
 * declaration, then the pending proposal with the most votes, then the most
 * recent proposal for the slot. A slot never proposed falls back to "Slot N".
 */
function slotDeclarations(replay: ProposalReplay | null): Map<number, Declaration> {
  const names = new Map<number, Declaration>();
  const stored = all<{ slot: number; descriptionHex: string }>(
    `SELECT slot, description_hex AS descriptionHex FROM sidechain_proposals
     ORDER BY height, vout`,
  );
  for (const p of stored) {
    const d = decodeDeclaration(p.descriptionHex);
    if (d) names.set(p.slot, d);
  }
  for (const p of [...(replay?.pending ?? [])].sort((a, b) => a.votes - b.votes)) {
    if (p.declaration) names.set(p.slot, p.declaration);
  }
  for (const a of replay?.active.values() ?? []) {
    if (a.declaration) names.set(a.slot, a.declaration);
  }
  return names;
}
