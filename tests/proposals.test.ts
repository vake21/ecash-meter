// BIP 300 proposal replay (lib/proposals.ts) and M1/M2 parsing (lib/bmm.ts),
// against the enforcer's rules. Small thresholds keep the cases readable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeDeclaration,
  replayProposals,
  ECX_THRESHOLDS,
  type AckRow,
  type ProposalRow,
  type Thresholds,
} from "../lib/proposals";
import { opReturnPush, parseSidechainMessages, sha256dHex } from "../lib/bmm";

const T: Thresholds = {
  unusedSlotActivation: 3, // > 3 votes …
  unusedSlotMaxAge: 6, // … within 6 blocks
  usedSlotActivation: 5,
  usedSlotMaxAge: 10,
};
const H = (c: string) => c.repeat(64);
const m1 = (height: number, slot: number, hash: string, vout = 0): ProposalRow => ({
  height,
  vout,
  slot,
  descriptionHex: "",
  hash,
});
const acks = (slot: number, hash: string, heights: number[]): AckRow[] =>
  heights.map((height) => ({ height, slot, hash }));

test("ECX thresholds match the enforcer's Thresholds::ECX_MAINNET", () => {
  assert.deepEqual(ECX_THRESHOLDS, {
    unusedSlotActivation: 1_815,
    unusedSlotMaxAge: 2_016,
    usedSlotActivation: 6_048,
    usedSlotMaxAge: 12_096,
  });
});

test("activates once votes strictly exceed the threshold", () => {
  const r = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [11, 12, 13, 14]), 20, T);
  assert.equal(r.active.get(7)?.activationHeight, 14);
  assert.equal(r.active.get(7)?.votes, 4);
  assert.equal(r.pending.length, 0);
});

test("exactly the threshold is not enough", () => {
  const r = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [11, 12, 13]), 13, T);
  assert.equal(r.active.size, 0);
  assert.equal(r.pending[0].votes, 3);
});

test("an ack in the proposal's own block does not count", () => {
  const r = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [10, 11]), 11, T);
  assert.equal(r.pending[0].votes, 1);
});

test("acks for an unknown hash, or before the proposal, are ignored", () => {
  const r = replayProposals(
    [m1(10, 7, H("a"))],
    [...acks(7, H("b"), [11, 12]), ...acks(7, H("a"), [9])],
    12,
    T,
  );
  assert.equal(r.pending[0].votes, 0);
});

test("re-proposing a pending proposal does not reset its votes", () => {
  const r = replayProposals(
    [m1(10, 7, H("a")), m1(12, 7, H("a"))],
    acks(7, H("a"), [11, 12, 13]),
    13,
    T,
  );
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].proposalHeight, 10);
  assert.equal(r.pending[0].votes, 3);
});

test("a proposal that can no longer reach the threshold is dropped", () => {
  // max_fails = 6 − 3 = 3: three non-ack blocks after age 3 sink it.
  const live = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [11]), 12, T);
  assert.equal(live.pending.length, 1, "1 fail so far — still alive");
  const dead = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [11]), 14, T);
  assert.equal(dead.pending.length, 0, "age 4, 3 fails — dropped");
});

test("failure is checked in quiet stretches, not only at message blocks", () => {
  // The late ack at 30 must not revive a proposal that failed at 14.
  const r = replayProposals([m1(10, 7, H("a"))], acks(7, H("a"), [11, 30]), 30, T);
  assert.equal(r.pending.length, 0);
});

test("a proposal for an occupied slot uses the stricter threshold and replaces it", () => {
  const r = replayProposals(
    [m1(10, 7, H("a")), m1(20, 7, H("b"))],
    [...acks(7, H("a"), [11, 12, 13, 14]), ...acks(7, H("b"), [21, 22, 23, 24])],
    24,
    T,
  );
  // 4 votes activated "a" on the empty slot; 4 is not enough to replace it.
  assert.equal(r.active.get(7)?.hash, H("a"));
  assert.equal(r.pending[0].hash, H("b"));
  assert.equal(r.pending[0].threshold, 5);
  assert.equal(r.pending[0].replaces?.hash, H("a"));

  const replaced = replayProposals(
    [m1(10, 7, H("a")), m1(20, 7, H("b"))],
    [...acks(7, H("a"), [11, 12, 13, 14]), ...acks(7, H("b"), [21, 22, 23, 24, 25, 26])],
    26,
    T,
  );
  assert.equal(replaced.active.get(7)?.hash, H("b"));
  assert.equal(replaced.pending.length, 0);
});

test("decodeDeclaration reads a v0 declaration and rejects others", () => {
  const t = Buffer.from("Shuttle");
  const hex = Buffer.concat([
    Buffer.from([0, t.length]),
    t,
    Buffer.from("A DEX."),
    Buffer.alloc(52),
  ]).toString("hex");
  assert.deepEqual(decodeDeclaration(hex), { title: "Shuttle", description: "A DEX." });
  assert.equal(decodeDeclaration("01" + hex.slice(2)), null, "unknown version");
  assert.equal(decodeDeclaration("0007"), null, "truncated");
});

test("opReturnPush accepts exactly OP_RETURN <one push>", () => {
  assert.equal(opReturnPush("6a03aabbcc"), "aabbcc");
  assert.equal(opReturnPush("6a4c03aabbcc"), "aabbcc"); // OP_PUSHDATA1
  assert.equal(opReturnPush("6a4d0300aabbcc"), "aabbcc"); // OP_PUSHDATA2
  assert.equal(opReturnPush("6a03aabbcc51"), null, "trailing instruction");
  assert.equal(opReturnPush("6a04aabbcc"), null, "short push");
  assert.equal(opReturnPush("0014aa"), null, "not OP_RETURN");
});

test("parseSidechainMessages reads real ECX M1/M2 scripts", () => {
  // Slot 47 "Shuttle", from ECX blocks 982,691 (M1) and 982,692 (M2).
  const desc =
    "000753687574746c65546f6b656e732c2061737365747320616e64206120444558206f6e2061206661737420636861696e206f7665722065436173682e" +
    "4398e44579527773bae8cce0a4ca82189b8aa6f5f8796929131808b29313cbef19146877860848680e5c438100723912483568d7";
  const hash = "0631e356eedc13cf07c6e18c71a0a134a063d49cc8f894932dac19de51390db8";
  assert.equal(sha256dHex(desc), hash, "M2 carries sha256d(description) as-is");

  const m1Script = "6a4c76d5e0c4af2f" + desc;
  const m2Script = "6a25d6e1c5df2f" + hash;
  const out = (hex: string) => ({ scriptPubKey: { hex }, value: 0 });
  const { proposals, acks } = parseSidechainMessages({
    vout: [out(m1Script), out(m2Script), out(m2Script)], // duplicate M2 ignored
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].slot, 47);
  assert.equal(proposals[0].hash, hash);
  assert.deepEqual(decodeDeclaration(proposals[0].descriptionHex)?.title, "Shuttle");
  assert.deepEqual(acks, [{ slot: 47, hash }]);
});
