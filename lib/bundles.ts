// BIP 300 withdrawal bundles, replayed from the stored coinbase messages —
// which bundles are still collecting miner votes, and how many each has.
//
// Mirrors LayerTwo-Labs/bip300301_enforcer (lib/validator/task/mod.rs and
// dbs/diff.rs), block by block:
//
//   1. Coinbase messages, in output order:
//      M3  propose a bundle for an active slot → appended to that slot's
//          pending list with 1 vote (a re-proposal of a pending one is invalid).
//      M4  ack bundles (at most one per block; none = abstain everywhere):
//          0x01 one byte / 0x02 two bytes per active slot, ascending slot order:
//               an index into the slot's pending list, or abstain / alarm;
//          0x03 upvote each slot's leader if it leads the runner-up by ≥ 50;
//          0x00 repeat the previous block's effective actions, re-derived
//               against the current state.
//          Upvote: target +1; every other bundle in the slot with votes > 0
//          gets −1. Alarm: every bundle in the slot with votes > 0 gets −1.
//   2. Expiry: a bundle whose age exceeds the max age is dropped (order kept).
//   3. Transactions: a withdrawal (M6) pays out — and removes — its bundle.
//
// A message the enforcer would reject (inactive slot, wrong vote count,
// out-of-range index…) makes the whole block invalid, so it can't appear on
// the chain; such a message is simply skipped here.
//
// Votes refer to bundles by POSITION, and an upvote downvotes the slot's other
// bundles, so the state at any height depends on everything before it. The
// replay therefore has to start where the state is known — the ECX fork, where
// BIP 300 begins — which is why the store records these messages back to it
// (meta 'bundles_from').

/** ECX mainnet withdrawal thresholds (enforcer `Thresholds::ECX_MAINNET`). */
export const ECX_BUNDLE_THRESHOLDS = {
  /** A bundle expires once its age exceeds this many blocks (~12 weeks). */
  maxAge: 12_096,
  /** Votes must exceed this for the bundle to be paid out. */
  inclusionThreshold: 6_048,
} as const;

const ABSTAIN_ONE = 0xff;
const ALARM_ONE = 0xfe;
const ABSTAIN_TWO = 0xffff;
const ALARM_TWO = 0xfffe;
const U16_MAX = 0xffff;
const LEADING_BY_50_MARGIN = 50;

export interface BundleProposalRow {
  height: number;
  vout: number;
  slot: number;
  m6id: string;
}
export interface BundleAckRow {
  height: number;
  vout: number;
  version: number;
  votesHex: string;
}
export interface WithdrawalRow {
  height: number;
  txIndex: number;
  slot: number;
  m6id: string;
}

export interface PendingBundle {
  slot: number;
  /** Hex, in the byte order M3 carries it. */
  m6id: string;
  proposalHeight: number;
  votes: number;
}

/** What an M4 did in one slot, kept so a following "repeat previous" can redo it. */
type Action = { kind: "upvote"; m6id: string } | { kind: "alarm" };

/**
 * Replay bundle messages up to `tipHeight`. `activated` gives each active
 * slot and the height it activated (from lib/proposals.ts); a slot counts as
 * active for blocks after its activation block.
 */
