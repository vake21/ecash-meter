import { get, getMeta } from "@/lib/db";
import { computeFreshness, STALE_AFTER_SEC } from "@/lib/freshness";
import { PARSER_VERSION } from "@/lib/bmm";
import { ECX_FORK_BLOCK_HASH } from "@/lib/config";

// Never cache: the point of this route is to report the store's state right now.
export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe for monitoring and for the deploy runbook.
 *
 * Deliberately DB-only, exactly like the page reader — it must not call the node,
 * so a probe failure means "the site cannot serve real data", not "bitcoind is
 * briefly down". Returns 200 when the store is fresh, 503 otherwise, so an uptime
 * check catches a wedged indexer rather than only a hard crash.
 */
export async function GET() {
  try {
    const row = get<{ tip: number | null; blocks: number; last: number | null }>(
      "SELECT MAX(height) AS tip, COUNT(*) AS blocks, MAX(time) AS last FROM blocks",
    );
    const commitments =
      get<{ n: number }>("SELECT COUNT(*) AS n FROM commitments")?.n ?? 0;

    if (!row || row.blocks === 0 || row.last === null) {
      return Response.json(
        { status: "empty", detail: "store has no indexed blocks yet" },
        { status: 503 },
      );
    }

    const lastBlockTime = Number(row.last);
    const { ageSec, isStale } = computeFreshness(lastBlockTime);
    const storedParser = Number(getMeta("parser_version") ?? 0);

    // A parser-version mismatch means the indexer will refuse to append, so the
    // store is frozen even though nothing has crashed. Surface it as unhealthy.
    const parserMismatch = storedParser !== PARSER_VERSION;

    // Chain identity, for the same reason: a store built from anything other
    // than ECX is frozen (the indexer refuses to append to it) and is serving
    // data from the wrong chain. Checked here so monitoring reports it directly
    // instead of waiting for the data to go stale. A missing stamp counts as a
    // mismatch — it predates identity stamping, or carries only the old
    // genesis-based identity, which could not tell ECX from Bitcoin.
    const storedFork = getMeta("fork_block_hash");
    const chainMismatch = storedFork !== ECX_FORK_BLOCK_HASH;

    const body = {
      status: chainMismatch
        ? "chain-mismatch"
        : parserMismatch
          ? "parser-mismatch"
          : isStale
            ? "stale"
            : "ok",
      network: getMeta("network"),
      tipHeight: Number(row.tip),
      blocks: Number(row.blocks),
      commitments,
      lastBlockTime,
      ageSec,
      staleAfterSec: STALE_AFTER_SEC,
      parserVersion: { stored: storedParser, expected: PARSER_VERSION },
      chain: { stored: storedFork, expected: ECX_FORK_BLOCK_HASH },
    };

    return Response.json(body, {
      status: isStale || parserMismatch || chainMismatch ? 503 : 200,
    });
  } catch (err) {
    // Unreadable/missing DB file, or schema not yet created.
    return Response.json(
      {
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
