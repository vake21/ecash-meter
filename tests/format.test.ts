// Fee amounts are rendered in coin units, which silently rounds satoshi-scale
// totals to "0.00 ECX". `feeFormatter` picks the unit from the largest value in
// a set so small amounts survive display. Regression case: a store holding just
// 378 sats in total made every chart gridline read "0 ECX" beside full-height
// bars. Real bids are this small — the first paid bids observed on a live
// drivechain were 378 and 564 sats — so this is the normal case, not an edge.
//
// Assertions compare against L1_SYMBOL rather than a hardcoded ticker, so
// renaming the coin can't quietly turn these into no-ops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { L1_SYMBOL, SATS_PER_COIN } from "../lib/config";

const SYM = new RegExp(`${L1_SYMBOL}$`);
import {
  feeFormatter,
  formatCoins,
  formatCoinsCompact,
  formatSats,
} from "../lib/format";

// 0.01 coins — below this, two-decimal coin display loses the amount.
const THRESHOLD = SATS_PER_COIN / 100;

test("satoshi-scale totals format as sats, not 0.00 coins", () => {
  const f = feeFormatter(378);
  assert.equal(f(378), "378 sats");
  assert.equal(f(189), "189 sats");
  // The bug this guards: coin display erases the amount entirely.
  assert.equal(formatCoinsCompact(378), `0 ${L1_SYMBOL}`);
});

test("totals at or above the threshold format as coins", () => {
  const f = feeFormatter(SATS_PER_COIN);
  assert.match(f(SATS_PER_COIN), SYM);
  assert.doesNotMatch(f(SATS_PER_COIN), /sats$/);
});

test("threshold boundary: at the cutoff uses coins, just below uses sats", () => {
  assert.match(feeFormatter(THRESHOLD)(THRESHOLD), SYM);
  assert.match(feeFormatter(THRESHOLD - 1)(THRESHOLD - 1), /sats$/);
});

test("the unit is chosen from the reference max, not the value formatted", () => {
  // A zero row inside a sats-scale set still reads in sats, so a column never
  // mixes units.
  assert.equal(feeFormatter(378)(0), "0 sats");
  // ...and a small row inside a coin-scale set stays in coins.
  assert.match(feeFormatter(SATS_PER_COIN)(1), SYM);
});

test("an all-zero set formats as sats rather than 0.00 coins", () => {
  assert.equal(feeFormatter(0)(0), "0 sats");
});

test("caller can supply the coin formatter used above the threshold", () => {
  const f = feeFormatter(SATS_PER_COIN, (s) => formatCoins(s, 2));
  assert.equal(f(SATS_PER_COIN), `1.00 ${L1_SYMBOL}`);
});

test("fractional sats round to whole numbers", () => {
  // Chart gridlines are fractions of the max (maxDaily * 0.25), so the sats
  // formatter receives non-integers.
  assert.equal(formatSats(94.5), "95 sats");
  assert.equal(feeFormatter(378)(378 * 0.25), "95 sats");
});

test("sats output carries thousands separators", () => {
  assert.equal(formatSats(1_234_567), "1,234,567 sats");
});
