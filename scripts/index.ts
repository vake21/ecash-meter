// Standalone block indexer. Runs where the node is reachable, reconciles the
// derived cache against the node's canonical chain (handling reorgs and refusing
// to mix networks), indexes new blocks, and persists them. The website reads
// purely from the DB, so it never touches the node.
//
//   npm run index         # reconcile + catch up to tip once
//
// Run it on a loop/cron for a periodically-fresh site. Idempotent and safe to
// re-run; the reconciliation core lives in lib/indexer.ts (unit-tested).

// Load .env.local FIRST so RPC/DB config is in the environment before anything
// reads it. lib/rpc.ts reads config lazily (per call), so import order is no
// longer load-bearing, but loading here keeps the documented workflow working.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — rely on defaults / real env
}

import { rpc, mapPool, getRpcConfig } from "../lib/rpc";
import { runIndexer } from "../lib/indexer";
import { closeDb } from "../lib/db";

async function main() {
  const startedAt = Date.now();

  // Nudge operators off the placeholder credentials.
  const cfg = getRpcConfig();
  if (cfg.usingDefaultCredentials) {
    console.warn(
      "[index] using default RPC credentials (user/password) — set " +
        "ECASH_RPC_USER / ECASH_RPC_PASS in .env.local for production.",
    );
  }

  const result = await runIndexer({
    rpc,
    mapPool,
    log: (msg) => console.log(msg),
  });

  if (result.status === "refused") {
    console.error(result.message);
    process.exitCode = 1;
    closeDb();
    return;
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.status === "up-to-date") {
    console.log(
      `[index] up to date — node tip ${result.toHeight}. Nothing to do.`,
    );
  } else {
    const reorg =
      result.reorgDepth && result.reorgDepth > 0
        ? `reorg pruned ${result.reorgDepth} block(s), then `
        : "";
    console.log(
      `[index] done in ${secs}s — ${reorg}inserted ${result.blocksInserted} ` +
        `block(s), ${result.commitmentsInserted} commitment(s). Stored tip now ${result.toHeight}.`,
    );
  }
  closeDb();
}

main().catch((err) => {
  console.error("[index] failed:", err);
  process.exitCode = 1;
});
