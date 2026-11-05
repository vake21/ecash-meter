// Fix #4 — strict BMM commitment parsing + hardened fee attribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBlock,
  txFeeSats,
  BMM_PREFIX,
  type RawBlock,
  type RawTx,
} from "../lib/bmm";

const HA = "aa".repeat(32); // 64 hex chars
const HB = "bb".repeat(32);

/** A coinbase vout carrying a valid BMM commitment for `slot`. */
function commitVout(slotHex: string, hstar: string) {
  return { scriptPubKey: { hex: BMM_PREFIX + slotHex + hstar }, value: 0 };
}
/** A non-coinbase OP_RETURN vout embedding `hstar` (BMM request shape). */
function opReturn(hstar: string) {
  return { scriptPubKey: { hex: "6a20" + hstar }, value: 0 };
}
function block(tx: RawTx[]): RawBlock {
  return { height: 100, hash: "h", time: 1_700_000_000, tx };
}

test("valid BMM commitment parses (slot + hstar)", () => {
  const p = parseBlock(block([{ vout: [commitVout("02", HA)] }]));
  assert.equal(p.commitments.length, 1);
  assert.equal(p.commitments[0].slot, 2);
  assert.equal(p.commitments[0].hstar, HA);
});

test("bare prefix with no slot/hash is ignored", () => {
  const p = parseBlock(block([{ vout: [{ scriptPubKey: { hex: BMM_PREFIX }, value: 0 }] }]));
  assert.equal(p.commitments.length, 0);
});

test("valid slot but short hash is ignored", () => {
  const p = parseBlock(block([{ vout: [{ scriptPubKey: { hex: BMM_PREFIX + "02" + "aa".repeat(16) }, value: 0 }] }]));
  assert.equal(p.commitments.length, 0);
});

test("non-hex hash is ignored", () => {
  const bad = "zz".repeat(32);
  const p = parseBlock(block([{ vout: [{ scriptPubKey: { hex: BMM_PREFIX + "02" + bad }, value: 0 }] }]));
  assert.equal(p.commitments.length, 0);
});

test("wrong push length / trailing bytes is ignored", () => {
  // Extra byte after the 32-byte hash → not the exact 39-byte script.
  const p = parseBlock(block([{ vout: [{ scriptPubKey: { hex: BMM_PREFIX + "02" + HA + "ff" }, value: 0 }] }]));
  assert.equal(p.commitments.length, 0);
});

test("unrelated OP_RETURN is ignored", () => {
  const p = parseBlock(block([{ vout: [{ scriptPubKey: { hex: "6a0568656c6c6f" }, value: 0 }] }]));
  assert.equal(p.commitments.length, 0);
});

test("a malformed commitment cannot match unrelated tx outputs (no empty-string match)", () => {
  // Coinbase has ONLY a malformed (bare-prefix) candidate → no commitments →
  // no fees attributed, even though a fat unrelated OP_RETURN tx is present.
  const p = parseBlock(
    block([
      { vout: [{ scriptPubKey: { hex: BMM_PREFIX }, value: 0 }] }, // malformed coinbase
      { fee: 0.001, vout: [{ scriptPubKey: { hex: "6a04deadbeef" }, value: 0 }] },
    ]),
  );
  assert.equal(p.commitments.length, 0);
});

test("valid commitment still receives the correct fee", () => {
  const p = parseBlock(
    block([
      { vout: [commitVout("02", HA)] },
      { fee: 0.00002, vout: [opReturn(HA)] }, // 2000 sats
    ]),
  );
  assert.equal(p.commitments[0].feeSats, 2000);
});

test("one tx matching multiple commitments cannot attribute more than its own fee", () => {
  const p = parseBlock(
    block([
      { vout: [commitVout("02", HA), commitVout("04", HB)] },
      // A single tx that (unusually) embeds BOTH h* values. Fee = 3000 sats.
      { fee: 0.00003, vout: [opReturn(HA), opReturn(HB)] },
    ]),
  );
  const total = p.commitments.reduce((s, c) => s + c.feeSats, 0);
  assert.ok(total <= 3000, `attributed ${total} must not exceed the 3000-sat tx fee`);
  assert.equal(p.commitments.length, 2);
});

