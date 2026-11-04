import type { DrivechainStats, FeePoint } from "@/lib/types";
import type { Drivechain } from "@/lib/types";
import { SATS_PER_COIN } from "@/lib/config";
import {
  feeFormatter,
  formatCoins,
  formatCoinsCompact,
  formatInt,
  formatSatsCompact,
} from "@/lib/format";

export type ChartMetric = "fees" | "bmm" | "treasury" | "flows";

/** Per-metric wording, so the three charts share one geometry. */
const COPY: Record<
  ChartMetric,
  { aria: string; caption: string; emptyTitle: string; emptyBody: string }
> = {
  fees: {
    aria: "Daily drivechain fees fed to L1",
    caption: "Fees paid to L1 miners each day",
    emptyTitle: "No BMM commitments were found in the indexed window.",
    emptyBody: "The indexer has blocks, but none carried drivechain commitments over",
  },
  bmm: {
    aria: "Daily blind-merged-mining commitments per drivechain",
    caption: "L1 blocks carrying each sidechain's BMM commitment, per day",
    emptyTitle: "No BMM commitments were found in the indexed window.",
    emptyBody: "The indexer has blocks, but none carried drivechain commitments over",
  },
  flows: {
    aria: "ECX deposited into and withdrawn from each drivechain each day",
    caption: "ECX deposited (above the line) and withdrawn (below) each day",
    emptyTitle: "No deposits or withdrawals in the indexed window.",
    emptyBody: "No sidechain treasury changed over",
  },
  treasury: {
    aria: "ECX held in each drivechain's L1 treasury at the end of each day",
    caption: "ECX held at the end of each day",
    emptyTitle: "No drivechain held any ECX in the indexed window.",
    emptyBody: "No activated sidechain had a funded L1 treasury over",
  },
};

interface Props {
  stats: DrivechainStats[];
  windowDays: number;
  /**
   * Which series value to plot: "fees" = sats paid to L1 that day, "bmm" =
   * commitment counts that day, "treasury" = ECX held at the end of that day,
   * "flows" = ECX deposited (up) and withdrawn (down) that day.
   */
  metric: ChartMetric;
  /**
   * Draw this chart's own legend. Off when several charts sit side by side
   * under one shared <ChartLegend>, since their colours are identical.
   */
  showLegend?: boolean;
}

// Chart geometry (viewBox units). Sized for a half-width panel in the 2×2
// grid: the SVG scales to its container (~500px there), so 11-unit text lands
// near 10.5px on screen. The canvas is sized to the panel rather than shrunk
// into it — a 720-wide canvas in a third-width panel once rendered ~4px text.
const W = 520;
const H = 240;
const FONT = 11;
const padL = 4;
// Right gutter holds the gridline labels OUTSIDE the plot. Inside it, they
// collided with the last bar — always the tallest on the treasury chart, since a
// balance tends to grow.
const padR = 58;
const padT = 8;
const padB = 22;
const plotW = W - padL - padR;
const plotH = H - padT - padB;
const BAR_GAP = 2; // between days
const SEG_GAP = 2; // between stacked segments, so adjacent fills never touch
const SEG_RADIUS = 1.5;

