import type { Drivechain } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// eCash (ECX) mainnet — the only network this project targets.
//
// ECX is a Bitcoin hard fork that activates BIP 300/301. It starts from
// Bitcoin's ledger and forks at Bitcoin's difficulty adjustment at block
// 973,728, so it INHERITS Bitcoin's entire pre-fork history — including
// Bitcoin's genesis block.
// ─────────────────────────────────────────────────────────────────────────────

/** The L1 mainchain coin ticker. ECX is a 1:1 BTC split, so sat precision. */
export const L1_SYMBOL = "ECX";
export const SATS_PER_COIN = 100_000_000;

/** How many days of history the dashboard shows. */
export const WINDOW_DAYS = 30;

/** Height of the fork from Bitcoin. Block 973,728 is the first ECX block. */
export const ECX_FORK_HEIGHT = 973_728;

/**
 * Hash of the ECX fork block (height ECX_FORK_HEIGHT).
 *
 * ⚠ THIS, NOT THE GENESIS HASH, IS ECX'S NETWORK IDENTITY. Because ECX forks
 * from Bitcoin's ledger, its genesis hash is byte-identical to Bitcoin
 * mainnet's, and `getblockchaininfo.chain` reports "main" — so neither can tell
 * an ECX node apart from a Bitcoin node (or from another fork of the same
 * ledger). The first post-fork block hash can: the fork resets difficulty, so
 * block 973,728 is unique to ECX. The indexer pins this to refuse indexing any
 * other chain into an ECX store.
 */
export const ECX_FORK_BLOCK_HASH =
  "0000000000000001441a6a4ae49d679d4a30581db3e3eaeeb2fba5da6dc146ed";

/** Bitcoin's genesis, inherited by ECX. Kept for the record; NOT an identity. */
export const ECX_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

// ─────────────────────────────────────────────────────────────────────────────
// Drivechain (BIP 300 sidechain slot) metadata.
//
// The CHAIN is the source of truth for which slots are active: the dashboard
// renders exactly the slots it observes being merge-mined, and this table only
// supplies human-readable metadata when a slot matches a sidechain we know of.
// A slot with no entry here still renders — see drivechainForSlot() — because a
// hardcoded slate must never be able to hide real on-chain activity.
//
// Refresh this table from the network registry at https://drivechain.dev/config
// (each network's `sidechains[]`), or from a node's
// ValidatorService.GetSidechains. ECX mainnet's registry entry currently lists
// no sidechains, so these are the ecosystem's published slot assignments rather
// than a confirmed ECX slate.
//
// Series colours are a validated categorical palette for a DARK surface,
// assigned to slots in fixed ascending order and never cycled or reassigned by
// rank — a chain keeps its colour no matter where it ranks. The chart stacks in
// this same order so the adjacent pairs on screen are the pairs that were
// validated. Checked with the palette validator (OKLab ΔE): worst adjacent CVD
// 8.4, worst adjacent normal-vision 16.3, all eight inside the dark lightness
// band and above 3:1 contrast. The original hand-picked set failed three of
// those checks — zSide/Elements were ΔE 6.3 apart (indistinguishable to full
// colour vision) and Thunder/BitAssets ΔE 1.3 under deuteranopia.
//
// Coinshift is plum (#7e5596, hue 312°) rather than the red it started as. Red
// sat ΔE 7.1/7.8/13.0 from BitAssets/Elements/Truthcoin — three pairs under the
// 15 floor, crowded into the warm quadrant. Hue 312° is the one wide gap left
// between Photon (287°) and Elements (1°), and moving there took the worst of
// those three from 7.1 to 16.4.
//
// KNOWN LIMIT: the legend and table show every active chain together, so *every*
// pair matters there, and several are under the floor (BitNames/Photon 9.8,
// Flush/Thunder 10.5, BitAssets/Truthcoin 10.6, BitAssets/Elements 11.6,
// Thunder/zSide 11.9). Flush is not the weakest link in either dimension.
// This is inherent to eight series, not a tuning miss: a search over the whole
// feasible OKLCh space finds sets that clear normal-vision all-pairs at ΔE 17.6,
// but every one of them collapses under CVD (best found: ΔE 1.4 deutan). Chain
// NAMES in the legend and table are the secondary encoding that makes this
// legal. Re-run the validator (adjacent AND --pairs all) before editing.
// ─────────────────────────────────────────────────────────────────────────────
export const KNOWN_DRIVECHAINS: Drivechain[] = [
  {
    slot: 2,
    name: "BitNames",
    ticker: "BNMS",
    description: "A Namecoin/BitDNS variant aiming to replace ICANN",
    color: "#3987e5",
  },
  {
    slot: 4,
    name: "BitAssets",
    ticker: "BAST",
    description: "A sidechain for digital assets",
    color: "#d95926",
  },
  {
    slot: 9,
    name: "Thunder",
    ticker: "THDR",
    description: "Large & growing blocksize, plus fraud proofs",
    color: "#199e70",
  },
  {
    slot: 13,
    name: "Truthcoin",
    ticker: "TRTH",
    description: "Decentralized prediction markets and oracle data",
    color: "#c98500",
  },
  {
    slot: 24,
    name: "Elements",
    ticker: "ELEM",
    description: "Blockstream Elements, enabling Simplicity script",
    color: "#d55181",
  },
  {
    slot: 46,
    name: "Flush",
    ticker: "FLSH",
    description: "Tokens, assets and a DEX on a fast chain over eCash",
    color: "#00a8b9",
  },
  {
    slot: 98,
    name: "zSide",
    ticker: "ZSDE",
    description: "Sidechain with private transactions",
    color: "#008300",
  },
  {
    slot: 99,
    name: "Photon",
    ticker: "PHO",
    description: "Sidechain using post-quantum cryptography",
    color: "#9085e9",
  },
  {
    slot: 255,
    name: "Coinshift",
    ticker: "CSHF",
    description: "P2P, trustless L2↔L1 swap system",
    color: "#7e5596",
  },
];

