"use client";

// Live feed of recent drivechain activity — BMM blocks, deposits, withdrawals.
//
// The server renders the first page of events with the dashboard; this
// component then polls /api/activity and merges in anything new, highlighting
// it briefly. "Live" means as fresh as the store: the site never contacts the
// node, so a new block appears here once the indexer has stored it.
//
// Polling pauses while the tab is hidden and resumes (with an immediate check)
// when it becomes visible again, so an idle background tab costs nothing.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActivityEvent } from "@/lib/activity";
import { formatCoins, formatInt, formatSats } from "@/lib/format";

const POLL_MS = 30_000;
const HIGHLIGHT_MS = 8_000;

interface Props {
  initialEvents: ActivityEvent[];
  /** How many events to show (and request). */
  limit: number;
  /** ECX explorer base URL for links, or null for plain text. */
  explorerUrl: string | null;
}

type Status = "live" | "unavailable" | "offline";

// A ticking clock as an external store: null during the server render and
// hydration (so both renders match), then the current time, re-read every 15s.
// The value is quantised to 15s so repeated reads within a tick are identical,
// as useSyncExternalStore requires.
const TICK_S = 15;
const subscribeClock = (onTick: () => void) => {
  const id = setInterval(onTick, TICK_S * 1000);
  return () => clearInterval(id);
};
const readClock = () => Math.floor(Date.now() / 1000 / TICK_S) * TICK_S;
const serverClock = () => null;

/** "just now", "4m ago", "3h ago", "2d ago". */
function ago(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const KIND_LABEL: Record<ActivityEvent["kind"], string> = {
  bmm: "BMM block",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
};

function amountText(e: ActivityEvent): string {
  if (e.kind === "bmm") return e.amountSats > 0 ? `bid ${formatSats(e.amountSats)}` : "no paid bid";
  return `${e.kind === "withdrawal" ? "−" : "+"}${formatCoins(e.amountSats, 4)}`;
}

export default function ActivityFeed({ initialEvents, limit, explorerUrl }: Props) {
  const [events, setEvents] = useState(initialEvents);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<Status>("live");
  const now = useSyncExternalStore(subscribeClock, readClock, serverClock);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const known = useRef(new Set(initialEvents.map((e) => e.id)));

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/activity?limit=${limit}`, { cache: "no-store" });
      const body = (await res.json()) as { status: string; events: ActivityEvent[] };
      if (!res.ok || body.status !== "ok") {
        setStatus("unavailable");
        return;
      }
      const added = body.events.filter((e) => !known.current.has(e.id)).map((e) => e.id);
      body.events.forEach((e) => known.current.add(e.id));
      setEvents(body.events);
      setStatus("live");
      if (added.length > 0) {
        setFresh(new Set(added));
        setTimeout(() => setFresh(new Set()), HIGHLIGHT_MS);
      }
    } catch {
      setStatus("offline");
    } finally {
      setCheckedAt(Math.floor(Date.now() / 1000));
    }
  }, [limit]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  const link = (path: string, text: string) =>
    explorerUrl ? (
      <a
        href={`${explorerUrl}/${path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-white/20 underline-offset-2 transition-colors hover:text-brand hover:decoration-brand/60"
      >
        {text}
      </a>
    ) : (
      text
    );

  return (
    <section className="panel mt-10 rounded-2xl" aria-labelledby="activity-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-1 pt-6">
        <h2
          id="activity-heading"
          className="text-base font-semibold tracking-tight text-neutral-100"
        >
          Recent activity
        </h2>
        <p className="flex items-center gap-1.5 text-xs text-neutral-500" aria-live="polite">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              status === "live" ? "animate-pulse bg-brand" : "bg-amber-400"
            }`}
          />
          {status === "live"
            ? `Live · checks every ${POLL_MS / 1000}s${
                checkedAt && now ? ` · last checked ${ago(Math.max(0, now - checkedAt))}` : ""
              }`
            : status === "unavailable"
              ? "Paused — data temporarily unavailable"
              : "Paused — can't reach the site, retrying"}
          {fresh.size > 0 ? ` · ${fresh.size} new` : ""}
        </p>
      </div>

      {events.length === 0 ? (
        <p className="px-6 pb-6 pt-3 text-sm text-neutral-400">No activity yet.</p>
      ) : (
        <ul className="max-h-[28rem] overflow-y-auto px-3 pb-3 pt-2">
          {events.map((e) => (
            <li
              key={e.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border-t border-white/[0.06] px-3 py-2.5 text-sm transition-colors duration-1000 first:border-t-0 ${
                fresh.has(e.id) ? "bg-brand/10" : ""
              }`}
            >
              <span className="flex min-w-[9rem] items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: e.color }}
                />
                <span className="font-medium text-neutral-100">{e.name}</span>
              </span>
              <span className="min-w-[6.5rem] text-neutral-400">
                {KIND_LABEL[e.kind]}
                {e.activated === false ? (
                  <span
                    className="ml-2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-neutral-500 ring-1 ring-white/10"
                    title="This slot wasn't activated at this block, so the commitment has no effect on L1. It isn't counted in the figures above."
                  >
                    not activated
                  </span>
                ) : null}
              </span>
              <span className="min-w-[8rem] tabular-nums text-neutral-200">{amountText(e)}</span>
              <span className="tabular-nums text-neutral-400">
                block {link(`block/${e.blockHash}`, `#${formatInt(e.height)}`)}
                {e.txid ? (
                  <>
                    {" · tx "}
                    {link(`tx/${e.txid}`, `${e.txid.slice(0, 8)}…`)}
                  </>
                ) : null}
              </span>
              <span className="ml-auto text-xs tabular-nums text-neutral-500">
                {now ? ago(Math.max(0, now - e.time)) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
