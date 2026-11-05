// Shared BMM (blind-merged-mining) parsing — the single source of truth for how
// the indexer (lib/indexer.ts) interprets a block.
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

import { createHash } from "node:crypto";

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
 *   4 = also records sidechain treasury outputs and their spends
 *   5 = also records BIP 300 sidechain proposals (M1) and acks (M2) (current)
 *
 * ⚠ A bump forces a FULL rebuild from the ECX fork. The production node is
 * pruned and loses fork-era blocks after a few months, so the rebuild may have
 * to happen on a machine with an unpruned node, then be uploaded — see
 * "Rebuilding after a parser change" in deploy/README.md.
 */
export const PARSER_VERSION = 5;

/** BIP 300 M1 (propose sidechain) and M2 (ack proposal) message tags. */
const M1_TAG = "d5e0c4af";
const M2_TAG = "d6e1c5df";
/** BIP 300 M3 (propose withdrawal bundle) and M4 (ack bundles) tags. */
const M3_TAG = "d45aa943";
const M4_TAG = "d77d1776";

/**
 * The single data push of an `OP_RETURN <push>` script, as hex — or null if the
 * script is anything else (BIP 300 messages are exactly that shape; trailing
 * instructions make it an ordinary script). Accepts every push encoding.
 */
export function opReturnPush(hex: string): string | null {
  if (!/^6a([0-9a-f]{2})*$/i.test(hex) || hex.length < 4) return null;
  const op = parseInt(hex.slice(2, 4), 16);
  let len: number;
  let start: number;
  if (op >= 0x01 && op <= 0x4b) {
    len = op;
    start = 4;
  } else if (op === 0x4c && hex.length >= 6) {
    len = parseInt(hex.slice(4, 6), 16);
    start = 6;
  } else if (op === 0x4d && hex.length >= 8) {
    len = parseInt(hex.slice(6, 8) + hex.slice(4, 6), 16); // little-endian
    start = 8;
  } else {
    return null;
  }
  const data = hex.slice(start);
  return data.length === len * 2 ? data.toLowerCase() : null;
}

/** sha256d of hex bytes, hex, in the byte order an M2 carries it. */
export function sha256dHex(hex: string): string {
  const once = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  return createHash("sha256").update(once).digest("hex");
}

/** A sidechain proposal (M1) in a coinbase. */
export interface ParsedProposal {
  vout: number;
  slot: number;
  descriptionHex: string;
  hash: string;
}
/** A proposal ack (M2) in a coinbase. */
export interface ParsedAck {
  slot: number;
  hash: string;
}
/** A withdrawal-bundle proposal (M3) in a coinbase. */
export interface ParsedBundleProposal {
  vout: number;
  slot: number;
  /** The bundle's M6id, hex, in the byte order M3 carries it. */
  m6id: string;
}
/** A withdrawal-bundle ack (M4) in a coinbase: raw, interpreted by lib/bundles.ts. */
export interface ParsedBundleAck {
  vout: number;
  /** 0 repeat previous · 1 one byte per slot · 2 two bytes per slot · 3 leading by 50. */
  version: number;
  /** Bytes after the version, hex ("" for versions 0 and 3). */
  votesHex: string;
}
/** A withdrawal (M6) paid out of a treasury, identified by its M6id. */
export interface ParsedWithdrawal {
  txIndex: number;
  txid: string;
  slot: number;
  m6id: string;
}

/** getblock verbosity-3 shapes we rely on. */
export interface RawTx {
  txid?: string;
  /** Present at every getblock verbosity ≥ 2; needed to compute an M6id. */
  version?: number;
  locktime?: number;
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
  proposals: ParsedProposal[];
  acks: ParsedAck[];
  bundleProposals: ParsedBundleProposal[];
  bundleAcks: ParsedBundleAck[];
  withdrawals: ParsedWithdrawal[];
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
  const { proposals, acks, bundleProposals, bundleAcks } = parseSidechainMessages(coinbase);
  const withdrawals = parseWithdrawals(b);
  return {
    height: b.height,
    hash: b.hash,
    time: b.time,
    commitments,
    treasuryOutputs,
    treasurySpends,
    proposals,
    acks,
    bundleProposals,
    bundleAcks,
    withdrawals,
  };
}

/**
 * BIP 300 M1 proposals and M2 acks in a coinbase. Raw messages only — whether
 * they count (duplicates, same-block acks, thresholds) is decided by the replay
 * in lib/proposals.ts. At most one M2 per slot per block, as the enforcer
 * keeps; a later duplicate is ignored.
 */