/** The validated palette, in the order it was checked for adjacent contrast. */
const PALETTE = KNOWN_DRIVECHAINS.map((c) => c.color);

const BY_SLOT = new Map(KNOWN_DRIVECHAINS.map((c) => [c.slot, c]));

/** True when this slot matches a sidechain we have metadata for. */
export function isKnownSlot(slot: number): boolean {
  return BY_SLOT.has(slot);
}

/**
 * Metadata for a merge-mined slot observed on chain.
 *
 * Known slots return their hand-validated entry unchanged. An UNKNOWN slot gets
 * a synthesized entry so that real activity is always rendered — a slot we have
 * no name for is still a drivechain paying real fees to L1, and silently
 * dropping it would make the dashboard understate the total. (That was a real
 * bug: both read paths used to build their rows by iterating the hardcoded
 * registry, so any slot missing from it vanished from the site even though the
 * indexer had stored it.)
 *
 * `taken` lets the caller reserve the colours already in use by the active set,
 * so an unknown slot picks a free one instead of colliding. Colour choice is
 * deterministic for a given (slot, taken) pair, and an unknown slot's colour is
 * stable as long as the active set is. With more than PALETTE.length active
 * chains colours necessarily repeat; the chain NAME is the disambiguator.
 */
export function drivechainForSlot(
  slot: number,
  taken: ReadonlySet<string> = new Set(),
): Drivechain {
  const known = BY_SLOT.get(slot);
  if (known) return known;

  // Start from a stable position derived from the slot itself, then step to the
  // first colour the active set is not already using.
  const start = slot % PALETTE.length;
  let color = PALETTE[start];
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = PALETTE[(start + i) % PALETTE.length];
    if (!taken.has(candidate)) {
      color = candidate;
      break;
    }
  }

  return {
    slot,
    name: `Slot ${slot}`,
    ticker: `S${slot}`,
    description: "Unregistered drivechain slot — no published metadata",
    color,
  };
}

/**
 * Resolve a set of observed slots into display metadata, in ascending slot
 * order. Known slots keep their validated colours and reserve them first, so
 * unknown slots never steal a registered chain's colour.
 */
export function resolveDrivechains(slots: Iterable<number>): Drivechain[] {
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const taken = new Set<string>();
  for (const s of sorted) {
    const known = BY_SLOT.get(s);
    if (known) taken.add(known.color);
  }
  return sorted.map((s) => {
    const chain = drivechainForSlot(s, taken);
    taken.add(chain.color);
    return chain;
  });
}
