// Canonical-chain reconciliation: reorgs, chain identity, mid-download races.
// Uses a scripted fake node (mocked JSON-RPC) and an in-memory SQLite DB.
//
// The fake chain lives at REAL ECX heights, above the fork at ECX_FORK_HEIGHT,
// and answers getblockhash(ECX_FORK_HEIGHT) with the real fork-block hash — the
// same thing an ECX node does. That makes the identity guard a live part of
// every test here rather than something only the mismatch cases touch.

process.env.ECASH_METER_DB = ":memory:"; // must be set before db.ts opens a connection

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runIndexer } from "../lib/indexer";
import { mapPool } from "../lib/rpc";
import { closeDb, all, get, getMeta, setMeta, ensureSchema } from "../lib/db";
import { BMM_PREFIX, type RawTx } from "../lib/bmm";
import { ECX_FORK_BLOCK_HASH, ECX_FORK_HEIGHT } from "../lib/config";

const F = ECX_FORK_HEIGHT;

interface FakeBlock {
  height: number;
  hash: string;
  previousblockhash?: string;
  time: number;
  tx: RawTx[];
}

/**
 * A chain at ECX heights, generated on demand rather than materialized — the
 * fork is at height 973,728, so an array from genesis is not an option.
 *
 * Divergence is modelled as segments: `tagAt(h)` returns the tag of the last
 * segment starting at or below h, and a block's hash is `tag:height`. A reorg
 * pushes a new segment, which re-tags every height above its start.
 */
class FakeChain {
  private segments: { from: number; tag: string }[];
  private tipHeight: number;
  /** Hash reported at ECX_FORK_HEIGHT; override to impersonate another chain. */
  forkHash = ECX_FORK_BLOCK_HASH;
  /** Extra coinbase outputs at a height (e.g. M3/M4 messages). */
  extraCoinbase = new Map<number, RawTx["vout"]>();
  /** Make verbosity-1 getblock fail, as a pruned node does for old blocks. */
  pruned = false;
  /** Extra getblockchaininfo fields, to model a node that is still syncing. */
  chainInfo: Record<string, unknown> = {};

  constructor(len: number, tag = "base", startAbove = F) {
    this.segments = [{ from: 0, tag }];
    this.tipHeight = startAbove + len;
  }
  get tip() {
    return this.tipHeight;
  }
  private tagAt(h: number): string {
    let tag = this.segments[0].tag;
    for (const s of this.segments) if (s.from <= h) tag = s.tag;
    return tag;
  }
  hashAt(h: number): string {
    if (h > this.tipHeight) throw new Error(`no block at height ${h}`);
    if (h === F) return this.forkHash;
    return `${this.tagAt(h)}:${h}`;
  }
  private blockAt(h: number): FakeBlock {
    // One valid slot-2 BMM commitment per block → 1 commitment/block.
    const coinbase: RawTx = {
      vout: [
        { scriptPubKey: { hex: BMM_PREFIX + "02" + "aa".repeat(32) }, value: 0 },
        ...(this.extraCoinbase.get(h) ?? []),
      ],
    };
    return {
      height: h,
      hash: this.hashAt(h),
      previousblockhash: h === 0 ? undefined : this.hashAt(h - 1),
      time: 1_700_000_000 + h * 600,
      tx: [coinbase],
    };
  }
  byHash(hash: string): FakeBlock {
    if (hash === this.forkHash) return this.blockAt(F);
    const h = Number(hash.slice(hash.lastIndexOf(":") + 1));
    if (!Number.isInteger(h) || this.hashAt(h) !== hash) {
      throw new Error(`no block with hash ${hash}`);
    }
    return this.blockAt(h);
  }
  /** Grow the tip by `n` blocks, same segment tags. */
  extend(n: number) {
    this.tipHeight += n;
  }
  /** Diverge from `from` upward with a new tag, and set the new tip. */
  reorg(from: number, newTip: number, tag: string) {
    this.segments.push({ from, tag });
    this.tipHeight = newTip;
  }
  truncate(newTip: number) {
    this.tipHeight = newTip;
  }
  rpc = async <T = unknown>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    switch (method) {
      case "getblockchaininfo":
        return { chain: "main", ...this.chainInfo } as T; // ECX reports "main", exactly like Bitcoin
      case "getblockcount":
        return this.tipHeight as T;
      case "getblockhash":
        return this.hashAt(params[0] as number) as T;
      case "getblock": {
        const b = this.byHash(params[0] as string);
        if (params[1] === 1) {
          if (this.pruned) throw new Error("Block not available (pruned data)");
          return { tx: [`cb:${b.height}`] } as T;
        }
        return b as T;
      }
      case "getrawtransaction": {
        const id = params[0] as string;
        if (!id.startsWith("cb:")) throw new Error(`no tx ${id}`);
        return this.byHash(params[2] as string).tx[0] as T;
      }
      default:
        throw new Error(`unexpected rpc ${method}`);
    }
  };
}

