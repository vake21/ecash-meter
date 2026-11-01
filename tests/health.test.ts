// /api/health is what an uptime monitor watches, so every condition that leaves
// the store frozen or wrong must come back 503 — a 200 with bad data underneath
// is worse than a hard failure, because nothing alerts.

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { PARSER_VERSION } from "../lib/bmm";
import { ECX_FORK_BLOCK_HASH } from "../lib/config";
import { GET } from "../app/api/health/route";

/** A healthy store: one recent block, correctly stamped. */
function seedHealthy(ageSec = 0) {
  const now = Math.floor(Date.now() / 1000) - ageSec;
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", 982108, "h", now);
  run(
    "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
    982108,
    46,
    "ab".repeat(32),
    564,
  );
  setMeta("network", "ecx");
  setMeta("parser_version", String(PARSER_VERSION));
  setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
}

async function body() {
  const res = await GET();
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  closeDb();
  ensureSchema();
});
afterEach(() => closeDb());

test("a fresh, correctly stamped ECX store is 200 ok", async () => {
  seedHealthy();
  const r = await body();
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
  assert.equal(r.json.network, "ecx");
});

test("an empty store is 503", async () => {
  const r = await body();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, "empty");
});

test("a store stamped from another chain is 503 chain-mismatch", async () => {
  seedHealthy();
  setMeta("fork_block_hash", "ff".repeat(32));
  const r = await body();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, "chain-mismatch");
});

test("a store with no identity stamp is 503, not quietly ok", async () => {
  seedHealthy();
  run("DELETE FROM meta WHERE key = 'fork_block_hash'");
  const r = await body();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, "chain-mismatch");
});

test("a parser-version mismatch is 503", async () => {
  seedHealthy();
  setMeta("parser_version", String(PARSER_VERSION + 1));
  const r = await body();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, "parser-mismatch");
});

test("stale data is 503 even though nothing crashed", async () => {
  seedHealthy(60 * 60 * 24); // a day old
  const r = await body();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, "stale");
});
