# eCash Meter

A dashboard that tracks how much each BIP 300/301 **drivechain** (sidechain) commits to
the **eCash (ECX)** mainchain via blind-merged-mining (BMM) — both the per-chain BMM
activity and the fees fed to L1 miners.

> **eCash / ECX** here means the 2026 Bitcoin hard fork that activates BIP 300/301,
> forking from Bitcoin's ledger at block 973,728 — **not** the 2021 Bitcoin Cash
> spinoff (XEC).

This project targets **ECX mainnet and nothing else**. It does not support, and will
refuse to index, any other chain — see *Chain identity* below.

## How it works

```
eCash node  →  npm run index  →  SQLite (.data/ecash-meter.sqlite)  →  Next.js site
ECX mainnet     block indexer        history store                     reads the DB
```

- **Indexer** (`scripts/index.ts`) scans new L1 blocks, parses each coinbase's BMM
  commitments (one `OP_RETURN` per merge-mined slot) and BIP 300 sidechain proposals and
  acks, records every sidechain treasury output (`OP_DRIVECHAIN <slot> OP_TRUE`) and every
  spend of one, and stores them. It resumes from the
  highest block already stored, so re-running only fetches what's new.
- **Store** is a single SQLite file via Node's built-in `node:sqlite` — no database server.
- **Site** reads purely from the store, so it renders even when the node is offline.

The dashboard shows **every slot it observes being merge-mined, plus every slot activated
on ECX** (even one with no BMM blocks yet), resolving each against a table of published
sidechain metadata (`lib/config.ts`) and synthesizing an entry for any slot that table
does not name. A hardcoded slate must never be able to hide real on-chain activity.
Which slots are activated — and which proposals are still collecting votes, listed under
**Pending activation** — is replayed from the BIP 300 proposal (M1) and ack (M2) messages
in each coinbase (`lib/proposals.ts`), using the enforcer's own rules and ECX's
thresholds: a proposal for an empty slot activates with more than 1,815 acks within
2,016 blocks; one for an occupied slot needs more than 6,048 within 12,096 and would
replace (deactivate) the sidechain there. This needs the store to reach back to the ECX
fork; a shallower store falls back to the activation heights in `lib/config.ts` and shows
pending proposals as unknown.

**In sidechain** is the ECX each activated sidechain currently holds on L1: the value of
its current treasury output. Every deposit and withdrawal spends that output and creates
its successor, so the site replays the stored treasury events in chain order
(`lib/treasury.ts`), accepting a new output only if it spends the current one — the same
rule the enforcer applies, so look-alike outputs can't inflate a balance. This needs the
store to reach back to each slot's activation; if it doesn't, the balance shows as
"unknown" rather than a wrong number.

The headline metric follows the data: **fees to L1** whenever the window contains a paid
BMM bid, falling back to **BMM commitment count** when commitments exist but none paid a
fee.

## Chain identity

ECX forks from Bitcoin's ledger, so it **inherits Bitcoin's genesis block** and reports
`chain: "main"` from `getblockchaininfo`. Neither signal can tell an ECX node apart from a
Bitcoin node, or from any other fork of the same ledger.

The discriminator is the **first post-fork block**: the fork resets difficulty, so block
973,728 is unique to ECX. The indexer checks the node's hash at that height against
`ECX_FORK_BLOCK_HASH` and refuses to run against anything else, and it stamps that hash
into the store so a database can never be fed blocks from a different chain.

## Getting started

Requires **Node ≥ 22** (uses the built-in `node:sqlite`) and, for live data, a synced
eCash node serving mainnet JSON-RPC on `127.0.0.1:8532`.