const BACKFILL = 3;
const run = (rpc: FakeChain["rpc"], backfill = BACKFILL) =>
  runIndexer({ rpc, mapPool, backfill, concurrency: 4 });

function dbHeights(): number[] {
  return all<{ height: number }>(
    "SELECT height FROM blocks ORDER BY height",
  ).map((r) => r.height);
}

beforeEach(() => {
  process.env.ECASH_METER_DB = ":memory:";
  closeDb(); // fresh in-memory DB per test
});
afterEach(() => closeDb());

test("no reorg: only new blocks are fetched and inserted", async () => {
  const chain = new FakeChain(5); // tip = F+5
  await run(chain.rpc);
  assert.deepEqual(dbHeights(), [F + 3, F + 4, F + 5]);

  chain.extend(2); // tip = F+7
  const res = await run(chain.rpc);
  assert.equal(res.status, "ok");
  assert.equal(res.blocksInserted, 2); // only F+6, F+7
  assert.equal(res.reorgDepth, 0);
  assert.deepEqual(dbHeights(), [F + 3, F + 4, F + 5, F + 6, F + 7]);
});

test("already caught up → 'up-to-date', nothing fetched", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc);
  const res = await run(chain.rpc);
  assert.equal(res.status, "up-to-date");
});

test("one-block reorg: stale tip and its commitments are replaced", async () => {
  const chain = new FakeChain(5); // tip F+5, stores F+3..F+5
  await run(chain.rpc);
  chain.reorg(F + 5, F + 6, "fork"); // F+5 replaced, F+6 added
  const res = await run(chain.rpc);
  assert.equal(res.status, "ok");
  assert.equal(res.reorgDepth, 1);
  assert.deepEqual(dbHeights(), [F + 3, F + 4, F + 5, F + 6]);
  assert.equal(
    get<{ hash: string }>("SELECT hash FROM blocks WHERE height=?", F + 5)!
      .hash,
    `fork:${F + 5}`,
  );
  // Orphaned block's commitment is gone; each canonical block has exactly one.
  assert.equal(
    get<{ n: number }>("SELECT COUNT(*) n FROM commitments")!.n,
    4,
  );
});

test("multi-block reorg: walks back to the common ancestor", async () => {
  const chain = new FakeChain(5); // tip F+5
  await run(chain.rpc, 5); // stores F+1..F+5
  assert.deepEqual(dbHeights(), [F + 1, F + 2, F + 3, F + 4, F + 5]);
  chain.reorg(F + 3, F + 6, "fork"); // F+3,4,5 replaced + F+6; ancestor = F+2
  const res = await run(chain.rpc, 5);
  assert.equal(res.status, "ok");
  assert.equal(res.reorgDepth, 3);
  assert.deepEqual(dbHeights(), [F + 1, F + 2, F + 3, F + 4, F + 5, F + 6]);
  for (const h of [F + 3, F + 4, F + 5, F + 6]) {
    assert.equal(
      get<{ hash: string }>("SELECT hash FROM blocks WHERE height=?", h)!.hash,
      `fork:${h}`,
    );
  }
});

