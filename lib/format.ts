import { L1_SYMBOL, SATS_PER_COIN } from "./config";

/** Format sats as coins with symbol, e.g. "12.3456 BTC". */
export function formatCoins(sats: number, decimals = 4): string {
  const coins = sats / SATS_PER_COIN;
  return `${coins.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${L1_SYMBOL}`;
}

/** Compact coins for tight spaces, e.g. "1.2K BTC". */
export function formatCoinsCompact(sats: number): string {
  const coins = sats / SATS_PER_COIN;
  return `${coins.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  })} ${L1_SYMBOL}`;
}

/** Whole-number sats with thousands separators, e.g. "1,234,567 sats". */
export function formatSats(sats: number): string {
  return `${Math.round(sats).toLocaleString("en-US")} sats`;
}

/** Compact sats for tight spaces, e.g. "154K sats". */
export function formatSatsCompact(sats: number): string {
  return `${Math.round(sats).toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  })} sats`;
}

/**
 * Coin display carries at most 2 fraction digits, so any amount below 0.01
 * coins renders as "0.00" and the number is lost. Below this reference
 * magnitude, show sats instead.
 */
const COIN_DISPLAY_MIN_SATS = SATS_PER_COIN / 100;

/**
 * Pick a fee formatter from the LARGEST value in a set, so every label in that
 * set — axis ticks, a table column, a group of tiles — shares one unit. Mixing
 * sats and coins within a set would read worse than rounding everything to
 * zero, so the unit is decided once by the caller and applied to all members.
 *
 * `coinFormat` is the formatter used above the threshold; it defaults to the
 * compact form for tight spaces (chart axis, table cells).
 */
export function feeFormatter(
  maxSats: number,
  coinFormat: (sats: number) => string = formatCoinsCompact,
  satsFormat: (sats: number) => string = formatSats,
): (sats: number) => string {
  return maxSats < COIN_DISPLAY_MIN_SATS ? satsFormat : coinFormat;
}

/** Fraction (0-1) as a percentage, e.g. "23.4%". */
export function formatPct(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Integer with separators, e.g. "4,320". */
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Rough duration of `blocks` L1 blocks, e.g. "≈ 1.4 days" / "≈ 6 h". */
export function approxDuration(blocks: number, avgBlockSeconds?: number): string | null {
  if (!avgBlockSeconds || blocks <= 0) return null;
  const hours = (blocks * avgBlockSeconds) / 3600;
  return hours >= 48 ? `≈ ${(hours / 24).toFixed(1)} days` : `≈ ${Math.round(hours)} h`;
}
