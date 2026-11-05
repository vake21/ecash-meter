// The live activity feed: lib/activity.ts (what counts as an event), the
// /api/activity endpoint, and the feed component's server render.

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { PARSER_VERSION } from "../lib/bmm";
import { ECX_FORK_BLOCK_HASH } from "../lib/config";
import { getRecentActivity, type ActivityEvent } from "../lib/activity";
import { resetStoreProblemLog } from "../lib/store-check";
import { GET } from "../app/api/activity/route";
import ActivityFeed from "../components/ActivityFeed";

const TXA = "a".repeat(64);
const TXB = "b".repeat(64);
const TXC = "c".repeat(64);
const NOW = Math.floor(Date.now() / 1000);

/** Blocks 983,000–983,005 above the fork (config activations apply: slot 46 at 978,331). */
function seed() {
  for (let h = 983_000; h <= 983_005; h++) {
    run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", h, `hash${h}`, NOW - (983_005 - h) * 400);
  }
  const bmm = (h: number, slot: number, fee: number) =>
    run(
      "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
      h, slot, (h * 1000 + slot).toString(16).padStart(64, "0"), fee,
    );
  bmm(983_001, 9, 376);
  bmm(983_003, 46, 4_762);
  bmm(983_003, 9, 0);
  // Flush treasury: deposit 1.0 ECX, deposit 0.5, then withdraw 0.25.
  const out = (h: number, tx: string, v: number) =>
    run(
      "INSERT INTO treasury_outputs (height, tx_index, txid, vout, slot, value_sats) VALUES (?, 1, ?, 0, 46, ?)",
      h, tx, v,
    );
  const spend = (h: number, tx: string) =>
    run("INSERT INTO treasury_spends (height, tx_index, txid, vout) VALUES (?, 1, ?, 0)", h, tx);
  out(983_002, TXA, 100_000_000);
  out(983_004, TXB, 150_000_000);
  spend(983_004, TXA);
  out(983_005, TXC, 125_000_000);
  spend(983_005, TXB);
  setMeta("network", "ecx");
  setMeta("parser_version", String(PARSER_VERSION));
  setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
}

const brief = (e: ActivityEvent) => [e.kind, e.height, e.slot, e.amountSats, e.txid?.[0] ?? null];

const originalError = console.error;
beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  delete process.env.ECASH_DEMO;
  closeDb();
  ensureSchema();
  resetStoreProblemLog();
  console.error = () => {};
});
afterEach(() => {
  closeDb();
  delete process.env.ECASH_DEMO;
  console.error = originalError;
});

test("events: BMM blocks, deposits and withdrawals, newest first", () => {
  seed();
  const r = getRecentActivity(25);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.tipHeight, 983_005);
  assert.deepEqual(r.events.map(brief), [
    ["withdrawal", 983_005, 46, 25_000_000, "c"],
    ["deposit", 983_004, 46, 50_000_000, "b"],
    ["bmm", 983_003, 9, 0, null],
    ["bmm", 983_003, 46, 4_762, null],
    ["deposit", 983_002, 46, 100_000_000, "a"],
    ["bmm", 983_001, 9, 376, null],
  ]);
  const w = r.events[0];
  assert.equal(w.name, "Flush");
  assert.equal(w.blockHash, "hash983005");
  assert.equal(w.time, NOW);
});

test("a BMM commitment to an unactivated slot is tagged, not hidden", () => {
  seed();
  run(
    "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (983002, 77, ?, 0)",
    "e".repeat(64),
  );
  const r = getRecentActivity(25);
  assert.ok(r.ok);
  if (!r.ok) return;
  const early = r.events.find((e) => e.slot === 77)!;
  assert.equal(early.activated, false);
  assert.ok(r.events.filter((e) => e.slot !== 77).every((e) => e.activated));
  const html = renderToStaticMarkup(
    React.createElement(ActivityFeed, { initialEvents: r.events, limit: 25, explorerUrl: null }),
  );
  assert.equal(html.match(/not activated/g)?.length, 1);
});

test("the limit caps the merged list, keeping the newest", () => {
  seed();
  const r = getRecentActivity(2);
  assert.ok(r.ok && r.events.length === 2);
  if (r.ok) assert.deepEqual(r.events.map((e) => e.height), [983_005, 983_004]);
});

test("a look-alike treasury output is not a deposit", () => {
  seed();
  // An output with the drivechain script that doesn't spend the current treasury.
  run(
    "INSERT INTO treasury_outputs (height, tx_index, txid, vout, slot, value_sats) VALUES (983005, 7, ?, 0, 46, 999)",
    "f".repeat(64),
  );
  const r = getRecentActivity(25);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.events.filter((e) => e.kind === "deposit").length, 2);
});

test("an unavailable store yields no events, only a reason", () => {
  assert.deepEqual(getRecentActivity(), { ok: false, reason: "empty" });
});

test("GET /api/activity returns events, and clamps ?limit", async () => {
  seed();
  const res = await GET(new Request("http://x/api/activity?limit=3"));
  const body = (await res.json()) as { status: string; tipHeight: number; events: unknown[] };
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.equal(body.events.length, 3);

  const big = await GET(new Request("http://x/api/activity?limit=100000"));
  assert.equal(((await big.json()) as { events: unknown[] }).events.length, 6, "capped, all 6 shown");
});

test("GET /api/activity is 503 when the store is unavailable or in demo mode", async () => {
  let res = await GET(new Request("http://x/api/activity"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: "empty", events: [] });

  seed();
  process.env.ECASH_DEMO = "1";
  res = await GET(new Request("http://x/api/activity"));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { status: string }).status, "demo");
});

test("the feed's server render lists events, links only with an explorer, no clock", () => {
  seed();
  const r = getRecentActivity(25);
  assert.ok(r.ok);
  if (!r.ok) return;
  const render = (explorerUrl: string | null) =>
    renderToStaticMarkup(
      React.createElement(ActivityFeed, { initialEvents: r.events, limit: 25, explorerUrl }),
    );

  const plain = render(null);
  assert.match(plain, /Recent activity/);
  assert.match(plain, /Withdrawal/);
  assert.match(plain, /−0\.2500 ECX/);
  assert.match(plain, /\+1\.0000 ECX/);
  assert.match(plain, /bid 4,762 sats/);
  assert.match(plain, /no paid bid/);
  assert.doesNotMatch(plain, /<a /, "no explorer → no links");
  // Relative times need the browser's clock; the server render must not guess.
  assert.doesNotMatch(plain, /\bago\b|just now/);

  const linked = render("https://explorer.example.org");
  assert.match(linked, /href="https:\/\/explorer\.example\.org\/block\/hash983005"/);
  assert.match(linked, new RegExp(`href="https://explorer\\.example\\.org/tx/${TXC}"`));
});
