// BIP 300 sidechain proposals: which slots are active, and which proposals are
// still collecting votes — replayed from coinbase messages, exactly as the
// enforcer (bip300301_enforcer, lib/validator/task/mod.rs) does it, so the site
// needs no enforcer at runtime.
//
//   M1 (propose)  coinbase OP_RETURN <d5e0c4af> <slot:1> <description…>
//   M2 (ack)      coinbase OP_RETURN <d6e1c5df> <slot:1> <sha256d(description):32>
//
// Per block, in order:
//   1. M1: register (slot, sha256d(description)) with 0 votes at this height —
//      unless that exact proposal is already pending (miners can't reset votes).
//   2. M2: +1 vote for the matching pending proposal, unless it was proposed in
//      this same block. Then, if the slot is UNUSED and votes > 1,815 within
//      2,016 blocks of the proposal — or the slot is USED and votes > 6,048
//      within 12,096 blocks — the proposal activates (replacing whatever held
//      the slot) and leaves the pending set.
//   3. Drop proposals that have failed: older than the max age, or with so many
//      non-ack blocks that they can no longer reach the threshold in time.
//
// Those are ECX mainnet's thresholds (the enforcer's Thresholds::ECX_MAINNET).
// Verified on 2026-11-04 against a live ECX enforcer: same five activations at
// the same heights, and the same pending proposals with the same vote counts.

export interface Thresholds {
  unusedSlotActivation: number;
  unusedSlotMaxAge: number;
  usedSlotActivation: number;
  usedSlotMaxAge: number;
}

/** ECX mainnet BIP 300 thresholds (enforcer `Thresholds::ECX_MAINNET`). */
export const ECX_THRESHOLDS: Readonly<Thresholds> = {
  /** Proposal for an EMPTY slot: votes must strictly exceed this… */
  unusedSlotActivation: 1_815,
  /** …within this many blocks of the proposal (inclusive). */
  unusedSlotMaxAge: 2_016,
  /** Proposal REPLACING an active sidechain: votes must strictly exceed this… */
  usedSlotActivation: 6_048,
  /** …within this many blocks (ECX's withdrawal-bundle window). */
  usedSlotMaxAge: 12_096,
};

export interface ProposalRow {
  height: number;
  /** Coinbase output index, to order several M1s in one block. */
  vout: number;
  slot: number;
  /** Raw description bytes, hex. */
  descriptionHex: string;
  /** sha256d(description), hex in the byte order M2 carries it. */
  hash: string;
}
export interface AckRow {
  height: number;
  slot: number;
  hash: string;
}

export interface Declaration {
  title: string;
  description: string;
}

/** A sidechain occupying a slot. */
export interface ActiveSidechain {
  slot: number;
  hash: string;
  declaration: Declaration | null;
  proposalHeight: number;
  activationHeight: number;
  votes: number;
}

/** A proposal still collecting votes at the tip. */
export interface PendingProposal {
  slot: number;
  hash: string;
  declaration: Declaration | null;
  proposalHeight: number;
  votes: number;
  /** Blocks since the proposal, at the tip. */
  age: number;
  /** Votes must exceed this to activate (so threshold + 1 are needed). */
  threshold: number;
  /** Last age at which it can still activate. */
  maxAge: number;
  /** The active sidechain this would replace, or null for an empty slot. */
  replaces: ActiveSidechain | null;
}

export interface ProposalReplay {
  active: Map<number, ActiveSidechain>;
  pending: PendingProposal[];
}

/**
 * Decode a v0 sidechain declaration: 0x00, title length (1 byte), title, then a
 * description running up to two trailing hashes (32 + 20 bytes). Returns null
 * for anything else — the proposal still counts, it just has no readable name.
 */
export function decodeDeclaration(hex: string): Declaration | null {
  const b = Buffer.from(hex, "hex");
  if (b.length < 2 || b[0] !== 0) return null;
  const titleLen = b[1];
  const descEnd = b.length - 52;
  if (2 + titleLen > descEnd) return null;
  const dec = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      title: dec.decode(b.subarray(2, 2 + titleLen)),
      description: dec.decode(b.subarray(2 + titleLen, descEnd)),
    };
  } catch {
    return null;
  }
}

