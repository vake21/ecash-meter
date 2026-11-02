// Fix #3 (stored path) — the store's SQL aggregation must rank and share by the
// selected metric. Reproduces the original bug end-to-end over an in-memory DB.

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { getStoredDashboardData } from "../lib/store";
import { utcDate } from "../lib/bmm";

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

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  closeDb();
  ensureSchema();
  setMeta("network", "ecx");
});
afterEach(() => closeDb());

test("fee mode ranks the quiet high-paying chain first (BitAssets over BitNames)", async () => {
  // BitNames (slot 2): 10 commitments, 10 sats total.
  for (let h = 1; h <= 10; h++) seedCommitment(h, 2, 1);
  // BitAssets (slot 4): 1 commitment, 1000 sats.
  seedCommitment(11, 4, 1000);

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
  for (let h = 1; h <= 5; h++) seedCommitment(h, 2, 0); // BitNames: 5 commitments
  seedCommitment(6, 4, 0); // BitAssets: 1 commitment
  const data = await getStoredDashboardData();
  assert.equal(data.metric, "bmm");
  assert.equal(data.stats[0].chain.slot, 2); // 5 > 1
});

test("a zero-activity calendar day appears in the series with zero values", async () => {
  // Activity on day D-2 and day D, but NONE on D-1 → D-1 must be present as zero.
  seedCommitment(1, 2, 5, TIME - 2 * DAY);
  seedCommitment(2, 2, 7, TIME); // latest block → reference date = D
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
  seedCommitment(1, 2, 1, TIME - 40 * DAY); // sparse activity 40 days ago
  seedCommitment(2, 2, 1, TIME); // latest block
  const data = await getStoredDashboardData();
  assert.equal(data.windowDays, 30);
  for (const s of data.stats) assert.equal(s.series.length, 30);
  const refDate = utcDate(TIME);
  assert.equal(data.stats[0].series[0].date, addDaysUTC(refDate, -29)); // not -40
});

test("rolling 24h includes records inside the boundary and excludes older ones", async () => {
  seedCommitment(1, 2, 999, TIME - 90_000); // ~25h old → excluded
  seedCommitment(2, 2, 50, TIME - 1_000); // within 24h → included
  seedCommitment(3, 2, 100, TIME); // latest → included
  const data = await getStoredDashboardData();
  const s2 = data.stats.find((s) => s.chain.slot === 2)!;
  assert.equal(s2.feesLast24hSats, 150); // 50 + 100, not 999
});

test("lastBlockTime is exposed so the UI can flag stale data", async () => {
  seedCommitment(1, 2, 1, TIME - 5 * DAY);
  seedCommitment(2, 2, 1, TIME);
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
  seedCommitment(1, UNREGISTERED_SLOT, 564);
  const data = await getStoredDashboardData();

  const row = data.stats.find((s) => s.chain.slot === UNREGISTERED_SLOT);
  assert.ok(row, "an unnamed slot must appear — dropping it understates total fees");
  assert.equal(row.totalFeesSats, 564);
  assert.equal(row.bmmCommitments, 1);
  // Synthesized metadata, not a crash and not a blank name.
  assert.equal(row.chain.name, `Slot ${UNREGISTERED_SLOT}`);
  assert.equal(row.chain.ticker, `S${UNREGISTERED_SLOT}`);
  assert.match(row.chain.color, /^#[0-9a-f]{6}$/i);
  // It is the only active chain, so it carries the whole headline.
  assert.equal(data.grandTotalFeesSats, 564);
  assert.equal(data.stats[0].chain.slot, UNREGISTERED_SLOT);
  assert.equal(data.stats[0].shareOfTotal, 1);
});

test("rows are only the observed slots, not the whole registry", async () => {
  seedCommitment(1, 9, 100); // Thunder, a registered slot
  seedCommitment(2, UNREGISTERED_SLOT, 50); // unregistered
  const data = await getStoredDashboardData();

  assert.deepEqual(
    data.stats.map((s) => s.chain.slot).sort((a, b) => a - b),
    [9, UNREGISTERED_SLOT],
  );
  // A registered slot keeps its published metadata and its validated colour.
  const thunder = data.stats.find((s) => s.chain.slot === 9)!;
  assert.equal(thunder.chain.name, "Thunder");
  assert.equal(thunder.chain.color, "#199e70");
  // The unregistered slot does not steal a registered chain's colour.
  const unknown = data.stats.find((s) => s.chain.slot === UNREGISTERED_SLOT)!;
  assert.notEqual(unknown.chain.color, thunder.chain.color);
});

test("a registered slot renders its published name, not a synthesized one", async () => {
  // Slot 46 went from unnamed to Flush on 2026-11-02; resolving a registered
  // slot must prefer the table over the synthesized fallback.
  seedCommitment(1, 46, 999);
  const data = await getStoredDashboardData();
  const row = data.stats.find((s) => s.chain.slot === 46)!;
  assert.equal(row.chain.name, "Flush");
  assert.equal(row.chain.ticker, "FLSH");
  assert.equal(row.chain.color, "#00a8b9");
});

test("a slot with only rolling-24h activity is not dropped", async () => {
  seedCommitment(1, 255, 7);
  const data = await getStoredDashboardData();
  const row = data.stats.find((s) => s.chain.slot === 255)!;
  assert.equal(row.feesLast24hSats, 7);
});
