import SidechainName from "@/components/SidechainName";
import { formatInt } from "@/lib/format";
import type { PreActivationView } from "@/lib/types";

/**
 * Slots miners committed BMM blocks to while they weren't activated. The
 * enforcer accepts a commitment for any slot, but one for an unactivated slot
 * has no effect on L1 — usually a sidechain team testing before its vote
 * passes. Kept out of every other figure on the page.
 */
export default function PreActivationBmm({ rows }: { rows: PreActivationView[] }) {
  return (
    <section className="panel rounded-2xl">
      <div className="px-5 pb-1 pt-6">
        <h2 className="text-base font-semibold tracking-tight text-neutral-100">
          <SidechainName
            name="Merge-mining before activation"
            description="Miners have committed blocks for these slots, but they aren't activated, so the commitments have no effect on L1 yet. They're left out of the figures above."
          />
        </h2>
      </div>
      <ul className="px-2 pb-2 pt-2">
        {rows.map((r) => (
          <li
            key={r.slot}
            className="rounded-xl border-t border-white/[0.06] px-3 py-3.5 first:border-t-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs tabular-nums text-neutral-500">slot {r.slot}</span>
              <SidechainName
                name={r.name}
                description={r.description}
                className="font-medium text-neutral-100"
              />
              {r.votes !== undefined && r.votesNeeded !== undefined ? (
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-neutral-400 ring-1 ring-white/10">
                  {formatInt(r.votes)} / {formatInt(r.votesNeeded)} votes
                </span>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums text-neutral-500">
              <span>
                <span className="text-neutral-100">{formatInt(r.bmmBlocks)}</span>{" "}
                BMM {r.bmmBlocks === 1 ? "block" : "blocks"}
              </span>
              <span>
                {r.firstHeight === r.lastHeight
                  ? `at #${formatInt(r.lastHeight)}`
                  : `#${formatInt(r.firstHeight)} – #${formatInt(r.lastHeight)}`}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
