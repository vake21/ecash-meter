// The 7/30-day reporting window: parsing ?window=, the store honouring it, the
// demo data, and the page (selector state, and every figure following it).

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { PARSER_VERSION } from "../lib/bmm";
import { DEFAULT_WINDOW_DAYS, ECX_FORK_BLOCK_HASH, parseWindowDays } from "../lib/config";
import { getStoredDashboardData } from "../lib/store";
import { getDemoDashboardData } from "../lib/mock-data";
import Home from "../app/page";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

/** 20 days of history: one block per day, each with a 100-sat commitment. */
function seed20Days() {
  for (let d = 0; d < 20; d++) {
    const h = 983_000 + d;
    run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", h, `h${h}`, NOW - (19 - d) * DAY);
    run(
      "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
      h, 46, h.toString(16).padStart(64, "0"), 100,
    );
  }
  setMeta("network", "ecx");
  setMeta("parser_version", String(PARSER_VERSION));
  setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
}

const page = async (window?: string) =>
  renderToStaticMarkup(
    await Home({ searchParams: Promise.resolve(window === undefined ? {} : { window }) }),
  );

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  delete process.env.ECASH_DEMO;
  closeDb();
  ensureSchema();
});
afterEach(() => {
  closeDb();
  delete process.env.ECASH_DEMO;
});

test("parseWindowDays accepts 7 and 30, anything else is the default", () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 30);
  assert.equal(parseWindowDays("7"), 7);
  assert.equal(parseWindowDays("30"), 30);
  assert.equal(parseWindowDays(["7", "30"]), 7, "first of a repeated param");
  for (const v of [undefined, "", "14", "banana", "-7", "7days"]) {
    assert.equal(parseWindowDays(v), 30, String(v));
  }
});

test("the store covers exactly the chosen window", async () => {
  seed20Days();
  const week = await getStoredDashboardData(7);
  assert.equal(week.windowDays, 7);
  assert.equal(week.stats[0].series.length, 7);
  assert.equal(week.grandTotalFeesSats, 700, "totals cover only the window");

  const month = await getStoredDashboardData(30);
  assert.equal(month.windowDays, 20, "never longer than the history");
  assert.equal(month.grandTotalFeesSats, 2_000);
});

test("demo data: the 7-day view is the tail of the 30-day view", () => {
  const month = getDemoDashboardData(30);
  const week = getDemoDashboardData(7);
  assert.equal(week.windowDays, 7);
  const slot = month.stats[0].chain.slot;
  const m = month.stats.find((s) => s.chain.slot === slot)!.series.slice(-7);
  const w = week.stats.find((s) => s.chain.slot === slot)!.series;
  assert.deepEqual(w, m);
});

test("the page follows ?window= in the selector, cards, heading and charts", async () => {
  seed20Days();
  const week = await page("7");
  assert.match(week, /aria-current="true"[^>]*>7 days</);
  assert.match(week, /Total fees \(7d\)/);
  assert.match(week, /Last 7 days/);
  assert.doesNotMatch(week, /history so far/);

  const month = await page("30");
  assert.match(month, /aria-current="true"[^>]*>30 days</);
  assert.match(month, /Total fees \(20d\)/);
  assert.match(month, /Only 20 days of history so far/);
});

test("no or invalid ?window= falls back to 30 days", async () => {
  seed20Days();
  for (const w of [undefined, "banana"]) {
    assert.match(await page(w), /aria-current="true"[^>]*>30 days</, String(w));
  }
});

test("selector links keep the visitor on the page", async () => {
  seed20Days();
  const html = await page("7");
  assert.match(html, /href="\?window=7"/);
  assert.match(html, /href="\?window=30"/);
});
