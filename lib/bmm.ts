// Shared BMM (blind-merged-mining) parsing — the single source of truth used by
// BOTH the live node scan (lib/node.ts) and the persistent indexer (scripts/index.ts),
// so the two paths can never disagree on how a block is interpreted.
//
// ─── BMM ON-CHAIN FORMAT (verified against live eCash chain data, 2026-11-01) ───
// Each mainchain coinbase carries one OP_RETURN output PER merge-mined slot:
//   script hex = 6a 25 d1617368 <slot:1 byte> <hStar:32 bytes>
//   (6a=OP_RETURN, 25=push 37 bytes, d1617368=BMM tag, then slot + h*)
// The script is EXACTLY this — 6 + 1 + 32 = 39 bytes (78 hex chars). We parse it
// strictly: a candidate that merely starts with the tag but is truncated or
// malformed is ignored, never turned into a (slot=NaN, hstar="") commitment.
// Counting valid commitments per slot gives real, live per-drivechain BMM activity.
//
// FEES: a drivechain pays L1 via the fee on the BMM *request* tx that commits
// that h*. We attribute a fee by finding a non-coinbase tx whose OP_RETURN embeds
// a coinbase h*, then charging ONLY that transaction's own fee to that slot — the
// individual bid's fee, never the block's aggregate fee pool. Each BMM request tx
// in a block is priced and attributed independently; hstar is always a full
// 32-byte hash here, so we never match an empty/partial string.
//
// Verified against real chain data: a live block with 7 coinbase commitments
// (slots 2, 8, 9, 13, 98, 99, 255) matched exactly one paid bid tx per
// commitment, attributing their individual fees (6 × 564 sats and 1 × 378 sats)
// rather than the block's aggregate pool. Where a window contains commitments
// but no paid bid, fees read 0 and the headline metric falls back to commitment
// COUNT — see lib/aggregate.ts.
//
// Requires getblock verbosity 3 (Bitcoin Core ≥ v25; eCash's node is based on
// Core 32.1): it supplies each tx's `fee` directly, plus `vin[].prevout.value`
// for the sum(inputs) − sum(outputs) fallback. Verbosity 3 reads prevouts from
// block undo data, so it only works for blocks the node holds undo data for.

/** The 4-byte BMM tag plus the OP_RETURN/push prefix, as a hex string. */
export const BMM_PREFIX = "6a25d1617368"; // 6a=OP_RETURN 25=push37 d1617368=tag

/**
 * Strict coinbase BMM-commitment script: the exact tag, then a 1-byte slot and a
 * 32-byte h*, and NOTHING else. Anchored so truncated/oversized scripts fail.
 */
export const BMM_COMMITMENT_RE = /^6a25d1617368([0-9a-f]{2})([0-9a-f]{64})$/i;

/**
 * BIP 300 sidechain treasury output (the "CTIP"): every deposit and withdrawal
 * spends the slot's current treasury output and creates its successor, whose
 * value is everything the sidechain holds on L1.
 *   script hex = b7 01 <slot:1 byte> 51   (OP_NOP8=OP_DRIVECHAIN, push1 slot, OP_TRUE)
 * The slot is always a 1-byte push, never a small-int opcode (slot 9 is
 * `b7010951`, not `b75951`). Verified against the ECX enforcer's GetCtip for
 * all five activated slots on 2026-11-04; ECX's node labels these outputs
 * `"type": "drivechain"`.
 */
export const TREASURY_SCRIPT_RE = /^b701([0-9a-f]{2})51$/i;

/**
 * Fee-attribution parser version. Stored in the DB's `meta` table so the indexer
 * can detect a database written by a different version and refuse to append stale
 * data to it (the DB is a derived cache — rebuild instead). BUMP THIS whenever the
 * fee math or commitment interpretation below changes.
 *   1 = original (whole-block-fee-pool attribution — incorrect)
 *   2 = per-BMM-request-tx fee attribution
 *   3 = strict commitment parsing + hardened fee attribution
 *   4 = also records sidechain treasury outputs and their spends (current)
 */
export const PARSER_VERSION = 4;

/** getblock verbosity-3 shapes we rely on. */
export interface RawTx {
  txid?: string;
  vout: { scriptPubKey: { hex: string }; value: number; n?: number }[];
  /** Per-tx fee in BTC (present for non-coinbase txs at verbosity 3). */
  fee?: number;
  /**
   * Inputs. At verbosity 3 each non-coinbase input carries the outpoint it
   * spends (`txid`, `vout`) and its `prevout` (value in BTC, plus script).
   */
  vin?: {
    txid?: string;
    vout?: number;
    prevout?: { value: number; scriptPubKey?: { hex: string } };
  }[];
}
export interface RawBlock {
  height: number;
  hash: string;
  time: number;
  /** Hash of the parent block — used to validate chain connectivity on index. */
  previousblockhash?: string;
  tx: RawTx[];
}

/** One BMM commitment parsed out of a block's coinbase. */
export interface ParsedCommitment {
  /** BIP 300 sidechain slot (0-255). */
  slot: number;
  /** 32-byte sidechain block hash commitment, hex (lowercased, always 64 chars). */
  hstar: string;
  /** Fee (sats) attributed to this commitment's slot (0 when the bid paid none). */
  feeSats: number;
}
/** A drivechain treasury output created in this block. */
export interface TreasuryOutput {
  /** Position of the creating tx within the block (orders same-block events). */
  txIndex: number;
  txid: string;
  vout: number;
  slot: number;
  valueSats: number;
}
/** An input in this block that spends a drivechain treasury output. */
export interface TreasurySpend {
  txIndex: number;
  /** The outpoint being spent. */
  txid: string;
  vout: number;
}
export interface ParsedBlock {
  height: number;
  hash: string;
  /** Unix seconds of the block. */
  time: number;
  commitments: ParsedCommitment[];
  treasuryOutputs: TreasuryOutput[];
  treasurySpends: TreasurySpend[];
}