test("node tip lower than stored tip: prune, don't claim up-to-date", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc, 5); // stores F+1..F+5
  chain.truncate(F + 3); // node tip now F+3, no divergence below
  const res = await run(chain.rpc, 5);
  assert.equal(res.status, "ok");
  assert.equal(res.reorgDepth, 2); // F+4, F+5 removed
  assert.equal(res.blocksInserted, 0);
  assert.deepEqual(dbHeights(), [F + 1, F + 2, F + 3]);
});

test("node still syncing behind the store: refuse and delete nothing", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc, 5);
  chain.truncate(F + 3);
  chain.chainInfo = { initialblockdownload: true, blocks: F + 3, headers: F + 3 };
  const res = await run(chain.rpc, 5);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "node-syncing");
  assert.equal(dbHeights().length, 5);
});

test("node with headers ahead of its blocks behind the store: refuse and delete nothing", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc, 5);
  chain.truncate(F + 3);
  chain.chainInfo = { initialblockdownload: false, blocks: F + 3, headers: F + 90 };
  const res = await run(chain.rpc, 5);
  assert.equal(res.reason, "node-syncing");
  assert.equal(dbHeights().length, 5);
});

test("a syncing node that is ahead of the store still indexes", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc, 5);
  chain.extend(2);
  chain.chainInfo = { initialblockdownload: true, blocks: F + 7, headers: F + 90 };
  const res = await run(chain.rpc, 5);
  assert.equal(res.status, "ok");
  assert.equal(dbHeights().length, 7);
});

test("node is not on ECX: refuse on the fork-block hash", async () => {
  // Genesis and `chain` are useless here — a Bitcoin node matches ECX on both.
  // The fork block is what differs.
  const chain = new FakeChain(5);
  chain.forkHash = "00".repeat(32);
  const res = await run(chain.rpc);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "network-mismatch");
  assert.match(res.message!, /NOT on eCash/);
  assert.deepEqual(dbHeights(), []); // nothing written
});

test("node still syncing below the fork: refuse, don't guess", async () => {
  const chain = new FakeChain(5, "base", 0); // tip = 5, far below the fork
  const res = await run(chain.rpc);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "network-mismatch");
  assert.match(res.message!, /below the ECX fork/);
});

test("store stamped from a different chain: refuse and leave it untouched", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc);
  const before = dbHeights();
  const lastBefore = getMeta("last_indexed_height");

  // Re-stamp the store as if it had been built against another chain.
  setMeta("fork_block_hash", "ff".repeat(32));
  const res = await run(chain.rpc);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "network-mismatch");
  assert.deepEqual(dbHeights(), before); // unchanged
  assert.equal(getMeta("last_indexed_height"), lastBefore);
});

test("store with no identity stamp is refused as unverifiable", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc);
  // A store predating identity stamping — or stamped only with the old
  // genesis-based identity, which could not tell ECX from Bitcoin.
  ensureSchema();
  all("DELETE FROM meta WHERE key = 'fork_block_hash'");
  const res = await run(chain.rpc);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "unverifiable-history");
});

test("a fresh index stamps the ECX fork hash", async () => {
  const chain = new FakeChain(5);
  const res = await run(chain.rpc);
  assert.equal(res.status, "ok");
  assert.equal(getMeta("fork_block_hash"), ECX_FORK_BLOCK_HASH);
  assert.equal(getMeta("network"), "ecx");
});

test("deep reorg beyond stored history: refuse rather than trust it", async () => {
  const chain = new FakeChain(10); // tip F+10
  await run(chain.rpc); // stores F+8..F+10
  assert.deepEqual(dbHeights(), [F + 8, F + 9, F + 10]);
  chain.reorg(F + 6, F + 11, "fork"); // diverges below stored min (F+8)
  const res = await run(chain.rpc);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "deep-reorg");
  assert.deepEqual(dbHeights(), [F + 8, F + 9, F + 10]); // untouched
});

