// Fix #3 — metric selection, share, and ranking all use the SAME metric.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeStats, orderByCustody } from "../lib/aggregate";
import type { DrivechainStats, Drivechain } from "../lib/types";

function chain(slot: number, name: string): Drivechain {
  return { slot, name, ticker: name.slice(0, 4).toUpperCase(), description: "", color: "#000" };
}
function stat(slot: number, name: string, fees: number, bmm: number): DrivechainStats {
  return {
    chain: chain(slot, name),
    totalFeesSats: fees,
    feesLast24hSats: 0,
    bmmCommitments: bmm,
    bmmBidCount: 0,
    avgBidSats: 0,
    shareOfTotal: 0,
    series: [],
  };
}

test("no fees → metric 'bmm'; share and sort use commitment counts", () => {
  const stats = [stat(2, "A", 0, 3), stat(4, "B", 0, 7)];
  const { metric } = finalizeStats(stats);
  assert.equal(metric, "bmm");
  assert.equal(stats[0].chain.name, "B"); // 7 > 3
  assert.ok(Math.abs(stats[0].shareOfTotal - 7 / 10) < 1e-9);
});

test("nonzero fees → metric 'fees'; share and sort use fee sats", () => {
  const stats = [stat(2, "A", 10, 3), stat(4, "B", 90, 7)];
  const { metric } = finalizeStats(stats);
  assert.equal(metric, "fees");
  assert.equal(stats[0].chain.name, "B");
  assert.ok(Math.abs(stats[0].shareOfTotal - 90 / 100) < 1e-9);
});

test("a busy chain paying little ranks below a quiet chain paying more (fee mode)", () => {
  // The original bug: BitNames (10 commitments, 10 sats) beat BitAssets
  // (1 commitment, 1000 sats). Now BitAssets must win in fee mode.
  const stats = [stat(2, "BitNames", 10, 10), stat(4, "BitAssets", 1000, 1)];
  const { metric } = finalizeStats(stats);
  assert.equal(metric, "fees");
  assert.equal(stats[0].chain.name, "BitAssets");
  assert.ok(Math.abs(stats[0].shareOfTotal - 1000 / 1010) < 1e-9);
  assert.ok(Math.abs(stats[1].shareOfTotal - 10 / 1010) < 1e-9);
});

test("zero denominator yields 0 shares, never NaN/Infinity", () => {
  const stats = [stat(2, "A", 0, 0), stat(4, "B", 0, 0)];
  const { metric } = finalizeStats(stats);
  assert.equal(metric, "bmm");
  for (const s of stats) {
    assert.equal(s.shareOfTotal, 0);
    assert.ok(Number.isFinite(s.shareOfTotal));
  }
});

test("equal values use a deterministic tie-breaker (slot ascending)", () => {
  const stats = [stat(9, "C", 50, 5), stat(2, "A", 50, 5), stat(4, "B", 50, 5)];
  finalizeStats(stats);
  assert.deepEqual(stats.map((s) => s.chain.slot), [2, 4, 9]);
});

test("shares sum to ~1 when the selected grand total is nonzero", () => {
  const stats = [stat(2, "A", 33, 1), stat(4, "B", 33, 1), stat(9, "C", 34, 1)];
  finalizeStats(stats);
  const sum = stats.reduce((s, x) => s + x.shareOfTotal, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`);
});

test("stored-path and live-path inputs produce identical output (same helper)", () => {
  const a = [stat(2, "A", 10, 3), stat(4, "B", 90, 7)];
  const b = [stat(2, "A", 10, 3), stat(4, "B", 90, 7)];
  const ra = finalizeStats(a);
  const rb = finalizeStats(b);
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.map((s) => [s.chain.slot, s.shareOfTotal]), b.map((s) => [s.chain.slot, s.shareOfTotal]));
});

// ── Table order: ECX custodied ───────────────────────────────────────────────

const held = (s: DrivechainStats, treasurySats: number | null | undefined) => ({
  ...s,
  treasurySats,
});

test("orderByCustody puts the largest treasury first, whatever the fees", () => {
  const stats = [
    held(stat(46, "Flush", 200_000, 100), 341_009_500),
    held(stat(9, "Thunder", 11_000, 30), 118_000_000),
    held(stat(130, "FreeBank", 0, 0), 1_000_000),
  ];
  // Thunder overtakes Flush once it custodies more.
  stats[1] = held(stats[1], 500_000_000);
  assert.deepEqual(
    orderByCustody(stats).map((r) => r.chain.name),
    ["Thunder", "Flush", "FreeBank"],
  );
});

test("orderByCustody keeps the incoming order for equal balances", () => {
  const stats = [
    held(stat(24, "Elements+", 0, 2), 1_000_000),
    held(stat(130, "FreeBank", 0, 1), 1_000_000),
    held(stat(131, "Tally", 0, 0), 1_000_000),
  ];
  assert.deepEqual(
    orderByCustody(stats).map((r) => r.chain.slot),
    [24, 130, 131],
  );
});

test("orderByCustody sorts unknown and untracked balances last", () => {
  const stats = [
    held(stat(1, "Unknown", 0, 0), null),
    held(stat(2, "Untracked", 0, 0), undefined),
    held(stat(3, "Empty", 0, 0), 0),
    held(stat(4, "Funded", 0, 0), 5),
  ];
  assert.deepEqual(
    orderByCustody(stats).map((r) => r.chain.name),
    ["Funded", "Empty", "Unknown", "Untracked"],
  );
});

test("orderByCustody does not reorder its input", () => {
  const stats = [held(stat(1, "Small", 9, 0), 1), held(stat(2, "Big", 0, 0), 9)];
  orderByCustody(stats);
  assert.deepEqual(stats.map((r) => r.chain.name), ["Small", "Big"]);
});
