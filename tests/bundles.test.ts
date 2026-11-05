// Withdrawal-bundle replay (lib/bundles.ts), case by case against the
// enforcer's rules (bip300301_enforcer lib/validator/task/mod.rs, dbs/diff.rs).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ECX_BUNDLE_THRESHOLDS,
  replayBundles,
  type BundleAckRow,
  type BundleProposalRow,
  type WithdrawalRow,
} from "../lib/bundles";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
// Slots 9 and 46 active from block 101 on (activated at 100).
const ACTIVE = [
  { slot: 46, activationHeight: 100 },
  { slot: 9, activationHeight: 100 },
];

const m3 = (height: number, slot: number, m6id: string, vout = 1): BundleProposalRow => ({
  height, vout, slot, m6id,
});
/** OneByte M4: one byte per active slot, ascending (slot 9, then 46). */
const oneByte = (height: number, votes: number[], vout = 2): BundleAckRow => ({
  height, vout, version: 1, votesHex: Buffer.from(votes).toString("hex"),
});
const twoBytes = (height: number, votes: number[], vout = 2): BundleAckRow => {
  const b = Buffer.alloc(votes.length * 2);
  votes.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return { height, vout, version: 2, votesHex: b.toString("hex") };
};
const repeat = (height: number): BundleAckRow => ({ height, vout: 2, version: 0, votesHex: "" });
const leading = (height: number): BundleAckRow => ({ height, vout: 2, version: 3, votesHex: "" });
const ABSTAIN = 0xff;
const ALARM = 0xfe;

function replay(
  proposals: BundleProposalRow[],
  acks: BundleAckRow[] = [],
  withdrawals: WithdrawalRow[] = [],
  tip = 2_000,
) {
  return replayBundles(proposals, acks, withdrawals, ACTIVE, tip).map((b) => [
    b.slot, b.m6id.slice(0, 2), b.votes,
  ]);
}

test("ECX thresholds match the enforcer's Thresholds::ECX_MAINNET", () => {
  assert.equal(ECX_BUNDLE_THRESHOLDS.maxAge, 12_096);
  assert.equal(ECX_BUNDLE_THRESHOLDS.inclusionThreshold, 6_048);
});

test("a proposed bundle starts with one vote; re-proposing a pending one is ignored", () => {
  assert.deepEqual(replay([m3(200, 9, A), m3(300, 9, A)]), [[9, "aa", 1]]);
});

test("a bundle for an inactive slot is ignored, including in the activation block", () => {
  assert.deepEqual(replay([m3(200, 77, A), m3(100, 9, B), m3(101, 9, C)]), [[9, "cc", 1]]);
});

test("an upvote by index adds one and takes one from the slot's other positive bundles", () => {
  // Slot 9: A (1 vote), B (1 vote). Upvote index 1 (B) twice.
  const got = replay(
    [m3(200, 9, A), m3(201, 9, B)],
    [oneByte(202, [1, ABSTAIN]), oneByte(203, [1, ABSTAIN])],
  );
  // B: 1 → 2 → 3. A: 1 → 0 → stays 0 (never below zero).
  assert.deepEqual(got, [[9, "aa", 0], [9, "bb", 3]]);
});

test("abstain changes nothing; alarm takes one from every positive bundle", () => {
  const got = replay(
    [m3(200, 9, A), m3(200, 46, B, 2)],
    [oneByte(201, [ABSTAIN, ABSTAIN]), oneByte(202, [0, 0]), oneByte(203, [ALARM, ABSTAIN])],
  );
  const bySlot = Object.fromEntries(got.map((r) => [r[0], r[2]]));
  assert.equal(bySlot[9], 1); // 1 → 2 → alarm → 1
  assert.equal(bySlot[46], 2); // 1 → 2 → abstain
});

test("the vote vector covers active slots in ascending order; a wrong length is ignored", () => {
  const got = replay(
    [m3(200, 9, A), m3(200, 46, B, 2)],
    [oneByte(201, [0, ABSTAIN]), oneByte(202, [0])], // second: one vote for two slots
  );
  const bySlot = Object.fromEntries(got.map((r) => [r[0], r[2]]));
  assert.equal(bySlot[9], 2, "first byte is slot 9, the lower slot");
  assert.equal(bySlot[46], 1);
});

