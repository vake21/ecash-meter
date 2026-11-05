import Link from "next/link";
import { loadDashboard } from "@/lib/dashboard";
import { parseWindowDays, WINDOW_OPTIONS, type WindowDays } from "@/lib/config";
import { hasLogo, hasWallpaper, LOGO_FILE, WALLPAPER_FILE } from "@/lib/branding";
import { credit, explorerUrl, learnLinks } from "@/lib/site-links";
import { getRecentActivity, DEFAULT_ACTIVITY_LIMIT } from "@/lib/activity";
import ActivityFeed from "@/components/ActivityFeed";
import SidechainName from "@/components/SidechainName";
import PreActivationBmm from "@/components/PreActivationBmm";
import { computeFreshness } from "@/lib/freshness";
import { orderByCustody } from "@/lib/aggregate";
import type { PendingProposalView } from "@/lib/types";
import FeeChart, { ChartLegend, type ChartMetric } from "@/components/FeeChart";
import HeaderMotif from "@/components/HeaderMotif";
import { feeFormatter, formatCoins, formatInt, formatPct } from "@/lib/format";

// Reads the SQLite store on every request (never the node), so don't prerender
// this route at build.
export const dynamic = "force-dynamic";


export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // Reporting window from ?window=7|30 (anything else → the default). Every
  // window-dependent figure follows it: cards, charts and the table's columns.
  const selectedWindow = parseWindowDays((await searchParams)?.window);
  const dashboard = await loadDashboard(process.env, selectedWindow);

  // No figures at all when the store can't be trusted: no totals, charts,
  // rankings or activity — and never demo data in their place. The reason goes
  // to the server log and /api/health, not to the public page.
  if (dashboard.kind === "unavailable") {
    return (
      <PageShell badges={<StatusBadge tone="warn" label="DATA UNAVAILABLE" />}>
        <section className="panel rounded-2xl px-6 py-14 text-center">
          <h2 className="text-xl font-semibold tracking-tight text-neutral-100">
            Data temporarily unavailable
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-neutral-400">
            The meter&apos;s saved eCash mainnet data can&apos;t be shown right
            now. Figures will return once the data store is available again.
          </p>
        </section>
        <SiteFooter note="No figures are shown while the data store is unavailable." />
      </PageShell>
    );
  }

  const isDemo = dashboard.kind === "demo";
  // First page of the activity feed, rendered with the page; the feed then
  // polls /api/activity for anything newer.
  const activity = isDemo ? null : getRecentActivity(DEFAULT_ACTIVITY_LIMIT);
  const data = dashboard.data;
  const {
    stats,
    grandTotalFeesSats,
    grandTotalBmmCommitments,
    tipHeight,
    windowDays,
    blocksScanned,
    metric,
    note,
    lastBlockTime,
    activatedCount,
    totalTreasurySats,
    pendingProposals,
    preActivationBmm,
    avgBlockSeconds,
  } = data;
  // Shown only when something has merge-mined a slot that wasn't activated.
  const showPreActivation = (preActivationBmm?.length ?? 0) > 0;
  const showSideColumn = pendingProposals !== undefined || showPreActivation;
  const isBmm = metric === "bmm";
  // "Active" = merge-mined in the window. Activated-but-idle slots are listed
  // in the table but don't count here.
  const activeCount = stats.filter((r) => r.bmmCommitments > 0).length;
  const activeSub =
    activatedCount != null ? `of ${activatedCount} activated` : undefined;

  // Treasury column appears only when the data tracks treasuries (saved data
  // does; the demo dataset doesn't).
  const showTreasury = stats.some((r) => r.treasurySats !== undefined);

  // The charts sit side by side and share one legend (same colour per chain in
  // every chart). The legend lists each chain that appears in ANY of them.
  const charts: { metric: ChartMetric; title: string }[] = [
    ...(!isBmm ? [{ metric: "fees" as const, title: "Estimated fees to L1" }] : []),
    { metric: "bmm", title: "BMM blocks" },
    ...(showTreasury
      ? [
          { metric: "treasury" as const, title: "ECX held" },
          { metric: "flows" as const, title: "Deposits and withdrawals" },
        ]
      : []),
  ];
  // The table is ordered by ECX custodied, largest first, so it re-sorts itself
  // as balances change. (The cards and charts keep the headline ranking.)
  const tableRows = orderByCustody(stats);

  const legendChains = stats
    .filter((r) =>
      r.series.some(
        (p) =>
          p.bmmCount > 0 ||
          p.feeSats > 0 ||
          (p.treasurySats ?? 0) > 0 ||
          (p.depositSats ?? 0) > 0 ||
          (p.withdrawalSats ?? 0) > 0,
      ),
    )
    .map((r) => r.chain);

  // Fee amounts pick their unit per group, so satoshi-scale totals show as sats
  // rather than rounding away to "0.00 BTC". The two tiles key off the window
  // total so they always agree; the table column keys off its own largest row.
  const formatTileFee = feeFormatter(grandTotalFeesSats, (s) =>
    formatCoins(s, 2),
  );
  const formatRowFee = feeFormatter(
    Math.max(0, ...stats.map((r) => r.totalFeesSats)),
  );

  // How recently the data was updated (the latest indexed block's age), shown
  // as a neutral "updated 12m ago". The page deliberately doesn't call data
  // stale or out of date; /api/health is where staleness is reported, for
  // monitoring. Demo data has no real block time, so no age either.
  const freshness = isDemo ? null : computeFreshness(lastBlockTime).label;
  // The saved data's latest block, as a fixed UTC stamp ("2026-11-04 20:01 UTC").
  const blockStamp =
    !isDemo && lastBlockTime != null
      ? new Date(lastBlockTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC"
      : null;

  const badges = isDemo ? (
    <StatusBadge tone="demo" label="DEMO — SAMPLE DATA" />
  ) : (
    <>
      <StatusBadge tone="saved" label="SAVED · ECX MAINNET DATA" />
      <span className="rounded-full bg-white/[0.06] px-3 py-1.5 text-neutral-400 ring-1 ring-white/10">
        block #{formatInt(tipHeight)}
        {blockStamp ? ` · ${blockStamp}` : ""}
      </span>
      {freshness ? (
        <span className="rounded-full bg-white/[0.06] px-3 py-1.5 text-neutral-400 ring-1 ring-white/10">
          updated {freshness}
        </span>
      ) : null}
    </>
  );

  return (
    <PageShell badges={badges}>
      {isDemo ? (
        <div
          role="note"
          className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          <strong className="font-semibold">DEMO — SAMPLE DATA.</strong> Every
          figure on this page is invented for demonstration. None of it comes
          from the eCash chain.
        </div>
      ) : null}

        {note ? (
          <div className="mb-6 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200/90">
            {note}
          </div>
        ) : null}

        <WindowSelector selected={selectedWindow} shownDays={windowDays} />

        {/* summary cards */}
        <section className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {isBmm ? (
            <>
              <StatCard
                label={`BMM commitments (${windowDays}d)`}
                value={formatInt(grandTotalBmmCommitments)}
              />
              <StatCard
                label="Blocks scanned"
                value={formatInt(blocksScanned)}
              />
              <StatCard
                label="Active drivechains"
                value={String(activeCount)}
                sub={activeSub}
              />
              <StatCard
                label="Most active"
                value={stats[0]?.chain.name ?? "—"}
                sub={
                  stats[0]
                    ? formatPct(stats[0].shareOfTotal) + " of commitments"
                    : ""
                }
              />
            </>
          ) : (
            <>
              <StatCard
                label={`Total fees (${windowDays}d)`}
                value={formatTileFee(grandTotalFeesSats)}
              />
              <StatCard
                label="Fees last 24h"
                value={formatTileFee(
                  stats.reduce((s, r) => s + r.feesLast24hSats, 0),
                )}
              />
              <StatCard
                label="Active drivechains"
                value={String(activeCount)}
                sub={activeSub}
              />
              <StatCard
                label="Top contributor"
                value={stats[0]?.chain.name ?? "—"}
                sub={
                  stats[0] ? formatPct(stats[0].shareOfTotal) + " of fees" : ""
                }
              />
            </>
          )}
        </section>

        {/* charts — a horizontally scrolling row, same dates on every x-axis, same colour per
            drivechain, one shared legend */}
        <section className="mb-10">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              Last {windowDays} {windowDays === 1 ? "day" : "days"}
            </h2>
            <ChartLegend chains={legendChains} />
          </div>
          {/* One row that scrolls sideways. Each chart has a fixed width, so
              the next one peeks in at the right edge — the cue that there is
              more — and scroll-snap lands every swipe on a chart's left edge.
              The strip bleeds into the page gutter (-mx-6 px-6) so a chart
              can scroll all the way to the edge rather than clipping early.
              It is focusable, so the arrow keys scroll it too. */}
          <div
            role="region"
            aria-label="Charts — scroll sideways for more"
            tabIndex={0}
            className="-mx-6 snap-x snap-mandatory scroll-px-6 overflow-x-auto px-6 pb-3 [scrollbar-color:#404040_transparent] [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <div className="flex gap-5">
              {charts.map((c) => (
                <div
                  key={c.metric}
                  className="w-[min(85vw,30rem)] shrink-0 snap-start"
                >
                  <ChartPanel title={c.title}>
                    <FeeChart
                      stats={stats}
                      windowDays={windowDays}
                      metric={c.metric}
                      showLegend={false}
                    />
                  </ChartPanel>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Drivechains table with Pending activation beside it on wide screens
            (stacked below lg). The table takes the flexible width; the
            proposals get a fixed narrow column. */}
        <div
          className={
            showSideColumn
              ? "grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]"
              : ""
          }
        >
        {/* drivechain table, ordered by ECX custodied */}
        <section className="panel rounded-2xl">
          <h2 className="px-6 pb-1 pt-6 text-base font-semibold tracking-tight text-neutral-100">
            Activated Drivechains
          </h2>
          <div className="overflow-x-auto px-3 pb-3 pt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-neutral-500">
                  <th className="px-3 py-2 text-right font-medium">Slot</th>
                  <th className="px-3 py-2 font-medium">Drivechain</th>
                  <th className="px-3 py-2 text-right font-medium">
                    BMM blocks
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    Estimated fees to L1
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Share</th>
                  {showTreasury ? (
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title="ECX currently held in the sidechain's L1 treasury output"
                    >
                      In sidechain
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr
                    key={r.chain.slot}
                    className="border-t border-white/[0.06] transition-colors hover:bg-white/[0.035]"
                  >
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-400">
                      {r.chain.slot}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: r.chain.color }}
                        />
                        <div>
                          {/* Description on hover / tap, not inline. */}
                          <div className="font-medium text-neutral-100">
                            <SidechainName
                              name={r.chain.name}
                              description={r.chain.description}
                            />{" "}
                            <span className="text-neutral-500">
                              ({r.chain.ticker})
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-medium tabular-nums">
                      {formatInt(r.bmmCommitments)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-300">
                      {r.totalFeesSats > 0 ? formatRowFee(r.totalFeesSats) : "—"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="tabular-nums text-neutral-300">
                          {r.shareOfTotal > 0 ? formatPct(r.shareOfTotal) : "—"}
                        </span>
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-800">
                          {r.shareOfTotal > 0 ? (
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${Math.max(r.shareOfTotal * 100, 2)}%`,
                                backgroundColor: r.chain.color,
                              }}
                            />
                          ) : null}
                        </span>
                      </div>
                    </td>
                    {showTreasury ? (
                      <td className="px-3 py-3 text-right tabular-nums text-neutral-100">
                        <TreasuryCell sats={r.treasurySats} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              {showTreasury && totalTreasurySats !== undefined ? (
                <tfoot>
                  <tr className="border-t border-white/[0.12] text-neutral-400">
                    <td className="px-3 py-3 text-xs font-medium uppercase tracking-[0.08em]" colSpan={5}>
                      Total held by drivechains
                    </td>
                    <td className="px-3 py-3 text-right font-medium tabular-nums text-neutral-100">
                      <TreasuryCell sats={totalTreasurySats} />
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </section>

        {/* pending proposals — only where the data source tracks them */}
        {showSideColumn ? (
          <div className="grid gap-6">
            {pendingProposals !== undefined ? (
              <PendingProposals
                proposals={pendingProposals}
                avgBlockSeconds={avgBlockSeconds}
              />
            ) : null}
            {showPreActivation ? <PreActivationBmm rows={preActivationBmm!} /> : null}
          </div>
        ) : null}
        </div>

        {/* live activity feed — real (saved) data only; the browser keeps it fresh */}
        {!isDemo && activity?.ok ? (
          <ActivityFeed
            initialEvents={activity.events}
            limit={DEFAULT_ACTIVITY_LIMIT}
            explorerUrl={explorerUrl}
          />
        ) : null}

      <SiteFooter
        note={
          isDemo
            ? "DEMO — SAMPLE DATA · every figure on this page is invented for demonstration."
            : `Saved eCash (ECX) mainnet data · ${formatInt(blocksScanned)} blocks indexed, up to block #${formatInt(tipHeight)}${blockStamp ? ` mined ${blockStamp}` : ""}.`
        }
      />
    </PageShell>
  );
}

/**
 * A treasury balance. Four decimals, not two: a sidechain can hold well under
 * 0.01 ECX, and rounding that to "0.00" would read as empty.
 */
function TreasuryCell({ sats }: { sats: number | null | undefined }) {
  if (sats === undefined) return <span className="text-neutral-600">—</span>;
  if (sats === null)
    return (
      <span
        className="text-neutral-500"
        title="The indexed history doesn't reach back to this sidechain's activation, so its balance can't be derived. Rebuild the store from the ECX fork."
      >
        unknown
      </span>
    );
  return <>{formatCoins(sats, 4)}</>;
}

/** Rough duration of `blocks` L1 blocks, e.g. "≈ 1.4 days" / "≈ 6 h". */
function approxDuration(blocks: number, avgBlockSeconds?: number): string | null {
  if (!avgBlockSeconds || blocks <= 0) return null;
  const hours = (blocks * avgBlockSeconds) / 3600;
  return hours >= 48 ? `≈ ${(hours / 24).toFixed(1)} days` : `≈ ${Math.round(hours)} h`;
}

/**
 * Sidechain proposals still collecting miner votes, by slot. A proposal on an
 * empty slot would activate a new sidechain; one on an occupied slot would
 * replace (deactivate) the sidechain there, and needs far more votes.
 */
function PendingProposals({
  proposals,
  avgBlockSeconds,
}: {
  proposals: PendingProposalView[] | null;
  avgBlockSeconds?: number;
}) {
  const rows = [...(proposals ?? [])].sort(
    (a, b) => a.slot - b.slot || a.proposalHeight - b.proposalHeight,
  );
  // A compact list rather than a table: it sits in a narrow column beside the
  // Drivechains table, where five table columns wouldn't fit.
  return (
    <section className="panel rounded-2xl">
      <div className="px-5 pb-1 pt-6">
        <h2 className="text-base font-semibold tracking-tight text-neutral-100">
          Pending activation
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          Sidechain proposals collecting miner votes (BIP 300). One for a slot
          already in use would replace — deactivate — the sidechain there.
        </p>
      </div>
      {proposals === null ? (
        <p className="px-5 pb-6 pt-3 text-sm text-neutral-400">
          Unknown — the indexed history doesn&apos;t reach back to the ECX fork,
          so proposal votes can&apos;t be counted.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-6 pt-3 text-sm text-neutral-400">
          No sidechain proposals are collecting votes right now.
        </p>
      ) : (
        <ul className="px-2 pb-2 pt-2">
          {rows.map((p) => {
            const progress = Math.min(p.votes / p.votesNeeded, 1);
            const left = approxDuration(p.blocksLeft, avgBlockSeconds);
            return (
              <li
                key={`${p.slot}-${p.proposalHeight}`}
                className="rounded-xl border-t border-white/[0.06] px-3 py-3.5 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-xs tabular-nums text-neutral-500">
                    slot {p.slot}
                  </span>
                  <SidechainName
                    name={p.name}
                    description={p.description}
                    className="font-medium text-neutral-100"
                  />
                  {p.replaces ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/30">
                      Replaces {p.replaces}
                    </span>
                  ) : (
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-neutral-400 ring-1 ring-white/10">
                      New slot
                    </span>
                  )}
                </div>
                <div className="mt-2.5 flex items-baseline justify-between text-xs">
                  <span className="text-neutral-500">Votes</span>
                  <span className="tabular-nums text-neutral-100">
                    {formatInt(p.votes)}
                    <span className="text-neutral-500"> / {formatInt(p.votesNeeded)}</span>
                  </span>
                </div>
                <div
                  className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
                  role="img"
                  aria-label={`${formatPct(progress, 0)} of the votes needed`}
                >
                  <span
                    className="block h-full rounded-full bg-brand"
                    style={{ width: `${Math.max(progress * 100, 2)}%` }}
                  />
                </div>

                <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums text-neutral-500">
                  <span>
                    proposed #{formatInt(p.proposalHeight)} · {formatInt(p.age)} blocks ago
                  </span>
                  <span>
                    {formatInt(p.blocksLeft)} blocks left{left ? ` (${left})` : ""}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ChartPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel rounded-2xl p-5">
      <h3 className="mb-3 text-sm font-semibold tracking-tight text-neutral-100">
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="panel panel-hover rounded-2xl p-5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </div>
      {/* Proportional figures, not tabular — equal-width digits read loose at
          display sizes. `tabular-nums` stays on the table, where numbers align
          vertically and need to. */}
      <div className="mt-2.5 text-2xl font-semibold tracking-tight text-neutral-50 sm:text-3xl">
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-xs text-neutral-500">{sub}</div> : null}
    </div>
  );
}

/**
 * Choose the reporting window. Plain links to ?window=N, so the server renders
 * the chosen window (no client JS needed) and a view can be bookmarked; Next's
 * <Link> swaps the page in place without losing the scroll position. When the
 * stored history is shorter than the chosen window, says so instead of
 * implying a full window.
 */
function WindowSelector({
  selected,
  shownDays,
}: {
  selected: WindowDays;
  shownDays: number;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-3 text-xs">
      {shownDays < selected ? (
        <span className="text-neutral-500">
          Only {shownDays} {shownDays === 1 ? "day" : "days"} of history so far
        </span>
      ) : null}
      <nav
        aria-label="Time window"
        className="inline-flex rounded-full bg-white/[0.06] p-1 ring-1 ring-white/10"
      >
        {WINDOW_OPTIONS.map((days) => {
          const active = days === selected;
          return (
            <Link
              key={days}
              href={`?window=${days}`}
              scroll={false}
              aria-current={active ? "true" : undefined}
              className={`rounded-full px-3 py-1 font-medium transition-colors ${
                active
                  ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                  : "text-neutral-400 hover:text-neutral-100"
              }`}
            >
              {days} days
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Header status pill. Tone: saved data, demo data, or no data. */
function StatusBadge({
  tone,
  label,
}: {
  tone: "saved" | "demo" | "warn";
  label: string;
}) {
  const styles =
    tone === "saved"
      ? ["bg-brand/15 text-brand ring-brand/35", "bg-brand"]
      : ["bg-amber-500/15 text-amber-300 ring-amber-500/30", "bg-amber-400"];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium ring-1 ${styles[0]}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${styles[1]}`} />
      {label}
    </span>
  );
}

/**
 * The page frame: ambient background, header with the wordmark, and a slot for
 * the status badges. Shared by the data, demo and unavailable views.
 */
function PageShell({
  badges,
  children,
}: {
  badges: React.ReactNode;
  children: React.ReactNode;
}) {
  // `isolate` on <main> is load-bearing: without a stacking context there, the
  // ambient layer (z-index -10) joins the ROOT stacking context and main's
  // opaque bg-neutral-950 paints straight over it, hiding the wallpaper.
  return (
    <main className="relative isolate min-h-screen bg-neutral-950 text-neutral-100">
      {/* Page-level ambient wash, fixed so it stays put while the page scrolls.
          Sits behind everything and never intercepts pointer events.

          Layers paint first-listed on top. The brand gradients sit ABOVE the
          scrim so they keep tinting the page, while the scrim dims only the
          wallpaper beneath it. The scrim is bottom-weighted on the assumption
          that artwork is darkest at the top, which is where the header sits and
          where a bright band would do the most damage to legibility.

          With no wallpaper present the gradients alone are the background, and
          the scrim is dropped — it exists only to tame the image. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background: [
            "radial-gradient(1100px 520px at 12% -8%, rgba(25,158,112,0.13), transparent 62%)",
            "radial-gradient(900px 460px at 88% -4%, rgba(201,133,0,0.07), transparent 58%)",
            ...(hasWallpaper
              ? [
                  "linear-gradient(to bottom, rgba(10,10,10,0.30), rgba(10,10,10,0.58) 45%, rgba(10,10,10,0.80))",
                  `url('/${WALLPAPER_FILE}') center center / cover no-repeat`,
                ]
              : []),
          ].join(","),
        }}
      />
      <div className="mx-auto max-w-6xl px-6 py-12 sm:py-14">
        {/* header */}
        <header className="relative isolate mb-10 flex flex-wrap items-end justify-between gap-5 pb-4">
          <HeaderMotif />
          <div>
            {/* When a logo is supplied its wordmark IS the name, so the image
                carries the h1's accessible name rather than repeating it as text
                beside it. With no logo the h1 is the wordmark.

                A plain <img> rather than next/image on purpose: the file is
                deployer-supplied with unknown dimensions, and next/image needs
                width/height up front for a non-imported source. Letting the
                browser use the file's real intrinsic ratio is correct for any
                asset, and it keeps sharp off the server's runtime path. */}
            <h1>
              {hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/${LOGO_FILE}`}
                  alt="eCash Meter"
                  className="h-12 w-auto sm:h-14"
                />
              ) : (
                <span className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
                  eCash Meter
                </span>
              )}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {badges}
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

/** Footer: further-reading links, a status line, and the optional credit. */
function SiteFooter({ note }: { note: string }) {
  return (
    <footer className="mt-12 border-t border-white/[0.07] pt-7">
          {/* Further reading — supplied per deployment via site.local.json, so a
              fork ships with no external links at all. */}
          {learnLinks.length > 0 ? (
            <nav
              aria-label="Learn"
              className="mb-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
            >
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
                Learn
              </span>
              {learnLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-neutral-400 transition-colors hover:text-brand"
                >
                  {l.label}
                  <span aria-hidden="true" className="ml-1 text-brand">
                    ↗
                  </span>
                </a>
              ))}
            </nav>
          ) : null}
          <p className="text-center text-xs text-neutral-600">{note}</p>

          {/* Optional "project of X" credit, also from site.local.json. */}
          {credit ? (
            <a
              href={credit.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 flex items-center justify-center gap-3 text-sm text-neutral-400 transition-colors hover:text-neutral-200"
            >
              {credit.hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/${credit.logo}`}
                  alt=""
                  aria-hidden="true"
                  className="h-9 w-9 rounded-[7px] ring-1 ring-white/10"
                />
              ) : null}
              {credit.label}
              <span aria-hidden="true" className="text-brand">
                ↗
              </span>
            </a>
          ) : null}
    </footer>
  );
}