// Stacked bar chart: one bar per day, each segment one drivechain's value that
// day — fees fed to L1, BMM blocks, ECX held at day's end (a balance, so the
// bar's height is the total held by all drivechains), or ECX deposited and
// withdrawn. Pure SVG, no chart dependency, SSR. Every metric shares the
// geometry, palette and stack order, so the charts read as one system.
//
// Each metric supplies an UP and a DOWN value per chain per day. Only "flows"
// has a down side (withdrawals); for the rest it is 0 and the zero line sits on
// the floor, exactly as a plain stacked bar chart. When withdrawals exist the
// zero line rises to split the plot in proportion to the largest up and down
// days, and withdrawals stack downward in the same chain colours.
export default function FeeChart({
  stats,
  windowDays,
  metric,
  showLegend = true,
}: Props) {
  const dates = stats[0]?.series.map((p) => p.date) ?? [];
  const up = (p: FeePoint | undefined): number =>
    metric === "bmm"
      ? (p?.bmmCount ?? 0)
      : metric === "treasury"
        ? (p?.treasurySats ?? 0)
        : metric === "flows"
          ? (p?.depositSats ?? 0)
          : (p?.feeSats ?? 0);
  const down = (p: FeePoint | undefined): number =>
    metric === "flows" ? (p?.withdrawalSats ?? 0) : 0;
  const copy = COPY[metric];
  // Total of the values we'd actually plot (from the series), so the empty-state
  // decision matches what the chart would draw.
  const windowTotal = stats.reduce(
    (sum, st) => sum + st.series.reduce((s, p) => s + up(p) + down(p), 0),
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
        <p className="text-sm text-neutral-400">{copy.emptyTitle}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {copy.emptyBody} the last {windowDays}{" "}
          {windowDays === 1 ? "day" : "days"}.
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
    .filter((st) => st.series.some((p) => up(p) > 0 || down(p) > 0))
    .sort((a, b) => a.chain.slot - b.chain.slot);

  // Largest daily stack on each side of the zero line, for y-axis scaling.
  const dailyMax = (f: (p: FeePoint | undefined) => number) =>
    Math.max(0, ...dates.map((_, i) => stats.reduce((s, st) => s + f(st.series[i]), 0)));
  const maxUp = dailyMax(up);
  const maxDown = dailyMax(down);
  const range = Math.max(maxUp + maxDown, 1);
  const zeroY = padT + plotH * (maxUp / range);
  const toH = (v: number) => (v / range) * plotH;
  // Unit choice (sats vs coins) keys off the larger side.
  const maxDaily = Math.max(maxUp, maxDown, 1);

  // Pick the fee unit ONCE from the largest daily total so all four gridlines
  // share it. Scaling to maxDaily means a satoshi-scale window still draws
  // full-height bars; without this the ticks would all read "0 BTC" beside them.
  const formatFee = feeFormatter(maxDaily);
  const formatValue = (v: number, side: "up" | "down" = "up") =>
    metric === "bmm"
      ? `${formatInt(Math.round(v))} BMM block${v === 1 ? "" : "s"}`
      : metric === "treasury"
        ? formatCoins(v, 4) // exact holdings in the tooltip; the axis rounds
        : metric === "flows"
          ? side === "up"
            ? `${formatCoins(v, 4)} deposited`
            : `${formatCoins(v, 4)} withdrawn`
          : formatFee(v);
  // Axis ticks use compact numbers ("154K sats", "4.62 ECX") to fit the gutter.
  // Coin ticks carry enough decimals to tell neighbouring ticks apart: at a max
  // of 0.01 ECX the ticks are 0.0025 apart, and a fixed 2 decimals printed
  // "0.01 ECX" three times.
  const formatAxisFee = feeFormatter(
    maxDaily,
    axisCoinFormatter(maxDaily / 4),
    formatSatsCompact,
  );
  const axisLabel = (v: number) => {
    const text =
      metric === "bmm" ? formatInt(Math.round(Math.abs(v))) : formatAxisFee(Math.abs(v));
    return v < 0 ? `−${text}` : text;
  };

  const n = dates.length;
  const barW = plotW / n - BAR_GAP;

  // Gridlines: 25/50/75/100% of the max when everything is above zero (every
  // chart but a flows chart with withdrawals). With a down side, 50/100% of each
  // side's max plus a labelled zero line, so both halves read independently.
  const gridYs: { key: string; v: number; y: number; zero?: boolean }[] =
    maxDown === 0
      ? [0.25, 0.5, 0.75, 1].map((f) => ({
          key: `u${f}`,
          v: maxUp * f,
          y: zeroY - toH(maxUp * f),
        }))
      : [
          ...(maxUp > 0
            ? [0.5, 1].map((f) => ({ key: `u${f}`, v: maxUp * f, y: zeroY - toH(maxUp * f) }))
            : []),
          { key: "zero", v: 0, y: zeroY, zero: true },
          ...[0.5, 1].map((f) => ({ key: `d${f}`, v: -maxDown * f, y: zeroY + toH(maxDown * f) })),
        ];

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={copy.aria}
      >
        {/* gridlines — recessive, behind the data */}
        {gridYs.map((g) => (
          <g key={g.key}>
            <line
              x1={padL}
              x2={W - padR}
              y1={g.y}
              y2={g.y}
              stroke={g.zero ? "#525252" : "#262626"}
              strokeWidth={1}
            />
            <text
              x={W - 2}
              y={g.y + 3}
              textAnchor="end"
              className="fill-neutral-500"
              fontSize={FONT}
            >
              {g.zero ? "0" : axisLabel(g.v)}
            </text>
          </g>
        ))}

        {/* stacked bars, in fixed slot order, outward from the zero line */}
        {dates.map((date, i) => {
          const x = padL + i * (plotW / n) + BAR_GAP / 2;
          let yCursor = zeroY;
          let yDown = zeroY;
          return (
            <g key={date}>
              {stacked.map((st) => {
                const v = down(st.series[i]);
                if (v <= 0) return null;
                const h = toH(v);
                // Gap on the zero-line side, mirroring the up segments; a sliver
                // thinner than its minimum height stays inside its own slot.
                const drawH = Math.max(h - SEG_GAP, 0.75);
                const y = Math.max(yDown, yDown + h - drawH);
                yDown += h;
                return (
                  <rect
                    key={`d${st.chain.slot}`}
                    x={x}
                    y={y}
                    width={barW}
                    height={drawH}
                    rx={Math.min(SEG_RADIUS, drawH / 2)}
                    fill={st.chain.color}
                  >
                    <title>{`${st.chain.name} — ${date} — ${formatValue(v, "down")}`}</title>
                  </rect>
                );
              })}
              {stacked.map((st) => {
                const v = up(st.series[i]);
                if (v <= 0) return null;
                const h = toH(v);
                yCursor -= h;
                // Hold the gap out of the drawn height so neighbouring fills are
                // separated by surface, never by a colour boundary alone.
                const drawH = Math.max(h - SEG_GAP, 0.75);
                // A segment thinner than its minimum drawn height is lifted so
                // it stays inside its own slot, never poking below the baseline
                // or into the segment underneath.
                const y = Math.min(yCursor, yCursor + h - drawH);
                return (
                  <rect
                    key={st.chain.slot}
                    x={x}
                    y={y}
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
        {[...new Set([0, Math.floor(n / 2), n - 1])].map((i) => {
          // The first label starts at the plot edge rather than centring on its
          // bar, which would push it off the canvas on a narrow chart.
          const first = i === 0 && n > 1;
          const x = first ? padL : padL + i * (plotW / n) + barW / 2;
          return (
            <text
              key={i}
              x={x}
              y={H - 6}
              textAnchor={first ? "start" : "middle"}
              className="fill-neutral-500"
              fontSize={FONT}
            >
              {dates[i].slice(5)}
            </text>
          );
        })}
      </svg>

      {showLegend ? (
        <ChartLegend
          className="mt-3"
          chains={stacked.map((st) => st.chain)}
        />
      ) : null}

      <p className="mt-2 text-xs text-neutral-500">{copy.caption}</p>
    </div>
  );
}

/** Coin formatter for axis ticks `stepSats` apart: ≥2 decimals, more if needed. */
function axisCoinFormatter(stepSats: number): (sats: number) => string {
  const stepCoins = stepSats / SATS_PER_COIN;
  if (stepCoins >= 1) return formatCoinsCompact;
  const decimals = Math.min(8, Math.max(2, Math.ceil(-Math.log10(stepCoins)) + 1));
  return (sats) => formatCoins(sats, decimals);
}

/**
 * Legend — more series than direct labels can fit, so identity is carried here
 * rather than by colour alone. Same order as the stack (slot order), and the
 * text wears text tokens rather than the series colour. Shared by charts that
 * sit side by side, so it is exported on its own.
 */
export function ChartLegend({
  chains,
  className = "",
}: {
  chains: Drivechain[];
  className?: string;
}) {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1.5 ${className}`}>
      {[...chains]
        .sort((a, b) => a.slot - b.slot)
        .map((c) => (
          <li
            key={c.slot}
            className="flex items-center gap-1.5 text-xs text-neutral-400"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: c.color }}
            />
            {c.name}
          </li>
        ))}
    </ul>
  );
}
