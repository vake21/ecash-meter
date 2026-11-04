import { getDashboardData } from "@/lib/node";
import { hasLogo, hasWallpaper, LOGO_FILE, WALLPAPER_FILE } from "@/lib/branding";
import { credit, learnLinks } from "@/lib/site-links";
import { computeFreshness } from "@/lib/freshness";
import { orderByCustody } from "@/lib/aggregate";
import type { PendingProposalView } from "@/lib/types";
import FeeChart, { ChartLegend, type ChartMetric } from "@/components/FeeChart";
import HeaderMotif from "@/components/HeaderMotif";
import { feeFormatter, formatCoins, formatInt, formatPct } from "@/lib/format";

// Data is read from the node at request time (behind a short TTL cache in the
// data layer), so don't prerender this route at build.
export const dynamic = "force-dynamic";


export default async function Home() {
  const data = await getDashboardData();
  const {
    stats,
    grandTotalFeesSats,
    grandTotalBmmCommitments,
    tipHeight,
    windowDays,
    blocksScanned,
    network,
    metric,
    note,
    lastBlockTime,
    activatedCount,
    totalTreasurySats,
    pendingProposals,
    avgBlockSeconds,
  } = data;
  const isBmm = metric === "bmm";
  // "Active" = merge-mined in the window. Activated-but-idle slots are listed
  // in the table but don't count here.
  const activeCount = stats.filter((r) => r.bmmCommitments > 0).length;
  const activeSub =
    activatedCount != null ? `of ${activatedCount} activated` : undefined;

  // Treasury column appears only when the data source tracks treasuries (the
  // DB path does; the live-scan and mock paths don't).
  const showTreasury = stats.some((r) => r.treasurySats !== undefined);

  // The charts sit side by side and share one legend (same colour per chain in
  // every chart). The legend lists each chain that appears in ANY of them.
  const charts: { metric: ChartMetric; title: string }[] = [
    ...(!isBmm ? [{ metric: "fees" as const, title: "Fees fed to L1" }] : []),
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

  // Data freshness (computed in the data layer, not during render): flag stale so
  // an old indexer's data is never silently presented as current.
  const { isStale, label: freshness } = computeFreshness(lastBlockTime);

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
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">
              {isBmm
                ? "Blind-merged-mining activity each BIP 301 drivechain commits to L1."
                : "Fees each BIP 301 drivechain feeds to L1 miners via blind-merged-mining bids."}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium ring-1 ${
                network === "mock"
                  ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
                  : "bg-brand/15 text-brand ring-brand/35"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  network === "mock" ? "bg-amber-400" : "bg-brand"
                }`}
              />
              {network === "mock" ? "MOCK DATA" : "LIVE · ECX MAINNET"}
            </span>
            <span className="rounded-full bg-white/[0.06] px-3 py-1.5 text-neutral-400 ring-1 ring-white/10">
              tip #{formatInt(tipHeight)}
            </span>
            {freshness ? (
              <span
                className={`rounded-full px-3 py-1.5 font-medium ring-1 ${
                  isStale
                    ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
                    : "bg-white/[0.06] text-neutral-400 ring-white/10"
                }`}
                title={`Latest indexed block time: ${new Date(
                  (lastBlockTime ?? 0) * 1000,
                ).toISOString()}`}
              >
                {isStale ? "stale · " : "updated "}
                {freshness}
              </span>
            ) : null}
          </div>
        </header>

        {note ? (
          <div className="mb-6 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200/90">
            {note}
          </div>
        ) : null}

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

        {/* charts — a 2×2 grid, same dates on every x-axis, same colour per
            drivechain, one shared legend */}
        <section className="mb-10">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              Last {windowDays} {windowDays === 1 ? "day" : "days"}
            </h2>
            <ChartLegend chains={legendChains} />
          </div>
          {/* 2×2 on wide screens; one column on narrow ones. */}
          <div className="grid gap-5 md:grid-cols-2">
            {charts.map((c) => (
              <ChartPanel key={c.metric} title={c.title}>
                <FeeChart
                  stats={stats}
                  windowDays={windowDays}
                  metric={c.metric}
                  showLegend={false}
                />
              </ChartPanel>
            ))}
          </div>
        </section>

        {/* drivechain table, ordered by ECX custodied */}
        <section className="panel rounded-2xl">
          <h2 className="px-6 pb-1 pt-6 text-base font-semibold tracking-tight text-neutral-100">
            Drivechains
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
                    Fees to L1
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
                          <div className="font-medium text-neutral-100">
                            {r.chain.name}{" "}
                            <span className="text-neutral-500">
                              ({r.chain.ticker})
                            </span>
                          </div>
                          <div className="text-xs text-neutral-500">
                            {r.chain.description}
                          </div>
                          {r.activated && r.bmmCommitments === 0 ? (
                            <div className="mt-1 text-[11px] text-neutral-500">
                              Activated · no BMM blocks in the last {windowDays}{" "}
                              {windowDays === 1 ? "day" : "days"}
                            </div>
                          ) : null}
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
        {pendingProposals !== undefined ? (
          <PendingProposals
            proposals={pendingProposals}
            avgBlockSeconds={avgBlockSeconds}
          />
        ) : null}

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
          <p className="text-center text-xs text-neutral-600">
            {network === "mock"
              ? "Mockup with placeholder data · numbers are illustrative until wired to a live eCash node."
              : `Live from eCash (ECX) mainnet · scanned ${formatInt(
                  blocksScanned,
                )} blocks up to tip #${formatInt(tipHeight)}.`}
          </p>

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
      </div>
    </main>
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
  return (
    <section className="panel mt-10 rounded-2xl">
      <div className="px-6 pb-1 pt-6">
        <h2 className="text-base font-semibold tracking-tight text-neutral-100">
          Pending activation
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Sidechain proposals collecting miner votes (BIP 300). A proposal for a
          slot that is already in use would replace — deactivate — the
          sidechain there.
        </p>
      </div>
      {proposals === null ? (
        <p className="px-6 pb-6 pt-3 text-sm text-neutral-400">
          Unknown — the indexed history doesn&apos;t reach back to the ECX fork,
          so proposal votes can&apos;t be counted.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-6 pb-6 pt-3 text-sm text-neutral-400">
          No sidechain proposals are collecting votes right now.
        </p>
      ) : (
        <div className="overflow-x-auto px-3 pb-3 pt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-neutral-500">
                <th className="px-3 py-2 text-right font-medium">Slot</th>
                <th className="px-3 py-2 font-medium">Proposed sidechain</th>
                <th className="px-3 py-2 text-right font-medium">Votes</th>
                <th className="px-3 py-2 text-right font-medium">Proposed</th>
                <th className="px-3 py-2 text-right font-medium">
                  Voting window
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const progress = Math.min(p.votes / p.votesNeeded, 1);
                const left = approxDuration(p.blocksLeft, avgBlockSeconds);
                return (
                  <tr
                    key={`${p.slot}-${p.proposalHeight}`}
                    className="border-t border-white/[0.06] transition-colors hover:bg-white/[0.035]"
                  >
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-400">
                      {p.slot}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-neutral-100">
                          {p.name}
                        </span>
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
                      {p.description ? (
                        <div className="mt-0.5 text-xs text-neutral-500">
                          {p.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="tabular-nums text-neutral-100">
                        {formatInt(p.votes)}
                        <span className="text-neutral-500">
                          {" "}
                          / {formatInt(p.votesNeeded)}
                        </span>
                      </div>
                      <div
                        className="ml-auto mt-1.5 h-1.5 w-24 overflow-hidden rounded-full bg-neutral-800"
                        role="img"
                        aria-label={`${formatPct(progress, 0)} of the votes needed`}
                      >
                        <span
                          className="block h-full rounded-full bg-brand"
                          style={{ width: `${Math.max(progress * 100, 2)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-300">
                      #{formatInt(p.proposalHeight)}
                      <div className="text-xs text-neutral-500">
                        {formatInt(p.age)} blocks ago
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-300">
                      {formatInt(p.blocksLeft)} blocks left
                      {left ? (
                        <div className="text-xs text-neutral-500">{left}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
