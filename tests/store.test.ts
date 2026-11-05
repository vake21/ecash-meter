// Fix #3 (stored path) — the store's SQL aggregation must rank and share by the
// selected metric. Reproduces the original bug end-to-end over an in-memory DB.

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { getStoredDashboardData } from "../lib/store";
import { sha256dHex, utcDate } from "../lib/bmm";

const TIME = 1_752_000_000; // fixed recent timestamp → one date, within the window
const DAY = 86_400;

function hstar(n: number): string {
  return n.toString(16).padStart(64, "0");
}
function addDaysUTC(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000).toISOString().slice(0, 10);
}
/** Insert one block carrying one commitment for `slot` paying `fee` sats. */
function seedCommitment(height: number, slot: number, fee: number, time = TIME) {
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", height, `h${height}`, time);
  run(
    "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
    height,
    slot,
    hstar(height),
    fee,
  );
}

/** A v0 declaration: 0x00, title length, title, description, 52 hash bytes. */
function declaration(title: string, description: string): string {
  const t = Buffer.from(title, "utf8");
  return Buffer.concat([
    Buffer.from([0, t.length]),
    t,
    Buffer.from(description, "utf8"),
    Buffer.alloc(52),
  ]).toString("hex");
}

/** Ensure block rows exist for [from, to], all at TIME. */
function seedBlocks(from: number, to: number) {
  for (let h = from; h <= to; h++) {
    run(
      "INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      h,
      `h${h}`,
      TIME,
    );
  }
}

/**
 * Propose `slot` at `at` (M1) and ack it in each of the next `acks` blocks
 * (M2). 1,816 acks activates an empty slot on ECX.
 */
function propose(slot: number, title: string, at: number, acks: number, vout = 0) {
  const descriptionHex = declaration(title, `${title} description`);
  const hash = sha256dHex(descriptionHex);
  seedBlocks(at, at + acks);
  run(
    "INSERT INTO sidechain_proposals (height, vout, slot, description_hex, hash) VALUES (?, ?, ?, ?, ?)",
    at,
    vout,
    slot,
    descriptionHex,
    hash,
  );
  for (let h = at + 1; h <= at + acks; h++) {
    run("INSERT INTO sidechain_acks (height, slot, hash) VALUES (?, ?, ?)", h, slot, hash);
  }
}
const ACTIVATE = 1_816;
/**
 * Activate each slot through real votes (proposed at block 10, active from
 * ~1,827). Only commitments to an activated slot count toward the figures, so
 * tests put theirs at LIVE + n, after every activation.
 */
function activate(...slots: number[]) {
  slots.forEach((slot, i) => propose(slot, `S${slot}`, 10, ACTIVATE, i));
}
const LIVE = 5_000;

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  closeDb();
  ensureSchema();
  setMeta("network", "ecx");
});
afterEach(() => closeDb());

test("fee mode ranks the quiet high-paying chain first (BitAssets over BitNames)", async () => {
  activate(2, 4);
  // BitNames (slot 2): 10 commitments, 10 sats total.
  for (let h = 1; h <= 10; h++) seedCommitment(LIVE + h, 2, 1);
  // BitAssets (slot 4): 1 commitment, 1000 sats.
  seedCommitment(LIVE + 11, 4, 1000);

  const data = await getStoredDashboardData();
  assert.equal(data.metric, "fees");
  assert.equal(data.stats[0].chain.name, "BitAssets");
  assert.equal(data.stats[0].chain.slot, 4);
  // Share is by FEES: 1000 / 1010 ≈ 0.990.
  assert.ok(Math.abs(data.stats[0].shareOfTotal - 1000 / 1010) < 1e-6);
  const bitNames = data.stats.find((s) => s.chain.slot === 2)!;
  assert.ok(Math.abs(bitNames.shareOfTotal - 10 / 1010) < 1e-6);
});

test("no fees → bmm mode, ranked by commitment count", async () => {
  activate(2, 4);
  for (let h = 1; h <= 5; h++) seedCommitment(LIVE + h, 2, 0); // BitNames: 5 commitments
  seedCommitment(LIVE + 6, 4, 0); // BitAssets: 1 commitment
  const data = await getStoredDashboardData();
  assert.equal(data.metric, "bmm");
  assert.equal(data.stats[0].chain.slot, 2); // 5 > 1
});

