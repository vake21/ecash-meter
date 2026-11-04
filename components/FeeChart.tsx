import type { DrivechainStats, FeePoint } from "@/lib/types";
import { feeFormatter, formatInt } from "@/lib/format";

interface Props {
  stats: DrivechainStats[];
  windowDays: number;
  /** Which series value to plot. "bmm" = commitment counts, "fees" = sats. */
  metric: "fees" | "bmm";
}

// Chart geometry (viewBox units).
const W = 720;
const H = 300;
const padL = 8;
const padR = 8;
const padT = 8;
const padB = 30;
const plotW = W - padL - padR;
const plotH = H - padT - padB;
const BAR_GAP = 2; // between days
const SEG_GAP = 2; // between stacked segments, so adjacent fills never touch
const SEG_RADIUS = 2;

// Stacked bar chart: one bar per day, each segment one drivechain's contribution
// that day (BMM commitments or fees). Pure SVG — no chart dependency. SSR.
export default function FeeChart({ stats, windowDays, metric }: Props) {
  const dates = stats[0]?.series.map((p) => p.date) ?? [];
  const value = (p: FeePoint | undefined) =>
    metric === "bmm" ? (p?.bmmCount ?? 0) : (p?.feeSats ?? 0);
  // Total of the values we'd actually plot (from the series), so the empty-state
  // decision matches what the chart would draw.
  const windowTotal = stats.reduce(
    (sum, st) => sum + st.series.reduce((s, p) => s + value(p), 0),
    0,
  );

  // Legitimate empty state: either no dates at all, or blocks were indexed but no
  // BMM commitments fell in the (now zero-filled) window, so every value is 0.
  // Render a message rather than computing chart geometry over zero dates (which
  // would divide by zero and index past the end of `dates`) or drawing an all-zero
  // chart that reads as broken. Do NOT fabricate mock activity here.
  if (dates.length === 0 || windowTotal === 0) {
    return (
      <div className="w-full rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-10 text-center">
        <p className="text-sm text-neutral-400">
          No BMM commitments were found in the indexed window.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          The indexer has blocks, but none carried drivechain commitments over
          the last {windowDays} {windowDays === 1 ? "day" : "days"}.
        </p>
      </div>
    );
  }

  // Stack in FIXED slot order, not the ranked order `stats` arrives in. Two
  // reasons: the series palette was validated on the adjacent pairs that slot
  // order produces, and a stack whose segment order changes with the ranking is
  // unreadable across days. The ranked order still drives the table below.
  // Chains with nothing to plot in the window (activated but idle) are left out
  // of the stack and the legend; the table still lists them.
  const stacked = stats
    .filter((st) => st.series.some((p) => value(p) > 0))
    .sort((a, b) => a.chain.slot - b.chain.slot);

  // Daily total across all chains, for y-axis scaling.
  const dailyTotals = dates.map((_, i) =>
    stats.reduce((s, st) => s + value(st.series[i]), 0),
  );
  const maxDaily = Math.max(...dailyTotals, 1);

  // Pick the fee unit ONCE from the largest daily total so all four gridlines
  // share it. Scaling to maxDaily means a satoshi-scale window still draws
  // full-height bars; without this the ticks would all read "0 BTC" beside them.
  const formatFee = feeFormatter(maxDaily);
  const formatValue = (v: number) =>
    metric === "bmm"
      ? `${formatInt(Math.round(v))} commitment${v === 1 ? "" : "s"}`
      : formatFee(v);
  const axisLabel = (v: number) =>
    metric === "bmm" ? formatInt(Math.round(v)) : formatFee(v);

  const n = dates.length;
  const barW = plotW / n - BAR_GAP;

  // Gridlines at 25/50/75/100% of max.
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => ({
    f,
    y: padT + plotH * (1 - f),
  }));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={
          metric === "bmm"
            ? "Daily blind-merged-mining commitments per drivechain"
            : "Daily drivechain fees fed to L1"
        }
      >
        {/* gridlines — recessive, behind the data */}
        {gridYs.map((g) => (
          <g key={g.f}>
            <line
              x1={padL}
              x2={W - padR}
              y1={g.y}
              y2={g.y}
              stroke="#262626"
              strokeWidth={1}
            />
            <text
              x={W - padR}
              y={g.y - 3}
              textAnchor="end"
              className="fill-neutral-500"
              fontSize={9}
            >
              {axisLabel(maxDaily * g.f)}
            </text>
          </g>
        ))}

        {/* stacked bars, in fixed slot order from the baseline up */}
        {dates.map((date, i) => {
          const x = padL + i * (plotW / n) + BAR_GAP / 2;
          let yCursor = padT + plotH;
          return (
            <g key={date}>
              {stacked.map((st) => {
                const v = value(st.series[i]);
                if (v <= 0) return null;
                const h = (v / maxDaily) * plotH;
                yCursor -= h;
                // Hold the gap out of the drawn height so neighbouring fills are
                // separated by surface, never by a colour boundary alone.
                const drawH = Math.max(h - SEG_GAP, 0.75);
                return (
                  <rect
                    key={st.chain.slot}
                    x={x}
                    y={yCursor}
                    width={barW}
                    height={drawH}
                    rx={Math.min(SEG_RADIUS, drawH / 2)}
                    fill={st.chain.color}
                  >
                    <title>{`${st.chain.name} — ${date} — ${formatValue(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {/* x-axis: first/mid/last date labels */}
        {[0, Math.floor(n / 2), n - 1].map((i) => {
          const x = padL + i * (plotW / n) + barW / 2;
          return (
            <text
              key={i}
              x={x}
              y={H - 8}
              textAnchor="middle"
              className="fill-neutral-500"
              fontSize={9}
            >
              {dates[i].slice(5)}
            </text>
          );
        })}
      </svg>

      {/* Legend — eight series is past the point where direct labels fit, so
          identity is carried here rather than by colour alone. Same order as the
          stack, and the text wears text tokens rather than the series colour. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {stacked.map((st) => (
          <li
            key={st.chain.slot}
            className="flex items-center gap-1.5 text-xs text-neutral-400"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: st.chain.color }}
            />
            {st.chain.name}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-neutral-500">
        {metric === "bmm"
          ? "Daily BMM commitments (blocks merge-mined), stacked by drivechain"
          : "Daily fees fed to L1 miners, stacked by drivechain"}{" "}
        · last {windowDays} {windowDays === 1 ? "day" : "days"}
      </p>
    </div>
  );
}