test("reorg during download: inconsistent batch is not committed, retry succeeds", async () => {
  const chain = new FakeChain(5); // tip F+5
  let corruptOnce = true;
  const flakyRpc = (async <T = unknown>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    if (method === "getblock") {
      const b = chain.byHash(params[0] as string);
      if (corruptOnce && b.height === F + 4) {
        corruptOnce = false; // corrupt the batch only on the first attempt
        return { ...b, previousblockhash: "WRONG" } as T;
      }
      return b as T;
    }
    return chain.rpc<T>(method, params);
  }) as FakeChain["rpc"];

  const res = await run(flakyRpc);
  assert.equal(res.status, "ok");
  assert.deepEqual(dbHeights(), [F + 3, F + 4, F + 5]);
  // The corrupt version was never persisted; the retry stored the real block.
  assert.equal(
    get<{ hash: string }>("SELECT hash FROM blocks WHERE height=?", F + 4)!
      .hash,
    `base:${F + 4}`,
  );
});

// ── Chunked backfill ────────────────────────────────────────────────────────
// Real ECX blocks are large at verbosity 3, so a deep backfill is committed in
// bounded slices instead of one batch. The store must stay a valid contiguous
// prefix at every point, so an interrupted run loses history but never tears it.

test("a deep backfill is fetched in chunks, not one batch", async () => {
  const chain = new FakeChain(20); // tip F+20
  const fetched: number[] = [];
  const countingRpc = (async <T = unknown>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    if (method === "getblock") {
      fetched.push(chain.byHash(params[0] as string).height);
    }
    return chain.rpc<T>(method, params);
  }) as FakeChain["rpc"];

  const res = await runIndexer({
    rpc: countingRpc,
    mapPool,
    backfill: 20,
    concurrency: 4,
    chunkSize: 6,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.blocksInserted, 20);
  assert.equal(dbHeights().length, 20);
  // Every block fetched exactly once despite the chunking.
  assert.equal(fetched.length, 20);
  assert.equal(new Set(fetched).size, 20);
});

test("an interrupted backfill leaves a contiguous prefix, and resumes", async () => {
  const chain = new FakeChain(20); // tip F+20
  let allow = 9; // die partway through the third chunk
  const flakyRpc = (async <T = unknown>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    if (method === "getblock") {
      if (allow-- <= 0) throw new Error("node went away");
      return chain.byHash(params[0] as string) as T;
    }
    return chain.rpc<T>(method, params);
  }) as FakeChain["rpc"];

  await assert.rejects(
    runIndexer({
      rpc: flakyRpc,
      mapPool,
      backfill: 20,
      concurrency: 1,
      chunkSize: 4,
    }),
    /node went away/,
  );

  // What survived is a contiguous run starting at the backfill floor — not a
  // torn set with holes in it.
  const got = dbHeights();
  assert.ok(got.length > 0, "committed chunks must survive the failure");
  assert.deepEqual(
    got,
    Array.from({ length: got.length }, (_, i) => got[0] + i),
    "stored heights must be contiguous",
  );
  // The recorded height matches the real stored tip, so a resume starts right.
  assert.equal(Number(getMeta("last_indexed_height")), got[got.length - 1]);

  // A healthy re-run finishes the job.
  const res = await runIndexer({
    rpc: chain.rpc,
    mapPool,
    backfill: 20,
    concurrency: 4,
    chunkSize: 4,
  });
  assert.equal(res.status, "ok");
  assert.equal(dbHeights().length, 20);
  assert.equal(dbHeights()[19], F + 20);
});