test("a zero-activity calendar day appears in the series with zero values", async () => {
  activate(2);
  // Activity on day D-2 and day D, but NONE on D-1 → D-1 must be present as zero.
  seedCommitment(LIVE + 1, 2, 5, TIME - 2 * DAY);
  seedCommitment(LIVE + 2, 2, 7, TIME); // latest block → reference date = D
  const data = await getStoredDashboardData();
  assert.equal(data.windowDays, 3);
  const s2 = data.stats.find((s) => s.chain.slot === 2)!;
  assert.equal(s2.series.length, 3);
  assert.equal(s2.series[1].bmmCount, 0); // the skipped middle day D-1
  assert.equal(s2.series[1].feeSats, 0);
  assert.equal(s2.series[0].bmmCount, 1); // D-2 had a commitment
  assert.equal(s2.series[2].bmmCount, 1); // D had a commitment
});

test("window is exactly 30 dates and never reaches past 30 calendar days", async () => {
  activate(2);
  seedCommitment(LIVE + 1, 2, 1, TIME - 40 * DAY); // sparse activity 40 days ago
  seedCommitment(LIVE + 2, 2, 1, TIME); // latest block
  const data = await getStoredDashboardData();
  assert.equal(data.windowDays, 30);
  for (const s of data.stats) assert.equal(s.series.length, 30);
  const refDate = utcDate(TIME);
  assert.equal(data.stats[0].series[0].date, addDaysUTC(refDate, -29)); // not -40
});

test("rolling 24h includes records inside the boundary and excludes older ones", async () => {
  activate(2);
  seedCommitment(LIVE + 1, 2, 999, TIME - 90_000); // ~25h old → excluded
  seedCommitment(LIVE + 2, 2, 50, TIME - 1_000); // within 24h → included
  seedCommitment(LIVE + 3, 2, 100, TIME); // latest → included
  const data = await getStoredDashboardData();
  const s2 = data.stats.find((s) => s.chain.slot === 2)!;
  assert.equal(s2.feesLast24hSats, 150); // 50 + 100, not 999
});

test("lastBlockTime is exposed so the UI can flag stale data", async () => {
  activate(2);
  seedCommitment(LIVE + 1, 2, 1, TIME - 5 * DAY);
  seedCommitment(LIVE + 2, 2, 1, TIME);
  const data = await getStoredDashboardData();
  assert.equal(data.lastBlockTime, TIME); // the most recent block time
});

// ── Unregistered slots must never be hidden ──────────────────────────────────
// Both read paths used to build their rows by iterating the hardcoded registry
// (`DRIVECHAINS.map(...)`), so a slot the registry didn't list vanished from the
// dashboard even though the indexer had stored its commitments and fees.
//
// This was not hypothetical. When ECX mainnet was first indexed its ONLY
// merge-mined slot was 46, which no published slate named — so the old code
// would have hidden 98.9% of all fees on the chain. Slot 46 is now registered as
// Flush, so these tests use 77 instead: the invariant is about any slot the
// table does not name, not about slot 46 specifically.

const UNREGISTERED_SLOT = 77;

