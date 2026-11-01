// Data-freshness derivation, kept out of the React render path so the "current
// time" read stays a pure data concern (server components must not call impure
// functions like Date.now() during render). `nowSec` is injectable for testing.

export interface Freshness {
  /** Age of the latest indexed block in seconds, or null if unknown. */
  ageSec: number | null;
  /** True when the data is old enough that it shouldn't read as "current". */
  isStale: boolean;
  /** Short human label ("just now", "12m ago"), or null if unknown. */
  label: string | null;
}

/** Data older than this reads as stale (generous vs ~10-min ECX blocks). */
export const STALE_AFTER_SEC = 30 * 60;

export function computeFreshness(
  lastBlockTime?: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): Freshness {
  if (lastBlockTime == null) return { ageSec: null, isStale: false, label: null };
  const ageSec = Math.max(0, nowSec - lastBlockTime);
  const label =
    ageSec < 90
      ? "just now"
      : ageSec < 3600
        ? `${Math.round(ageSec / 60)}m ago`
        : ageSec < 86_400
          ? `${Math.round(ageSec / 3600)}h ago`
          : `${Math.round(ageSec / 86_400)}d ago`;
  return { ageSec, isStale: ageSec > STALE_AFTER_SEC, label };
}