/** Replay M1/M2 messages up to and including `tipHeight`. */
export function replayProposals(
  proposals: ProposalRow[],
  acks: AckRow[],
  tipHeight: number,
  t: Thresholds = ECX_THRESHOLDS,
): ProposalReplay {
  const key = (slot: number, hash: string) => `${slot}:${hash}`;
  interface Live {
    slot: number;
    hash: string;
    descriptionHex: string;
    proposalHeight: number;
    votes: number;
  }
  const pending = new Map<string, Live>();
  const active = new Map<number, ActiveSidechain>();

  const limits = (slot: number) =>
    active.has(slot)
      ? { threshold: t.usedSlotActivation, maxAge: t.usedSlotMaxAge }
      : { threshold: t.unusedSlotActivation, maxAge: t.unusedSlotMaxAge };

  /** The enforcer's failure rule, evaluated as of `height`. */
  const dropFailed = (height: number) => {
    for (const [k, p] of pending) {
      const { threshold, maxAge } = limits(p.slot);
      const age = Math.max(0, height - p.proposalHeight);
      const maxFails = Math.max(0, maxAge - threshold);
      const fails = Math.max(0, age - p.votes);
      if (age > maxAge || (age > maxFails && fails >= maxFails)) pending.delete(k);
    }
  };

  const m1ByHeight = groupBy(
    [...proposals].sort((a, b) => a.height - b.height || a.vout - b.vout),
    (p) => p.height,
  );
  const m2ByHeight = groupBy(acks, (a) => a.height);
  const heights = [...new Set([...m1ByHeight.keys(), ...m2ByHeight.keys()])]
    .filter((h) => h <= tipHeight)
    .sort((a, b) => a - b);

  for (const h of heights) {
    // Between message blocks nothing changes a proposal's votes, and both
    // failure conditions only become MORE true as blocks pass — so checking as
    // of the block before this one covers every block in the gap.
    dropFailed(h - 1);

    for (const m1 of m1ByHeight.get(h) ?? []) {
      const k = key(m1.slot, m1.hash);
      if (pending.has(k)) continue;
      pending.set(k, {
        slot: m1.slot,
        hash: m1.hash,
        descriptionHex: m1.descriptionHex,
        proposalHeight: h,
        votes: 0,
      });
    }

    for (const m2 of m2ByHeight.get(h) ?? []) {
      const k = key(m2.slot, m2.hash);
      const p = pending.get(k);
      if (!p || p.proposalHeight === h) continue;
      p.votes += 1;
      const age = h - p.proposalHeight;
      const { threshold, maxAge } = limits(p.slot);
      if (p.votes > threshold && age <= maxAge) {
        active.set(p.slot, {
          slot: p.slot,
          hash: p.hash,
          declaration: decodeDeclaration(p.descriptionHex),
          proposalHeight: p.proposalHeight,
          activationHeight: h,
          votes: p.votes,
        });
        pending.delete(k);
      }
    }

    dropFailed(h);
  }
  dropFailed(tipHeight);

  return {
    active,
    pending: [...pending.values()]
      .map((p) => {
        const { threshold, maxAge } = limits(p.slot);
        return {
          slot: p.slot,
          hash: p.hash,
          declaration: decodeDeclaration(p.descriptionHex),
          proposalHeight: p.proposalHeight,
          votes: p.votes,
          age: tipHeight - p.proposalHeight,
          threshold,
          maxAge,
          replaces: active.get(p.slot) ?? null,
        };
      })
      .sort((a, b) => a.slot - b.slot || a.proposalHeight - b.proposalHeight),
  };
}

function groupBy<T>(rows: T[], k: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const key = k(r);
    let list = m.get(key);
    if (!list) m.set(key, (list = []));
    list.push(r);
  }
  return m;
}