test("a slot missing from the registry still renders, with its fees", async () => {
  activate(UNREGISTERED_SLOT);
  seedCommitment(LIVE + 1, UNREGISTERED_SLOT, 564);
  const data = await getStoredDashboardData();

  const row = data.stats.find((s) => s.chain.slot === UNREGISTERED_SLOT);
  assert.ok(row, "an unnamed slot must appear — dropping it understates total fees");
  assert.equal(row.totalFeesSats, 564);
  assert.equal(row.bmmCommitments, 1);
  // Its on-chain name, and synthesized metadata for the rest — not a crash.
  assert.equal(row.chain.name, `S${UNREGISTERED_SLOT}`);
  assert.equal(row.chain.ticker, `S${UNREGISTERED_SLOT}`);
  assert.match(row.chain.color, /^#[0-9a-f]{6}$/i);
  // It is the only active chain, so it carries the whole headline.
  assert.equal(data.grandTotalFeesSats, 564);
  assert.equal(data.stats[0].chain.slot, UNREGISTERED_SLOT);
  assert.equal(data.stats[0].shareOfTotal, 1);
});

test("rows are the observed slots plus activated ones, not the whole registry", async () => {
  seedCommitment(LIVE + 1, 9, 100); // Thunder, a registered slot
  seedCommitment(LIVE + 2, UNREGISTERED_SLOT, 50); // unregistered
  // Activate ECX's five slots, and the unregistered one, through real M1/M2 votes.
  for (const [i, slot] of [9, 24, 46, 130, 131, UNREGISTERED_SLOT].entries()) {
    propose(slot, `S${slot}`, 10, ACTIVATE, i);
  }
  const data = await getStoredDashboardData();

  // Activated-but-idle slots (24, 46, 130, 131) are listed; lookup-only
  // entries that were never activated on ECX (2, 4, 13, 98, 99, 255) are not.
  assert.deepEqual(
    data.stats.map((s) => s.chain.slot).sort((a, b) => a - b),
    [9, 24, 46, UNREGISTERED_SLOT, 130, 131],
  );
  const idle = data.stats.find((s) => s.chain.slot === 130)!;
  assert.equal(idle.activated, true);
  assert.equal(idle.bmmCommitments, 0);
  assert.equal(idle.shareOfTotal, 0);
  assert.equal(data.activatedCount, 6);
  // A registered slot keeps its published metadata and its validated colour.
  const thunder = data.stats.find((s) => s.chain.slot === 9)!;
  assert.equal(thunder.chain.name, "Thunder");
  assert.equal(thunder.chain.color, "#199e70");
  // The unregistered slot does not steal a registered chain's colour.
  const unknown = data.stats.find((s) => s.chain.slot === UNREGISTERED_SLOT)!;
  assert.notEqual(unknown.chain.color, thunder.chain.color);
});

// ── Unactivated slots ────────────────────────────────────────────────────────
// A commitment is just bytes in the coinbase; the enforcer accepts one for any
// slot. Only commitments to a slot activated at that height count, and a slot
// that isn't activated is never listed, even while it's being merge-mined.

test("commitments to unactivated slots are left out of every figure and the table", async () => {
  activate(9);
  seedCommitment(LIVE + 1, 9, 100); // Thunder, activated: counts
  seedCommitment(LIVE + 2, UNREGISTERED_SLOT, 5_000); // never activated
  seedCommitment(LIVE + 3, UNREGISTERED_SLOT, 0);
  seedCommitment(LIVE + 4, 24, 0); // a registered slot, but not activated here
  const data = await getStoredDashboardData();

  assert.deepEqual(data.stats.map((s) => s.chain.slot), [9]);
  assert.equal(data.grandTotalFeesSats, 100);
  assert.equal(data.grandTotalBmmCommitments, 1);
  assert.equal(data.stats[0].shareOfTotal, 1);
  assert.equal(data.stats[0].feesLast24hSats, 100);
});

test("a sidechain's commitments from before its activation don't count", async () => {
  propose(9, "Thunder", 3_000, ACTIVATE); // active from ~4,817
  seedCommitment(2_000, 9, 70); // before the proposal
  seedCommitment(LIVE + 1, 9, 30); // after activation
  const data = await getStoredDashboardData();
  const thunder = data.stats.find((s) => s.chain.slot === 9)!;
  assert.equal(thunder.bmmCommitments, 1);
  assert.equal(thunder.totalFeesSats, 30);
});

test("a slot merge-mining while its proposal collects votes isn't listed as activated", async () => {
  propose(120, "Shuttle", LIVE - 500, 398); // pending, still inside its window
  seedCommitment(LIVE + 1, 120, 0);
  const data = await getStoredDashboardData();
  assert.equal(data.stats.length, 0);
  assert.equal(data.grandTotalBmmCommitments, 0);
  assert.deepEqual(data.pendingProposals?.map((p) => [p.slot, p.votes]), [[120, 398]]);
});

test("a registered slot renders its published name, not a synthesized one", async () => {
  activate(46);
  // Slot 46 went from unnamed to Flush on 2026-11-02; resolving a registered
  // slot must prefer the table over the synthesized fallback.
  seedCommitment(LIVE + 1, 46, 999);
  const data = await getStoredDashboardData();
  const row = data.stats.find((s) => s.chain.slot === 46)!;
  assert.equal(row.chain.name, "Flush");
  assert.equal(row.chain.ticker, "FLSH");
  assert.equal(row.chain.color, "#00a8b9");
});

test("a slot with only rolling-24h activity is not dropped", async () => {
  activate(255);
  seedCommitment(LIVE + 1, 255, 7);
  const data = await getStoredDashboardData();
  const row = data.stats.find((s) => s.chain.slot === 255)!;
  assert.equal(row.feesLast24hSats, 7);
});

// ── Treasury balances ────────────────────────────────────────────────────────

const TXA = "a".repeat(64);
const TXB = "b".repeat(64);

test("treasury balance comes from the replayed treasury chain", async () => {
  // Store reaches back past every activation height (978,324 … 978,708).
  seedCommitment(978_000, 9, 0);
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", 979_000, "h979000", TIME);
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", 979_001, "h979001", TIME);
  run(
    "INSERT INTO treasury_outputs (height, tx_index, txid, vout, slot, value_sats) VALUES (?, ?, ?, ?, ?, ?)",
    979_000, 1, TXA, 0, 46, 1_000_000,
  );
  run(
    "INSERT INTO treasury_outputs (height, tx_index, txid, vout, slot, value_sats) VALUES (?, ?, ?, ?, ?, ?)",
    979_001, 3, TXB, 1, 46, 3_000_000,
  );
  run(
    "INSERT INTO treasury_spends (height, tx_index, txid, vout) VALUES (?, ?, ?, ?)",
    979_001, 3, TXA, 0,
  );
  const data = await getStoredDashboardData();
  const bySlot = new Map(data.stats.map((s) => [s.chain.slot, s]));
  assert.equal(bySlot.get(46)!.treasurySats, 3_000_000);
  assert.equal(bySlot.get(130)!.treasurySats, 0, "activated, never funded");
  assert.equal(data.totalTreasurySats, 3_000_000);
  // Daily series carries the end-of-day balance for charting.
  const last = bySlot.get(46)!.series.at(-1)!;
  assert.equal(last.treasurySats, 3_000_000);
  // Both treasury changes land on the last day: +1,000,000 then +2,000,000.
  assert.equal(last.depositSats, 3_000_000);
  assert.equal(last.withdrawalSats, 0);
  assert.equal(bySlot.get(130)!.series.at(-1)!.treasurySats, 0);
});

test("treasury is unknown, not zero, when the store starts after activation", async () => {
  seedCommitment(983_000, 9, 0); // later than every activation height
  const data = await getStoredDashboardData();
  for (const s of data.stats.filter((r) => r.activated)) {
    assert.equal(s.treasurySats, null, `slot ${s.chain.slot}`);
    // Unknown balances are never charted as 0.
    assert.ok(
      s.series.every(
        (p) =>
          p.treasurySats === undefined &&
          p.depositSats === undefined &&
          p.withdrawalSats === undefined,
      ),
    );
  }
  assert.equal(data.totalTreasurySats, null);
  // A slot that isn't activated has no treasury figure at all.
  assert.equal(
    data.stats.find((s) => s.chain.slot === UNREGISTERED_SLOT)?.treasurySats,
    undefined,
  );
});

// ── Activation and pending proposals, replayed from M1/M2 ────────────────────

test("activations come from replayed votes, with on-chain names for unknown slots", async () => {
  propose(200, "Newchain", 10, ACTIVATE); // not in config.ts
  propose(201, "Almost", 10, ACTIVATE - 1, 1); // one vote short
  const data = await getStoredDashboardData();

  const row = data.stats.find((s) => s.chain.slot === 200)!;
  assert.equal(row.activated, true);
  assert.equal(row.chain.name, "Newchain", "named from its own declaration");
  assert.equal(row.chain.description, "Newchain description");
  assert.equal(data.activatedCount, 1);

  assert.equal(data.stats.some((s) => s.chain.slot === 201), false);
  assert.deepEqual(
    data.pendingProposals?.map((p) => [p.slot, p.name, p.votes, p.votesNeeded, p.replaces]),
    [[201, "Almost", ACTIVATE - 1, ACTIVATE, null]],
  );
});

test("a proposal for an occupied slot is listed with the sidechain it would replace", async () => {
  propose(9, "Thunder", 10, ACTIVATE); // Thunder takes slot 9
  propose(9, "Lightning", 3_000, 5); // then a rival proposal for slot 9
  const data = await getStoredDashboardData();
  const [p] = data.pendingProposals!;
  assert.equal(p.name, "Lightning");
  assert.equal(p.replaces, "Thunder");
  assert.equal(p.votesNeeded, 6_049, "replacing needs the stricter threshold");
});

test("without history back to the fork: config activations, proposals unknown", async () => {
  seedCommitment(983_000, 9, 0); // store starts long after the fork
  const data = await getStoredDashboardData();
  assert.equal(data.pendingProposals, null);
  assert.equal(data.activatedCount, 5); // from config.ts
});

test("block-rate estimate uses recent blocks, not the whole history", async () => {
  // 500 fast early blocks (10 s), then 500 slow recent ones (400 s) — the shape
  // of ECX after its fork, when difficulty was still settling.
  let t = TIME - 500 * 10 - 500 * 400;
  for (let h = 1; h <= 1000; h++) {
    t += h <= 500 ? 10 : 400;
    run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", h, `h${h}`, t);
  }
  const data = await getStoredDashboardData();
  assert.equal(data.avgBlockSeconds, 400);
});
