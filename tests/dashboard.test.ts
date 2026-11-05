// The site's data-source contract (lib/dashboard.ts, lib/store-check.ts, the
// page and /api/health):
//   - real figures come ONLY from a validated SQLite store;
//   - a missing/empty/unreadable/incompatible store shows "Data temporarily
//     unavailable" with no figures — never mock numbers;
//   - saved data keeps being served when the node is offline, labelled as saved;
//   - demo data appears ONLY with ECASH_DEMO=1, and is labelled everywhere.

process.env.ECASH_METER_DB = ":memory:";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureSchema, run, setMeta, closeDb } from "../lib/db";
import { PARSER_VERSION } from "../lib/bmm";
import { ECX_FORK_BLOCK_HASH } from "../lib/config";
import { loadDashboard, isDemoMode } from "../lib/dashboard";
import { resetStoreProblemLog } from "../lib/store-check";
import Home from "../app/page";
import { GET as health } from "../app/api/health/route";

const NOW = () => Math.floor(Date.now() / 1000);

/** A valid ECX store: two blocks, one paid commitment, correctly stamped. */
function seedValid(ageSec = 60) {
  const t = NOW() - ageSec;
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", 983_000, "a", t - 400);
  run("INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)", 983_001, "b", t);
  run(
    "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
    983_001,
    46,
    "ab".repeat(32),
    564,
  );
  setMeta("network", "ecx");
  setMeta("parser_version", String(PARSER_VERSION));
  setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
}

const env = (extra: Record<string, string> = {}) =>
  ({ ...process.env, ECASH_DEMO: "", ...extra }) as NodeJS.ProcessEnv;