export function parseSidechainMessages(coinbase: RawTx | undefined): {
  proposals: ParsedProposal[];
  acks: ParsedAck[];
  bundleProposals: ParsedBundleProposal[];
  bundleAcks: ParsedBundleAck[];
} {
  const proposals: ParsedProposal[] = [];
  const acks: ParsedAck[] = [];
  const bundleProposals: ParsedBundleProposal[] = [];
  const bundleAcks: ParsedBundleAck[] = [];
  const ackedSlots = new Set<number>();
  (coinbase?.vout ?? []).forEach((o, vout) => {
    const data = opReturnPush(o?.scriptPubKey?.hex ?? "");
    if (data == null) return;
    if (data.startsWith(M1_TAG) && data.length >= 10) {
      const descriptionHex = data.slice(10);
      proposals.push({
        vout,
        slot: parseInt(data.slice(8, 10), 16),
        descriptionHex,
        hash: sha256dHex(descriptionHex),
      });
    } else if (data.startsWith(M2_TAG) && data.length === 2 * (4 + 1 + 32)) {
      const slot = parseInt(data.slice(8, 10), 16);
      if (ackedSlots.has(slot)) return;
      ackedSlots.add(slot);
      acks.push({ slot, hash: data.slice(10) });
    } else if (data.startsWith(M3_TAG) && data.length === 2 * (4 + 1 + 32)) {
      bundleProposals.push({
        vout,
        slot: parseInt(data.slice(8, 10), 16),
        m6id: data.slice(10),
      });
    } else if (data.startsWith(M4_TAG) && data.length >= 10 && bundleAcks.length === 0) {
      // At most one M4 per block (the enforcer rejects a second); keep the first.
      bundleAcks.push({
        vout,
        version: parseInt(data.slice(8, 10), 16),
        votesHex: data.slice(10),
      });
    }
  });
  return { proposals, acks, bundleProposals, bundleAcks };
}

/** Bitcoin CompactSize, hex. */
function varIntHex(n: number): string {
  if (n < 0xfd) return n.toString(16).padStart(2, "0");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  if (n <= 0xffff) return "fd" + b.subarray(0, 2).toString("hex");
  if (n <= 0xffffffff) return "fe" + b.subarray(0, 4).toString("hex");
  return "ff" + b.toString("hex");
}
function u32le(n: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b.toString("hex");
}
function u64le(n: number | bigint): string {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b.toString("hex");
}

/**
 * The M6id of a withdrawal transaction, exactly as the enforcer computes it
 * (`OpDrivechain::compute_m6id`): the txid of the tx with its inputs removed
 * and its first output — the new treasury — replaced by a zero-value
 * `OP_RETURN <F_total>`, F_total being the fee as an 8-byte big-endian
 * integer: old treasury − new treasury − sum of payouts. Hex in internal byte
 * order, as an M3 carries it. Null if the tx isn't shaped like a withdrawal.
 */
export function computeM6id(tx: RawTx, oldTreasurySats: number): string | null {
  const blinded = blindedM6Hex(tx, oldTreasurySats);
  return blinded == null ? null : sha256dHex(blinded);
}

/** The serialized "blinded" withdrawal (see computeM6id), hex; null if not a withdrawal. */
export function blindedM6Hex(tx: RawTx, oldTreasurySats: number): string | null {
  const outs = tx?.vout;
  if (!Array.isArray(outs) || outs.length === 0) return null;
  if (!Number.isInteger(tx.version) || !Number.isInteger(tx.locktime)) return null;
  if (!TREASURY_SCRIPT_RE.test(outs[0]?.scriptPubKey?.hex ?? "")) return null;
  const newTreasury = toSats(outs[0].value);
  const payouts = outs.slice(1).reduce((sum, o) => sum + toSats(o?.value ?? 0), 0);
  const fee = oldTreasurySats - newTreasury - payouts;
  if (fee < 0) return null;
  const feeBe = Buffer.alloc(8);
  feeBe.writeBigUInt64BE(BigInt(fee));
  const output = (valueSats: number, scriptHex: string) =>
    u64le(valueSats) + varIntHex(scriptHex.length / 2) + scriptHex;
  const serialized =
    u32le(tx.version!) +
    varIntHex(0) + // no inputs
    varIntHex(outs.length) +
    output(0, "6a08" + feeBe.toString("hex")) +
    outs
      .slice(1)
      .map((o) => output(toSats(o.value), o.scriptPubKey.hex))
      .join("") +
    u32le(tx.locktime!);
  return serialized;
}

/**
 * Withdrawals (M6) in a block: transactions whose first output is a treasury
 * and that spend a larger treasury of the same slot, with their M6id. Like
 * every treasury event this is raw; lib/bundles.ts decides which one actually
 * paid out a pending bundle.
 */
export function parseWithdrawals(b: RawBlock): ParsedWithdrawal[] {
  const out: ParsedWithdrawal[] = [];
  if (!Array.isArray(b?.tx)) return out;
  b.tx.forEach((tx, txIndex) => {
    if (txIndex === 0) return;
    const w = withdrawalOf(tx);
    if (w) out.push({ txIndex, ...w });
  });
  return out;
}

/** If `tx` (with prevouts) is a withdrawal, its txid, slot and M6id. */
export function withdrawalOf(tx: RawTx | undefined): Omit<ParsedWithdrawal, "txIndex"> | null {
  if (!tx || typeof tx.txid !== "string") return null;
  const first = TREASURY_SCRIPT_RE.exec(tx.vout?.[0]?.scriptPubKey?.hex ?? "");
  if (!first) return null;
  const slot = parseInt(first[1], 16);
  const oldTreasury = (tx.vin ?? []).reduce((sum, i) => {
    const m = TREASURY_SCRIPT_RE.exec(i?.prevout?.scriptPubKey?.hex ?? "");
    return m && parseInt(m[1], 16) === slot ? sum + toSats(i!.prevout!.value) : sum;
  }, 0);
  if (oldTreasury <= toSats(tx.vout[0].value)) return null; // a deposit, not a withdrawal
  const m6id = computeM6id(tx, oldTreasury);
  return m6id ? { txid: tx.txid, slot, m6id } : null;
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
