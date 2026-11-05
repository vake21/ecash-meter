import { loadDashboard } from "@/lib/dashboard";
import { computeFreshness, STALE_AFTER_SEC } from "@/lib/freshness";
import { PARSER_VERSION } from "@/lib/bmm";
import { ECX_FORK_BLOCK_HASH } from "@/lib/config";

// Never cache: the point of this route is to report the store's state right now.
export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe for monitoring and for the deploy runbook.
 *
 * It asks the SAME loader the page uses (lib/dashboard.ts), so it can never
 * disagree with what visitors see. `dashboard` says what the page is showing:
 *   "saved"        real ECX mainnet data from the store
 *   "unavailable"  "Data temporarily unavailable", no figures
 *   "demo"         sample data, because ECASH_DEMO=1 is set
 *
 * Like the page it is DB-only and never calls the node, so a failure here means
 * "the site cannot serve current real data", not "the node is briefly down".
 *
 * 200 only for fresh, validated saved data. Everything else is 503 so an uptime
 * check alerts: an unavailable store, demo mode (sample data must never pass as
 * healthy), and STALE saved data — the page still shows it, labelled as saved
 * and stale, but a wedged indexer is exactly what monitoring must catch.
 *
 * The response is public, so it carries reason codes and safe values (stored vs
 * expected fork hash and parser version) but never file paths or error text;
 * those go to the server log.
 */
export async function GET() {
  const d = await loadDashboard();

  if (d.kind === "demo") {
    return Response.json(
      {
        status: "demo",
        dashboard: "demo",
        detail: "ECASH_DEMO=1 is set: the site is serving sample data, not ECX mainnet data.",
      },
      { status: 503 },
    );
  }

  if (d.kind === "unavailable") {
    return Response.json(
      {
        status: d.reason,
        dashboard: "unavailable",
        detail: d.detail,
        ...(d.stored ? { stored: d.stored, expected: d.expected } : {}),
      },
      { status: 503 },
    );
  }

  const s = d.summary;
  const { ageSec, isStale } = computeFreshness(s.lastBlockTime);
  return Response.json(
    {
      status: isStale ? "stale" : "ok",
      dashboard: "saved",
      network: s.network,
      tipHeight: s.tipHeight,
      blocks: s.blocks,
      commitments: s.commitments,
      lastBlockTime: s.lastBlockTime,
      ageSec,
      staleAfterSec: STALE_AFTER_SEC,
      parserVersion: { stored: s.parserVersion, expected: PARSER_VERSION },
      chain: { stored: s.forkBlockHash, expected: ECX_FORK_BLOCK_HASH },
    },
    { status: isStale ? 503 : 200 },
  );
}