export function replayBundles(
  proposals: BundleProposalRow[],
  acks: BundleAckRow[],
  withdrawals: WithdrawalRow[],
  activated: { slot: number; activationHeight: number }[],
  tipHeight: number,
  thresholds: { maxAge: number } = ECX_BUNDLE_THRESHOLDS,
): PendingBundle[] {
  // Per slot, the pending bundles in the order they were proposed.
  const pending = new Map<number, PendingBundle[]>();
  const listOf = (slot: number) => {
    let l = pending.get(slot);
    if (!l) pending.set(slot, (l = []));
    return l;
  };
  const activeAt = (h: number) =>
    activated
      .filter((a) => a.activationHeight < h)
      .map((a) => a.slot)
      .sort((a, b) => a - b);

  const expire = (h: number) => {
    for (const [slot, list] of pending) {
      pending.set(
        slot,
        list.filter((b) => h - b.proposalHeight <= thresholds.maxAge),
      );
    }
  };

  const upvote = (slot: number, m6id: string): Action | null => {
    const list = listOf(slot);
    const target = list.find((b) => b.m6id === m6id);
    if (!target || target.votes >= U16_MAX) return null;
    for (const b of list) {
      if (b !== target && b.votes > 0) b.votes -= 1;
    }
    target.votes += 1;
    return { kind: "upvote", m6id };
  };
  const alarm = (slot: number): Action | null => {
    const positive = listOf(slot).filter((b) => b.votes > 0);
    if (positive.length === 0) return null;
    for (const b of positive) b.votes -= 1;
    return { kind: "alarm" };
  };

  // Group everything by height, coinbase messages in output order.
  type Msg =
    | { type: "m3"; vout: number; row: BundleProposalRow }
    | { type: "m4"; vout: number; row: BundleAckRow };
  const msgsAt = new Map<number, Msg[]>();
  const push = (h: number, m: Msg) => {
    const l = msgsAt.get(h);
    if (l) l.push(m);
    else msgsAt.set(h, [m]);
  };
  for (const row of proposals) push(row.height, { type: "m3", vout: row.vout, row });
  for (const row of acks) push(row.height, { type: "m4", vout: row.vout, row });
  const paidAt = new Map<number, WithdrawalRow[]>();
  for (const w of withdrawals) {
    const l = paidAt.get(w.height);
    if (l) l.push(w);
    else paidAt.set(w.height, [w]);
  }

  const heights = [...new Set([...msgsAt.keys(), ...paidAt.keys()])]
    .filter((h) => h <= tipHeight)
    .sort((a, b) => a - b);

  // The previous block's effective M4 actions, for "repeat previous".
  let lastActions = new Map<number, Action>();
  let lastActionsHeight = -1;

  for (const h of heights) {
    // Expiries that happened in the blocks since the last one with events.
    expire(h - 1);
    const active = activeAt(h);
    let actions = new Map<number, Action>();

    for (const m of (msgsAt.get(h) ?? []).sort((a, b) => a.vout - b.vout)) {
      if (m.type === "m3") {
        const { slot, m6id } = m.row;
        if (!active.includes(slot)) continue;
        const list = listOf(slot);
        if (list.some((b) => b.m6id === m6id)) continue;
        list.push({ slot, m6id, proposalHeight: h, votes: 1 });
        continue;
      }

      const { version, votesHex } = m.row;
      if (version === 0) {
        // Repeat the previous block's actions — only if that block was h − 1.
        const prev = lastActionsHeight === h - 1 ? lastActions : new Map<number, Action>();
        for (const [slot, a] of prev) {
          const done = a.kind === "upvote" ? upvote(slot, a.m6id) : alarm(slot);
          if (done) actions.set(slot, done);
        }
      } else if (version === 3) {
        if (votesHex !== "") continue;
        for (const slot of active) {
          const ranked = [...listOf(slot)].sort((a, b) => b.votes - a.votes);
          const lead = ranked[0];
          if (!lead) continue;
          const second = ranked[1]?.votes ?? 0;
          if (lead.votes - second >= LEADING_BY_50_MARGIN && lead.votes < U16_MAX) {
            const done = upvote(slot, lead.m6id);
            if (done) actions.set(slot, done);
          }
        }
      } else if (version === 1 || version === 2) {
        const votes = decodeVotes(version, votesHex);
        if (!votes || votes.length !== active.length) continue;
        // Validate every index first: one bad vote invalidates the whole M4.
        const ok = votes.every(
          (v, i) =>
            v === ABSTAIN_TWO || v === ALARM_TWO || v < listOf(active[i]).length,
        );
        if (!ok) continue;
        const next = new Map<number, Action>();
        votes.forEach((v, i) => {
          const slot = active[i];
          if (v === ABSTAIN_TWO) return;
          const done =
            v === ALARM_TWO ? alarm(slot) : upvote(slot, listOf(slot)[v].m6id);
          if (done) next.set(slot, done);
        });
        actions = next;
      }
    }
    lastActions = actions;
    lastActionsHeight = h;

    // Expiry at this block, after its coinbase messages.
    expire(h);

    // Withdrawals pay out (and remove) their bundle.
    for (const w of paidAt.get(h) ?? []) {
      const list = pending.get(w.slot);
      if (!list) continue;
      const i = list.findIndex((b) => b.m6id === w.m6id);
      if (i >= 0) list.splice(i, 1);
    }
  }
  expire(tipHeight);

  return [...pending.values()].flat();
}

/** M4 vote values as u16, with the one-byte sentinels widened; null if malformed. */
function decodeVotes(version: number, hex: string): number[] | null {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  if (version === 1) {
    return [...bytes].map((b) =>
      b === ABSTAIN_ONE ? ABSTAIN_TWO : b === ALARM_ONE ? ALARM_TWO : b,
    );
  }
  if (bytes.length % 2 !== 0) return null;
  const votes: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) votes.push(bytes.readUInt16LE(i));
  // Two-byte encoding is only allowed when a value needs it.
  if (votes.every((v) => v <= 253)) return null;
  return votes;
}