The node must be eCash's own build — get it from
[releases.ecash.com](https://releases.ecash.com/) (`L1-ecash-bitcoin`, channel `mainnet`).
**Stock Bitcoin Core will not work:** ECX is a hard fork with its own consensus rules,
network magic and ports. A node validating from genesis needs Bitcoin's entire history,
so use eCash's published assumeutxo snapshot — see [deploy/README.md](deploy/README.md).

```bash
npm install                 # install dependencies
cp .env.example .env.local  # create your local config (adjust if needed)
npm run index               # scan the node and populate the SQLite store
npm run dev                 # start the site at http://localhost:3000
```

Without a node, set `ECASH_DEMO=1` in `.env.local` to work on the UI against sample data.
That is a development setting only — see [Production setup](#production-setup).

## Production setup

One ECX mainnet node, one indexer, one SQLite file, one website:

```
ECX node ──RPC──▶ indexer (timer) ──writes──▶ SQLite ◀──reads── website
```

- **The website reads only the SQLite store.** It has no node connection and no RPC
  credentials, so it keeps serving the saved data while the node or indexer is down. The
  header labels it **SAVED · ECX MAINNET DATA** with the latest indexed block's height and
  time, and warns when no new block has been indexed for 30 minutes.
- **Before serving anything, it validates the store:** the ECX fork-block stamp, the
  `network` stamp and the parser version must all match this code — the same identity the
  indexer verifies against the node and stamps in.
- **If the store is missing, empty, unreadable or fails those checks, the page shows
  "Data temporarily unavailable"** with no totals, charts or rankings. It never falls back
  to sample data. The reason is written to the server log (once per change, with the file
  path and raw error) and reported by `/api/health`.
- **`/api/health`** uses the same loader as the page. It returns `200` only for fresh,
  validated data. Otherwise it returns `503`, with `status` set to `stale`, `missing`,
  `empty`, `unreadable`, `chain-mismatch`, `network-mismatch`, `parser-mismatch` or
  `demo`, and `dashboard` set to what the page is showing (`saved`, `unavailable` or
  `demo`). A stale store still shows its saved data, but reports `503` so monitoring
  catches a stalled indexer. The response carries no file paths or error text, only
  reason codes and stored/expected stamps.
- **Demo mode (`ECASH_DEMO=1`) is for development only.** It labels every view
  "DEMO — SAMPLE DATA" and makes `/api/health` return `503 demo`, so it cannot pass as
  production. A data failure never turns it on.

See [deploy/README.md](deploy/README.md) for the systemd units and environment files.

## Keeping data fresh

The site is only as current as the last indexer run. Run the indexer on a loop or a cron
job to keep the store up to date:

```bash
npm run index   # safe to run repeatedly; only fetches new blocks
```

A deep first run is committed in bounded chunks (`ECASH_INDEX_CHUNK`, default 250 blocks)
rather than one batch: real mainnet blocks carry thousands of transactions and verbosity-3
`getblock` embeds every input's prevout, so the whole range will not fit in memory at
once. Chunks commit in ascending order, so the store is always a valid contiguous prefix
— an interrupted run leaves less history, never torn history.

## Rebuilding the store

The SQLite file is a **derived cache** — every value in it is re-computed from the node,
so it is safe to delete at any time. To rebuild from scratch:

```bash
rm .data/ecash-meter.sqlite && npm run index
```

The indexer stamps each database with the fee-attribution parser version it was written
with. If you upgrade to a build whose fee math changed, the indexer detects the mismatch
and **refuses to append to the old cache** (so stale fees can't silently linger) — it
prints the `rm … && npm run index` command above. Rebuilding re-fetches the backfill range from the node.

## Fee attribution: current method and its limits

Fees are attributed by matching a coinbase BMM commitment (`h*`) to a non-coinbase
transaction whose `OP_RETURN` output **contains that 32-byte `h*`**, then charging
only that transaction's own fee to the committed slot (`lib/bmm.ts`).

This is a **heuristic**, not a full parse of a protocol-defined BMM-request format:

- **Guaranteed safe bounds (tested):** `h*` is always a complete 32-byte value, so a
  truncated/empty commitment can never match; each transaction's fee is attributed
  once and split across any slots it commits, so **the total attributed from a
  transaction never exceeds the fee it actually paid**.
- **Known limitation:** it matches *any* `OP_RETURN` that embeds the 32-byte
  sequence, which is broader than parsing an authoritative BMM-request tag + field
  layout. The method has been checked against real chain data — a block with seven
  coinbase commitments matched exactly one paid bid each, attributing their individual
  fees (6 × 564 sats, 1 × 378 sats) rather than the block's aggregate pool — but
  **before presenting this as authoritative fee accounting**, the canonical BIP 301
  BMM-request transaction format should be verified against protocol sources and
  parsed explicitly.
- If that verification changes how historical data is interpreted, bump
  `PARSER_VERSION` (`lib/bmm.ts`) and rebuild the derived cache (see above).

## Configuration

All settings live in `.env.local` (see `.env.example` for the full list). Key ones:

| Variable | Purpose |
|---|---|
| `ECASH_METER_DB` | Path to the SQLite file (default `./.data/ecash-meter.sqlite`); read by the site, written by the indexer |
| `ECASH_DEMO` | `1` = show labelled sample data instead of the store. Development only |
| `ECASH_RPC_URL` / `ECASH_RPC_USER` / `ECASH_RPC_PASS` | Indexer only: the ECX mainnet node's JSON-RPC |
| `ECASH_BACKFILL_BLOCKS` | Indexer only: blocks to backfill on the first run (clamps to the ECX fork) |
| `ECASH_INDEX_CHUNK` | Blocks fetched + committed per transaction (default 250) |

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · SQLite (`node:sqlite`).