test("txFeeSats handles missing/negative/non-finite fee safely", () => {
  assert.equal(txFeeSats({ vout: [] }), 0); // no fee, no vin
  assert.equal(txFeeSats({ fee: -5, vout: [] }), 0); // negative
  assert.equal(txFeeSats({ fee: NaN, vout: [] }), 0); // NaN
  assert.equal(txFeeSats({ fee: Infinity, vout: [] }), 0); // Infinity
  // input−output fallback
  assert.equal(
    txFeeSats({ vin: [{ prevout: { value: 0.5 } }], vout: [{ scriptPubKey: { hex: "00" }, value: 0.49999 }] }),
    1000,
  );
  // fallback that would go negative clamps to 0
  assert.equal(
    txFeeSats({ vin: [{ prevout: { value: 0.1 } }], vout: [{ scriptPubKey: { hex: "00" }, value: 0.2 }] }),
    0,
  );
});

test("empty transaction array is handled without throwing", () => {
  const p = parseBlock({ height: 1, hash: "h", time: 1, tx: [] });
  assert.equal(p.commitments.length, 0);
});

test("coinbase without a vout array does not crash", () => {
  const p = parseBlock({ height: 1, hash: "h", time: 1, tx: [{} as RawTx] });
  assert.equal(p.commitments.length, 0);
});

test("two valid commitments in one coinbase both parse", () => {
  const p = parseBlock(block([{ vout: [commitVout("02", HA), commitVout("ff", HB)] }]));
  assert.equal(p.commitments.length, 2);
  assert.deepEqual(
    p.commitments.map((c) => c.slot).sort((a, b) => a - b),
    [2, 255],
  );
});

// ── Withdrawal bundles (M3 / M4 / M6) ────────────────────────────────────────

test("M3 and M4 are parsed from the coinbase; only the first M4 is kept", async () => {
  const { parseSidechainMessages } = await import("../lib/bmm");
  const m6id = "ab".repeat(32);
  const got = parseSidechainMessages({
    vout: [
      { scriptPubKey: { hex: "6a25d45aa9432e" + m6id }, value: 0 },
      { scriptPubKey: { hex: "6a07d77d177601ff00" }, value: 0 },
      { scriptPubKey: { hex: "6a05d77d177603" }, value: 0 },
      { scriptPubKey: { hex: "6a24d45aa9432e" + m6id.slice(2) }, value: 0 }, // too short
    ],
  });
  assert.deepEqual(got.bundleProposals, [{ vout: 0, slot: 46, m6id }]);
  assert.deepEqual(got.bundleAcks, [{ vout: 1, version: 1, votesHex: "ff00" }]);
});

// Checked against the node: `decoderawtransaction <blinded hex> false` on an
// ECX node reports txid 4efefae3…e0a4, the byte-reverse of the M6id below.
const SAMPLE_WITHDRAWAL = {
  txid: "11".repeat(32),
  version: 2,
  locktime: 983_000,
  vin: [{ txid: "44".repeat(32), vout: 0, prevout: { value: 1.0, scriptPubKey: { hex: "b7012e51" } } }],
  vout: [
    { scriptPubKey: { hex: "b7012e51" }, value: 0.6 }, // new treasury, slot 46
    { scriptPubKey: { hex: "0014" + "22".repeat(20) }, value: 0.25 },
    { scriptPubKey: { hex: "76a914" + "33".repeat(20) + "88ac" }, value: 0.1 },
  ],
};

test("computeM6id matches the enforcer's blinded-transaction txid", async () => {
  const { blindedM6Hex, computeM6id } = await import("../lib/bmm");
  assert.equal(
    blindedM6Hex(SAMPLE_WITHDRAWAL, 100_000_000),
    "0200000000030000000000000000" + "0a6a0800000000004c4b40" + // 0 inputs; fee 0.05 BTC
      "40787d01000000001600142222222222222222222222222222222222222222" +
      "80969800000000001976a914333333333333333333333333333333333333333388ac" +
      "d8ff0e00",
  );
  assert.equal(
    computeM6id(SAMPLE_WITHDRAWAL, 100_000_000),
    "a4e0e37f6ae474d0111390f9e87bad251eeb55f9daaf27922d57d1e0e3fafe4e",
  );
  // Payouts larger than the treasury: not a withdrawal.
  assert.equal(computeM6id(SAMPLE_WITHDRAWAL, 90_000_000), null);
});

test("a withdrawal is recognised from its prevouts; a deposit is not", async () => {
  const { withdrawalOf } = await import("../lib/bmm");
  assert.deepEqual(withdrawalOf(SAMPLE_WITHDRAWAL), {
    txid: "11".repeat(32),
    slot: 46,
    m6id: "a4e0e37f6ae474d0111390f9e87bad251eeb55f9daaf27922d57d1e0e3fafe4e",
  });
  const deposit = {
    ...SAMPLE_WITHDRAWAL,
    vout: [{ scriptPubKey: { hex: "b7012e51" }, value: 1.5 }],
  };
  assert.equal(withdrawalOf(deposit), null);
});
