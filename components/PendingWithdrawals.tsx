"use client";

// Withdrawal bundles collecting miner votes (BIP 300 M3/M4), beside the
// activity feed. Rendered with the page, then kept fresh by the feed's own
// poll: ActivityFeed broadcasts each /api/activity response, which carries the
// current pending list, so there is no second timer.

import { useEffect, useState } from "react";
import SidechainName from "@/components/SidechainName";
import { ACTIVITY_EVENT } from "@/components/ActivityFeed";
import { approxDuration, formatInt, formatPct } from "@/lib/format";
import type { PendingWithdrawalView } from "@/lib/types";

interface Props {
  /** null = unknown (the store doesn't record bundle history back to the fork). */
  initial: PendingWithdrawalView[] | null;
  avgBlockSeconds?: number;
}

export default function PendingWithdrawals({ initial, avgBlockSeconds }: Props) {
  const [bundles, setBundles] = useState(initial);

  useEffect(() => {
    const onActivity = (e: Event) => {
      const body = (e as CustomEvent<{ pendingWithdrawals?: PendingWithdrawalView[] | null }>)
        .detail;
      if (body && body.pendingWithdrawals !== undefined) setBundles(body.pendingWithdrawals);
    };
    window.addEventListener(ACTIVITY_EVENT, onActivity);
    return () => window.removeEventListener(ACTIVITY_EVENT, onActivity);
  }, []);

  // On wide screens it fills its column, whose height the feed sets, and the
  // list scrolls inside it; stacked, the list scrolls past a fixed height.
  return (
    <section className="panel flex flex-col rounded-2xl lg:absolute lg:inset-0">
      <div className="px-5 pb-1 pt-6">
        <h2 className="text-base font-semibold tracking-tight text-neutral-100">
          Pending Withdrawals
        </h2>
      </div>
      {bundles === null ? (
        <p className="px-5 pb-6 pt-3 text-sm text-neutral-400">
          Unknown — the indexed history doesn&apos;t record withdrawal bundles back to
          the ECX fork, so their votes can&apos;t be counted.
        </p>
      ) : bundles.length === 0 ? (
        <p className="px-5 pb-6 pt-3 text-sm text-neutral-400">
          No withdrawal bundles are collecting votes right now.
        </p>
      ) : (
        <ul className="mx-2 mb-2 mt-2 max-h-[20rem] min-h-0 flex-1 overflow-y-auto lg:max-h-none [scrollbar-color:#404040_transparent] [scrollbar-width:thin]">
          {bundles.map((b) => {
            const progress = Math.min(b.votes / b.votesNeeded, 1);
            const left = approxDuration(b.blocksLeft, avgBlockSeconds);
            return (
              <li
                key={`${b.slot}-${b.m6id}`}
                className="rounded-xl border-t border-white/[0.06] px-3 py-3.5 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: b.color }}
                  />
                  <SidechainName
                    name={b.name}
                    description={b.description}
                    className="font-medium text-neutral-100"
                  />
                  <span
                    className="font-mono text-[11px] text-neutral-500"
                    title={`Bundle ${b.m6id}`}
                  >
                    {b.m6id.slice(0, 10)}…
                  </span>
                </div>
                <div className="mt-2.5 flex items-baseline justify-between text-xs">
                  <span className="text-neutral-500">Votes</span>
                  <span className="tabular-nums text-neutral-100">
                    {formatInt(b.votes)}
                    <span className="text-neutral-500"> / {formatInt(b.votesNeeded)}</span>
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
                    proposed #{formatInt(b.proposalHeight)} · {formatInt(b.age)} blocks ago
                  </span>
                  <span>
                    {formatInt(b.blocksLeft)} blocks left{left ? ` (${left})` : ""}
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