async function renderHome(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

// Silence + capture the operator log; stub fetch so any node call is caught.
const originalError = console.error;
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
let logged: string[] = [];
let fetchCalls = 0;
let tmp: string | null = null;

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  delete process.env.ECASH_DEMO;
  closeDb();
  ensureSchema();
  resetStoreProblemLog();
  logged = [];
  fetchCalls = 0;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.warn = () => {};
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("node offline");
  }) as typeof fetch;
});
afterEach(() => {
  closeDb();
  console.error = originalError;
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
  delete process.env.ECASH_DEMO;
  process.env.ECASH_METER_DB = ":memory:";
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

// ── Normal reads ─────────────────────────────────────────────────────────────

test("a valid store is served as saved ECX data", async () => {
  seedValid();
  const d = await loadDashboard(env());
  assert.equal(d.kind, "saved");
  if (d.kind !== "saved") return;
  assert.equal(d.data.network, "ecx");
  assert.equal(d.data.tipHeight, 983_001);
  assert.equal(d.data.grandTotalFeesSats, 564);
  assert.equal(d.summary.parserVersion, PARSER_VERSION);
});

test("the page labels saved data as saved mainnet data, with height and time", async () => {
  seedValid();
  const html = await renderHome();
  assert.match(html, /SAVED · ECX MAINNET DATA/);
  assert.match(html, /block #983,001/);
  assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.doesNotMatch(html, /LIVE/, "never implies a live node connection");
  assert.doesNotMatch(html, /DEMO/);
  assert.doesNotMatch(html, /Data temporarily unavailable/);
});

test("an unactivated slot that merge-mines isn't on the page, except tagged in the feed", async () => {
  seedValid();
  // A commitment to slot 77, which isn't activated.
  run(
    "INSERT INTO commitments (height, slot, hstar, fee_sats) VALUES (?, ?, ?, ?)",
    983_000,
    77,
    "cd".repeat(32),
    9_999,
  );
  const html = await renderHome();
  assert.doesNotMatch(html, /Merge-Mining Before Activation/);
  assert.equal(html.match(/>Slot 77</g)?.length ?? 0, 1, "only the feed row names it");
  assert.match(html, /not activated/, "the activity feed tags it");
  const d = await loadDashboard(env());
  assert.ok(d.kind === "saved");
  if (d.kind !== "saved") return;
  assert.equal(d.data.grandTotalFeesSats, 564, "its fee isn't counted");
  assert.ok(!d.data.stats.some((s) => s.chain.slot === 77));
});

test("Pending Withdrawals sits beside the feed: unknown, then none pending", async () => {
  seedValid();
  let html = await renderHome();
  assert.match(html, /Pending Withdrawals/);
  assert.match(html, /doesn&#x27;t record withdrawal bundles back to/);
  setMeta("bundles_from", "973728");
  html = await renderHome();
  assert.match(html, /No withdrawal bundles are collecting votes right now/);
});

// ── Node offline ─────────────────────────────────────────────────────────────

test("saved data is served with the node offline — the site never calls it", async () => {
  process.env.ECASH_RPC_URL = "http://127.0.0.1:9"; // nothing listens here
  seedValid();
  const d = await loadDashboard(env());
  assert.equal(d.kind, "saved");
  await renderHome();
  await health();
  assert.equal(fetchCalls, 0, "no network request from the page or health");
});

test("old saved data is still shown, saying only how recently it was updated", async () => {
  seedValid(3 * 86_400); // three days without a new block
  const html = await renderHome();
  assert.match(html, /SAVED · ECX MAINNET DATA/);
  assert.match(html, /updated 3d ago/);
  assert.doesNotMatch(html, /stale|out of date/i, "the page never calls data stale");
  assert.match(html, /<svg[^>]*role="img"/, "figures are still shown");

  const res = await health();
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 503, "monitoring (not the page) still flags a stalled indexer");
  assert.equal(body.status, "stale");
  assert.equal(body.dashboard, "saved", "…while the page keeps serving saved data");
});

// ── Unavailable: never mock figures ──────────────────────────────────────────

async function assertUnavailable(reason: string) {
  const d = await loadDashboard(env());
  assert.equal(d.kind, "unavailable");
  if (d.kind === "unavailable") assert.equal(d.reason, reason);

  const html = await renderHome();
  assert.match(html, /Data temporarily unavailable/);
  assert.doesNotMatch(html, /<svg[^>]*role="img"/, "no charts");
  assert.doesNotMatch(html, /<table/, "no rankings");
  assert.doesNotMatch(html, /Total fees|BMM commitments|Active drivechains/, "no totals");
  assert.doesNotMatch(html, /DEMO|SAMPLE/, "a failure never activates demo mode");

  const res = await health();
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 503);
  assert.equal(body.status, reason);
  assert.equal(body.dashboard, "unavailable");
  return body;
}

test("an empty store is unavailable", async () => {
  await assertUnavailable("empty");
});

test("a missing database file is unavailable, and is not created by the read", async () => {
  tmp = mkdtempSync(join(tmpdir(), "ecash-meter-"));
  const path = join(tmp, "nope.sqlite");
  closeDb();
  process.env.ECASH_METER_DB = path;
  await assertUnavailable("missing");
  assert.equal(existsSync(path), false);
});

test("an unreadable database is unavailable; the cause is logged, not published", async () => {
  tmp = mkdtempSync(join(tmpdir(), "ecash-meter-"));
  const path = join(tmp, "corrupt.sqlite");
  writeFileSync(path, "this is not a sqlite database".repeat(200));
  closeDb();
  process.env.ECASH_METER_DB = path;
  const body = await assertUnavailable("unreadable");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(tmp.replace(/[/\\]/g, ".")), "no path");
  assert.doesNotMatch(JSON.stringify(body), /not a database|SQLITE/i, "no raw error text");
  assert.ok(
    logged.some((l) => l.includes("unreadable") && l.includes(path)),
    "the operator log names the reason and the path",
  );
});

test("a store from another chain is unavailable", async () => {
  seedValid();
  setMeta("fork_block_hash", "ff".repeat(32));
  const body = await assertUnavailable("chain-mismatch");
  assert.deepEqual(body.stored, { forkBlockHash: "ff".repeat(32) });
  assert.deepEqual(body.expected, { forkBlockHash: ECX_FORK_BLOCK_HASH });
});

test("a store with no identity stamp is unavailable", async () => {
  seedValid();
  run("DELETE FROM meta WHERE key = 'fork_block_hash'");
  await assertUnavailable("chain-mismatch");
});

test("a store from another parser version is unavailable", async () => {
  seedValid();
  setMeta("parser_version", String(PARSER_VERSION - 1));
  const body = await assertUnavailable("parser-mismatch");
  assert.deepEqual(body.stored, { parserVersion: PARSER_VERSION - 1 });
  assert.deepEqual(body.expected, { parserVersion: PARSER_VERSION });
});

test("a store not stamped as ECX is unavailable", async () => {
  seedValid();
  setMeta("network", "not-ecx");
  await assertUnavailable("network-mismatch");
});

test("each problem is logged once, not on every request", async () => {
  await loadDashboard(env());
  await loadDashboard(env());
  await loadDashboard(env());
  assert.equal(logged.filter((l) => l.includes("(empty)")).length, 1);
});

// ── Demo mode: explicit only ─────────────────────────────────────────────────

test("demo mode needs ECASH_DEMO=1 exactly", () => {
  assert.equal(isDemoMode(env({ ECASH_DEMO: "1" })), true);
  for (const v of ["", "0", "true", "yes"]) {
    assert.equal(isDemoMode(env({ ECASH_DEMO: v })), false, `ECASH_DEMO=${v}`);
  }
});

test("legacy ECASH_SOURCE=mock / live no longer produce mock data", async () => {
  for (const source of ["mock", "live"]) {
    const d = await loadDashboard(env({ ECASH_SOURCE: source, ECASH_LIVE: "1" }));
    assert.equal(d.kind, "unavailable", `ECASH_SOURCE=${source} on an empty store`);
  }
});

test("explicit demo mode serves sample data, labelled on every view", async () => {
  process.env.ECASH_DEMO = "1";
  const d = await loadDashboard();
  assert.equal(d.kind, "demo");
  assert.equal(d.kind === "demo" && d.data.network, "demo");

  const html = await renderHome();
  // Badge, banner and footer all carry the label.
  assert.ok((html.match(/DEMO — SAMPLE DATA/g) ?? []).length >= 3);
  assert.doesNotMatch(html, /SAVED · ECX MAINNET/);

  const res = await health();
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 503, "sample data is never reported healthy");
  assert.equal(body.status, "demo");
});
