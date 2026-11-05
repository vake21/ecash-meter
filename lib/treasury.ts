// Sidechain treasury replay: which L1 output is each slot's CURRENT treasury
// (its "CTIP"), and so how much ECX the sidechain holds.
//
// Under BIP 300 a sidechain's coins sit in ONE L1 output per slot. Every deposit
// (M5) and withdrawal (M6) spends that output and creates its successor, so the
// treasuries form a chain per slot, and the latest link's value is the balance.
//
// The script alone is not enough to identify a treasury: anyone can create an
// output with a drivechain script without touching the real one, and a plain
// bitcoind will accept it. So, mirroring the enforcer's rule, we replay events
// in chain order and accept a new treasury output for a slot only if
//   - the slot is activated at that height, and
//   - the tx creates exactly ONE treasury output for that slot, and
//   - it spends the slot's current treasury (or the slot has none yet — the
//     first deposit).
// Anything else is ignored. A tx that spends the current treasury WITHOUT a
// valid successor leaves the slot empty.
//
// Verified against the ECX enforcer's GetCtip on 2026-11-04: same outpoint,
// value and sequence number for all five activated slots.

import type { Drivechain } from "./types";

export interface TreasuryOutputRow {
  height: number;
  txIndex: number;
  txid: string;
  vout: number;
  slot: number;
  valueSats: number;
}
export interface TreasurySpendRow {
  height: number;
  txIndex: number;
  txid: string;
  vout: number;
}

export interface Ctip {
  txid: string;
  vout: number;
  valueSats: number;
  height: number;
  /** 0 for the slot's first treasury output, +1 for each successor. */
  sequence: number;
}

const outpoint = (txid: string, vout: number) => `${txid}:${vout}`;
const txKey = (height: number, txIndex: number) => height * 1_000_000 + txIndex;

/** A slot's balance changed at this height (0 = emptied). */
export interface BalanceChange {
  height: number;
  valueSats: number;
  /**
   * The transaction that made this change: the one creating the new treasury
   * output. Absent when the treasury was emptied (spent with no successor).
   */
  txid?: string;
}

export interface TreasuryReplay {
  /** Every activated slot's current treasury: its Ctip, or null if it holds nothing. */
  ctips: Map<number, Ctip | null>;
  /** Every activated slot's balance changes, in chain order. */
  history: Map<number, BalanceChange[]>;
}

/**
 * Replay treasury events into each activated slot's current treasury output.
 * Returns an entry for every slot in `activated`: its Ctip, or null when the
 * slot holds nothing (never funded, or emptied).
 */
export function replayTreasury(
  outputs: TreasuryOutputRow[],
  spends: TreasurySpendRow[],
  activated: Pick<Drivechain, "slot" | "activationHeight">[],
): Map<number, Ctip | null> {
  return replayTreasuryHistory(outputs, spends, activated).ctips;
}

/** As replayTreasury, but also returns each slot's balance history. */
export function replayTreasuryHistory(
  outputs: TreasuryOutputRow[],
  spends: TreasurySpendRow[],
  activated: Pick<Drivechain, "slot" | "activationHeight">[],
): TreasuryReplay {
  const activationBySlot = new Map(
    activated
      .filter((c) => c.activationHeight != null)
      .map((c) => [c.slot, c.activationHeight!]),
  );

  // Group events by transaction, in chain order.
  const byTx = new Map<
    number,
    { height: number; outs: TreasuryOutputRow[]; spent: Set<string> }
  >();
  const entry = (height: number, txIndex: number) => {
    const k = txKey(height, txIndex);
    let e = byTx.get(k);
    if (!e) byTx.set(k, (e = { height, outs: [], spent: new Set() }));
    return e;
  };
  for (const o of outputs) entry(o.height, o.txIndex).outs.push(o);
  for (const s of spends) entry(s.height, s.txIndex).spent.add(outpoint(s.txid, s.vout));

  const ctips = new Map<number, Ctip | null>();
  const history = new Map<number, BalanceChange[]>();
  for (const slot of activationBySlot.keys()) {
    ctips.set(slot, null);
    history.set(slot, []);
  }
  const nextSeq = new Map<number, number>();

  for (const k of [...byTx.keys()].sort((a, b) => a - b)) {
    const { height, outs, spent } = byTx.get(k)!;

    const touched = new Set<number>(outs.map((o) => o.slot));
    for (const [slot, c] of ctips) {
      if (c && spent.has(outpoint(c.txid, c.vout))) touched.add(slot);
    }

    for (const slot of touched) {
      const activation = activationBySlot.get(slot);
      if (activation == null || height < activation) continue;
      const current = ctips.get(slot) ?? null;
      const spendsCurrent =
        current != null && spent.has(outpoint(current.txid, current.vout));
      const slotOuts = outs.filter((o) => o.slot === slot);

      if (slotOuts.length === 1 && (current == null || spendsCurrent)) {
        const o = slotOuts[0];
        const sequence = nextSeq.get(slot) ?? 0;
        nextSeq.set(slot, sequence + 1);
        ctips.set(slot, {
          txid: o.txid,
          vout: o.vout,
          valueSats: o.valueSats,
          height: o.height,
          sequence,
        });
        history.get(slot)!.push({ height, valueSats: o.valueSats, txid: o.txid });
      } else if (spendsCurrent) {
        ctips.set(slot, null);
        history.get(slot)!.push({ height, valueSats: 0 });
      }
    }
  }
  return { ctips, history };
}

/**
 * End-of-day balance for each of `dates` (ascending ISO dates), given a slot's
 * balance changes and the unix time of each block height. A day with no change
 * carries the previous balance forward; days before the first change read 0.
 */
export function dailyBalances(
  changes: BalanceChange[],
  timeOfHeight: (height: number) => number | undefined,
  dates: string[],
  toDate: (unixSeconds: number) => string,
): number[] {
  const dated = changes
    .map((c) => {
      const t = timeOfHeight(c.height);
      return t == null ? null : { date: toDate(t), valueSats: c.valueSats };
    })
    .filter((c): c is { date: string; valueSats: number } => c != null);
  let i = 0;
  let balance = 0;
  return dates.map((d) => {
    while (i < dated.length && dated[i].date <= d) balance = dated[i++].valueSats;
    return balance;
  });
}

/**
 * ECX deposited and withdrawn on each of `dates`, from a slot's balance
 * changes. A treasury only moves through deposits (M5) and withdrawals (M6),
 * so a rise in balance is a deposit and a fall is a withdrawal, each the size
 * of the change. Changes before the window still set the running balance but
 * are not counted.
 *
 * On ECX a deposit arrives in two transactions — a loose treasury-script output,
 * then a merge that spends it with the current treasury. Only the merge changes
 * the balance, so each deposit is counted once, at the merge.
 */
export function dailyFlows(
  changes: BalanceChange[],
  timeOfHeight: (height: number) => number | undefined,
  dates: string[],
  toDate: (unixSeconds: number) => string,
): { deposits: number[]; withdrawals: number[] } {
  const index = new Map(dates.map((d, i) => [d, i]));
  const deposits = dates.map(() => 0);
  const withdrawals = dates.map(() => 0);
  let balance = 0;
  for (const c of changes) {
    const delta = c.valueSats - balance;
    balance = c.valueSats;
    const t = timeOfHeight(c.height);
    const i = t == null ? undefined : index.get(toDate(t));
    if (i == null) continue;
    if (delta > 0) deposits[i] += delta;
    else if (delta < 0) withdrawals[i] -= delta;
  }
  return { deposits, withdrawals };
}