/** BTC (float) → whole sats, rounded. Non-finite input yields 0, never NaN. */
function toSats(btc: number): number {
  if (!Number.isFinite(btc)) return 0;
  return Math.round(btc * 1e8);
}

/**
 * Fee (sats) paid by a single transaction. Prefers the node-provided `fee`
 * (getblock verbosity 3); falls back to sum(inputs) − sum(outputs) from the
 * prevout values. Guaranteed to return a finite, non-negative integer — never
 * NaN, Infinity, a negative number, or a block-wide proxy. Missing/garbage data
 * yields 0, so it understates rather than overstates.
 */
export function txFeeSats(tx: RawTx): number {
  if (typeof tx?.fee === "number" && Number.isFinite(tx.fee) && tx.fee >= 0) {
    return toSats(tx.fee);
  }
  const vin = tx?.vin;
  if (
    Array.isArray(vin) &&
    vin.length > 0 &&
    vin.every((i) => i?.prevout && Number.isFinite(i.prevout.value))
  ) {
    const inSats = vin.reduce((s, i) => s + toSats(i.prevout!.value), 0);
    const outSats = (tx.vout ?? []).reduce(
      (s, o) => s + toSats(o?.value ?? 0),
      0,
    );
    const fee = inSats - outSats;
    return fee > 0 ? fee : 0;
  }
  return 0;
}

/**
 * Parse one block into its BMM commitments, with per-slot fee attribution.
 * Pure and deterministic: same block in → same result out. Tolerant of malformed
 * RPC shapes (missing coinbase, missing vout, truncated scripts): it produces
 * zero commitments rather than throwing, so one bad block can't wedge the indexer.
 */
export function parseBlock(b: RawBlock): ParsedBlock {
  const commitments: ParsedCommitment[] = [];
  const coinbase = Array.isArray(b?.tx) ? b.tx[0] : undefined;

  if (coinbase && Array.isArray(coinbase.vout)) {
    for (const v of coinbase.vout) {
      const hex = v?.scriptPubKey?.hex;
      if (typeof hex !== "string") continue;
      const m = BMM_COMMITMENT_RE.exec(hex);
      if (!m) continue;
      const slot = parseInt(m[1], 16); // 2 hex chars → always 0..255
      const hstar = m[2].toLowerCase(); // always exactly 64 hex chars
      commitments.push({ slot, hstar, feeSats: 0 });
    }
  }

  // Fee attribution: each non-coinbase tx whose OP_RETURN embeds a coinbase h* is a
  // paid BMM bid. Charge ONLY that tx's own fee to the slot(s) it commits — every
  // bid priced independently, never the block's aggregate fee pool. hstar is always
  // a full 32-byte hash, so an empty/partial string can never match. A single BMM
  // request normally commits exactly one slot; if one somehow commits several, its
  // fee is split evenly so the total attributed can never exceed the fee it paid.
  if (commitments.length > 0 && Array.isArray(b.tx)) {
    for (const tx of b.tx.slice(1)) {
      if (!tx || !Array.isArray(tx.vout)) continue;
      const matched = new Set<ParsedCommitment>();
      for (const v of tx.vout) {
        const hex = v?.scriptPubKey?.hex;
        if (typeof hex !== "string" || !hex.startsWith("6a")) continue;
        for (const c of commitments) {
          if (hex.includes(c.hstar)) matched.add(c);
        }
      }
      if (matched.size === 0) continue;
      const share = Math.floor(txFeeSats(tx) / matched.size);
      for (const c of matched) c.feeSats += share;
    }
  }

  const { treasuryOutputs, treasurySpends } = parseTreasury(b);
  return {
    height: b.height,
    hash: b.hash,
    time: b.time,
    commitments,
    treasuryOutputs,
    treasurySpends,
  };
}

/**
 * Every drivechain treasury output created, and every one spent, in a block.
 * Records raw events only — deciding which output is a slot's CURRENT treasury
 * needs the whole history, and lives in lib/treasury.ts. The coinbase is
 * skipped: deposits and withdrawals are ordinary transactions.
 */
export function parseTreasury(b: RawBlock): {
  treasuryOutputs: TreasuryOutput[];
  treasurySpends: TreasurySpend[];
} {
  const treasuryOutputs: TreasuryOutput[] = [];
  const treasurySpends: TreasurySpend[] = [];
  if (!Array.isArray(b?.tx)) return { treasuryOutputs, treasurySpends };

  b.tx.forEach((tx, txIndex) => {
    if (txIndex === 0 || !tx || typeof tx.txid !== "string") return;
    for (const i of tx.vin ?? []) {
      const hex = i?.prevout?.scriptPubKey?.hex;
      if (
        typeof hex === "string" &&
        TREASURY_SCRIPT_RE.test(hex) &&
        typeof i.txid === "string" &&
        Number.isInteger(i.vout)
      ) {
        treasurySpends.push({ txIndex, txid: i.txid, vout: i.vout! });
      }
    }
    (tx.vout ?? []).forEach((o, n) => {
      const m = TREASURY_SCRIPT_RE.exec(o?.scriptPubKey?.hex ?? "");
      if (!m) return;
      treasuryOutputs.push({
        txIndex,
        txid: tx.txid!,
        vout: Number.isInteger(o.n) ? o.n! : n,
        slot: parseInt(m[1], 16),
        valueSats: toSats(o.value),
      });
    });
  });
  return { treasuryOutputs, treasurySpends };
}

/** UTC ISO date (YYYY-MM-DD) for a unix-seconds timestamp. */
export function utcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