test("an out-of-range index invalidates the whole M4", () => {
  const got = replay([m3(200, 9, A), m3(200, 46, B, 2)], [oneByte(201, [0, 5])]);
  assert.deepEqual(got.map((r) => r[2]), [1, 1]);
});

test("an M4 can vote for a bundle proposed earlier in the same coinbase", () => {
  assert.deepEqual(replay([m3(200, 9, A, 1)], [oneByte(200, [0, ABSTAIN], 2)]), [[9, "aa", 2]]);
  // …but not one proposed after it.
  assert.deepEqual(replay([m3(200, 9, A, 3)], [oneByte(200, [0, ABSTAIN], 2)]), [[9, "aa", 1]]);
});

test("two-byte votes are only valid when a value needs two bytes", () => {
  // [index 0, abstain 0xFFFF]: 0xFFFF > 253, so the encoding is allowed.
  assert.deepEqual(replay([m3(200, 9, A)], [twoBytes(201, [0, 0xffff])]), [[9, "aa", 2]]);
  // Everything ≤ 253: invalid, ignored.
  assert.deepEqual(replay([m3(200, 9, A)], [twoBytes(201, [0, 0])]), [[9, "aa", 1]]);
});

test("leading by 50 upvotes a slot's leader only with a margin of at least 50", () => {
  const upvotes = (n: number) => Array.from({ length: n }, (_, i) => oneByte(201 + i, [0, ABSTAIN]));
  // A alone at 50 votes (1 + 49): leads an implicit 0 by 50 → upvoted to 51.
  assert.deepEqual(replay([m3(200, 9, A)], [...upvotes(49), leading(250)]), [[9, "aa", 51]]);
  // At 49 votes: a lead of 49 isn't enough.
  assert.deepEqual(replay([m3(200, 9, A)], [...upvotes(48), leading(249)]), [[9, "aa", 49]]);
  // Two bundles tied: no leader.
  assert.deepEqual(
    replay([m3(200, 9, A), m3(200, 9, B, 2)], [leading(201)]),
    [[9, "aa", 1], [9, "bb", 1]],
  );
});

test("repeat-previous redoes the previous block's actions, re-derived now", () => {
  // 201 upvotes B (downvoting A); 202 repeats; 204 repeats but 203 had no M4.
  const got = replay(
    [m3(200, 9, A), m3(200, 9, B, 2)],
    [oneByte(201, [1, ABSTAIN], 3), repeat(202), repeat(204)],
  );
  assert.deepEqual(got, [[9, "aa", 0], [9, "bb", 3]]);
});

test("repeat-previous casts no vote for a bundle that has since gone", () => {
  const got = replay(
    [m3(200, 9, A), m3(200, 9, B, 2)],
    [oneByte(201, [0, ABSTAIN], 3), repeat(202)],
    [{ height: 201, txIndex: 1, slot: 9, m6id: A }], // A paid out in 201
  );
  assert.deepEqual(got, [[9, "bb", 0]]); // B was downvoted in 201, nothing in 202
});

test("a withdrawal removes only its own bundle, and later indexes shift", () => {
  const got = replay(
    [m3(200, 9, A), m3(200, 9, B, 2), m3(200, 9, C, 3)],
    [oneByte(202, [1, ABSTAIN])], // after A is gone, index 1 is C
    [{ height: 201, txIndex: 1, slot: 9, m6id: A }],
  );
  assert.deepEqual(got, [[9, "bb", 0], [9, "cc", 2]]);
});

test("a bundle expires once its age exceeds 12,096 blocks, keeping the others' order", () => {
  const max = ECX_BUNDLE_THRESHOLDS.maxAge;
  const props = [m3(200, 9, A), m3(300, 9, B)];
  assert.deepEqual(replay(props, [], [], 200 + max).map((r) => r[1]), ["aa", "bb"]);
  assert.deepEqual(replay(props, [], [], 200 + max + 1).map((r) => r[1]), ["bb"]);
  // After A expires, index 0 means B.
  const got = replay(props, [oneByte(200 + max + 5, [0, ABSTAIN])], [], 200 + max + 10);
  assert.deepEqual(got, [[9, "bb", 2]]);
});
