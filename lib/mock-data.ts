import { KNOWN_DRIVECHAINS, WINDOW_DAYS } from "./config";
import { finalizeStats } from "./aggregate";
import type {
  DashboardData,
  DrivechainStats,
  FeePoint,
} from "./types";

// Deterministic mock data. We avoid Math.random so the dashboard renders the
// same numbers on every server/client pass (no hydration mismatch) and so the
// mockup is reproducible. A small seeded PRNG drives the variation.
//
// This module mimics the OUTPUT of aggregating BMM bids per drivechain. It is
// served ONLY in explicit demo mode (ECASH_DEMO=1, see lib/dashboard.ts) and is
// never a fallback for missing or broken data — the page labels it
// "DEMO — SAMPLE DATA" throughout. It deliberately shows every KNOWN drivechain
// busy at once, which no real chain need look like.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Relative "activity weight" per slot so chains differ in fee volume in a
// stable, believable way. Higher = busier sidechain = more/larger BMM bids.
const ACTIVITY_WEIGHT: Record<number, number> = {
  2: 0.4, // BitNames
  4: 0.85, // BitAssets
  9: 1.35, // Thunder (busiest)
  13: 1.0, // Truthcoin
  24: 0.25, // Elements (intermittently mined)
  98: 0.7, // zSide
  99: 0.55, // Photon
  255: 0.15, // Coinshift (sparse)
};

// Fixed reference date for reproducible ISO date labels (project "today").
const REFERENCE_DATE = "2026-07-14";

function dateNDaysBefore(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function buildSeries(slot: number): FeePoint[] {
  const rand = mulberry32(1000 + slot);
  const weight = ACTIVITY_WEIGHT[slot] ?? 0.6;
  const points: FeePoint[] = [];
  // Gentle upward adoption trend across the window.
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = dateNDaysBefore(REFERENCE_DATE, i);
    const dayIndex = WINDOW_DAYS - 1 - i;
    const trend = 0.6 + (0.9 * dayIndex) / WINDOW_DAYS; // ramp up over time
    const noise = 0.7 + rand() * 0.6; // 0.7x .. 1.3x jitter
    // Base: ~0.9 coin/day at weight 1, in sats.
    const feeSats = Math.round(90_000_000 * weight * trend * noise);
    // ~144 blocks/day; each paid bid ~ one BMM commitment.
    const bmmCount = Math.round(144 * weight * trend * noise);
    points.push({ date, feeSats, bmmCount });
  }
  return points;
}

function buildStats(): DrivechainStats[] {
  const raw = KNOWN_DRIVECHAINS.map((chain) => {
    const series = buildSeries(chain.slot);
    const totalFeesSats = series.reduce((s, p) => s + p.feeSats, 0);
    const feesLast24hSats = series[series.length - 1].feeSats;
    const bmmCommitments = series.reduce((s, p) => s + p.bmmCount, 0);
    // In the mock, every merge-mined block was a paid bid.
    const bmmBidCount = bmmCommitments;
    const avgBidSats = Math.round(totalFeesSats / Math.max(bmmBidCount, 1));
    return {
      chain,
      totalFeesSats,
      feesLast24hSats,
      bmmCommitments,
      bmmBidCount,
      avgBidSats,
      shareOfTotal: 0, // filled by finalizeStats
      series,
    };
  });
  return raw;
}

export function getDemoDashboardData(): DashboardData {
  const stats = buildStats();
  // Same metric-selection / share / ranking policy as the stored path.
  const { metric, grandTotalFeesSats, grandTotalBmmCommitments } =
    finalizeStats(stats);
  return {
    network: "demo",
    metric,
    tipHeight: 892_143,
    windowDays: WINDOW_DAYS,
    blocksScanned: WINDOW_DAYS * 144,
    stats,
    grandTotalFeesSats,
    grandTotalBmmCommitments,
  };
}
