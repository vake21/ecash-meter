// Treasury parsing (lib/bmm.ts) and replay (lib/treasury.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTreasury, type RawBlock, type RawTx } from "../lib/bmm";
import {
  replayTreasury,
  type TreasuryOutputRow,
  type TreasurySpendRow,
} from "../lib/treasury";

const id = (c: string) => c.repeat(64);
const SLOT46 = "b7012e51";
const ACTIVATED = [
  { slot: 46, activationHeight: 100 },
  { slot: 9, activationHeight: 100 },
];

function out(
  height: number,
  txIndex: number,
  txid: string,
  slot: number,
  valueSats: number,
  vout = 0,
): TreasuryOutputRow {
  return { height, txIndex, txid, vout, slot, valueSats };
}
function spend(height: number, txIndex: number, txid: string, vout = 0): TreasurySpendRow {
  return { height, txIndex, txid, vout };
}

// ── parseTreasury ────────────────────────────────────────────────────────────

test("parseTreasury finds treasury outputs and spends, skipping the coinbase", () => {
  const coinbase: RawTx = {
    txid: id("0"),
    vout: [{ scriptPubKey: { hex: SLOT46 }, value: 9 }],
  };
  const deposit: RawTx = {
    txid: id("d"),
    vin: [
      {
        txid: id("a"),
        vout: 1,
        prevout: { value: 1, scriptPubKey: { hex: SLOT46 } },
      },
      { txid: id("e"), vout: 0, prevout: { value: 2, scriptPubKey: { hex: "0014" + "00".repeat(20) } } },
    ],
    vout: [
      { scriptPubKey: { hex: "0014" + "11".repeat(20) }, value: 0.5, n: 0 },
      { scriptPubKey: { hex: SLOT46 }, value: 3.410095, n: 1 },
      // Look-alikes that must not match: small-int slot opcode, trailing byte.
      { scriptPubKey: { hex: "b75951" }, value: 1, n: 2 },
      { scriptPubKey: { hex: "b7012e5100" }, value: 1, n: 3 },
    ],
  };
  const block: RawBlock = { height: 1, hash: "h", time: 0, tx: [coinbase, deposit] };
  const { treasuryOutputs, treasurySpends } = parseTreasury(block);

  assert.deepEqual(treasuryOutputs, [
    { txIndex: 1, txid: id("d"), vout: 1, slot: 46, valueSats: 341_009_500 },
  ]);
  assert.deepEqual(treasurySpends, [{ txIndex: 1, txid: id("a"), vout: 1 }]);
});

// ── replayTreasury ───────────────────────────────────────────────────────────

test("follows the chain of treasury outputs to the current one", () => {
  const ctips = replayTreasury(
    [out(101, 1, id("a"), 46, 1_000), out(102, 1, id("b"), 46, 5_000), out(103, 2, id("c"), 46, 4_000)],
    [spend(102, 1, id("a")), spend(103, 2, id("b"))],
    ACTIVATED,
  );
  assert.deepEqual(ctips.get(46), {
    txid: id("c"),
    vout: 0,
    valueSats: 4_000,
    height: 103,
    sequence: 2,
  });
});

test("an activated slot with no deposits is present and empty", () => {
  const ctips = replayTreasury([], [], ACTIVATED);
  assert.equal(ctips.get(9), null);
  assert.equal(ctips.has(77), false);
});

test("ignores a look-alike output that doesn't spend the current treasury", () => {
  const ctips = replayTreasury(
    [out(101, 1, id("a"), 46, 1_000), out(102, 1, id("f"), 46, 999_999)],
    [],
    ACTIVATED,
  );
  assert.equal(ctips.get(46)?.txid, id("a"));
  assert.equal(ctips.get(46)?.valueSats, 1_000);
});

test("ignores outputs before the slot's activation", () => {
  const ctips = replayTreasury([out(99, 1, id("a"), 46, 1_000)], [], ACTIVATED);
  assert.equal(ctips.get(46), null);
});

test("orders same-block events by transaction position", () => {
  // Created and re-spent within one block, listed out of order.
  const ctips = replayTreasury(
    [out(101, 5, id("b"), 46, 2_000), out(101, 2, id("a"), 46, 1_000)],
    [spend(101, 5, id("a"))],
    ACTIVATED,
  );
  assert.equal(ctips.get(46)?.txid, id("b"));
  assert.equal(ctips.get(46)?.sequence, 1);
});

test("a tx creating two outputs for one slot is not a valid successor", () => {
  const ctips = replayTreasury(
    [
      out(101, 1, id("a"), 46, 1_000),
      out(102, 1, id("b"), 46, 2_000, 0),
      out(102, 1, id("b"), 46, 2_000, 1),
    ],
    [spend(102, 1, id("a"))],
    ACTIVATED,
  );
  assert.equal(ctips.get(46), null, "the old treasury was spent with no valid successor");
});

test("slots are independent", () => {
  const ctips = replayTreasury(
    [out(101, 1, id("a"), 46, 1_000), out(101, 2, id("b"), 9, 7_000)],
    [],
    ACTIVATED,
  );
  assert.equal(ctips.get(46)?.valueSats, 1_000);
  assert.equal(ctips.get(9)?.valueSats, 7_000);
});
