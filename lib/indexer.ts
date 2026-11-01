// Canonical-chain reconciliation + indexing core. Extracted from scripts/index.ts
// so it can be unit-tested against a mocked JSON-RPC boundary and an in-memory
// SQLite DB, with no live node.
//
// The DB is a derived cache and the indexer is its only writer. Blockchain history
// is NOT append-only: a reorganization can replace recent blocks. So before
// appending we (1) prove the node and the DB are both on ECX (fork-block hash —
// NOT genesis, which ECX inherits from Bitcoin), and
// (2) walk back to the most recent stored block that is still canonical, delete
// everything above it (cascading to its commitments), and re-index from there.
// All DB mutation for a run happens in ONE transaction, after blocks are fetched
// and validated, so a failure mid-run never leaves a torn cache.

import {
  parseBlock,
  PARSER_VERSION,
  type RawBlock,
} from "./bmm";
import { ECX_FORK_BLOCK_HASH, ECX_FORK_HEIGHT } from "./config";
import { ensureSchema, get, run, tx, getMeta, setMeta } from "./db";

type Rpc = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
type MapPool = <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
) => Promise<R[]>;

export interface IndexerDeps {
  rpc: Rpc;
  mapPool: MapPool;
  log?: (msg: string) => void;
  /** First-run backfill depth (blocks). Defaults from env, else 432. */
  backfill?: number;
  concurrency?: number;
  /** Blocks fetched + committed per transaction. Defaults from env, else 250. */
  chunkSize?: number;
  /** How many times to restart reconciliation if the chain moves mid-download. */
  maxReorgRetries?: number;
}

export type RefusalReason =
  | "network-mismatch"
  | "unverifiable-history"
  | "parser-version"
  | "deep-reorg";

/** The network this indexer will index, and nothing else. */
const NETWORK = "ecx";

export interface IndexerResult {
  status: "ok" | "up-to-date" | "refused";
  reason?: RefusalReason;
  /** Operator-facing explanation, present when status is "refused". */
  message?: string;
  network?: string;
  fromHeight?: number;
  toHeight?: number;
  blocksInserted?: number;
  commitmentsInserted?: number;
  /** Blocks removed because they were no longer canonical (reorg depth). */
  reorgDepth?: number;
}

/** Thrown internally when the chain changes under us mid-download; triggers retry. */
class ReorgDetected extends Error {}

function localHashAt(height: number): string | null {
  const row = get<{ hash: string }>(
    "SELECT hash FROM blocks WHERE height = ?",
    height,
  );
  return row?.hash ?? null;
}

/**
 * Walk backward from min(localTip, nodeTip) to the most recent height whose stored
 * hash matches the node's canonical hash. Returns null if none within the stored
 * range agree (a reorg deeper than we can verify).
 */
async function findCommonAncestor(
  rpc: Rpc,
  localTip: number,
  nodeTip: number,
  minLocal: number,
): Promise<number | null> {
  let candidate = Math.min(localTip, nodeTip);
  while (candidate >= minLocal) {
    const stored = localHashAt(candidate);
    if (stored == null) {
      candidate--;
      continue;
    }
    const canonical = await rpc<string>("getblockhash", [candidate]);
    if (stored === canonical) return candidate;
    candidate--;
  }
  return null;
}

/**
 * Fetch blocks [from..to] at verbosity 3 and validate they form a canonical,
 * internally-consistent chain that connects to `ancestorHash` (null for a fresh
 * backfill's first block). Throws ReorgDetected if anything fails — the caller
 * discards the batch and re-reconciles.
 *
 * `to` is a CHUNK boundary, not necessarily the node tip: a deep backfill is
 * processed in bounded slices so the whole range is never resident at once.
 */
async function fetchAndValidate(
  rpc: Rpc,
  mapPool: MapPool,
  from: number,
  to: number,
  ancestorHash: string | null,
  concurrency: number,
): Promise<RawBlock[]> {
  if (from > to) return [];
  const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const hashes = await mapPool(heights, concurrency, (h) =>
    rpc<string>("getblockhash", [h]),
  );
  const blocks = await mapPool(hashes, concurrency, (hash) =>
    rpc<RawBlock>("getblock", [hash, 3]),
  );

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.height !== heights[i] || b?.hash !== hashes[i]) {
      throw new ReorgDetected(`block ${heights[i]} did not match requested hash`);
    }
    const expectedPrev = i === 0 ? ancestorHash : blocks[i - 1].hash;
    if (expectedPrev != null && b.previousblockhash !== expectedPrev) {
      throw new ReorgDetected(`block ${b.height} does not connect to its parent`);
    }
  }

  // Re-check this chunk's top block is still canonical after the (possibly
  // slow) download, so a chain that moved under us is caught before we commit.
  if (blocks.length > 0) {
    const topHashNow = await rpc<string>("getblockhash", [to]);
    if (topHashNow !== hashes[hashes.length - 1]) {
      throw new ReorgDetected("chain changed during download");
    }
  }
  return blocks;
}

