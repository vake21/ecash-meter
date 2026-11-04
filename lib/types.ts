// Core domain types for eCash Meter.
//
// The unit of account is satoshis of the L1 (mainchain) coin. eCash (ECX) is a
// 1:1 Bitcoin hard fork, so the mainchain coin uses 8-decimal (sat) precision.
//
// Under BIP 301 (blind merged mining), a sidechain's block is committed on L1
// by a "BMM bid" transaction whose fee is paid to the L1 miner. Summing those
// bids per sidechain slot tells us how much each drivechain feeds L1 security.

/** Static metadata for one drivechain (BIP 300 sidechain slot). */
export interface Drivechain {
  /** BIP 300 sidechain slot number (0-255). */
  slot: number;
  name: string;
  ticker: string;
  description: string;
  /** Tailwind-friendly accent color (hex) used in charts/cards. */
  color: string;
  /**
   * L1 height at which this slot's BIP 300 activation vote passed on ECX.
   * Absent for slots that are not activated on ECX.
   */
  activationHeight?: number;
}

/**
 * A single BMM bid observed on the L1 mainchain. This is the raw unit we will
 * eventually parse from a full node; aggregates below are derived from these.
 */
export interface BmmBid {
  /** L1 block height the bid was confirmed in. */
  height: number;
  /** Sidechain slot this bid commits a block for. */
  slot: number;
  /** Fee paid to the L1 miner, in satoshis. */
  feeSats: number;
  /** L1 txid of the BMM bid transaction. */
  txid: string;
  /** Unix seconds of the L1 block. */
  time: number;
}

/** One day's worth of activity for one drivechain. */
export interface FeePoint {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  feeSats: number;
  /** BMM commitments that day (blocks the sidechain was merge-mined into). */
  bmmCount: number;
  /**
   * ECX held in the sidechain's L1 treasury at the END of that day, sats.
   * Absent when the source doesn't track treasuries or the balance is unknown.
   */
  treasurySats?: number;
}

/** Rolled-up stats for one drivechain over the tracked window. */
export interface DrivechainStats {
  chain: Drivechain;
  /** Total fees fed to L1 over the whole window, in sats. */
  totalFeesSats: number;
  /** Fees in the most recent 24h, in sats. */
  feesLast24hSats: number;
  /**
   * BMM commitments over the window = blocks this sidechain was merge-mined
   * into (one coinbase h* commitment per block). This is the real signal even
   * on a stretch of chain where no bid paid a fee.
   */
  bmmCommitments: number;
  /** Number of fee-paying BMM bid txs identified. */
  bmmBidCount: number;
  /** Average bid size, in sats (0 when no paid bids). */
  avgBidSats: number;
  /** Share of the headline metric (fees or BMM commitments) across chains (0-1). */
  shareOfTotal: number;
  /** Daily time series for charting. */
  series: FeePoint[];
  /** True when the slot is activated on ECX (listed even with no BMM blocks). */
  activated?: boolean;
  /**
   * ECX currently held in the sidechain's L1 treasury output (its CTIP), sats.
   * `undefined` = this data source doesn't track treasuries; `null` = unknown
   * because the store doesn't cover the slot's history back to activation;
   * 0 = activated but nothing deposited.
   */
  treasurySats?: number | null;
}

/** Everything the dashboard needs, as returned by the data layer. */
export interface DashboardData {
  /**
   * Where the data came from. "ecx" is eCash mainnet — the only chain this
   * project indexes; "mock" is the deterministic placeholder dataset.
   */
  network: "ecx" | "mock";
  /**
   * Which metric is the meaningful headline for this dataset:
   *  - "fees": fees fed to L1 (any window containing a paid BMM bid)
   *  - "bmm":  BMM commitment activity (window with commitments but no paid bids)
   */
  metric: "fees" | "bmm";
  /** Latest L1 block height reflected in this snapshot. */
  tipHeight: number;
  /** Number of days covered by the series. */
  windowDays: number;
  /** Total blocks scanned to build this snapshot. */
  blocksScanned: number;
  stats: DrivechainStats[];
  /** Sum of totalFeesSats across all drivechains. */
  grandTotalFeesSats: number;
  /** Sum of bmmCommitments across all drivechains. */
  grandTotalBmmCommitments: number;
  /**
   * Unix seconds of the most recent indexed block. Lets the UI show data
   * freshness and flag a stale indexer instead of presenting old data as current.
   */
  lastBlockTime?: number;
  /** Number of slots activated on ECX (undefined when not tracked). */
  activatedCount?: number;
  /**
   * Sum of treasurySats across activated slots; null if any is unknown,
   * undefined when this data source doesn't track treasuries.
   */
  totalTreasurySats?: number | null;
  /** Optional human note (e.g. why fees read 0 for this window). */
  note?: string;
}