test("a reorg prune happens in the first chunk's transaction", async () => {
  const chain = new FakeChain(20);
  await runIndexer({ rpc: chain.rpc, mapPool, backfill: 20, concurrency: 4, chunkSize: 5 });
  assert.equal(dbHeights().length, 20);

  chain.reorg(F + 10, F + 25, "fork");
  const res = await runIndexer({
    rpc: chain.rpc,
    mapPool,
    backfill: 20,
    concurrency: 4,
    chunkSize: 5,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.reorgDepth, 11); // F+10..F+20 replaced
  // No stale block survived alongside its replacement.
  const stale = get<{ n: number }>(
    "SELECT COUNT(*) n FROM blocks WHERE hash LIKE 'base:%' AND height >= ?",
    F + 10,
  )!.n;
  assert.equal(stale, 0);
  assert.equal(dbHeights()[dbHeights().length - 1], F + 25);
});

// ── The backfill never reaches below the fork ────────────────────────────────
// Blocks below ECX_FORK_HEIGHT are Bitcoin blocks where BIP 300/301 is not
// active, so a coinbase OP_RETURN matching the BMM pattern there is a false
// positive, not a drivechain commitment. An over-sized backfill must clamp
// rather than invent sidechain activity in Bitcoin's history.

test("an over-sized backfill clamps to the fork height", async () => {
  const chain = new FakeChain(5); // tip = F+5
  // 1000 blocks would reach ~F-994 — the FakeChain would happily serve them.
  const res = await run(chain.rpc, 1000);
  assert.equal(res.status, "ok");
  assert.equal(res.fromHeight, F, "must start exactly at the fork block");
  const got = dbHeights();
  assert.equal(got[0], F, "nothing below the fork may be stored");
  assert.equal(got[got.length - 1], F + 5);
  assert.equal(got.length, 6); // F..F+5 inclusive
});

test("a backfill inside the post-fork range is untouched by the clamp", async () => {
  const chain = new FakeChain(20); // tip = F+20
  const res = await run(chain.rpc, 5);
  assert.equal(res.status, "ok");
  assert.equal(res.fromHeight, F + 16); // tip-5+1, well above the fork
  assert.equal(dbHeights()[0], F + 16);
});

// ── Withdrawal bundles ───────────────────────────────────────────────────────

const M3 = (slot: number, m6id: string) => ({
  scriptPubKey: { hex: "6a25d45aa943" + slot.toString(16).padStart(2, "0") + m6id },
  value: 0,
});
/** Plain objects (node:sqlite rows have a null prototype). */
const rows = (sql: string) => all(sql).map((r) => ({ ...r }));
const M4_LEADING = { scriptPubKey: { hex: "6a05d77d177603" }, value: 0 };

test("a fresh index from the fork records bundle messages and marks them complete", async () => {
  const chain = new FakeChain(5);
  chain.extraCoinbase.set(F + 2, [M3(9, "ab".repeat(32)), M4_LEADING]);
  await run(chain.rpc, 1000);
  assert.equal(getMeta("bundles_from"), String(F));
  assert.deepEqual(rows("SELECT height, vout, slot, m6id FROM bundle_proposals"), [
    { height: F + 2, vout: 1, slot: 9, m6id: "ab".repeat(32) },
  ]);
  assert.deepEqual(rows("SELECT height, version, votes_hex FROM bundle_acks"), [
    { height: F + 2, version: 3, votes_hex: "" },
  ]);
});

test("a shallow index doesn't claim bundle history it doesn't have", async () => {
  const chain = new FakeChain(20);
  await run(chain.rpc, 5);
  assert.equal(getMeta("bundles_from"), null);
});

test("a store indexed before bundles were recorded is caught up from the fork", async () => {
  const chain = new FakeChain(5);
  chain.extraCoinbase.set(F + 3, [M4_LEADING]);
  await run(chain.rpc, 1000);
  // Simulate an older store: no bundle rows, no marker.
  ensureSchema();
  get("DELETE FROM bundle_acks");
  get("DELETE FROM meta WHERE key = 'bundles_from'");
  assert.equal(getMeta("bundles_from"), null);

  chain.extend(1);
  const res = await run(chain.rpc, 1000);
  assert.equal(res.status, "ok");
  assert.equal(getMeta("bundles_from"), String(F));
  assert.deepEqual(rows("SELECT height, version FROM bundle_acks"), [{ height: F + 3, version: 3 }]);
});

test("a pruned node can't catch bundles up: marker stays unset, indexing goes on", async () => {
  const chain = new FakeChain(5);
  await run(chain.rpc, 1000);
  get("DELETE FROM meta WHERE key = 'bundles_from'");
  chain.pruned = true;
  chain.extend(2);
  const logs: string[] = [];
  const res = await runIndexer({
    rpc: chain.rpc, mapPool, backfill: 1000, concurrency: 4, log: (m) => logs.push(m),
  });
  assert.equal(res.status, "ok");
  assert.equal(res.blocksInserted, 2);
  assert.equal(getMeta("bundles_from"), null);
  assert.ok(logs.some((l) => /pruned/.test(l)));
});