export async function runIndexer(deps: IndexerDeps): Promise<IndexerResult> {
  const { rpc, mapPool } = deps;
  const log = deps.log ?? (() => {});
  const backfill =
    deps.backfill ??
    Number(
      process.env.ECASH_BACKFILL_BLOCKS ?? process.env.ECASH_SCAN_BLOCKS ?? 432,
    );
  const concurrency = deps.concurrency ?? 24;
  const chunkSize = Math.max(
    1,
    deps.chunkSize ?? Number(process.env.ECASH_INDEX_CHUNK ?? 250),
  );
  const maxRetries = deps.maxReorgRetries ?? 3;

  ensureSchema();

  const network = NETWORK;

  // ── Chain identity: verify the node is actually on ECX. ──
  //
  // The genesis hash CANNOT do this. ECX forks from Bitcoin's ledger, so it
  // inherits Bitcoin's genesis block byte for byte, and `getblockchaininfo`
  // reports chain "main" just as Bitcoin does. A Bitcoin node, or any other
  // fork of the same ledger, is indistinguishable by either signal.
  //
  // The first post-fork block is the discriminator: the fork resets difficulty,
  // so block ECX_FORK_HEIGHT is unique to ECX. We ask the node for its hash at
  // that height and compare. A node still syncing past the fork has no block
  // there yet, which is a "come back later", not a wrong chain.
  const nodeTipForIdentity = await rpc<number>("getblockcount");
  if (nodeTipForIdentity < ECX_FORK_HEIGHT) {
    return {
      status: "refused",
      reason: "network-mismatch",
      message:
        `[index] node is at height ${nodeTipForIdentity}, below the ECX fork at ` +
        `${ECX_FORK_HEIGHT}.\n` +
        `        Cannot confirm it is on eCash mainnet yet — wait for it to sync past the fork.`,
    };
  }
  const forkHash = await rpc<string>("getblockhash", [ECX_FORK_HEIGHT]);
  if (forkHash !== ECX_FORK_BLOCK_HASH) {
    return {
      status: "refused",
      reason: "network-mismatch",
      message:
        `[index] refusing to index: this node is NOT on eCash (ECX) mainnet.\n` +
        `        Block ${ECX_FORK_HEIGHT} is ${forkHash.slice(0, 16)}…, but ECX's fork block is ` +
        `${ECX_FORK_BLOCK_HASH.slice(0, 16)}….\n` +
        `        Note ECX shares Bitcoin's genesis hash and also reports chain "main", so this\n` +
        `        fork-block check is the only reliable identity test. Point ECASH_RPC_URL at an\n` +
        `        ECX node.`,
    };
  }

  /** Stored-range summary. Re-read per attempt: committing a chunk changes it. */
  const readSummary = () => {
    const r = get<{ max: number | null; min: number | null; cnt: number }>(
      "SELECT MAX(height) AS max, MIN(height) AS min, COUNT(*) AS cnt FROM blocks",
    )!;
    return { hasData: r.cnt > 0, localTip: r.max, minLocal: r.min };
  };
  const { hasData: hadDataAtStart } = readSummary();

  // ── Identity guard: was this DB built from the same chain? ──
  const storedFork = getMeta("fork_block_hash");
  if (hadDataAtStart && storedFork != null && storedFork !== ECX_FORK_BLOCK_HASH) {
    return {
      status: "refused",
      reason: "network-mismatch",
      message:
        `[index] refusing to index: this database was built from a different chain ` +
        `(stored fork block ${storedFork.slice(0, 16)}…, expected ${ECX_FORK_BLOCK_HASH.slice(0, 16)}…).\n` +
        `        Databases from different networks must never be mixed. Point ECASH_METER_DB at a\n` +
        `        separate file, or rebuild: delete the DB file and re-index.`,
    };
  }
  // ── Parser-version guard: stored fees computed by a different parser? ──
  const storedParser = getMeta("parser_version");
  if (hadDataAtStart && storedParser !== String(PARSER_VERSION)) {
    return {
      status: "refused",
      reason: "parser-version",
      message:
        `[index] parser version mismatch — this DB was built with parser ` +
        `${storedParser ?? "(unversioned)"}, but the code is parser ${PARSER_VERSION}.\n` +
        `        The derived cache must be rebuilt: delete the DB file and re-index.`,
    };
  }
  // A non-empty DB with no recorded fork hash can't be verified — either it
  // predates identity stamping, or it was stamped with the old genesis-only
  // identity, which could not distinguish ECX from Bitcoin. Refuse rather than
  // trust unverifiable history.
  if (hadDataAtStart && storedFork == null) {
    return {
      status: "refused",
      reason: "unverifiable-history",
      message:
        `[index] this database has no recorded ECX fork-block hash, so its history cannot\n` +
        `        be verified against the node. Rebuild the derived cache: delete the DB file\n` +
        `        and re-index.`,
    };
  }

  // ── Reconcile + fetch, retrying if the chain moves under us mid-download. ──
  for (let attempt = 1; ; attempt++) {
    const { hasData, localTip, minLocal } = readSummary();
    const nodeTip = await rpc<number>("getblockcount");

    let commonAncestor: number;
    let ancestorHash: string | null;
    if (!hasData) {
      // Fresh backfill: no stored history to reconcile against.
      commonAncestor = Math.max(0, nodeTip - backfill + 1) - 1;
      ancestorHash = null;
    } else {
      const found = await findCommonAncestor(rpc, localTip!, nodeTip, minLocal!);
      if (found === null) {
        return {
          status: "refused",
          reason: "deep-reorg",
          message:
            `[index] reorg deeper than stored history: no common ancestor within stored ` +
            `heights ${minLocal}..${localTip}.\n` +
            `        Cannot safely reconcile a partial cache this far back. Rebuild it: ` +
            `delete the DB file and re-index.`,
        };
      }
      commonAncestor = found;
      ancestorHash = localHashAt(commonAncestor);
    }

    const from = commonAncestor + 1;
    const reorgDepth = hasData ? Math.max(0, localTip! - commonAncestor) : 0;

    // Nothing new to add AND nothing stale to prune → genuinely up to date.
    if (from > nodeTip && reorgDepth === 0) {
      return { status: "up-to-date", network, toHeight: nodeTip };
    }

    // Persist in bounded CHUNKS, each its own transaction. Real ECX mainnet
    // blocks carry thousands of transactions, and verbosity 3 embeds every
    // input's prevout, so a deep backfill cannot be held in memory as one batch
    // — a 10,000-block first run would exhaust a small VPS.
    //
    // Chunks are committed in ascending order, so the store is always a valid
    // contiguous prefix of the chain: an interrupted run leaves less history,
    // never torn history, and the next run resumes from the stored tip. The
    // reorg prune rides in the FIRST chunk's transaction, so stale blocks are
    // never visible alongside their replacements.
    let blocksInserted = 0;
    let commitmentsInserted = 0;
    let prevHash = ancestorHash;
    let cursor = from;
    let pruned = false;
    // Only worth narrating when the run spans more than one chunk.
    const multiChunk = nodeTip - from + 1 > chunkSize;

    try {
      while (cursor <= nodeTip) {
        const to = Math.min(cursor + chunkSize - 1, nodeTip);
        const blocks = await fetchAndValidate(
          rpc,
          mapPool,
          cursor,
          to,
          prevHash,
          concurrency,
        );

        tx(() => {
          if (!pruned && hasData && reorgDepth > 0) {
            run("DELETE FROM blocks WHERE height > ?", commonAncestor); // cascades
            pruned = true;
          }
          for (const raw of blocks) {
            const parsed = parseBlock(raw);
            const ins = run(
              `INSERT INTO blocks (height, hash, time) VALUES (?, ?, ?)
               ON CONFLICT (height) DO NOTHING`,
              parsed.height,
              parsed.hash,
              parsed.time,
            );
            blocksInserted += Number(ins.changes);
            for (const c of parsed.commitments) {
              const cins = run(
                `INSERT INTO commitments (height, slot, hstar, fee_sats)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (height, slot, hstar) DO NOTHING`,
                parsed.height,
                c.slot,
                c.hstar,
                c.feeSats,
              );
              commitmentsInserted += Number(cins.changes);
            }
          }
          setMeta("network", network);
          setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
          setMeta("parser_version", String(PARSER_VERSION));
          setMeta("last_indexed_height", String(to));
        });

        if (multiChunk) log(`[index] indexed to ${to} of ${nodeTip}…`);
        prevHash = blocks[blocks.length - 1]!.hash;
        cursor = to + 1;
      }
    } catch (err) {
      if (err instanceof ReorgDetected && attempt <= maxRetries) {
        log(
          `[index] chain moved during download (attempt ${attempt}) — re-reconciling…`,
        );
        continue;
      }
      throw err;
    }

    // A prune with nothing to re-index (the node's tip went backwards) still has
    // to delete the stale blocks and record the new height.
    if (!pruned && hasData && reorgDepth > 0) {
      tx(() => {
        run("DELETE FROM blocks WHERE height > ?", commonAncestor); // cascades
        setMeta("network", network);
        setMeta("fork_block_hash", ECX_FORK_BLOCK_HASH);
        setMeta("parser_version", String(PARSER_VERSION));
        setMeta("last_indexed_height", String(nodeTip));
      });
    }

    return {
      status: "ok",
      network,
      fromHeight: from,
      toHeight: nodeTip,
      blocksInserted,
      commitmentsInserted,
      reorgDepth,
    };
  }
}
